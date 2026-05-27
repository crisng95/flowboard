"""Unit tests for Phase 4.2G: Flow Asset Pipeline Hardening.

Verifies strict security and privacy validations for generated asset pipelines.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flowboard.extension_worker.base_executor import validate_executor_event
from flowboard.extension_worker.flow_executor import FlowDriver, FlowExecutor
from flowboard.extension_worker.mock_executor import ExecutionError


class TestFlowExecutorHardening:

    @pytest.fixture
    def basic_job(self) -> Dict[str, Any]:
        return {
            "id": "job-flow-123",
            "user_id": "user-uuid-456",
            "task_type": "txt2img",
            "input_data": {"prompt": "A scenic mountain view"},
        }

    @pytest.mark.asyncio
    async def test_valid_image_asset(self, basic_job) -> None:
        """Valid image asset passes verification successfully."""
        executor = FlowExecutor()
        async for event in executor.run(basic_job):
            validate_executor_event(event)

        output, assets = executor.last_result()
        assert output["provider"] == "flow"
        assert output["asset_count"] == 1
        assert assets[0]["mime_type"] == "image/png"

    @pytest.mark.asyncio
    async def test_valid_video_asset(self, basic_job) -> None:
        """Valid video asset (mp4) passes verification successfully."""
        class VideoDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "motion.mp4",
                    "storage_key": f"users/{user_id}/flow/{request_id}/motion.mp4",
                    "mime_type": "video/mp4",
                    "byte_size": 204800,
                    "checksum": "a" * 64,
                    "prompt_snapshot": prompt
                }]

        executor = FlowExecutor(driver=VideoDriver())
        async for event in executor.run(basic_job):
            pass

        output, assets = executor.last_result()
        assert assets[0]["mime_type"] == "video/mp4"

    @pytest.mark.asyncio
    async def test_reject_wrong_prefix(self, basic_job) -> None:
        """Reject storage keys that do not start with the strict prefix."""
        class WrongPrefixDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "motion.png",
                    "storage_key": "some/other/path/motion.png",
                    "mime_type": "image/png",
                    "byte_size": 100,
                    "checksum": "a" * 64
                }]

        executor = FlowExecutor(driver=WrongPrefixDriver())
        with pytest.raises(ExecutionError, match="Invalid storage_key: must start with"):
            async for _ in executor.run(basic_job):
                pass

    @pytest.mark.asyncio
    async def test_reject_path_traversal(self, basic_job) -> None:
        """Reject storage keys attempting path traversal or forbidden characters."""
        for dangerous_key in [
            "users/user-uuid-456/flow/job-flow-123/../../hacked.png",
            "users/user-uuid-456/flow/job-flow-123/sub//folder.png",
            "users/user-uuid-456/flow/job-flow-123/back\\slash.png",
            "/users/user-uuid-456/flow/job-flow-123/output.png",
            "users/user-uuid-456/flow/job-flow-123/\0output.png"
        ]:
            class TraversalDriver(FlowDriver):
                def __init__(self, key):
                    super().__init__()
                    self.key = key

                async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                    return [{
                        "source_provider": "flow",
                        "file_name": "test.png",
                        "storage_key": self.key,
                        "mime_type": "image/png",
                        "byte_size": 100,
                        "checksum": "a" * 64
                    }]

            executor = FlowExecutor(driver=TraversalDriver(dangerous_key))
            with pytest.raises(ExecutionError, match="contains path traversal|must start with"):
                async for _ in executor.run(basic_job):
                    pass

    @pytest.mark.asyncio
    async def test_reject_bad_checksum(self, basic_job) -> None:
        """Reject checksums that are not exactly 64 characters or have non-hex characters."""
        for bad_checksum in [
            "a" * 63,
            "a" * 65,
            "z" * 64,
            "z" + ("a" * 63)
        ]:
            class ChecksumDriver(FlowDriver):
                def __init__(self, cs):
                    super().__init__()
                    self.cs = cs

                async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                    return [{
                        "source_provider": "flow",
                        "file_name": "test.png",
                        "storage_key": f"users/{user_id}/flow/{request_id}/test.png",
                        "mime_type": "image/png",
                        "byte_size": 100,
                        "checksum": self.cs
                    }]

            executor = FlowExecutor(driver=ChecksumDriver(bad_checksum))
            with pytest.raises(ExecutionError, match="Invalid checksum: must be a 64-character SHA-256 hex string"):
                async for _ in executor.run(basic_job):
                    pass

    @pytest.mark.asyncio
    async def test_checksum_uppercase_normalized_lowercase(self, basic_job) -> None:
        """Uppercase checksum is normalized to lowercase on successful validations."""
        class UpperChecksumDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "test.png",
                    "storage_key": f"users/{user_id}/flow/{request_id}/test.png",
                    "mime_type": "image/png",
                    "byte_size": 100,
                    "checksum": "A" * 64
                }]

        executor = FlowExecutor(driver=UpperChecksumDriver())
        async for _ in executor.run(basic_job):
            pass

        _, assets = executor.last_result()
        assert assets[0]["checksum"] == "a" * 64

    @pytest.mark.asyncio
    async def test_reject_unsupported_mime(self, basic_job) -> None:
        """Reject unsupported mime-types like html, exe, or text."""
        class HtmlDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "broken.html",
                    "storage_key": f"users/{user_id}/flow/{request_id}/broken.html",
                    "mime_type": "text/html",
                    "byte_size": 100,
                    "checksum": "a" * 64
                }]

        executor = FlowExecutor(driver=HtmlDriver())
        with pytest.raises(ExecutionError, match="Unsupported mime_type"):
            async for _ in executor.run(basic_job):
                pass

    @pytest.mark.asyncio
    async def test_reject_negative_non_int_byte_size(self, basic_job) -> None:
        """Reject byte sizes that are negative or non-integer."""
        for bad_size in [-1, "100", 50.5, True]:  # True is checked by isinstance(..., bool)
            class SizeDriver(FlowDriver):
                def __init__(self, size):
                    super().__init__()
                    self.size = size

                async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                    return [{
                        "source_provider": "flow",
                        "file_name": "test.png",
                        "storage_key": f"users/{user_id}/flow/{request_id}/test.png",
                        "mime_type": "image/png",
                        "byte_size": self.size,
                        "checksum": "a" * 64
                    }]

            executor = FlowExecutor(driver=SizeDriver(bad_size))
            with pytest.raises(ExecutionError, match="Invalid byte_size"):
                async for _ in executor.run(basic_job):
                    pass

    @pytest.mark.asyncio
    async def test_reject_bad_file_name(self, basic_job) -> None:
        """Reject file names that are empty or contain forbidden characters."""
        for bad_name in ["", "   ", "sub/folder.png", "back\\slash.png", "test\0name.png"]:
            class NameDriver(FlowDriver):
                def __init__(self, name):
                    super().__init__()
                    self.name = name

                async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                    return [{
                        "source_provider": "flow",
                        "file_name": self.name,
                        "storage_key": f"users/{user_id}/flow/{request_id}/test.png",
                        "mime_type": "image/png",
                        "byte_size": 100,
                        "checksum": "a" * 64
                    }]

            executor = FlowExecutor(driver=NameDriver(bad_name))
            with pytest.raises(ExecutionError, match="Invalid file_name"):
                async for _ in executor.run(basic_job):
                    pass

    @pytest.mark.asyncio
    async def test_prompt_snapshot_truncate_sanitize(self, basic_job) -> None:
        """Prompt snapshot strips whitespaces, removes control characters, truncates to 256, and appends ellipsis."""
        long_prompt = " \r\n" + "A" * 300 + "\x00\x1f" + "B" * 50 + " \t"
        basic_job["input_data"]["prompt"] = long_prompt

        executor = FlowExecutor()
        async for _ in executor.run(basic_job):
            pass

        _, assets = executor.last_result()
        prompt_snapshot = assets[0]["prompt_snapshot"]
        
        # Check stripping of whitespaces, control chars removal, and truncation at 256 + '...'
        assert len(prompt_snapshot) == 259
        assert prompt_snapshot.endswith("...")
        assert "A" * 256 in prompt_snapshot
        assert "\x00" not in prompt_snapshot
        assert "\x1f" not in prompt_snapshot

    @pytest.mark.asyncio
    async def test_multi_asset_index_error_message(self, basic_job) -> None:
        """In multi-asset generation, a validation error correctly points to the index of the offending item."""
        class MultiAssetDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [
                    {
                        "source_provider": "flow",
                        "file_name": "first.png",
                        "storage_key": f"users/{user_id}/flow/{request_id}/first.png",
                        "mime_type": "image/png",
                        "byte_size": 100,
                        "checksum": "a" * 64
                    },
                    {
                        "source_provider": "flow",
                        "file_name": "second.png",
                        "storage_key": f"users/{user_id}/flow/{request_id}/second.png",
                        "mime_type": "text/html",  # Offending item!
                        "byte_size": 200,
                        "checksum": "b" * 64
                    }
                ]

        executor = FlowExecutor(driver=MultiAssetDriver())
        with pytest.raises(ExecutionError, match=r"\[asset index 1\] Unsupported mime_type"):
            async for _ in executor.run(basic_job):
                pass

    @pytest.mark.asyncio
    async def test_flow_executor_with_asset_uploader_integration(self, basic_job) -> None:
        """Verify FlowExecutor correctly integrates with AssetUploader to upload generated content."""
        from flowboard.extension_worker.asset_uploader import AssetUploader
        mock_uploader = MagicMock(spec=AssetUploader)
        mock_uploader.upload = AsyncMock(return_value={
            "source_provider": "flow",
            "file_name": "flow_result.png",
            "storage_key": "users/user-uuid-456/flow/job-flow-123/output-0.png",
            "mime_type": "image/png",
            "byte_size": 55,
            "checksum": "dummy_checksum"
        })
        
        executor = FlowExecutor(uploader=mock_uploader)
        async for event in executor.run(basic_job):
            pass
            
        output, assets = executor.last_result()
        mock_uploader.upload.assert_called_once()
        assert assets[0]["checksum"] == "dummy_checksum"
        assert assets[0]["byte_size"] == 55

    @pytest.mark.asyncio
    async def test_flow_executor_uploader_rejects_missing_source(self, basic_job) -> None:
        """Verify FlowExecutor raises ExecutionError when both content_bytes and local_path are missing."""
        from flowboard.extension_worker.asset_uploader import AssetUploader
        mock_uploader = MagicMock(spec=AssetUploader)
        
        class MissingSourceDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "flow_result.png",
                    "storage_key": f"users/{user_id}/flow/{request_id}/output-0.png",
                    "mime_type": "image/png",
                    "byte_size": 100,
                    "checksum": "a" * 64,
                }]
                
        executor = FlowExecutor(driver=MissingSourceDriver(), uploader=mock_uploader)
        with pytest.raises(ExecutionError, match="Missing upload source"):
            async for _ in executor.run(basic_job):
                pass

    @pytest.mark.asyncio
    async def test_flow_executor_uploader_rejects_ambiguous_source(self, basic_job) -> None:
        """Verify FlowExecutor raises ExecutionError when both content_bytes and local_path are provided."""
        from flowboard.extension_worker.asset_uploader import AssetUploader
        mock_uploader = MagicMock(spec=AssetUploader)
        
        class AmbiguousSourceDriver(FlowDriver):
            async def generate_assets(self, prompt, user_id, request_id, timeout=30.0):
                return [{
                    "source_provider": "flow",
                    "file_name": "flow_result.png",
                    "storage_key": f"users/{user_id}/flow/{request_id}/output-0.png",
                    "mime_type": "image/png",
                    "byte_size": 100,
                    "checksum": "a" * 64,
                    "content_bytes": b"data",
                    "local_path": "/tmp/file.png"
                }]
                
        executor = FlowExecutor(driver=AmbiguousSourceDriver(), uploader=mock_uploader)
        with pytest.raises(ExecutionError, match="Ambiguous upload source"):
            async for _ in executor.run(basic_job):
                pass

    @pytest.mark.asyncio
    async def test_main_loader_selects_flow_executor(self) -> None:
        """Main loader injection picks FlowExecutor when configuration environment provider is set to flow."""
        with patch("flowboard.extension_worker.__main__.EXT_CLIENT_ID", "client-123"), \
             patch("flowboard.extension_worker.__main__.EXT_PAIRING_SECRET", "secret-456"), \
             patch("flowboard.extension_worker.__main__.EXT_PROVIDER", "flow"), \
             patch("flowboard.extension_worker.__main__.WorkerLoop") as mock_loop_class, \
             patch("flowboard.extension_worker.client.WorkerClient") as mock_client:

            mock_loop_instance = MagicMock()
            mock_loop_instance.run = AsyncMock()
            mock_loop_class.return_value = mock_loop_instance

            # Trigger __main__ run
            from flowboard.extension_worker.__main__ import _main
            await _main()

            # Ensure WorkerLoop is initialized with FlowExecutor class
            mock_loop_class.assert_called_once()
            called_args = mock_loop_class.call_args[1]
            assert called_args["provider"] == "flow"
            
            from flowboard.extension_worker.flow_executor import FlowExecutor as ActualFlowExecutor
            assert called_args["executor_class"] is ActualFlowExecutor
