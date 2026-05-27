"""FlowAPIDriver — Flow extension bridge driver.

Uses the existing FlowClient WebSocket bridge (extension keeps Bearer token,
solves reCAPTCHA) and FlowSDK (gen_image via batchGenerateImages) to generate
real Google Flow images without any DOM/Playwright interaction.

Architecture:
    FlowAPIDriver.generate_assets()
        → FlowSDK.create_project()          (TRPC, no captcha)
        → FlowSDK.gen_image()               (api_request + captcha)
        → extract fifeUrl from media_entries
        → httpx.get(fifeUrl)                (GCS signed URL, no auth)
        → sniff MIME + validate size
        → return asset dict list for FlowExecutor
"""
from __future__ import annotations

import base64
import hashlib
import logging
from typing import Any, Dict, List, Optional

import httpx

from flowboard.extension_worker.flow_executor import FlowDriver
from flowboard.services.flow_client import FlowClient
from flowboard.services.flow_sdk import FlowSDK, extract_media_entries, is_valid_project_id

logger = logging.getLogger(__name__)

# GCS signed URLs are self-contained — no auth header needed.
_ALLOWED_FIFE_PREFIXES = (
    "https://flow-content.google/",
    # Some responses use this mirror; add as discovered.
    "https://lh3.googleusercontent.com/",
)

_MAX_ASSET_BYTES = 25 * 1024 * 1024  # 25 MB hard limit
_ALLOWED_OUTPUT_MIMES = {"image/png", "image/jpeg", "video/mp4"}


class FlowAPIDriverError(RuntimeError):
    """Driver-level error — surfaced as job failure to WorkerLoop."""


class FlowAPIDriver(FlowDriver):
    """Real Flow image driver via extension bridge (no DOM automation).

    Requires the Chrome extension to be connected and holding a live
    Bearer token before ``generate_assets`` is called.
    """

    def __init__(
        self,
        client: FlowClient,
        paygate_tier: Optional[str] = None,
        image_model: Optional[str] = None,
        download_timeout_sec: float = 60.0,
    ) -> None:
        super().__init__()
        self._client = client
        # Resolved from client.paygate_tier at call time; default TIER_ONE
        # if extension hasn't pushed tier yet (cold start warning logged).
        self._override_tier = paygate_tier
        self._image_model = image_model
        self._download_timeout = download_timeout_sec

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _resolve_tier(self) -> str:
        if self._override_tier:
            return self._override_tier
        tier = self._client.paygate_tier
        if tier:
            return tier
        logger.warning(
            "[flow-api-driver] paygate_tier not yet resolved from extension "
            "(cold start); defaulting to PAYGATE_TIER_ONE"
        )
        return "PAYGATE_TIER_ONE"

    def _sniff_mime(self, content_bytes: bytes) -> Optional[str]:
        if content_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if content_bytes.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if len(content_bytes) > 8 and content_bytes[4:8] == b"ftyp":
            return "video/mp4"
        return None

    def _redact_url(self, url: str) -> str:
        if not url:
            return ""
        try:
            from urllib.parse import urlparse
            parsed = urlparse(url)
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?[REDACTED]"
        except Exception:
            return "[URL REDACTED]"

    def _is_allowed_fife_url(self, url: str) -> bool:
        return isinstance(url, str) and any(
            url.startswith(p) for p in _ALLOWED_FIFE_PREFIXES
        )

    # ------------------------------------------------------------------ #
    # Main public method (implements FlowDriver interface)
    # ------------------------------------------------------------------ #

    async def generate_assets(
        self,
        prompt: str,
        user_id: str,
        request_id: str,
        timeout: float = 120.0,
        input_data: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Generate one image via the Flow extension bridge.

        1. Verify extension is connected.
        2. create_project (TRPC, quick).
        3. gen_image (batchGenerateImages + reCAPTCHA via extension).
        4. Download fifeUrl bytes via httpx (GCS signed URL, no auth).
        5. Validate MIME + size, return asset dict.

        Raises FlowAPIDriverError on any failure.
        """
        import asyncio

        prompt_hash = hashlib.sha256(prompt.encode()).hexdigest()[:12]
        logger.info(
            "[flow-api-driver] request=%s prompt_len=%d prompt_hash=%s",
            request_id[:8], len(prompt), prompt_hash,
        )

        # 1. Extension connectivity guard
        if not self._client.connected:
            raise FlowAPIDriverError(
                "Flow extension is not connected — cannot make authenticated API calls"
            )

        input_data = input_data if isinstance(input_data, dict) else {}
        sdk = FlowSDK(client=self._client)
        tier = self._resolve_tier()

        # 2. Create project (TRPC — fast, no captcha)
        project_id = input_data.get("project_id")
        if not isinstance(project_id, str) or not is_valid_project_id(project_id) or project_id == "cloud-worker":
            raw_title = input_data.get("project_title") or input_data.get("board_name")
            project_title = str(raw_title).strip() if isinstance(raw_title, str) and raw_title.strip() else f"flowboard-{request_id[:8]}"
            try:
                proj_result = await asyncio.wait_for(
                    sdk.create_project(title=project_title[:80]),
                    timeout=30.0,
                )
            except asyncio.TimeoutError:
                raise FlowAPIDriverError("create_project timed out after 30s")
            except Exception as exc:
                raise FlowAPIDriverError(f"create_project failed: {exc}") from exc

            if proj_result.get("error"):
                raise FlowAPIDriverError(
                    f"create_project returned error: {proj_result['error']}"
                )
            project_id = proj_result.get("project_id")
            if not project_id:
                raise FlowAPIDriverError(
                    "create_project returned no project_id"
                )
        logger.info("[flow-api-driver] project_id=%s...", str(project_id)[:12])

        aspect_ratio = input_data.get("aspect_ratio") if isinstance(input_data.get("aspect_ratio"), str) else "IMAGE_ASPECT_RATIO_LANDSCAPE"
        image_model = input_data.get("image_model") if isinstance(input_data.get("image_model"), str) else self._image_model
        variant_count = self._resolve_variant_count(input_data.get("variant_count"))
        prompts = input_data.get("prompts") if isinstance(input_data.get("prompts"), list) else None
        ref_media_ids = await self._resolve_ref_media_ids(sdk, input_data.get("ref_media_ids"), str(project_id))

        # 3. Generate image (batchGenerateImages + reCAPTCHA)
        gen_timeout = max(30.0, timeout - 30.0)
        try:
            gen_result = await asyncio.wait_for(
                sdk.gen_image(
                    prompt=prompt,
                    project_id=project_id,
                    aspect_ratio=aspect_ratio,
                    paygate_tier=tier,
                    ref_media_ids=ref_media_ids,
                    variant_count=variant_count,
                    prompts=prompts,
                    image_model=image_model,
                ),
                timeout=gen_timeout,
            )
        except asyncio.TimeoutError:
            raise FlowAPIDriverError(
                f"gen_image timed out after {gen_timeout:.0f}s"
            )
        except Exception as exc:
            raise FlowAPIDriverError(f"gen_image failed: {exc}") from exc

        if gen_result.get("error"):
            raise FlowAPIDriverError(
                f"gen_image API error: {gen_result['error']}"
            )

        # 4. Extract fifeUrl
        entries = gen_result.get("media_entries") or extract_media_entries(
            gen_result.get("raw", {})
        )
        if not entries:
            raise FlowAPIDriverError(
                "gen_image returned no media entries"
            )

        first = entries[0]
        fife_url: Optional[str] = first.get("url")
        media_id: Optional[str] = first.get("media_id")

        if not fife_url:
            raise FlowAPIDriverError(
                f"gen_image media entry has no fifeUrl "
                f"(media_id={str(media_id)[:12] if media_id else 'none'})"
            )

        if not self._is_allowed_fife_url(fife_url):
            raise FlowAPIDriverError(
                f"fifeUrl has disallowed scheme: {self._redact_url(fife_url)}"
            )

        logger.info(
            "[flow-api-driver] downloading asset: url=%s",
            self._redact_url(fife_url),
        )

        # 5. Download bytes (GCS signed URL — no auth header)
        try:
            async with httpx.AsyncClient(timeout=self._download_timeout) as client:
                resp = await client.get(fife_url)
        except Exception as exc:
            raise FlowAPIDriverError(f"fifeUrl download failed: {exc}") from exc

        if resp.status_code != 200:
            raise FlowAPIDriverError(
                f"fifeUrl download HTTP {resp.status_code}"
            )

        content_bytes = resp.content

        # 6. Size guard
        if len(content_bytes) > _MAX_ASSET_BYTES:
            raise FlowAPIDriverError(
                f"asset exceeds 25 MB limit ({len(content_bytes)} bytes)"
            )

        # 7. MIME sniff
        reported_mime = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        sniffed = self._sniff_mime(content_bytes)
        final_mime = sniffed or (reported_mime if reported_mime in _ALLOWED_OUTPUT_MIMES else None)
        if not final_mime:
            raise FlowAPIDriverError(
                f"unrecognised MIME type (reported={reported_mime!r}, sniffed=None)"
            )
        if final_mime not in _ALLOWED_OUTPUT_MIMES:
            raise FlowAPIDriverError(f"unsupported MIME type: {final_mime}")

        ext_map = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "video/mp4": "mp4",
        }
        ext = ext_map.get(final_mime, "bin")
        file_name = f"flow_output.{ext}"
        checksum = hashlib.sha256(content_bytes).hexdigest()

        logger.info(
            "[flow-api-driver] asset OK: mime=%s bytes=%d checksum=%s",
            final_mime, len(content_bytes), checksum[:12],
        )

        return [
            {
                "source_provider": "flow",
                "file_name": file_name,
                "storage_key": f"users/{user_id}/flow/{request_id}/output-0.{ext}",
                "mime_type": final_mime,
                "byte_size": len(content_bytes),
                "checksum": checksum,
                "prompt_snapshot": prompt,
                "content_bytes": content_bytes,
                "media_id": media_id,
                "project_id": project_id,
            }
        ]

    def _resolve_variant_count(self, value: Any) -> int:
        try:
            return max(1, min(int(value or 1), 4))
        except Exception:
            return 1

    async def _resolve_ref_media_ids(self, sdk: FlowSDK, value: Any, project_id: str) -> Optional[List[str]]:
        if not isinstance(value, list):
            return None
        resolved: List[str] = []
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item.strip():
                continue
            ref = item.strip()
            if ref.startswith("http://") or ref.startswith("https://"):
                resolved.append(await self._upload_url_reference(sdk, ref, project_id, index))
            else:
                resolved.append(ref)
        return resolved or None

    async def _upload_url_reference(self, sdk: FlowSDK, url: str, project_id: str, index: int) -> str:
        try:
            async with httpx.AsyncClient(timeout=self._download_timeout, follow_redirects=True) as client:
                resp = await client.get(url)
        except Exception as exc:
            raise FlowAPIDriverError(f"reference download failed: {exc}") from exc
        if resp.status_code != 200:
            raise FlowAPIDriverError(f"reference download HTTP {resp.status_code}")
        content_bytes = resp.content
        if len(content_bytes) > _MAX_ASSET_BYTES:
            raise FlowAPIDriverError(f"reference exceeds 25 MB limit ({len(content_bytes)} bytes)")
        reported_mime = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        mime_type = self._sniff_mime(content_bytes) or reported_mime
        if mime_type not in {"image/png", "image/jpeg"}:
            raise FlowAPIDriverError(f"unsupported reference MIME type: {mime_type}")
        ext = "png" if mime_type == "image/png" else "jpg"
        upload = await sdk.upload_image(
            image_base64=base64.b64encode(content_bytes).decode("ascii"),
            mime_type=mime_type,
            project_id=project_id,
            file_name=f"reference-{index + 1}.{ext}",
        )
        if upload.get("error"):
            raise FlowAPIDriverError(f"reference upload failed: {upload['error']}")
        media_id = upload.get("media_id")
        if not isinstance(media_id, str) or not media_id:
            raise FlowAPIDriverError("reference upload returned no media_id")
        return media_id
