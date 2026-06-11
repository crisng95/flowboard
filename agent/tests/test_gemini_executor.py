"""Unit tests for Phase 4.2B: Gemini Executor Driver Scaffold."""
from __future__ import annotations

import asyncio
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flowboard.extension_worker.gemini_executor import GeminiDriver, GeminiExecutor
from flowboard.extension_worker.mock_executor import ExecutionError

MOCK_JOB_SUCCESS = {
    "id": "gemini-job-1",
    "input_data": {"prompt": "Tell me a joke"},
}

MOCK_JOB_MISSING = {
    "id": "gemini-job-2",
    "input_data": {},
}

MOCK_JOB_EMPTY = {
    "id": "gemini-job-3",
    "input_data": {"prompt": "   "},
}

MOCK_JOB_EMPTY_WITH_ATTACHMENTS = {
    "id": "gemini-job-4",
    "input_data": {"prompt": "  ", "attachments": [{"mimeType": "image/png", "data": "QUJD"}]},
}


class FakeGeminiDriver(GeminiDriver):
    """Test driver simulating success, timeout, or errors."""

    def __init__(
        self,
        response_dict: Optional[Dict[str, Any]] = None,
        should_timeout: bool = False,
        should_error: bool = False,
        delay_sec: float = 0.0,
    ) -> None:
        self.response = response_dict or {"text": "A funny joke", "model": "gemini-pro"}
        self.should_timeout = should_timeout
        self.should_error = should_error
        self.delay = delay_sec

    async def generate(self, prompt: str, timeout: float = 30.0) -> Dict[str, Any]:
        if self.delay > 0:
            await asyncio.sleep(self.delay)

        if self.should_timeout:
            # Sleep longer than timeout to trigger asyncio.TimeoutError
            await asyncio.sleep(timeout + 1.0)
            raise asyncio.TimeoutError()

        if self.should_error:
            raise RuntimeError("Fake connection error")

        return self.response


class TestGeminiExecutor:

    @pytest.mark.asyncio
    async def test_success_path_yields_stages(self):
        """Happy path: executor yields stages, driver completes, last_result is correct."""
        driver = FakeGeminiDriver()
        executor = GeminiExecutor(driver=driver)

        events = []
        async for event in executor.run(MOCK_JOB_SUCCESS):
            events.append(event)

        # Should yield at least submitting, waiting_provider, extracting
        stages = [e["stage"] for e in events]
        assert "submitting" in stages
        assert "waiting_provider" in stages
        assert "extracting" in stages

        output, assets = executor.last_result()
        assert output["provider"] == "gemini"
        assert output["text"] == "A funny joke"
        assert output["model"] == "gemini-pro"
        assert assets == []

    @pytest.mark.asyncio
    async def test_missing_prompt_raises_execution_error(self):
        """Missing or empty prompt raises controlled ExecutionError."""
        executor = GeminiExecutor()

        with pytest.raises(ExecutionError, match="Missing required field 'prompt'"):
            async for _ in executor.run(MOCK_JOB_MISSING):
                pass

        with pytest.raises(ExecutionError, match="prompt' is empty or invalid"):
            async for _ in executor.run(MOCK_JOB_EMPTY):
                pass

    @pytest.mark.asyncio
    async def test_empty_prompt_with_attachments_succeeds(self):
        """Empty prompt is allowed if attachments are present."""
        driver = FakeGeminiDriver()
        executor = GeminiExecutor(driver=driver)

        events = []
        async for event in executor.run(MOCK_JOB_EMPTY_WITH_ATTACHMENTS):
            events.append(event)

        output, assets = executor.last_result()
        assert output["text"] == "A funny joke"

    @pytest.mark.asyncio
    async def test_provider_timeout_raises_execution_error(self):
        """Executor wraps TimeoutError in controlled ExecutionError."""
        # Config timeout to be short for fast tests
        driver = FakeGeminiDriver(should_timeout=True)
        executor = GeminiExecutor(driver=driver, timeout_sec=0.05)

        with pytest.raises(ExecutionError, match="execution timed out after"):
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

    @pytest.mark.asyncio
    async def test_driver_error_raises_execution_error(self):
        """Executor wraps generic driver exceptions in controlled ExecutionError."""
        driver = FakeGeminiDriver(should_error=True)
        executor = GeminiExecutor(driver=driver)

        with pytest.raises(ExecutionError, match="Gemini driver encountered error"):
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

    @pytest.mark.asyncio
    async def test_malformed_response_raises_execution_error(self):
        """Malformed or empty dict/text from driver raises controlled ExecutionError."""
        # 1. Non-dict response
        driver_non_dict = FakeGeminiDriver(response_dict="not-a-dict")  # type: ignore
        executor = GeminiExecutor(driver=driver_non_dict)
        with pytest.raises(ExecutionError, match="response is not a dict"):
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

        # 2. Missing text key
        driver_no_text = FakeGeminiDriver(response_dict={"model": "gemini-pro"})
        executor = GeminiExecutor(driver=driver_no_text)
        with pytest.raises(ExecutionError, match="missing, null, or empty 'text' key"):
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

        # 3. Empty/whitespace text key
        driver_empty_text = FakeGeminiDriver(response_dict={"text": "   ", "model": "gemini-pro"})
        executor = GeminiExecutor(driver=driver_empty_text)
        with pytest.raises(ExecutionError, match="missing, null, or empty 'text' key"):
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

    @pytest.mark.asyncio
    async def test_cancellation_propagates(self):
        """CancelledError propagates cleanly without being swallowed."""
        # Driver takes 1s; we cancel the run task after 0.05s
        driver = FakeGeminiDriver(delay_sec=1.0)
        executor = GeminiExecutor(driver=driver, timeout_sec=5.0)

        async def run_task():
            async for _ in executor.run(MOCK_JOB_SUCCESS):
                pass

        task = asyncio.create_task(run_task())
        await asyncio.sleep(0.05)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_provider_selector_in_main(self):
        """__main__.py selects correct executor based on EXT_PROVIDER."""
        from flowboard.extension_worker.__main__ import _main
        from flowboard.extension_worker.worker_loop import WorkerLoop

        mock_loop_instance = MagicMock()
        mock_loop_instance.run = AsyncMock()

        # Patch WorkerClient to bypass real HTTP calls
        with patch("flowboard.extension_worker.__main__.WorkerClient") as mock_client_cls, \
             patch("flowboard.extension_worker.__main__.WorkerLoop", return_value=mock_loop_instance) as mock_worker_loop_cls, \
             patch("flowboard.extension_worker.__main__.EXT_PROVIDER", "gemini"), \
             patch("flowboard.extension_worker.__main__.EXT_CLIENT_ID", "dummy-id"), \
             patch("flowboard.extension_worker.__main__.EXT_PAIRING_SECRET", "dummy-secret"):

            await _main()

            # Verify the exact executor injected was GeminiExecutor
            from flowboard.extension_worker.gemini_executor import GeminiExecutor
            mock_worker_loop_cls.assert_called_once()
            called_kwargs = mock_worker_loop_cls.call_args.kwargs
            assert called_kwargs["executor_class"] == GeminiExecutor
