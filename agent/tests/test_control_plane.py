import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from flowboard.routes.control_plane import RequestCreateInput, PairingRegisterInput
from flowboard.services.control_plane import control_plane_service

# =========================================================================
# 1. FRONTEND USER API ENDPOINTS TESTS
# =========================================================================

def test_create_request_success(client):
    """Verify POST /api/requests correctly routes and compiles inputs."""
    mock_res = {
        "id": "00000000-0000-0000-0000-000000000001",
        "status": "queued",
        "provider": "flow",
        "task_type": "txt2img",
        "input_data": {"prompt": "A beautiful scenic view"},
        "idempotency_key": "user_1_key",
        "expected_output": "image"
    }
    
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "create_or_reset_request", new_callable=AsyncMock) as mock_service:
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_service.return_value = mock_res
        
        payload = {
            "board_id": "b0000000-0000-0000-0000-000000000001",
            "node_id": "e0000000-0000-0000-0000-000000000001",
            "provider": "flow",
            "task_type": "txt2img",
            "input_data": {"prompt": "A beautiful scenic view"},
            "idempotency_key": "user_1_key",
            "expected_output": "image"
        }
        
        headers = {"Authorization": "Bearer my_valid_supabase_jwt"}
        response = client.post("/api/control-plane/requests", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "00000000-0000-0000-0000-000000000001"
        assert data["status"] == "queued"
        mock_service.assert_called_once()
        mock_verify.assert_called_once_with("my_valid_supabase_jwt")

def test_sign_read_asset_success(client):
    """Verify POST /api/assets/sign-read generates a 15-minute S3/R2 pre-signed read URL."""
    mock_url = "https://flowboard-assets.r2.cloudflarestorage.com/keys/out.png?X-Amz-Signature=123"
    mock_asset = {
        "id": "asset_123",
        "user_id": "11111111-1111-1111-1111-111111111111",
        "storage_key": "users/11111111-1111-1111-1111-111111111111/out.png"
    }
    
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "get_user_asset", new_callable=AsyncMock) as mock_get_asset, \
         patch.object(control_plane_service, "generate_read_url") as mock_service:
        
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_get_asset.return_value = mock_asset
        mock_service.return_value = mock_url
        
        payload = {
            "asset_id": "asset_123"
        }
        
        headers = {"Authorization": "Bearer my_valid_supabase_jwt"}
        response = client.post("/api/assets/sign-read", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["url"] == mock_url
        assert data["expires_in"] == 900
        mock_get_asset.assert_called_once_with("11111111-1111-1111-1111-111111111111", "asset_123")
        mock_service.assert_called_once_with("users/11111111-1111-1111-1111-111111111111/out.png")

def test_sign_upload_asset_success(client):
    """Verify POST /api/assets/sign-upload generates a valid S3/R2 pre-signed upload URL."""
    mock_url = "https://flowboard-assets.r2.cloudflarestorage.com/keys/in.png?X-Amz-Signature=456"
    
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "generate_upload_url") as mock_service:
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_service.return_value = mock_url
        
        payload = {
            "storage_key": "users/11111111-1111-1111-1111-111111111111/in.png",
            "content_type": "image/png",
            "expires_in": 600
        }
        
        headers = {"Authorization": "Bearer my_valid_supabase_jwt"}
        response = client.post("/api/assets/sign-upload", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["url"] == mock_url
        assert data["expires_in"] == 600
        mock_service.assert_called_once_with(
            storage_key="users/11111111-1111-1111-1111-111111111111/in.png",
            content_type="image/png",
            expires_in=600
        )

def test_pairings_register_success(client):
    """Verify POST /api/pairings/register executes device registration."""
    mock_res = {
        "client_id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
        "pairing": {
            "id": "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
            "user_id": "11111111-1111-1111-1111-111111111111",
            "is_active": True
        }
    }
    
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "register_pairing", new_callable=AsyncMock) as mock_service:
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_service.return_value = mock_res
        
        payload = {
            "client_name": "Chrome Ext A",
            "client_installation_id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "secret": "my_client_secret_123"
        }
        
        headers = {"Authorization": "Bearer my_valid_supabase_jwt"}
        response = client.post("/api/pairings/register", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["client_id"] == "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0"
        assert data["pairing"]["is_active"] is True
        mock_service.assert_called_once()

def test_pairings_rotate_success(client):
    """Verify POST /api/pairings/rotate-secret executes key rotation."""
    mock_res = {
        "id": "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
        "current_secret_hash": "new_hash_abc",
        "previous_secret_hash": "old_hash_xyz"
    }
    mock_pairing = {
        "id": "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
        "user_id": "11111111-1111-1111-1111-111111111111"
    }
    
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "get_user_pairing", new_callable=AsyncMock) as mock_get_pairing, \
         patch.object(control_plane_service, "rotate_pairing_secret", new_callable=AsyncMock) as mock_service:
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_get_pairing.return_value = mock_pairing
        mock_service.return_value = mock_res
        
        payload = {
            "pairing_id": "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0",
            "new_secret": "my_new_secret_456"
        }
        
        headers = {"Authorization": "Bearer my_valid_supabase_jwt"}
        response = client.post("/api/pairings/rotate-secret", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["current_secret_hash"] == "new_hash_abc"
        mock_get_pairing.assert_called_once_with("11111111-1111-1111-1111-111111111111", "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0")
        mock_service.assert_called_once()

# =========================================================================
# 2. EXTENSION WORKER API ENDPOINTS TESTS (AUTHENTICATED HEADERS)
# =========================================================================

def test_extension_endpoints_require_headers(client):
    """Verify that extension routes return 422 Unprocessable Entity when headers are missing."""
    response = client.post("/api/extension/claim", json={"provider": "flow"})
    assert response.status_code == 422 # Missing Header fields

def test_extension_endpoints_reject_invalid_pairing(client):
    """Verify extension routes return 401 Unauthorized for invalid pairing credentials."""
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth:
        mock_auth.return_value = False
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "invalid_secret"
        }
        
        response = client.post("/api/extension/claim", json={"provider": "flow"}, headers=headers)
        assert response.status_code == 401
        assert response.json()["detail"] == "Unauthorized: Invalid Extension Client ID or Pairing Secret"
        mock_auth.assert_called_once_with("a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0", "invalid_secret")

def test_extension_claim_job_success(client):
    """Verify that claim_job claims a queued request using skip-locked and active pairing."""
    mock_job = {
        "id": "00000000-0000-0000-0000-000000000001",
        "status": "claimed",
        "provider": "flow",
        "task_type": "txt2img"
    }
    
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
         patch.object(control_plane_service, "claim_next_request", new_callable=AsyncMock) as mock_claim:
        
        mock_auth.return_value = True
        mock_claim.return_value = mock_job
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "valid_secret_123"
        }
        
        response = client.post("/api/extension/claim", json={"provider": "flow", "lease_duration_sec": 60}, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "00000000-0000-0000-0000-000000000001"
        assert data["status"] == "claimed"
        mock_claim.assert_called_once_with(provider="flow", client_id="a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0", lease_duration_sec=60)

def test_extension_heartbeat_success(client):
    """Verify extension heartbeat lease renewal succeeds."""
    mock_res = {
        "id": "00000000-0000-0000-0000-000000000001",
        "last_heartbeat_at": "now"
    }
    
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
         patch.object(control_plane_service, "renew_request_lease", new_callable=AsyncMock) as mock_hb:
        
        mock_auth.return_value = True
        mock_hb.return_value = mock_res
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "valid_secret_123"
        }
        
        response = client.post("/api/extension/heartbeat", json={"request_id": "00000000-0000-0000-0000-000000000001", "lease_duration_sec": 60}, headers=headers)
        assert response.status_code == 200
        assert response.json()["id"] == "00000000-0000-0000-0000-000000000001"

def test_extension_progress_success(client):
    """Verify extension progress update succeeds."""
    mock_res = {
        "id": "00000000-0000-0000-0000-000000000001",
        "progress_stage": "extracting",
        "progress": 50
    }
    
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
         patch.object(control_plane_service, "update_request_progress", new_callable=AsyncMock) as mock_prog:
        
        mock_auth.return_value = True
        mock_prog.return_value = mock_res
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "valid_secret_123"
        }
        
        payload = {
            "request_id": "00000000-0000-0000-0000-000000000001",
            "progress_stage": "extracting",
            "progress": 50
        }
        
        response = client.post("/api/extension/progress", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["progress_stage"] == "extracting"
        assert data["progress"] == 50

def test_extension_complete_success(client):
    """Verify extension completes job and logs assets atomically."""
    mock_res = {
        "id": "00000000-0000-0000-0000-000000000001",
        "status": "completed"
    }
    
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
         patch.object(control_plane_service, "complete_request_with_assets", new_callable=AsyncMock) as mock_comp:
        
        mock_auth.return_value = True
        mock_comp.return_value = mock_res
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "valid_secret_123"
        }
        
        payload = {
            "request_id": "00000000-0000-0000-0000-000000000001",
            "output_result": {"video_url": "bucket/out.mp4"},
            "assets": [
                {
                    "file_name": "out.mp4",
                    "storage_key": "keys/out.mp4",
                    "mime_type": "video/mp4",
                    "byte_size": 2048500,
                    "checksum": "checksum_hash"
                }
            ]
        }
        
        response = client.post("/api/extension/complete", json=payload, headers=headers)
        assert response.status_code == 200
        assert response.json()["status"] == "completed"

def test_extension_fail_success(client):
    """Verify extension fails job and appends event snapshot atomically."""
    mock_res = {
        "id": "00000000-0000-0000-0000-000000000001",
        "status": "failed"
    }
    
    with patch.object(control_plane_service, "validate_pairing", new_callable=AsyncMock) as mock_auth, \
         patch.object(control_plane_service, "fail_request_with_event", new_callable=AsyncMock) as mock_fail:
        
        mock_auth.return_value = True
        mock_fail.return_value = mock_res
        
        headers = {
            "X-Client-Id": "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0",
            "X-Pairing-Secret": "valid_secret_123"
        }
        
        payload = {
            "request_id": "00000000-0000-0000-0000-000000000001",
            "error_message": "Network timeout waiting for provider ui element",
            "debug_snapshot_bucket": "flowboard-debug",
            "debug_snapshot_key": "debug/snap_123.log"
        }
        
        response = client.post("/api/extension/fail", json=payload, headers=headers)
        assert response.status_code == 200
        assert response.json()["status"] == "failed"

# =========================================================================
# 3. SYSTEM CRON API ENDPOINTS TESTS
# =========================================================================

def test_cron_recover_stale_success(client):
    """Verify cron recover-stale successfully triggers database sweep with valid token."""
    with patch.object(control_plane_service, "recover_stale_requests", new_callable=AsyncMock) as mock_recover:
        headers = {"X-Recover-Token": "default_cron_secret_token_123"}
        response = client.post("/api/cron/recover-stale", headers=headers)
        assert response.status_code == 200
        assert response.json() == {"ok": True, "message": "Expired leases recovered successfully"}
        mock_recover.assert_called_once()

# =========================================================================
# 4. HARDENING SECURITY TESTS (NEGATIVE GATING CASES)
# =========================================================================

def test_jwt_authenticator_invalid_token(client):
    """Verify endpoint rejects invalid JWT token format or verification failure with 401."""
    payload = {
        "board_id": "b0000000-0000-0000-0000-000000000001",
        "node_id": "e0000000-0000-0000-0000-000000000001",
        "provider": "flow",
        "task_type": "txt2img",
        "input_data": {"prompt": "A beautiful scenic view"},
        "idempotency_key": "user_1_key",
        "expected_output": "image"
    }
    
    # 1. Invalid Authorization Header Format
    headers = {"Authorization": "invalid_format_no_bearer"}
    response = client.post("/api/control-plane/requests", json=payload, headers=headers)
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid Authorization token format. Must be Bearer <token>"
    
    # 2. Token Verification Failure (returns None)
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify:
        mock_verify.return_value = None
        headers = {"Authorization": "Bearer bad_expired_token"}
        response = client.post("/api/control-plane/requests", json=payload, headers=headers)
        assert response.status_code == 401
        assert response.json()["detail"] == "Invalid or expired Supabase JWT token"

def test_sign_read_asset_ownership_spoofing(client):
    """Verify that sign-read rejects attempts to read assets not owned by the authenticated user."""
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "get_user_asset", new_callable=AsyncMock) as mock_get_asset:
        
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_get_asset.return_value = None # Asset does not exist or belongs to another user
        
        payload = {
            "asset_id": "asset_owned_by_someone_else"
        }
        
        headers = {"Authorization": "Bearer valid_token_user_1"}
        response = client.post("/api/assets/sign-read", json=payload, headers=headers)
        assert response.status_code == 404
        assert response.json()["detail"] == "Asset not found or access denied"

def test_sign_upload_asset_invalid_prefix(client):
    """Verify that sign-upload rejects attempts to sign storage keys outside user's sandbox prefix."""
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify:
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        
        # storage_key does not start with users/11111111-1111-1111-1111-111111111111/
        payload = {
            "storage_key": "users/different_user_id_here/in.png",
            "content_type": "image/png"
        }
        
        headers = {"Authorization": "Bearer valid_token"}
        response = client.post("/api/assets/sign-upload", json=payload, headers=headers)
        assert response.status_code == 403
        assert "Access denied: storage_key must start with" in response.json()["detail"]

def test_rotate_pairing_ownership_spoofing(client):
    """Verify that pairing rotation rejects rotating a pairing not owned by the user."""
    with patch.object(control_plane_service, "verify_supabase_jwt", new_callable=AsyncMock) as mock_verify, \
         patch.object(control_plane_service, "get_user_pairing", new_callable=AsyncMock) as mock_get_pairing:
        
        mock_verify.return_value = "11111111-1111-1111-1111-111111111111"
        mock_get_pairing.return_value = None # Pairing belongs to someone else
        
        payload = {
            "pairing_id": "pairing_owned_by_someone_else",
            "new_secret": "secure_new_secret"
        }
        
        headers = {"Authorization": "Bearer valid_token"}
        response = client.post("/api/pairings/rotate-secret", json=payload, headers=headers)
        assert response.status_code == 404
        assert response.json()["detail"] == "Pairing not found or access denied"

def test_cron_recover_stale_unauthorized(client):
    """Verify cron recover-stale returns 401 Unauthorized when recover token is missing or invalid."""
    # 1. Missing Token
    response = client.post("/api/cron/recover-stale")
    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized: Invalid or missing X-Recover-Token"
    
    # 2. Invalid Token
    headers = {"X-Recover-Token": "completely_wrong_secret"}
    response = client.post("/api/cron/recover-stale", headers=headers)
    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized: Invalid or missing X-Recover-Token"
