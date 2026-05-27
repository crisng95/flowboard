"""WorkerLoop — orchestrates the full extension job lifecycle.

Poll → Claim → Heartbeat (concurrent) → Execute → Complete / Fail

The loop is designed to run as a long-lived asyncio Task.  Shut it down
gracefully by calling `loop.request_shutdown()` and then awaiting
`loop.drain()`.

Operational Guards (Phase 4.1)
-------------------------------
- Secret values are NEVER logged (log sanitisation).
- Network errors on claim use exponential backoff with full jitter.
- Poll interval has ±25% jitter to spread workers across the second boundary.
- Heartbeat fires immediately once before entering the sleep cycle, so jobs
  that complete quickly still send at least one heartbeat renewal.
- Structured metric log lines are emitted for all key events so they can be
  parsed by log aggregators (Datadog, Loki, etc.).

Architecture
------------
                        ┌──────────────────────────────────────┐
                        │             WorkerLoop.run()          │
                        │                                       │
  ┌──────────┐          │  ┌─────────────────────────────────┐  │
  │ Control  │  claim   │  │        _process_job(job)        │  │
  │ Plane    │◄─────────┤  │                                 │  │
  │ Gateway  │  hb/prog │  │  ┌─────────────┐  ┌──────────┐ │  │
  │          │◄─────────┤  │  │  _heartbeat │  │ executor │ │  │
  │          │ complete │  │  │   _task     │  │  .run()  │ │  │
  │          │◄─────────┤  │  └─────────────┘  └──────────┘ │  │
  └──────────┘          │  └─────────────────────────────────┘  │
                        │  sleep(poll + jitter) if no job       │
                        └──────────────────────────────────────┘
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Dict, Optional, Type

from flowboard.extension_worker.client import (
    NoJobAvailableError,
    WorkerAuthError,
    WorkerClient,
    WorkerClientError,
)
from flowboard.extension_worker.mock_executor import ExecutionError, MockExecutor
from flowboard.extension_worker.base_executor import BaseExecutor, validate_executor_event

logger = logging.getLogger(__name__)

# Type alias for an executor class (so tests can inject a custom one)
ExecutorClass = Type[BaseExecutor]

# Exponential backoff limits for transient claim errors
_BACKOFF_BASE_SEC = 1.0
_BACKOFF_MAX_SEC = 60.0
_POLL_JITTER_FACTOR = 0.25  # ±25% jitter on poll interval


def _jitter(interval: float, factor: float = _POLL_JITTER_FACTOR) -> float:
    """Return `interval` ± `factor` fraction (uniform jitter)."""
    delta = interval * factor
    return interval + random.uniform(-delta, delta)


def _backoff(attempt: int, base: float = _BACKOFF_BASE_SEC, cap: float = _BACKOFF_MAX_SEC) -> float:
    """Full-jitter exponential backoff: random(0, min(cap, base * 2^attempt))."""
    ceiling = min(cap, base * (2 ** attempt))
    return random.uniform(0, ceiling)


class WorkerLoop:
    """Async poll-claim-execute loop for a single extension worker identity.

    Parameters
    ----------
    client:
        Configured `WorkerClient` instance (must be used as async ctx manager
        *before* calling `run()`).
    provider:
        Provider name to claim jobs for (e.g. ``"mock"``, ``"flow"``).
    poll_interval_sec:
        Base seconds between claim attempts when queue is empty.
        Actual sleep includes ±25% jitter.
    heartbeat_interval_sec:
        Seconds between heartbeat renewals while a job is running.
        The first heartbeat fires immediately after job start (no initial sleep).
    lease_duration_sec:
        Lease window requested on each claim / heartbeat.
    executor_class:
        Executor class to instantiate for each job.  Defaults to
        `MockExecutor`.  Inject a test double or real provider driver.
    """

    def __init__(
        self,
        client: WorkerClient,
        provider: str = "mock",
        poll_interval_sec: float = 5.0,
        heartbeat_interval_sec: float = 20.0,
        lease_duration_sec: int = 60,
        executor_class: ExecutorClass = MockExecutor,
        stop_after_jobs: Optional[int] = None,
    ) -> None:
        self._client = client
        self._provider = provider
        self._poll_interval = poll_interval_sec
        self._hb_interval = heartbeat_interval_sec
        self._lease_sec = lease_duration_sec
        self._executor_class = executor_class
        self._stop_after_jobs = stop_after_jobs

        self._shutdown_event = asyncio.Event()
        self._running_task: Optional[asyncio.Task[None]] = None

    # ------------------------------------------------------------------ #
    # Public control interface
    # ------------------------------------------------------------------ #

    def request_shutdown(self) -> None:
        """Signal the loop to stop after the current job completes."""
        logger.info("event=shutdown_requested")
        self._shutdown_event.set()

    async def drain(self, timeout: float = 10.0) -> None:
        """Wait for the running loop task to finish (up to `timeout` seconds)."""
        if self._running_task and not self._running_task.done():
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._running_task), timeout=timeout
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._running_task.cancel()

    async def run(self) -> None:
        """Main loop — runs until `request_shutdown()` is called."""
        self._running_task = asyncio.current_task()
        logger.info(
            "event=worker_started provider=%s poll_sec=%.1f heartbeat_sec=%.1f lease_sec=%d",
            self._provider, self._poll_interval, self._hb_interval, self._lease_sec,
        )

        claim_error_streak = 0  # consecutive network error counter for backoff
        jobs_processed = 0

        while not self._shutdown_event.is_set():
            if self._stop_after_jobs is not None and jobs_processed >= self._stop_after_jobs:
                logger.info(
                    "event=stop_after_jobs_reached limit=%d processed=%d",
                    self._stop_after_jobs, jobs_processed,
                )
                break

            try:
                job = await self._client.claim(self._provider, self._lease_sec)
                claim_error_streak = 0  # reset on success
                logger.info(
                    "event=claimed job_id=%s provider=%s",
                    job.get("id"), self._provider,
                )

            except WorkerAuthError:
                # Fatal — wrong credentials, no point retrying
                logger.error(
                    "event=auth_failed provider=%s action=stopping "
                    "[SECURITY] credentials rejected by gateway",
                    self._provider,
                )
                break

            except NoJobAvailableError:
                sleep_sec = _jitter(self._poll_interval)
                logger.debug(
                    "event=claim_empty provider=%s sleep_sec=%.2f",
                    self._provider, sleep_sec,
                )
                try:
                    await asyncio.wait_for(
                        self._shutdown_event.wait(), timeout=sleep_sec
                    )
                except asyncio.TimeoutError:
                    pass
                continue

            except WorkerClientError as exc:
                claim_error_streak += 1
                sleep_sec = _backoff(claim_error_streak)
                logger.warning(
                    "event=claim_error streak=%d http_status=%d sleep_sec=%.2f",
                    claim_error_streak, exc.status_code, sleep_sec,
                )
                try:
                    await asyncio.wait_for(
                        self._shutdown_event.wait(), timeout=sleep_sec
                    )
                except asyncio.TimeoutError:
                    pass
                continue

            except Exception:
                claim_error_streak += 1
                sleep_sec = _backoff(claim_error_streak)
                logger.exception(
                    "event=claim_unexpected_error streak=%d sleep_sec=%.2f",
                    claim_error_streak, sleep_sec,
                )
                await asyncio.sleep(sleep_sec)
                continue

            await self._process_job(job)
            jobs_processed += 1

        logger.info("event=worker_stopped provider=%s", self._provider)

    # ------------------------------------------------------------------ #
    # Internal job execution
    # ------------------------------------------------------------------ #

    async def _process_job(self, job: Dict[str, Any]) -> None:
        """Execute a single claimed job: heartbeat + execute + complete/fail."""
        request_id: str = job["id"]
        start_ts = time.monotonic()
        logger.info("event=job_started job_id=%s", request_id)

        # Start concurrent heartbeat task (fires immediately, then on interval)
        hb_task = asyncio.create_task(
            self._heartbeat_loop(request_id),
            name=f"hb-{request_id[:8]}",
        )

        try:
            if self._provider == "flow":
                from flowboard.extension_worker.asset_uploader import AssetUploader
                from flowboard.extension_worker.flow_api_driver import FlowAPIDriver
                from flowboard.extension_worker.flow_executor import FlowExecutor
                from flowboard.services.flow_client import flow_client

                uploader = AssetUploader(self._client)
                if self._executor_class is FlowExecutor:
                    executor = self._executor_class(driver=FlowAPIDriver(client=flow_client), uploader=uploader)
                else:
                    executor = self._executor_class(uploader=uploader)
            else:
                executor = self._executor_class()
            async for event in executor.run(job):
                # Validate event format & constraints
                validated = validate_executor_event(event)
                await self._client.progress(
                    request_id=request_id,
                    progress_stage=validated["stage"],
                    progress=validated["progress"],
                )
                logger.debug(
                    "event=progress job_id=%s stage=%s pct=%d",
                    request_id, validated["stage"], validated["progress"],
                )

            output, assets = executor.last_result()
            await self._client.complete(
                request_id=request_id,
                output_result=output,
                assets=assets,
            )
            elapsed = time.monotonic() - start_ts
            logger.info(
                "event=job_completed job_id=%s elapsed_sec=%.2f asset_count=%d",
                request_id, elapsed, len(assets),
            )

        except asyncio.CancelledError:
            elapsed = time.monotonic() - start_ts
            logger.warning(
                "event=job_cancelled job_id=%s elapsed_sec=%.2f",
                request_id, elapsed,
            )
            raise

        except ExecutionError as exc:
            elapsed = time.monotonic() - start_ts
            logger.error(
                "event=job_failed job_id=%s reason=executor_error elapsed_sec=%.2f error=%s",
                request_id, elapsed, exc,
            )
            await self._safe_fail(request_id, str(exc))

        except WorkerClientError as exc:
            # Gateway rejected one of our calls (e.g. lease stolen by another worker)
            elapsed = time.monotonic() - start_ts
            logger.error(
                "event=job_gateway_error job_id=%s http_status=%d elapsed_sec=%.2f "
                "[lease may have been claimed by another worker]",
                request_id, exc.status_code, elapsed,
            )
            # Do NOT try to fail — we may not hold the lease any more

        except Exception as exc:
            elapsed = time.monotonic() - start_ts
            logger.exception(
                "event=job_unexpected_error job_id=%s elapsed_sec=%.2f",
                request_id, elapsed,
            )
            await self._safe_fail(request_id, f"Unexpected error: {exc}")

        finally:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

    async def _heartbeat_loop(self, request_id: str) -> None:
        """Runs concurrently while a job executes; keeps the lease alive.

        Fires an initial heartbeat immediately (before the first sleep) so that
        even short jobs get at least one renewal, then repeats every
        `heartbeat_interval_sec`.
        """
        first = True
        while True:
            if first:
                # Immediate first beat — no sleep before the first renewal
                first = False
            else:
                await asyncio.sleep(self._hb_interval)
            try:
                await self._client.heartbeat(request_id, self._lease_sec)
                logger.debug("event=heartbeat_ok job_id=%s", request_id)
            except Exception as exc:
                logger.warning(
                    "event=heartbeat_failed job_id=%s error=%s",
                    request_id, exc,
                )

    async def _safe_fail(self, request_id: str, error_message: str) -> None:
        """Attempt to mark job as failed; swallow errors to avoid cascading."""
        try:
            await self._client.fail(request_id=request_id, error_message=error_message)
            logger.info("event=fail_reported job_id=%s", request_id)
        except Exception as exc:
            logger.warning(
                "event=fail_report_error job_id=%s error=%s",
                request_id, exc,
            )
