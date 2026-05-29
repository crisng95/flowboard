import secrets
import httpx
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from flowboard.config import CONTROL_PLANE_CRON_TOKEN
from flowboard.services.control_plane import control_plane_service

router = APIRouter(prefix="/api", tags=["control-plane"])

# =========================================================================
# FASTAPI CONTRACT SCHEMAS (Pydantic Contract Types)
# =========================================================================

class RequestCreateInput(BaseModel):
    board_id: str = Field(..., description="UUID of the board")
    node_id: str = Field(..., description="UUID of the node")
    provider: str = Field(..., description="Target provider (e.g. 'flow', 'gemini')")
    task_type: str = Field(..., description="Generation type (e.g. 'txt2img')")
    input_data: Dict[str, Any] = Field(..., description="Task inputs")
    idempotency_key: str = Field(..., description="Băm key tránh xung đột chéo")
    expected_output: str = Field(..., description="Output expected type")

class SignReadInput(BaseModel):
    asset_id: str = Field(..., description="UUID of the asset to read")

class SignUploadInput(BaseModel):
    storage_key: str = Field(..., description="Key under which file will be stored in R2")
    content_type: str = Field(..., description="MIME type of the target file")
    expires_in: Optional[int] = Field(900, description="Upload expiry in seconds")

class PairingRegisterInput(BaseModel):
    client_name: str = Field(..., description="Device label")
    client_installation_id: str = Field(..., description="Unique installation ID generated locally")
    secret: str = Field(..., description="Client pairing secret to hash")

class PairingRotateInput(BaseModel):
    pairing_id: str = Field(..., description="UUID of pairing to rotate")
    new_secret: str = Field(..., description="New secret to replace current secret")

class ClaimJobInput(BaseModel):
    provider: str = Field(..., description="Target provider (e.g. 'flow', 'gemini')")
    lease_duration_sec: Optional[int] = Field(60, description="Lease window")

class HeartbeatJobInput(BaseModel):
    request_id: str = Field(..., description="UUID of request being processed")
    lease_duration_sec: Optional[int] = Field(60, description="Extended lease duration")

class ProgressJobInput(BaseModel):
    request_id: str = Field(..., description="UUID of request")
    progress_stage: str = Field(..., description="Stage identifier")
    progress: int = Field(..., ge=0, le=100, description="Percentage completed")

class CompleteJobInput(BaseModel):
    request_id: str = Field(..., description="UUID of request")
    output_result: Dict[str, Any] = Field(..., description="Output JSON parameters")
    assets: List[Dict[str, Any]] = Field(default_factory=list, description="Array of generated asset metadata objects")

class FailJobInput(BaseModel):
    request_id: str = Field(..., description="UUID of request")
    error_message: str = Field(..., description="Error detail message")
    debug_snapshot_bucket: Optional[str] = Field(None, description="Bucket containing snap log")
    debug_snapshot_key: Optional[str] = Field(None, description="Storage key of snap log")

# =========================================================================
# DEPENDENCY INJECTION FOR AUTHENTICATION
# =========================================================================

async def get_current_user_id(authorization: str = Header(..., description="Bearer JWT token from Supabase")) -> str:
    """Dependency injection to verify Supabase JWT token and return authenticated user ID."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization token format. Must be Bearer <token>"
        )
    token = authorization.split(" ")[1]
    user_id = await control_plane_service.verify_supabase_jwt(token)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired Supabase JWT token"
        )
    return user_id

async def verify_extension_client(
    x_client_id: str = Header(..., alias="X-Client-Id", description="UUID of the extension client"),
    x_pairing_secret: str = Header(..., alias="X-Pairing-Secret", description="Long-lived rotation pairing secret")
) -> str:
    """Dependency injection that checks headers and matches hashes with grace support."""
    try:
        is_valid = await control_plane_service.validate_pairing(x_client_id, x_pairing_secret)
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Pairing lookup failed HTTP {e.response.status_code}: {e.response.text[:500]}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pairing lookup failed: {e}"
        )
    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Invalid Extension Client ID or Pairing Secret"
        )
    return x_client_id

# =========================================================================
# A. Nhóm API cho Trình duyệt Frontend (User-Facing)
# =========================================================================

@router.post("/control-plane/requests")
async def create_request(
    body: RequestCreateInput,
    current_user_id: str = Depends(get_current_user_id)
) -> Dict[str, Any]:
    """Tạo mới hoặc reset tác vụ lỗi/hủy (Atomic Create/Reset Job)."""
    try:
        req = await control_plane_service.create_or_reset_request(
            user_id=current_user_id,
            board_id=body.board_id,
            node_id=body.node_id,
            provider=body.provider,
            task_type=body.task_type,
            input_data=body.input_data,
            idempotency_key=body.idempotency_key,
            expected_output=body.expected_output
        )
        return req
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/assets/sign-read")
async def sign_read(
    body: SignReadInput,
    current_user_id: str = Depends(get_current_user_id)
) -> Dict[str, Any]:
    """Sinh signed read URL thời gian ngắn (15 phút) để tải file về hiển thị."""
    try:
        # Lookup owner and storage key from DB assets table prior to signing
        asset = await control_plane_service.get_user_asset(current_user_id, body.asset_id)
        if not asset:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Asset not found or access denied"
            )
        storage_key = asset.get("storage_key")
        if not storage_key:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid asset storage key"
            )
        read_url = control_plane_service.generate_read_url(storage_key)
        return {"url": read_url, "expires_in": 900}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/assets/sign-upload")
async def sign_upload(
    body: SignUploadInput,
    current_user_id: str = Depends(get_current_user_id)
) -> Dict[str, Any]:
    """Sinh presigned URL cho phép frontend/extension upload tệp trực tiếp lên R2."""
    # Khóa sign-upload bằng policy key prefix: users/{user_id}/...
    expected_prefix = f"users/{current_user_id}/"
    if not body.storage_key.startswith(expected_prefix):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: storage_key must start with '{expected_prefix}'"
        )
    try:
        upload_url = control_plane_service.generate_upload_url(
            storage_key=body.storage_key,
            content_type=body.content_type,
            expires_in=body.expires_in
        )
        return {"url": upload_url, "expires_in": body.expires_in}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/pairings/register")
async def register_pairing(
    body: PairingRegisterInput,
    current_user_id: str = Depends(get_current_user_id)
) -> Dict[str, Any]:
    """Đăng ký thiết bị extension client mới và tạo Pairing hoạt động."""
    try:
        result = await control_plane_service.register_pairing(
            user_id=current_user_id,
            client_name=body.client_name,
            client_installation_id=body.client_installation_id,
            secret=body.secret
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/pairings/rotate-secret")
async def rotate_pairing_secret(
    body: PairingRotateInput,
    current_user_id: str = Depends(get_current_user_id)
) -> Dict[str, Any]:
    """Xoay vòng pairing secret (current -> previous) với 24h grace overlap."""
    try:
        # Verify ownership of pairing
        pairing = await control_plane_service.get_user_pairing(current_user_id, body.pairing_id)
        if not pairing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pairing not found or access denied"
            )
        result = await control_plane_service.rotate_pairing_secret(
            pairing_id=body.pairing_id,
            new_secret=body.new_secret,
            user_id=current_user_id
        )
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

# =========================================================================
# B. Nhóm API cho Extension (Execution Plane)
# =========================================================================

@router.post("/extension/sign-upload")
async def extension_sign_upload(
    body: SignUploadInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Sinh presigned URL cho phép extension upload tệp trực tiếp lên R2."""
    import re
    control_chars_regex = re.compile(r"[\x00-\x1f\x7f-\x9f]")
    
    # 1. Lookup user_id from client_id
    user_id = await control_plane_service.get_client_user_id(client_id)
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Extension client owner not found"
        )
        
    # 2. Verify storage_key prefix
    expected_prefix = f"users/{user_id}/"
    if not body.storage_key.startswith(expected_prefix):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Access denied: storage_key must start with '{expected_prefix}'"
        )
        
    # 3. Reject dangerous paths or traversal attempts in storage_key
    if any(bad in body.storage_key for bad in ["..", "\\", "//"]) or body.storage_key.startswith("/") or control_chars_regex.search(body.storage_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid storage_key: contains path traversal or forbidden characters"
        )
        
    # 4. Validate allowed content type
    if body.content_type not in ["image/png", "image/jpeg", "video/mp4"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported MIME type"
        )
        
    # 5. Clamp expires_in
    expires_in = body.expires_in
    if expires_in is None:
        expires_in = 900
    else:
        expires_in = max(60, min(900, expires_in))
        
    try:
        upload_url = control_plane_service.generate_upload_url(
            storage_key=body.storage_key,
            content_type=body.content_type,
            expires_in=expires_in
        )
        return {"url": upload_url, "expires_in": expires_in}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/extension/claim")
async def claim_job(
    body: ClaimJobInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Atomic claim query utilizing skip-locked mechanics."""
    try:
        job = await control_plane_service.claim_next_request(
            provider=body.provider,
            client_id=client_id,
            lease_duration_sec=body.lease_duration_sec
        )
        if not job:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No queued requests available for claim under this provider"
            )
        return job
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Supabase claim HTTP {e.response.status_code}: {e.response.text[:500]}"
        )
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"claim failed: {e}")

@router.post("/extension/heartbeat")
async def heartbeat_job(
    body: HeartbeatJobInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Gia hạn lease job đang chạy định kỳ (Heartbeat)."""
    try:
        result = await control_plane_service.renew_request_lease(
            request_id=body.request_id,
            client_id=client_id,
            lease_duration_sec=body.lease_duration_sec
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/extension/progress")
async def progress_job(
    body: ProgressJobInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Cập nhật phân đoạn tiến trình (Progress Update)."""
    try:
        result = await control_plane_service.update_request_progress(
            request_id=body.request_id,
            client_id=client_id,
            progress_stage=body.progress_stage,
            progress=body.progress
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/extension/complete")
async def complete_job(
    body: CompleteJobInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Ghi nhận hoàn thành công việc và chèn Assets đồng bộ (Atomic Complete)."""
    try:
        result = await control_plane_service.complete_request_with_assets(
            request_id=body.request_id,
            client_id=client_id,
            output_result=body.output_result,
            assets=body.assets
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

@router.post("/extension/fail")
async def fail_job(
    body: FailJobInput,
    client_id: str = Depends(verify_extension_client)
) -> Dict[str, Any]:
    """Ghi nhận job thất bại và append debug snapshot (Atomic Fail)."""
    try:
        result = await control_plane_service.fail_request_with_event(
            request_id=body.request_id,
            client_id=client_id,
            error_message=body.error_message,
            debug_snapshot_bucket=body.debug_snapshot_bucket,
            debug_snapshot_key=body.debug_snapshot_key
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

# =========================================================================
# C. Nhóm API Hệ thống (Cron / Admin)
# =========================================================================

@router.post("/cron/recover-stale")
async def recover_stale(
    recover_token: Optional[str] = Header(None, alias="X-Recover-Token")
) -> Dict[str, Any]:
    """Quét và khôi phục tự động các job bị mất kết nối (Cron Stale Recovery)."""
    if not recover_token or not secrets.compare_digest(recover_token, CONTROL_PLANE_CRON_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Invalid or missing X-Recover-Token"
        )
    try:
        await control_plane_service.recover_stale_requests()
        return {"ok": True, "message": "Expired leases recovered successfully"}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
