"""FlowExecutor — executes visual generation tasks via Flow engine.

Implements BaseExecutor protocol and abstracts driver interaction via FlowDriver.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from flowboard.extension_worker.base_executor import BaseExecutor, ProgressEvent
from flowboard.extension_worker.mock_executor import ExecutionError
from flowboard.extension_worker.asset_uploader import AssetUploader

logger = logging.getLogger(__name__)

CHECKSUM_REGEX = re.compile(r"^[a-fA-F0-9]{64}$")
CONTROL_CHARS_REGEX = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class FlowDriver:
    """Mock driver for Flow provider to simulate visual generation."""

    def __init__(self, simulate_delay_sec: float = 0.05) -> None:
        self.simulate_delay_sec = simulate_delay_sec

    async def generate_assets(
        self,
        prompt: str,
        user_id: str,
        request_id: str,
        timeout: float = 30.0,
        input_data: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Mock asset generation yielding standard metadata matching the assets schema.

        Can be overridden or mocked in tests to trigger timeout or malformed payloads.
        """
        # Cooperative sleep to simulate generation
        await asyncio.sleep(self.simulate_delay_sec)

        # Generate a stable checksum hash from prompt for testing
        checksum = hashlib.sha256(prompt.encode("utf-8")).hexdigest()

        # Simulated transparent 1px PNG content bytes
        tiny_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"

        return [
            {
                "source_provider": "flow",
                "file_name": "flow_result.png",
                "storage_key": f"users/{user_id}/flow/{request_id}/output-0.png",
                "mime_type": "image/png",
                "byte_size": len(tiny_png),
                "checksum": checksum,
                "prompt_snapshot": prompt,
                "content_bytes": tiny_png,
            }
        ]


class FlowExecutor(BaseExecutor):
    """Executes Flow visual generation requests.

    Conforms to the BaseExecutor protocol.
    """

    def __init__(
        self,
        driver: Optional[FlowDriver] = None,
        uploader: Optional[AssetUploader] = None,
        timeout_sec: float = 30.0
    ) -> None:
        self._driver = driver or FlowDriver()
        self._uploader = uploader
        self._timeout_sec = timeout_sec
        self._output: Optional[Dict[str, Any]] = None
        self._assets: Optional[List[Dict[str, Any]]] = None

    async def run(self, job: Dict[str, Any]) -> AsyncGenerator[ProgressEvent, None]:
        request_id = job.get("id", "unknown")
        user_id = job.get("user_id")
        input_data = job.get("input_data", {})
        task_type = job.get("task_type", "txt2img")

        # 1. Enforce user_id requirement
        if not user_id or not isinstance(user_id, str) or not user_id.strip():
            logger.error("job=%s reason=missing_user_id", request_id)
            raise ExecutionError("Missing or invalid user_id in job payload. Cannot generate secure storage keys.")

        # 2. Validate prompt
        if not input_data or "prompt" not in input_data:
            logger.error("job=%s reason=missing_prompt", request_id)
            raise ExecutionError("Missing required field 'prompt' in input_data")

        prompt = input_data["prompt"]
        if not isinstance(prompt, str) or not prompt.strip():
            logger.error("job=%s reason=empty_prompt", request_id)
            raise ExecutionError("Required field 'prompt' is empty or invalid string type")

        # 3. Redact prompt in logs
        prompt_len = len(prompt)
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        logger.info(
            "job=%s event=flow_start prompt_len=%d prompt_hash=%s",
            request_id, prompt_len, prompt_hash
        )

        start_time = time.monotonic()

        # Stage 1: preparing
        yield {"stage": "preparing", "progress": 10, "message": "Parsing Flow references and input parameters"}
        await asyncio.sleep(0.01)

        # Stage 2: submitting
        yield {"stage": "submitting", "progress": 30, "message": "Submitting task to visual generation engine"}
        await asyncio.sleep(0.01)

        # Stage 3: waiting_provider
        yield {"stage": "waiting_provider", "progress": 60, "message": "Generating visual assets via Flow engine"}

        try:
            # Enforce timeout guard
            raw_assets = await asyncio.wait_for(
                self._driver.generate_assets(
                    prompt,
                    user_id,
                    request_id,
                    timeout=self._timeout_sec,
                    input_data=input_data,
                ),
                timeout=self._timeout_sec
            )
        except asyncio.TimeoutError:
            logger.error("job=%s reason=provider_timeout", request_id)
            raise ExecutionError(f"Flow execution timed out after {self._timeout_sec}s")
        except asyncio.CancelledError:
            logger.warning("job=%s event=flow_cancelled", request_id)
            raise
        except Exception as exc:
            logger.error("job=%s reason=driver_error error=%s", request_id, exc)
            raise ExecutionError(f"Flow driver encountered error: {exc}")

        # Stage 4: extracting
        yield {"stage": "extracting", "progress": 80, "message": "Extracting generated assets and metadata"}
        await asyncio.sleep(0.01)

        # 4. Validate driver response assets
        if not isinstance(raw_assets, list):
            logger.error("job=%s reason=malformed_assets_type", request_id)
            raise ExecutionError("Malformed response from Flow driver: assets result is not a list")

        if not raw_assets:
            logger.error("job=%s reason=empty_asset_list", request_id)
            raise ExecutionError("Flow driver returned an empty asset list. No assets generated.")

        required_keys = ["source_provider", "file_name", "storage_key", "mime_type", "byte_size", "checksum"]
        validated_assets = []
        allowed_mimes = {"image/png", "image/jpeg", "video/mp4"}
        prefix = f"users/{user_id}/flow/{request_id}/"

        for index, asset in enumerate(raw_assets):
            if not isinstance(asset, dict):
                logger.error("job=%s reason=malformed_asset_item index=%d", request_id, index)
                raise ExecutionError(f"[asset index {index}] Malformed asset item: item is not a dict")

            # Check missing keys
            missing_keys = [key for key in required_keys if key not in asset]
            if missing_keys:
                logger.error("job=%s reason=missing_asset_keys index=%d missing=%s", request_id, index, missing_keys)
                raise ExecutionError(f"[asset index {index}] Malformed asset item: missing required keys {missing_keys}")

            # Extract fields
            source_provider = asset["source_provider"]
            file_name = asset["file_name"]
            storage_key = asset["storage_key"]
            mime_type = asset["mime_type"]
            byte_size = asset["byte_size"]
            checksum = asset["checksum"]
            prompt_snapshot = asset.get("prompt_snapshot")

            # A. Validate source_provider
            if source_provider != "flow":
                logger.error("job=%s reason=invalid_source_provider index=%d value=%s", request_id, index, source_provider)
                raise ExecutionError(f"[asset index {index}] Invalid source_provider: must be 'flow', got '{source_provider}'")

            # B. Validate storage_key prefix & traversal attempts
            if not isinstance(storage_key, str) or not storage_key.startswith(prefix):
                logger.error("job=%s reason=invalid_storage_key_prefix index=%d", request_id, index)
                raise ExecutionError(f"[asset index {index}] Invalid storage_key: must start with '{prefix}'")

            if any(bad in storage_key for bad in ["..", "\\", "//"]) or storage_key.startswith("/") or CONTROL_CHARS_REGEX.search(storage_key):
                logger.error("job=%s reason=dangerous_storage_key index=%d", request_id, index)
                raise ExecutionError(f"[asset index {index}] Invalid storage_key: contains path traversal or forbidden characters")

            # C. Validate file_name
            if not isinstance(file_name, str) or not file_name.strip() or any(bad in file_name for bad in ["/", "\\"]) or CONTROL_CHARS_REGEX.search(file_name):
                logger.error("job=%s reason=invalid_file_name index=%d", request_id, index)
                raise ExecutionError(f"[asset index {index}] Invalid file_name: cannot be empty or contain slash/backslash/control characters")

            # D. Validate mime_type
            if mime_type not in allowed_mimes:
                logger.error("job=%s reason=unsupported_mime_type index=%d value=%s", request_id, index, mime_type)
                raise ExecutionError(f"[asset index {index}] Unsupported mime_type: must be image/png, image/jpeg, or video/mp4, got '{mime_type}'")

            # E. Validate byte_size
            if not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size < 0:
                logger.error("job=%s reason=invalid_byte_size index=%d value=%s", request_id, index, byte_size)
                raise ExecutionError(f"[asset index {index}] Invalid byte_size: must be an integer >= 0, got '{byte_size}'")

            # F. Validate and normalize checksum
            if not isinstance(checksum, str) or not CHECKSUM_REGEX.match(checksum):
                logger.error("job=%s reason=invalid_checksum index=%d", request_id, index)
                raise ExecutionError(f"[asset index {index}] Invalid checksum: must be a 64-character SHA-256 hex string")
            normalized_checksum = checksum.lower()

            # G. Normalize prompt_snapshot (privacy policy)
            normalized_prompt = None
            if prompt_snapshot is not None:
                if isinstance(prompt_snapshot, str):
                    cleaned = prompt_snapshot.strip()
                    cleaned = CONTROL_CHARS_REGEX.sub("", cleaned)
                    if cleaned:
                        if len(cleaned) > 256:
                            normalized_prompt = cleaned[:256] + "..."
                        else:
                            normalized_prompt = cleaned
                else:
                    logger.error("job=%s reason=invalid_prompt_snapshot_type index=%d", request_id, index)
                    raise ExecutionError(f"[asset index {index}] Invalid prompt_snapshot: must be a string or None")

            validated_assets.append({
                "source_provider": source_provider,
                "file_name": file_name,
                "storage_key": storage_key,
                "mime_type": mime_type,
                "byte_size": byte_size,
                "checksum": normalized_checksum,
                "prompt_snapshot": normalized_prompt,
            })

        # Stage 5: uploading
        yield {"stage": "uploading", "progress": 95, "message": "Synchronizing visual assets to storage"}
        
        # If real uploader integration is configured, execute real upload pipeline
        if self._uploader:
            uploaded_assets = []
            for index, asset in enumerate(validated_assets):
                raw_asset = raw_assets[index]
                content_bytes = raw_asset.get("content_bytes")
                local_path = raw_asset.get("local_path")
                
                if content_bytes is not None and local_path is not None:
                    logger.error("job=%s reason=ambiguous_upload_source index=%d", request_id, index)
                    raise ExecutionError(f"[asset index {index}] Ambiguous upload source: raw asset must provide either 'content_bytes' or 'local_path', not both")
                
                if content_bytes is None and local_path is None:
                    logger.error("job=%s reason=missing_upload_source index=%d", request_id, index)
                    raise ExecutionError(f"[asset index {index}] Missing upload source: raw asset must provide either 'content_bytes' or 'local_path'")
                
                upload_source = content_bytes if content_bytes is not None else local_path
                
                # Perform the R2 upload through our secure uploader boundary
                up_metadata = await self._uploader.upload(
                    file_path_or_bytes=upload_source,
                    storage_key=asset["storage_key"],
                    mime_type=asset["mime_type"],
                    file_name=asset["file_name"],
                    prompt_snapshot=asset.get("prompt_snapshot")
                )
                uploaded_assets.append(up_metadata)
            validated_assets = uploaded_assets
        else:
            # Otherwise yield mock cooperative delay to sustain UX progress
            await asyncio.sleep(0.01)

        media_ids = [a.get("media_id") for a in raw_assets if isinstance(a.get("media_id"), str)]
        project_ids = [a.get("project_id") for a in raw_assets if isinstance(a.get("project_id"), str)]
        self._output = {
            "provider": "flow",
            "task_type": task_type,
            "asset_count": len(validated_assets),
            "mock": self._uploader is None,
        }
        if media_ids:
            self._output["media_ids"] = media_ids
        if project_ids:
            self._output["project_id"] = project_ids[0]
        self._assets = validated_assets

        elapsed = time.monotonic() - start_time
        logger.info("job=%s event=flow_success elapsed=%.2fs", request_id, elapsed)

    def last_result(self) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        if self._output is None or self._assets is None:
            raise RuntimeError("FlowExecutor has not completed successfully yet.")
        return self._output, self._assets
