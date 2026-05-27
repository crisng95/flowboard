"""MockExecutor — simulates provider execution without touching a real AI service.

Yields progress events as it runs, then returns a final output dict.
A real provider executor replaces this class but keeps the same interface:

    async for event in executor.run(job):
        # event: {"stage": str, "progress": int}

    result, assets = executor.last_result()

Design notes:
  - Three realistic stages: submitting → waiting_provider → extracting
  - Total elapsed: random 3-5 seconds
  - 20% chance of simulated failure (controllable via `fail_rate` parameter)
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

from flowboard.extension_worker.base_executor import BaseExecutor, ProgressEvent

# Progress stages mirrors the DB check constraint
STAGES = [
    ("submitting",        20),
    ("waiting_provider",  60),
    ("extracting",        90),
]


class ExecutionError(Exception):
    """Raised when the mock provider encounters a simulated failure."""


class MockExecutor(BaseExecutor):
    """Simulates a provider run and yields progress events.

    Parameters
    ----------
    total_duration:
        Total simulated execution time in seconds (default: random 3-5s).
    fail_rate:
        Probability [0.0, 1.0] of a simulated failure mid-execution.
        Default 0.0 (never fail) — tests override this.
    """

    def __init__(
        self,
        total_duration: Optional[float] = None,
        fail_rate: float = 0.0,
    ) -> None:
        self._duration = total_duration if total_duration is not None else random.uniform(3.0, 5.0)
        self._fail_rate = fail_rate
        self._output: Optional[Dict[str, Any]] = None
        self._assets: Optional[List[Dict[str, Any]]] = None

    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        """Async generator that yields progress events and simulates execution.

        Usage::

            async for event in executor.run(job):
                await client.progress(job["id"], event["stage"], event["progress"])

        Raises ExecutionError on simulated failure.
        """
        request_id = job.get("id", "unknown")
        provider = job.get("provider", "mock")
        start = time.monotonic()

        # Calculate delay per stage
        stage_count = len(STAGES)
        stage_delay = self._duration / stage_count

        for i, (stage_name, stage_pct) in enumerate(STAGES):
            await asyncio.sleep(stage_delay)
            elapsed = time.monotonic() - start
            logger.debug(
                "[mock_executor] job=%s stage=%s pct=%d elapsed=%.1fs",
                request_id, stage_name, stage_pct, elapsed,
            )
            yield {"stage": stage_name, "progress": stage_pct}

            # Inject simulated failure partway through if configured
            if self._fail_rate > 0 and random.random() < self._fail_rate:
                raise ExecutionError(
                    f"Simulated provider failure at stage '{stage_name}' "
                    f"after {elapsed:.1f}s"
                )

        # Build mock output + synthetic asset metadata
        asset_id = str(uuid.uuid4())
        mock_storage_key = f"mock/{request_id}/output.png"
        self._output = {
            "provider": provider,
            "mock": True,
            "generated_at": time.time(),
            "storage_key": mock_storage_key,
        }
        self._assets = [
            {
                "file_name": "output.png",
                "storage_key": mock_storage_key,
                "mime_type": "image/png",
                "byte_size": 102400,
                "checksum": "mock_checksum_" + asset_id[:8],
            }
        ]
        logger.info(
            "[mock_executor] job=%s done in %.2fs",
            request_id,
            time.monotonic() - start,
        )

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """Return (output_result, assets) after a successful run().

        Must be called after the generator is fully consumed.
        """
        if self._output is None:
            raise RuntimeError("Executor has not completed a run yet.")
        return self._output, self._assets or []
