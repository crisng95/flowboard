"""Unit tests for Phase 4.2A: Provider Executor Interface Hardening & E2E Smoke Fixes.

Covers:
  - BaseExecutor Protocol conformance & event validation
  - Invalid executor events rejected (stage, progress out of bounds)
  - stop_after_jobs parameter cleanly exiting the loop without timeout
  - Heartbeat fires immediately for a slow executor
  - Cancellation/CancelledError propagates cleanly (is not swallowed)
  - Success and fail executors utilizing BaseExecutor protocol
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator, Dict, List, Tuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flowboard.extension_worker.base_executor import (
    BaseExecutor,
    InvalidExecutorEventError,
    ProgressEvent,
    validate_executor_event,
)
from flowboard.extension_worker.client import NoJobAvailableError, WorkerClient
from flowboard.extension_worker.mock_executor import ExecutionError
from flowboard.extension_worker.worker_loop import WorkerLoop

MOCK_JOB = {
    "id": "11111111-1111-1111-1111-111111111111",
    "status": "claimed",
    "provider": "mock",
    "task_type": "txt2img",
    "input_data": {"prompt": "Hardening testing"},
}


class SuccessFakeExecutor(BaseExecutor):
    """Complies with BaseExecutor protocol, yields valid events."""
    def __init__(self) -> None:
        self._output: Any = None
        self._assets: Any = None

    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        yield {"stage": "preparing", "progress": 10, "message": "Starting job"}
        yield {"stage": "submitting", "progress": 30}
        yield {"stage": "waiting_provider", "progress": 70, "debug": {"provider_id": "test-prov-1"}}
        yield {"stage": "extracting", "progress": 90}
        yield {"stage": "uploading", "progress": 95}
        self._output = {"result": "success"}
        self._assets = [{"file_name": "image.png", "storage_key": "k.png"}]

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        if self._output is None:
            raise RuntimeError("Run has not completed")
        return self._output, self._assets


class InvalidFakeExecutor(BaseExecutor):
    """Yields invalid event (progress out of bounds)."""
    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        yield {"stage": "preparing", "progress": 150}  # Invalid progress (>100)

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        return {}, []


class SlowFakeExecutor(BaseExecutor):
    """Simulates a slow provider execution."""
    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        yield {"stage": "preparing", "progress": 10}
        await asyncio.sleep(0.15)  # Let heartbeat run
        yield {"stage": "extracting", "progress": 90}

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        return {"result": "slow"}, []


class CancelledFakeExecutor(BaseExecutor):
    """Simulates a cancelled run by raising CancelledError."""
    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        yield {"stage": "preparing", "progress": 10}
        raise asyncio.CancelledError()

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        raise RuntimeError("Cancelled")


def _make_mock_client() -> MagicMock:
    mc = MagicMock(spec=WorkerClient)
    mc.claim = AsyncMock(return_value=MOCK_JOB)
    mc.heartbeat = AsyncMock(return_value={"id": MOCK_JOB["id"]})
    mc.progress = AsyncMock(return_value={"id": MOCK_JOB["id"]})
    mc.complete = AsyncMock(return_value={"id": MOCK_JOB["id"], "status": "completed"})
    mc.fail = AsyncMock(return_value={"id": MOCK_JOB["id"], "status": "failed"})
    return mc


class TestExecutorHardening:

    def test_progress_event_validation_valid(self):
        """Valid events pass validation."""
        valid_event = {"stage": "submitting", "progress": 50, "message": "ok", "debug": {"k": "v"}}
        validated = validate_executor_event(valid_event)
        assert validated["stage"] == "submitting"
        assert validated["progress"] == 50
        assert validated["message"] == "ok"
        assert validated["debug"] == {"k": "v"}

    def test_progress_event_validation_invalid_stage(self):
        """Invalid stage raises error."""
        with pytest.raises(InvalidExecutorEventError, match="Invalid progress stage"):
            validate_executor_event({"stage": "non_existent_stage", "progress": 50})

    def test_progress_event_validation_invalid_progress(self):
        """Invalid progress value raises error."""
        with pytest.raises(InvalidExecutorEventError, match="Progress must be between 0 and 100"):
            validate_executor_event({"stage": "submitting", "progress": -5})
        with pytest.raises(InvalidExecutorEventError, match="Progress must be between 0 and 100"):
            validate_executor_event({"stage": "submitting", "progress": 105})
        with pytest.raises(InvalidExecutorEventError, match="Progress must be an integer"):
            validate_executor_event({"stage": "submitting", "progress": "50"})

    @pytest.mark.asyncio
    async def test_success_fake_executor_conforms(self):
        """Fake executor runs correctly within WorkerLoop using BaseExecutor protocol."""
        mc = _make_mock_client()
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            stop_after_jobs=1,
            executor_class=SuccessFakeExecutor,
        )
        await asyncio.wait_for(loop.run(), timeout=2.0)
        assert mc.claim.call_count == 1
        assert mc.progress.call_count == 5
        mc.complete.assert_called_once()
        mc.fail.assert_not_called()

    @pytest.mark.asyncio
    async def test_invalid_executor_event_rejected(self):
        """Invalid event raises InvalidExecutorEventError and fails the job."""
        mc = _make_mock_client()
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            stop_after_jobs=1,
            executor_class=InvalidFakeExecutor,
        )
        await asyncio.wait_for(loop.run(), timeout=2.0)
        mc.fail.assert_called_once()
        fail_message = mc.fail.call_args.kwargs["error_message"]
        assert "Progress must be between 0 and 100" in fail_message
        mc.complete.assert_not_called()

    @pytest.mark.asyncio
    async def test_stop_after_jobs_stops_cleanly(self):
        """stop_after_jobs limit halts loop immediately without waiting for timeout."""
        mc = _make_mock_client()
        # Even though claim has an infinite pool of jobs, loop stops after 2 jobs.
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            stop_after_jobs=2,
            executor_class=SuccessFakeExecutor,
        )
        await asyncio.wait_for(loop.run(), timeout=2.0)
        assert mc.claim.call_count == 2
        assert mc.complete.call_count == 2

    @pytest.mark.asyncio
    async def test_slow_executor_heartbeat_fires(self):
        """Heartbeats fire periodically for a slow executor."""
        mc = _make_mock_client()
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=0.05,
            stop_after_jobs=1,
            executor_class=SlowFakeExecutor,
        )
        await asyncio.wait_for(loop.run(), timeout=2.0)
        assert mc.heartbeat.call_count >= 2

    @pytest.mark.asyncio
    async def test_cancelled_executor_propagates(self):
        """CancelledError inside executor is raised/propagated cleanly."""
        mc = _make_mock_client()
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            stop_after_jobs=1,
            executor_class=CancelledFakeExecutor,
        )
        with pytest.raises(asyncio.CancelledError):
            await loop.run()
        # complete/fail should NOT be called since CancelledError was propagated
        mc.complete.assert_not_called()
        mc.fail.assert_not_called()
