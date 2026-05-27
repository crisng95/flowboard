"""Extension Worker entry point.

Run as a standalone process::

    python -m flowboard.extension_worker

Or with env overrides::

    EXT_CLIENT_ID=... EXT_PAIRING_SECRET=... EXT_PROVIDER=flow \\
        python -m flowboard.extension_worker

Environment Variables (all optional except EXT_CLIENT_ID / EXT_PAIRING_SECRET)
-------------------------------------------------------------------------------
EXT_CLIENT_ID             Worker identity registered via /api/pairings/register
EXT_PAIRING_SECRET        Pairing secret (never logged)
CONTROL_PLANE_BASE_URL    Gateway base URL (default: http://127.0.0.1:8101)
EXT_PROVIDER              Provider name to claim jobs for (default: mock)
EXT_POLL_INTERVAL_SEC     Seconds between empty-queue polls (default: 5)
EXT_HEARTBEAT_INTERVAL_SEC  Seconds between heartbeat renewals (default: 20)
EXT_LEASE_DURATION_SEC    Lease window in seconds (default: 60)
LOG_LEVEL                 Logging level (default: INFO)

Security Notes
--------------
- EXT_PAIRING_SECRET is read once at startup and never echoed to logs.
- Startup banner logs a redacted token fingerprint (last 4 chars) for tracing.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
from typing import Optional

from flowboard.config import (
    CONTROL_PLANE_BASE_URL,
    EXT_CLIENT_ID,
    EXT_HEARTBEAT_INTERVAL_SEC,
    EXT_LEASE_DURATION_SEC,
    EXT_PAIRING_SECRET,
    EXT_POLL_INTERVAL_SEC,
    EXT_PROVIDER,
)
from flowboard.extension_worker.client import WorkerClient
from flowboard.extension_worker.worker_loop import WorkerLoop


# =========================================================================
# Logging setup
# =========================================================================

def _configure_logging(level_name: str = "INFO") -> None:
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
        stream=sys.stderr,
    )


# =========================================================================
# Config validation
# =========================================================================

def _validate_config() -> None:
    """Fail fast if required env vars are missing."""
    missing = []
    if not EXT_CLIENT_ID:
        missing.append("EXT_CLIENT_ID")
    if not EXT_PAIRING_SECRET:
        missing.append("EXT_PAIRING_SECRET")
    if missing:
        sys.stderr.write(
            f"[worker] FATAL: missing required env vars: {', '.join(missing)}\n"
            f"  Set them via environment or a .env file before starting the worker.\n"
            f"  Client ID and secret are obtained from the /api/pairings/register endpoint.\n"
        )
        sys.exit(1)


def _secret_fingerprint(secret: str) -> str:
    """Return a non-sensitive fingerprint for log tracing: last 4 chars."""
    if len(secret) <= 4:
        return "****"
    return f"****{secret[-4:]}"


# =========================================================================
# Graceful shutdown helper
# =========================================================================

class _ShutdownController:
    """Registers OS signal handlers and forwards to WorkerLoop."""

    def __init__(self) -> None:
        self._loop_ref: Optional[WorkerLoop] = None

    def attach(self, worker_loop: WorkerLoop) -> None:
        self._loop_ref = worker_loop

    def handle_signal(self, sig: signal.Signals) -> None:
        name = sig.name if hasattr(sig, "name") else str(sig)
        logger = logging.getLogger(__name__)
        logger.info("event=signal_received signal=%s action=requesting_shutdown", name)
        if self._loop_ref:
            self._loop_ref.request_shutdown()


# =========================================================================
# Main async entry point
# =========================================================================

async def _main() -> None:
    logger = logging.getLogger(__name__)

    logger.info(
        "event=worker_init provider=%s base_url=%s client_id=%s secret_fp=%s "
        "poll_sec=%.1f hb_sec=%.1f lease_sec=%d",
        EXT_PROVIDER,
        CONTROL_PLANE_BASE_URL,
        EXT_CLIENT_ID,
        _secret_fingerprint(EXT_PAIRING_SECRET),
        EXT_POLL_INTERVAL_SEC,
        EXT_HEARTBEAT_INTERVAL_SEC,
        EXT_LEASE_DURATION_SEC,
    )

    shutdown_ctrl = _ShutdownController()

    # Register OS signal handlers (SIGINT = Ctrl+C, SIGTERM = docker/k8s stop)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(
                sig,
                lambda s=sig: shutdown_ctrl.handle_signal(s),
            )
        except (NotImplementedError, OSError):
            # Windows does not support add_signal_handler for all signals;
            # fall back to KeyboardInterrupt catching in the outer try/except.
            pass

    async with WorkerClient(
        base_url=CONTROL_PLANE_BASE_URL,
        client_id=EXT_CLIENT_ID,
        pairing_secret=EXT_PAIRING_SECRET,
    ) as client:
        from flowboard.extension_worker.mock_executor import MockExecutor
        from flowboard.extension_worker.gemini_executor import GeminiExecutor
        from flowboard.extension_worker.flow_executor import FlowExecutor

        executor_class = MockExecutor
        if EXT_PROVIDER == "gemini":
            executor_class = GeminiExecutor
        elif EXT_PROVIDER == "flow":
            executor_class = FlowExecutor

        worker = WorkerLoop(
            client=client,
            provider=EXT_PROVIDER,
            poll_interval_sec=EXT_POLL_INTERVAL_SEC,
            heartbeat_interval_sec=EXT_HEARTBEAT_INTERVAL_SEC,
            lease_duration_sec=EXT_LEASE_DURATION_SEC,
            executor_class=executor_class,
        )
        shutdown_ctrl.attach(worker)

        try:
            await worker.run()
        except KeyboardInterrupt:
            # Windows fallback — Ctrl+C raises here instead of signal handler
            logger.info("event=keyboard_interrupt action=requesting_shutdown")
            worker.request_shutdown()

    logger.info("event=worker_exited")


# =========================================================================
# Entry point
# =========================================================================

if __name__ == "__main__":
    _configure_logging(os.getenv("LOG_LEVEL", "INFO"))
    _validate_config()
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
