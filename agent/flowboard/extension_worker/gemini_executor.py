"""GeminiExecutor — executes text generation tasks via Gemini.

Implements BaseExecutor protocol and abstracts driver interaction via GeminiDriver.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from flowboard.extension_worker.base_executor import BaseExecutor, ProgressEvent
from flowboard.extension_worker.mock_executor import ExecutionError

logger = logging.getLogger(__name__)


class GeminiDriver:
    """Mockable adapter for interacting with Gemini.

    In future phases, this will implement browser automation or direct CDP/API calls.
    """

    async def generate(self, prompt: str, timeout: float = 30.0) -> Dict[str, Any]:
        """Perform text generation.

        Should return a dictionary containing at least:
            {"text": str, "model": Optional[str], "raw": Optional[Any]}
        """
        raise NotImplementedError("Real browser driver to be implemented in a subsequent phase")


class GeminiExecutor(BaseExecutor):
    """Executes Gemini text generation requests.

    Conforms to the BaseExecutor protocol.
    """

    def __init__(self, driver: Optional[GeminiDriver] = None, timeout_sec: float = 30.0) -> None:
        self._driver = driver or GeminiDriver()
        self._timeout_sec = timeout_sec
        self._output: Optional[Dict[str, Any]] = None
        self._assets: Optional[List[Dict[str, Any]]] = None

    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        request_id = job.get("id", "unknown")
        input_data = job.get("input_data", {})

        # 1. Validate prompt
        if not input_data or "prompt" not in input_data:
            logger.error("job=%s reason=missing_prompt", request_id)
            raise ExecutionError("Missing required field 'prompt' in input_data")

        prompt = input_data["prompt"]
        if not isinstance(prompt, str) or not prompt.strip():
            logger.error("job=%s reason=empty_prompt", request_id)
            raise ExecutionError("Required field 'prompt' is empty or invalid string type")

        # 2. Redact sensitive prompt in logs
        prompt_len = len(prompt)
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        logger.info(
            "job=%s event=gemini_start prompt_len=%d prompt_hash=%s",
            request_id, prompt_len, prompt_hash
        )

        start_time = time.monotonic()

        # Stage 1: submitting
        yield {"stage": "submitting", "progress": 20, "message": "Initializing Gemini driver session"}
        await asyncio.sleep(0.01)  # cooperative yield

        # Stage 2: waiting_provider
        yield {"stage": "waiting_provider", "progress": 60, "message": "Generating text response from Gemini"}

        try:
            # Enforce timeout guard
            res = await asyncio.wait_for(
                self._driver.generate(prompt, timeout=self._timeout_sec),
                timeout=self._timeout_sec
            )
        except asyncio.TimeoutError:
            logger.error("job=%s reason=provider_timeout", request_id)
            raise ExecutionError(f"Gemini execution timed out after {self._timeout_sec}s")
        except asyncio.CancelledError:
            logger.warning("job=%s event=gemini_cancelled", request_id)
            raise
        except Exception as exc:
            logger.error("job=%s reason=driver_error error=%s", request_id, exc)
            raise ExecutionError(f"Gemini driver encountered error: {exc}")

        # 3. Validate response
        if not isinstance(res, dict):
            logger.error("job=%s reason=malformed_response", request_id)
            raise ExecutionError("Malformed response from Gemini driver: response is not a dict")

        if "text" not in res or res["text"] is None or not str(res["text"]).strip():
            logger.error("job=%s reason=missing_text", request_id)
            raise ExecutionError("Malformed response from Gemini driver: missing, null, or empty 'text' key")

        # Stage 3: extracting
        yield {"stage": "extracting", "progress": 90, "message": "Extracting generated content"}
        await asyncio.sleep(0.01)

        self._output = {
            "provider": "gemini",
            "text": res["text"],
            "model": res.get("model", "gemini-unknown"),
            "raw": res.get("raw"),
        }
        self._assets = []  # No assets generated for direct text generation scaffold

        elapsed = time.monotonic() - start_time
        logger.info("job=%s event=gemini_success elapsed=%.2fs", request_id, elapsed)

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        if self._output is None:
            raise RuntimeError("GeminiExecutor has not completed successfully yet.")
        return self._output, self._assets
