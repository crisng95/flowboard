"""Unit and integration tests for Phase 4.2H: R2 Asset Upload Integration.

Verifies `/api/extension/sign-upload` endpoint, security prefix constraints, MIME type rules,
and the AssetUploader worker boundary.
"""
from __future__ import annotations

import hashlib
import tempfile
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from fastapi import HTTPException
from fastapi.testclient import TestClient

from flowboard.routes.control_plane import SignUploadInput
from flowboard.services.control_plane import control_plane_service
from flowboard.extension_worker.client import WorkerClient
from flowboard.extension_worker.asset_uploader import AssetUploader


class TestR2AssetUploadIntegration:

    @pytest.fixture
    def client_headers(self) -> dict:
        return {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }

    @pytest.mark.asyncio
    async def test_extension_sign_upload_success(self, client) -> None:
        """Verify extension sign-upload successfully resolves owner, validates prefix, and signs R2 PUT URL."""
        mock_user_id = "user-uuid-999"
        mock_upload_url = "https://flowboard-assets.r2.cloudflarestorage.com/users/user-uuid-999/flow/job-123/out.png?sig=abc"
        
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        payload = {
            "storage_key": f"users/{mock_user_id}/flow/job-123/out.png",
            "content_type": "image/png",
            "expires_in": 300
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner, \
             patch.object(control_plane_service, "generate_upload_url") as mock_sign:
             
            mock_auth.return_value = True
            mock_owner.return_value = mock_user_id
            mock_sign.return_value = mock_upload_url
            
            response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
            assert response.status_code == 200
            data = response.json()
            assert data["url"] == mock_upload_url
            assert data["expires_in"] == 300
            
            mock_auth.assert_called_once_with("client-uuid-123", "client-secret-abc")
            mock_owner.assert_called_once_with("client-uuid-123")
            mock_sign.assert_called_once_with(
                storage_key=payload["storage_key"],
                content_type="image/png",
                expires_in=300
            )

    @pytest.mark.asyncio
    async def test_extension_sign_upload_unauthorized(self, client) -> None:
        """Verify endpoint returns 401 if extension client pairing is invalid."""
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "wrong-secret"
        }
        
        payload = {
            "storage_key": "users/any/flow/out.png",
            "content_type": "image/png"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth:
            mock_auth.return_value = False
            response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
            assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_extension_sign_upload_client_not_found(self, client) -> None:
        """Verify endpoint returns 404 if paired user_id cannot be found in DB."""
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        payload = {
            "storage_key": "users/any/flow/out.png",
            "content_type": "image/png"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner:
             
            mock_auth.return_value = True
            mock_owner.return_value = None  # Client exists but owner is null / not found
            
            response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
            assert response.status_code == 404
            assert response.json()["detail"] == "Extension client owner not found"

    @pytest.mark.asyncio
    async def test_extension_sign_upload_prefix_denied(self, client) -> None:
        """Verify endpoint returns 403 if storage_key prefix does not match user_id of paired client."""
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        payload = {
            "storage_key": "users/other-user-uuid/flow/out.png",
            "content_type": "image/png"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner:
             
            mock_auth.return_value = True
            mock_owner.return_value = "user-uuid-999"  # Owner is 999, but request tries to use 'other-user-uuid'
            
            response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
            assert response.status_code == 403
            assert "Access denied: storage_key must start with" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_extension_sign_upload_path_traversal(self, client) -> None:
        """Verify endpoint returns 400 for dangerous path traversals or symbols."""
        mock_user_id = "user-uuid-999"
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner:
             
            mock_auth.return_value = True
            mock_owner.return_value = mock_user_id
            
            for bad_key in [
                f"users/{mock_user_id}/flow/../../hacked.png",
                f"users/{mock_user_id}/flow/sub//folder.png",
                f"users/{mock_user_id}/flow/back\\slash.png",
                f"/users/{mock_user_id}/flow/output.png",
                f"users/{mock_user_id}/flow/\x00output.png"
            ]:
                payload = {
                    "storage_key": bad_key,
                    "content_type": "image/png"
                }
                response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
                assert response.status_code in [400, 403]
                if response.status_code == 400:
                    assert "path traversal or forbidden characters" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_extension_sign_upload_mime_rules(self, client) -> None:
        """Verify endpoint allows image/png, image/jpeg, video/mp4 and rejects others."""
        mock_user_id = "user-uuid-999"
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner, \
             patch.object(control_plane_service, "generate_upload_url") as mock_sign:
             
            mock_auth.return_value = True
            mock_owner.return_value = mock_user_id
            mock_sign.return_value = "https://mock.com"
            
            # Allowed MIME types
            for ok_mime in ["image/png", "image/jpeg", "video/mp4"]:
                payload = {
                    "storage_key": f"users/{mock_user_id}/flow/out.png",
                    "content_type": ok_mime
                }
                response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
                assert response.status_code == 200
                
            # Forbidden MIME types
            for bad_mime in ["image/gif", "application/json", "text/plain", "image/svg+xml"]:
                payload = {
                    "storage_key": f"users/{mock_user_id}/flow/out.png",
                    "content_type": bad_mime
                }
                response = client.post("/api/extension/sign-upload", json=payload, headers=headers)
                assert response.status_code == 400
                assert response.json()["detail"] == "Unsupported MIME type"

    @pytest.mark.asyncio
    async def test_extension_sign_upload_expires_clamping(self, client) -> None:
        """Verify expires_in is clamped between 60 and 900 seconds."""
        mock_user_id = "user-uuid-999"
        headers = {
            "X-Client-Id": "client-uuid-123",
            "X-Pairing-Secret": "client-secret-abc"
        }
        
        with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
             patch.object(control_plane_service, "get_client_user_id", new_callable=AsyncMock) as mock_owner, \
             patch.object(control_plane_service, "generate_upload_url") as mock_sign:
             
            mock_auth.return_value = True
            mock_owner.return_value = mock_user_id
            mock_sign.return_value = "https://mock.com"
            
            # Test clamping low value (30 -> 60)
            payload = {
                "storage_key": f"users/{mock_user_id}/flow/out.png",
                "content_type": "image/png",
                "expires_in": 30
            }
            client.post("/api/extension/sign-upload", json=payload, headers=headers)
            mock_sign.assert_called_with(storage_key=payload["storage_key"], content_type="image/png", expires_in=60)
            
            # Test clamping high value (2000 -> 900)
            payload = {
                "storage_key": f"users/{mock_user_id}/flow/out.png",
                "content_type": "image/png",
                "expires_in": 2000
            }
            client.post("/api/extension/sign-upload", json=payload, headers=headers)
            mock_sign.assert_called_with(storage_key=payload["storage_key"], content_type="image/png", expires_in=900)


class TestAssetUploaderBoundary:

    @pytest.mark.asyncio
    async def test_asset_uploader_upload_bytes(self) -> None:
        """Verify AssetUploader signs, PUTs to R2, computes correct lowercase hex checksum, and yields valid metadata."""
        mock_client = MagicMock(spec=WorkerClient)
        mock_client.sign_upload = AsyncMock(return_value={"url": "https://r2.mock/upload?signature=123"})
        
        uploader = AssetUploader(mock_client)
        
        # Tiny 1px transparent PNG bytes
        test_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        expected_checksum = hashlib.sha256(test_bytes).hexdigest().lower()
        storage_key = "users/user-123/flow/job-abc/out.png"
        
        # Mock httpx PUT upload request
        with patch("httpx.AsyncClient.put", new_callable=AsyncMock) as mock_put:
            mock_res = MagicMock()
            mock_res.is_success = True
            mock_put.return_value = mock_res
            
            metadata = await uploader.upload(
                file_path_or_bytes=test_bytes,
                storage_key=storage_key,
                mime_type="image/png",
                file_name="out.png",
                prompt_snapshot="A futuristic neon skyline"
            )
            
            # Verify uploader requested signature
            mock_client.sign_upload.assert_called_once_with(
                storage_key=storage_key,
                content_type="image/png",
                expires_in=900
            )
            
            # Verify uploader executed HTTP PUT
            mock_put.assert_called_once_with(
                "https://r2.mock/upload?signature=123",
                content=test_bytes,
                headers={"Content-Type": "image/png"}
            )
            
            # Verify output metadata
            assert metadata["source_provider"] == "flow"
            assert metadata["file_name"] == "out.png"
            assert metadata["storage_key"] == storage_key
            assert metadata["mime_type"] == "image/png"
            assert metadata["byte_size"] == len(test_bytes)
            assert metadata["checksum"] == expected_checksum
            assert metadata["prompt_snapshot"] == "A futuristic neon skyline"

    @pytest.mark.asyncio
    async def test_asset_uploader_upload_file_path(self) -> None:
        """Verify AssetUploader successfully uploads from a given local file path."""
        mock_client = MagicMock(spec=WorkerClient)
        mock_client.sign_upload = AsyncMock(return_value={"url": "https://r2.mock/upload"})
        
        uploader = AssetUploader(mock_client)
        
        test_content = b"sample image bytes for file path"
        expected_checksum = hashlib.sha256(test_content).hexdigest().lower()
        
        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_file.write(test_content)
            tmp_path = tmp_file.name
            
        try:
            with patch("httpx.AsyncClient.put", new_callable=AsyncMock) as mock_put:
                mock_res = MagicMock()
                mock_res.is_success = True
                mock_put.return_value = mock_res
                
                metadata = await uploader.upload(
                    file_path_or_bytes=tmp_path,
                    storage_key="users/user-123/flow/job-abc/out.png",
                    mime_type="image/png",
                    file_name="out.png"
                )
                
                assert metadata["byte_size"] == len(test_content)
                assert metadata["checksum"] == expected_checksum
        finally:
            import os
            try:
                os.remove(tmp_path)
            except Exception:
                pass
