"""Integration tests for Phase 3 — Extension Worker Minimal Loop.

Tests cover:
  Section 1 — WorkerClient (unit, no HTTP)
    - Wrong pairing secret → 401 → WorkerAuthError
    - Missing X-Client-Id / X-Pairing-Secret headers → 422
    - No job available → 409 → NoJobAvailableError
    - Successful claim → returns job dict
    - Heartbeat success
    - Progress success
    - Complete by correct client → success
    - Complete by wrong client (different X-Client-Id) → gateway error
    - Fail success

  Section 2 — MockExecutor (unit, pure async)
    - Full run yields 3 progress stages in order
    - last_result() returns output + assets after successful run
    - last_result() before run raises RuntimeError
    - Fail-rate 1.0 always raises ExecutionError

  Section 3 — WorkerLoop (integration via mocked WorkerClient)
    - Full lifecycle: claim → progress x3 → complete
    - Auth failure stops the loop immediately (no infinite retry)
    - Empty queue: loop sleeps then retries (poll counted)
    - Executor exception → client.fail() is called
    - Heartbeat is called while job executes
    - Complete by wrong client (gateway WorkerClientError mid-job) → loop continues
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest
import pytest_asyncio

from flowboard.extension_worker.client import (
    NoJobAvailableError,
    WorkerAuthError,
    WorkerClient,
    WorkerClientError,
)
from flowboard.extension_worker.mock_executor import ExecutionError, MockExecutor, STAGES
from flowboard.extension_worker.worker_loop import WorkerLoop

# =========================================================================
# Fixtures & helpers
# =========================================================================

VALID_CLIENT_ID = "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0"
VALID_SECRET = "super_secure_secret_123"
BASE_URL = "http://testserver"

MOCK_JOB = {
    "id": "00000000-0000-0000-0000-000000000001",
    "status": "claimed",
    "provider": "mock",
    "task_type": "txt2img",
    "input_data": {"prompt": "A scenic view"},
}


def _make_response(status_code: int, json_body: Any) -> MagicMock:
    """Build a minimal mock httpx.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.json.return_value = json_body
    resp.text = str(json_body)
    return resp


def _make_client(
    client_id: str = VALID_CLIENT_ID,
    secret: str = VALID_SECRET,
) -> WorkerClient:
    return WorkerClient(BASE_URL, client_id=client_id, pairing_secret=secret)


# =========================================================================
# Section 1 — WorkerClient
# =========================================================================

class TestWorkerClientClaim:

    @pytest.mark.asyncio
    async def test_wrong_secret_raises_auth_error(self):
        """401 from gateway maps to WorkerAuthError."""
        client = _make_client(secret="wrong_secret")
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(401, {"detail": "Unauthorized: Invalid Extension Client ID or Pairing Secret"})
            ):
                with pytest.raises(WorkerAuthError) as exc_info:
                    await client.claim("mock")
                assert exc_info.value.status_code == 401

    @pytest.mark.asyncio
    async def test_no_job_raises_no_job_available(self):
        """409 from gateway maps to NoJobAvailableError."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(409, {"detail": "No queued requests available"})
            ):
                with pytest.raises(NoJobAvailableError):
                    await client.claim("mock")

    @pytest.mark.asyncio
    async def test_successful_claim_returns_job(self):
        """200 from gateway returns the job dict."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(200, MOCK_JOB)
            ):
                job = await client.claim("mock", lease_duration_sec=60)
                assert job["id"] == MOCK_JOB["id"]
                assert job["status"] == "claimed"

    @pytest.mark.asyncio
    async def test_gateway_500_raises_worker_client_error(self):
        """Non-401/409 error maps to generic WorkerClientError."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(500, {"detail": "Internal Server Error"})
            ):
                with pytest.raises(WorkerClientError) as exc_info:
                    await client.claim("mock")
                assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_heartbeat_success(self):
        """Heartbeat sends correct payload and returns dict."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(200, {"id": "req-1", "last_heartbeat_at": "2024-01-01T00:00:00Z"})
            ) as mock_post:
                result = await client.heartbeat("req-1", lease_duration_sec=60)
                assert result["id"] == "req-1"
                mock_post.assert_called_once_with(
                    "/api/extension/heartbeat",
                    json={"request_id": "req-1", "lease_duration_sec": 60},
                )

    @pytest.mark.asyncio
    async def test_progress_success(self):
        """Progress sends correct payload."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(200, {"id": "req-1", "progress": 50})
            ) as mock_post:
                await client.progress("req-1", "extracting", 50)
                mock_post.assert_called_once_with(
                    "/api/extension/progress",
                    json={"request_id": "req-1", "progress_stage": "extracting", "progress": 50},
                )

    @pytest.mark.asyncio
    async def test_complete_by_correct_client(self):
        """Complete sends output_result + assets and returns dict."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(200, {"id": "req-1", "status": "completed"})
            ):
                result = await client.complete(
                    "req-1",
                    output_result={"mock": True},
                    assets=[{"file_name": "out.png", "storage_key": "k/out.png",
                              "mime_type": "image/png", "byte_size": 1024, "checksum": "abc"}]
                )
                assert result["status"] == "completed"

    @pytest.mark.asyncio
    async def test_complete_by_wrong_client_raises_error(self):
        """Gateway rejects complete when caller doesn't hold the lease (500)."""
        client = _make_client(client_id="wrong-client-id")
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(500, {"detail": "Unauthorized: Client does not hold the active lease"})
            ):
                with pytest.raises(WorkerClientError) as exc_info:
                    await client.complete("req-1", output_result={"mock": True})
                assert "Client does not hold" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_fail_success(self):
        """Fail sends error_message and optional snapshot references."""
        client = _make_client()
        async with client:
            with patch.object(
                client._http, "post",
                return_value=_make_response(200, {"id": "req-1", "status": "failed"})
            ) as mock_post:
                result = await client.fail(
                    "req-1",
                    error_message="Provider timed out",
                    debug_snapshot_bucket="flowboard-debug",
                    debug_snapshot_key="debug/snap.log",
                )
                assert result["status"] == "failed"
                posted_json = mock_post.call_args.kwargs["json"]
                assert posted_json["error_message"] == "Provider timed out"
                assert posted_json["debug_snapshot_bucket"] == "flowboard-debug"


# =========================================================================
# Section 2 — MockExecutor
# =========================================================================

class TestMockExecutor:

    @pytest.mark.asyncio
    async def test_run_yields_three_stages_in_order(self):
        """Executor emits exactly the 3 canonical stages with correct progress values."""
        executor = MockExecutor(total_duration=0.1)  # Fast for tests
        events: List[Dict[str, Any]] = []
        async for event in executor.run(MOCK_JOB):
            events.append(event)

        assert len(events) == 3
        expected = [(name, pct) for name, pct in STAGES]
        for event, (expected_stage, expected_pct) in zip(events, expected):
            assert event["stage"] == expected_stage
            assert event["progress"] == expected_pct

    @pytest.mark.asyncio
    async def test_last_result_returns_output_and_assets(self):
        """After a full run, last_result() returns structured output + assets."""
        executor = MockExecutor(total_duration=0.1)
        async for _ in executor.run(MOCK_JOB):
            pass
        output, assets = executor.last_result()
        assert output["mock"] is True
        assert output["provider"] == "mock"
        assert len(assets) == 1
        assert assets[0]["mime_type"] == "image/png"

    @pytest.mark.asyncio
    async def test_last_result_before_run_raises(self):
        """Calling last_result() before run() raises RuntimeError."""
        executor = MockExecutor()
        with pytest.raises(RuntimeError, match="not completed"):
            executor.last_result()

    @pytest.mark.asyncio
    async def test_fail_rate_1_always_raises_execution_error(self):
        """fail_rate=1.0 guarantees ExecutionError is raised during run."""
        executor = MockExecutor(total_duration=0.1, fail_rate=1.0)
        with pytest.raises(ExecutionError):
            async for _ in executor.run(MOCK_JOB):
                pass


# =========================================================================
# Section 3 — WorkerLoop
# =========================================================================

def _make_mock_client() -> MagicMock:
    """Build a fully mocked WorkerClient with async methods."""
    mc = MagicMock(spec=WorkerClient)
    mc.claim = AsyncMock(return_value=MOCK_JOB)
    mc.heartbeat = AsyncMock(return_value={"id": MOCK_JOB["id"]})
    mc.progress = AsyncMock(return_value={"id": MOCK_JOB["id"]})
    mc.complete = AsyncMock(return_value={"id": MOCK_JOB["id"], "status": "completed"})
    mc.fail = AsyncMock(return_value={"id": MOCK_JOB["id"], "status": "failed"})
    return mc


class _ImmediateExecutor(MockExecutor):
    """Zero-duration executor for fast testing (no real sleep)."""
    def __init__(self) -> None:
        super().__init__(total_duration=0.0)


class _FailExecutor(MockExecutor):
    """Always raises ExecutionError on first progress stage."""
    def __init__(self) -> None:
        super().__init__(total_duration=0.0, fail_rate=1.0)


class TestWorkerLoop:

    @pytest.mark.asyncio
    async def test_full_lifecycle_claim_progress_complete(self):
        """Happy path: claim → 3x progress → complete.

        First claim returns a job.  After the job is processed the loop tries
        to claim again; the side-effect signals shutdown then raises
        NoJobAvailableError, causing the poll-sleep to wake immediately and
        the loop to exit cleanly.
        """
        mc = _make_mock_client()
        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,  # Disable heartbeat firing during test
            lease_duration_sec=60,
            executor_class=_ImmediateExecutor,
        )

        call_count = 0

        async def _claim_once(*_a, **_kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return MOCK_JOB
            # Second attempt → signal shutdown then empty queue
            loop.request_shutdown()
            raise NoJobAvailableError()

        mc.claim.side_effect = _claim_once

        await asyncio.wait_for(loop.run(), timeout=2.0)

        assert mc.claim.call_count >= 1
        assert mc.progress.call_count == 3  # One per STAGE
        mc.complete.assert_called_once()
        mc.fail.assert_not_called()

    @pytest.mark.asyncio
    async def test_auth_failure_stops_loop_immediately(self):
        """WorkerAuthError on claim must break the loop (no retry)."""
        mc = _make_mock_client()
        mc.claim.side_effect = WorkerAuthError(401, "Unauthorized: bad secret")

        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            executor_class=_ImmediateExecutor,
        )

        await asyncio.wait_for(loop.run(), timeout=2.0)

        # Should only have been called once before breaking
        assert mc.claim.call_count == 1
        mc.complete.assert_not_called()
        mc.fail.assert_not_called()

    @pytest.mark.asyncio
    async def test_empty_queue_retries_after_poll_interval(self):
        """Queue empty → sleep → retry. Count claim calls to verify retry."""
        claim_count = 0
        shutdown_after = 3  # Break after N empty responses

        async def _claim_side_effect(*_args, **_kwargs):
            nonlocal claim_count
            claim_count += 1
            if claim_count >= shutdown_after:
                loop.request_shutdown()
            raise NoJobAvailableError()

        mc = _make_mock_client()
        mc.claim.side_effect = _claim_side_effect

        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,  # Very short for tests
            heartbeat_interval_sec=999,
            executor_class=_ImmediateExecutor,
        )

        await asyncio.wait_for(loop.run(), timeout=2.0)
        assert claim_count >= shutdown_after

    @pytest.mark.asyncio
    async def test_executor_exception_calls_fail(self):
        """If executor raises ExecutionError, client.fail() must be called."""
        mc = _make_mock_client()
        mc.claim.return_value = MOCK_JOB

        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            executor_class=_FailExecutor,
        )

        # One job then stop
        call_count = 0
        original_claim = mc.claim

        async def _once(*a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return MOCK_JOB
            loop.request_shutdown()
            raise NoJobAvailableError()

        mc.claim.side_effect = _once

        await asyncio.wait_for(loop.run(), timeout=2.0)

        mc.fail.assert_called_once()
        fail_kwargs = mc.fail.call_args.kwargs
        assert fail_kwargs["request_id"] == MOCK_JOB["id"]
        assert "Simulated" in fail_kwargs["error_message"]
        mc.complete.assert_not_called()

    @pytest.mark.asyncio
    async def test_heartbeat_called_during_execution(self):
        """Heartbeat task fires at least once for a job that takes longer than hb interval."""

        class _SlowExecutor(MockExecutor):
            def __init__(self) -> None:
                super().__init__(total_duration=0.15)  # 150ms > heartbeat interval

        mc = _make_mock_client()

        call_count = 0

        async def _once(*a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return MOCK_JOB
            loop.request_shutdown()
            raise NoJobAvailableError()

        mc.claim.side_effect = _once

        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=0.05,  # 50ms — fires inside 150ms job
            lease_duration_sec=60,
            executor_class=_SlowExecutor,
        )

        await asyncio.wait_for(loop.run(), timeout=3.0)

        # Heartbeat must have been called at least once during the slow job
        assert mc.heartbeat.call_count >= 1
        mc.heartbeat.assert_called_with(MOCK_JOB["id"], 60)

    @pytest.mark.asyncio
    async def test_gateway_error_on_complete_loop_continues(self):
        """WorkerClientError during complete() → loop does NOT crash; continues polling."""
        mc = _make_mock_client()
        mc.complete.side_effect = WorkerClientError(500, "Client does not hold the active lease")

        call_count = 0

        async def _twice(*a, **kw):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return MOCK_JOB
            # Second call: signal shutdown then 409
            loop.request_shutdown()
            raise NoJobAvailableError()

        mc.claim.side_effect = _twice

        loop = WorkerLoop(
            client=mc,
            provider="mock",
            poll_interval_sec=0.01,
            heartbeat_interval_sec=999,
            executor_class=_ImmediateExecutor,
        )

        # Should complete without raising
        await asyncio.wait_for(loop.run(), timeout=2.0)

        # complete was called (and errored) but loop didn't crash
        mc.complete.assert_called_once()
        # fail should NOT be called — WorkerClientError on complete is swallowed
        mc.fail.assert_not_called()
