from __future__ import annotations

import os
import hashlib
import logging
from typing import Any, Dict, Union, Optional
import httpx
from flowboard.extension_worker.client import WorkerClient

logger = logging.getLogger(__name__)


class AssetUploader:
    """Boundary responsible for secure uploads to Cloudflare R2 storage.
    
    Reads bytes or file path, requests presigned URL, PUTs to R2, computes SHA-256 checksum.
    """
    
    def __init__(self, client: WorkerClient) -> None:
        self._client = client

    async def upload(
        self,
        file_path_or_bytes: Union[str, bytes],
        storage_key: str,
        mime_type: str,
        file_name: str,
        prompt_snapshot: Optional[str] = None,
        expires_in: int = 900
    ) -> Dict[str, Any]:
        # 1. Resolve content bytes and size
        if isinstance(file_path_or_bytes, str):
            if not os.path.exists(file_path_or_bytes):
                raise FileNotFoundError(f"Source file not found: {file_path_or_bytes}")
            with open(file_path_or_bytes, "rb") as f:
                content_bytes = f.read()
        elif isinstance(file_path_or_bytes, bytes):
            content_bytes = file_path_or_bytes
        else:
            raise TypeError("file_path_or_bytes must be either a file path string or raw bytes")

        byte_size = len(content_bytes)

        # 2. Compute SHA-256 checksum (self-computed, normalized to lowercase hex)
        checksum = hashlib.sha256(content_bytes).hexdigest().lower()

        # 3. Redacted logging (no raw bytes, prompt, or full signed URL query string)
        key_summary = storage_key[:40] + "..." if len(storage_key) > 40 else storage_key
        logger.info(
            "Uploading asset: key=%s mime=%s size=%d checksum=%s",
            key_summary, mime_type, byte_size, checksum[:12]
        )

        # 4. Request presigned upload URL from Control Plane
        sign_res = await self._client.sign_upload(
            storage_key=storage_key,
            content_type=mime_type,
            expires_in=expires_in
        )
        upload_url = sign_res["url"]

        # Parse host/path for logs
        try:
            from urllib.parse import urlparse
            parsed = urlparse(upload_url)
            logger.info("Presigned URL requested successfully: %s://%s%s", parsed.scheme, parsed.netloc, parsed.path)
        except Exception:
            logger.info("Presigned URL requested successfully")

        # 5. Execute HTTP PUT upload to R2
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as http_client:
            res = await http_client.put(
                upload_url,
                content=content_bytes,
                headers={"Content-Type": mime_type}
            )
            if not res.is_success:
                raise RuntimeError(f"R2 PUT upload failed (HTTP {res.status_code}): {res.text}")

        # 6. Return standardized asset metadata
        metadata = {
            "source_provider": "flow",
            "file_name": file_name,
            "storage_key": storage_key,
            "mime_type": mime_type,
            "byte_size": byte_size,
            "checksum": checksum,
        }
        if prompt_snapshot is not None:
            metadata["prompt_snapshot"] = prompt_snapshot

        return metadata
