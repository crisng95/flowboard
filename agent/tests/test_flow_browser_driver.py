"""Unit tests for FlowAPIDriver — Flow extension bridge driver.

All tests mock FlowClient and httpx — no real browser, network, or extension
needed. Covers the full failure surface of FlowAPIDriver.generate_assets().
"""
from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flowboard.extension_worker.flow_api_driver import (
    FlowAPIDriver,
    FlowAPIDriverError,
)

# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

TINY_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00"
    b"\x00\rIDATx\x9cc`\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
TINY_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 10

FIFE_URL = "https://flow-content.google/image/abc123?Expires=9999&Signature=sig"


def _make_client(connected: bool = True, tier: Optional[str] = "PAYGATE_TIER_ONE") -> MagicMock:
    client = MagicMock()
    client.connected = connected
    client.paygate_tier = tier
    return client


def _make_sdk(
    project_id: Optional[str] = "proj-abc",
    project_error: Optional[str] = None,
    media_entries: Optional[list] = None,
    gen_error: Optional[str] = None,
) -> MagicMock:
    sdk = AsyncMock()
    if project_error:
        sdk.create_project.return_value = {"error": project_error, "raw": {}}
    else:
        sdk.create_project.return_value = {"project_id": project_id, "raw": {}}

    if gen_error:
        sdk.gen_image.return_value = {"error": gen_error, "raw": {}}
    else:
        entries = media_entries if media_entries is not None else [
            {"media_id": "media-1", "url": FIFE_URL, "mediaType": "image"}
        ]
        sdk.gen_image.return_value = {
            "media_ids": ["media-1"],
            "media_entries": entries,
            "raw": {},
        }
    return sdk


def _make_httpx_response(status: int = 200, content: bytes = TINY_PNG, ct: str = "image/png") -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.content = content
    resp.headers = {"content-type": ct}
    return resp


async def _run(coro):
    return await coro


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFlowAPIDriverExtensionGate:
    def test_not_connected_raises(self):
        client = _make_client(connected=False)
        driver = FlowAPIDriver(client=client)

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK"):
                with pytest.raises(FlowAPIDriverError, match="not connected"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())


class TestFlowAPIDriverProjectCreation:
    def test_create_project_error_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(project_error="network_failure")

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="create_project returned error"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_create_project_no_project_id_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(project_id=None)

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="no project_id"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())


class TestFlowAPIDriverGenImage:
    def test_gen_image_api_error_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(gen_error="PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED")

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="gen_image API error"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_no_media_entries_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(media_entries=[])

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="no media entries"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_no_fife_url_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(media_entries=[{"media_id": "m1", "url": None, "mediaType": "image"}])

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="no fifeUrl"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_disallowed_url_scheme_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk(media_entries=[{
            "media_id": "m1",
            "url": "http://evil.com/img.png",  # http not https
            "mediaType": "image",
        }])

        async def run():
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with pytest.raises(FlowAPIDriverError, match="disallowed scheme"):
                    await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())


class TestFlowAPIDriverDownload:
    def test_download_http_error_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk()

        async def run():
            mock_resp = _make_httpx_response(status=403)
            mock_async_cm = AsyncMock()
            mock_async_cm.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
            mock_async_cm.__aexit__ = AsyncMock(return_value=False)

            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    with pytest.raises(FlowAPIDriverError, match="HTTP 403"):
                        await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_size_exceeded_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk()
        big_content = b"\x89PNG\r\n\x1a\n" + b"x" * (26 * 1024 * 1024)  # > 25 MB

        async def run():
            mock_resp = _make_httpx_response(content=big_content)
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    with pytest.raises(FlowAPIDriverError, match="25 MB"):
                        await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())

    def test_unknown_mime_raises(self):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk()
        binary_content = b"\x00\x01\x02\x03garbage"  # not PNG/JPEG/MP4

        async def run():
            mock_resp = _make_httpx_response(content=binary_content, ct="application/octet-stream")
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    with pytest.raises(FlowAPIDriverError, match="MIME"):
                        await driver.generate_assets("prompt", "user-1", "req-1")

        asyncio.run(run())


class TestFlowAPIDriverSuccess:
    def _run_success(self, content: bytes, ct: str):
        client = _make_client()
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk()

        async def run():
            mock_resp = _make_httpx_response(content=content, ct=ct)
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    return await driver.generate_assets("a test prompt", "user-1", "req-abc")

        return asyncio.run(run())

    def test_png_asset_success(self):
        assets = self._run_success(TINY_PNG, "image/png")
        assert len(assets) == 1
        a = assets[0]
        assert a["mime_type"] == "image/png"
        assert a["file_name"] == "flow_output.png"
        assert a["source_provider"] == "flow"
        assert a["byte_size"] == len(TINY_PNG)
        assert a["checksum"] == hashlib.sha256(TINY_PNG).hexdigest()
        assert a["storage_key"].startswith("users/user-1/flow/req-abc/")
        assert a["prompt_snapshot"] == "a test prompt"
        assert a["content_bytes"] == TINY_PNG

    def test_jpeg_asset_success(self):
        assets = self._run_success(TINY_JPEG, "image/jpeg")
        assert assets[0]["mime_type"] == "image/jpeg"
        assert assets[0]["file_name"] == "flow_output.jpg"

    def test_paygate_tier_cold_start_defaults_to_tier_one(self):
        """Extension hasn't pushed a tier yet — should default without crashing."""
        client = _make_client(tier=None)
        driver = FlowAPIDriver(client=client)
        sdk = _make_sdk()

        async def run():
            mock_resp = _make_httpx_response(content=TINY_PNG)
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    assets = await driver.generate_assets("prompt", "user-1", "req-1")
            # Should use PAYGATE_TIER_ONE default
            call_kwargs = sdk.gen_image.call_args
            assert call_kwargs.kwargs["paygate_tier"] == "PAYGATE_TIER_ONE"
            return assets

        asyncio.run(run())

    def test_override_tier_used_over_client_tier(self):
        """override tier on constructor takes precedence over client.paygate_tier."""
        client = _make_client(tier="PAYGATE_TIER_ONE")
        driver = FlowAPIDriver(client=client, paygate_tier="PAYGATE_TIER_TWO")
        sdk = _make_sdk()

        async def run():
            mock_resp = _make_httpx_response(content=TINY_PNG)
            with patch("flowboard.extension_worker.flow_api_driver.FlowSDK", return_value=sdk):
                with patch("flowboard.extension_worker.flow_api_driver.httpx.AsyncClient") as mock_client:
                    mock_client.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(get=AsyncMock(return_value=mock_resp)))
                    mock_client.return_value.__aexit__ = AsyncMock(return_value=False)
                    await driver.generate_assets("prompt", "user-1", "req-1")
            call_kwargs = sdk.gen_image.call_args
            assert call_kwargs.kwargs["paygate_tier"] == "PAYGATE_TIER_TWO"

        asyncio.run(run())
