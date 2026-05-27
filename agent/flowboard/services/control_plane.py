import asyncio
import hashlib
import logging
import secrets
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
import httpx
import boto3
from botocore.config import Config

from flowboard.config import (
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    R2_ENDPOINT,
    R2_BUCKET,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY
)

logger = logging.getLogger(__name__)

class ControlPlaneService:
    def __init__(self):
        self.headers = {
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }
        # Disable verification issues or timeouts for cloud postgrest
        self.client = httpx.AsyncClient(
            base_url=SUPABASE_URL,
            headers=self.headers,
            timeout=httpx.Timeout(15.0)
        )

    def hash_secret(self, secret: str) -> str:
        """Helper to generate SHA-256 hash of rotation secrets."""
        return hashlib.sha256(secret.encode("utf-8")).hexdigest()

    def _get_s3_client(self):
        """Build a boto3 client pointing at Cloudflare R2 using S3v4 signature protocol."""
        return boto3.client(
            "s3",
            endpoint_url=R2_ENDPOINT,
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            config=Config(signature_version="s3v4"),
            region_name="auto"
        )

    async def close(self):
        """Ensure connection client is cleanly closed on shutdown."""
        await self.client.aclose()

    # =========================================================================
    # 1. CORE AI JOB REQUEST TRANSITIONS & RPC WRAPPERS
    # =========================================================================

    async def create_or_reset_request(
        self,
        user_id: str,
        board_id: str,
        node_id: str,
        provider: str,
        task_type: str,
        input_data: Dict[str, Any],
        idempotency_key: str,
        expected_output: str
    ) -> Dict[str, Any]:
        """TÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡o mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºi hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â·c reset tÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡c vÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¥ lÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Âi/hÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â§y (Atomic Create/Reset Job)."""
        payload = {
            "p_user_id": user_id,
            "p_board_id": board_id,
            "p_node_id": node_id,
            "p_provider": provider,
            "p_task_type": task_type,
            "p_input_data": input_data,
            "p_idempotency_key": idempotency_key,
            "p_expected_output": expected_output
        }
        res = await self.client.post("/rest/v1/rpc/create_or_reset_request", json=payload)
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else {}

    async def claim_next_request(
        self,
        provider: str,
        client_id: str,
        lease_duration_sec: int
    ) -> Optional[Dict[str, Any]]:
        """Claim the next queued request.

        Prefer the DB RPC when it exists. Some staging environments do not
        have the SQL RPC migration installed yet, so fall back to a narrow
        PostgREST select+patch path instead of hard-failing extension workers.
        """
        payload = {
            "p_provider": provider,
            "p_client_id": client_id,
            "p_lease_duration_sec": lease_duration_sec
        }
        try:
            res = await self.client.post("/rest/v1/rpc/claim_next_request", json=payload)
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else None
        except httpx.HTTPStatusError as exc:
            logger.warning("claim_next_request RPC failed; using fallback: %s", exc.response.text[:300])
            try:
                return await self._claim_next_request_fallback(provider, client_id, lease_duration_sec)
            except httpx.HTTPStatusError as fallback_exc:
                raise RuntimeError(
                    f"claim fallback failed HTTP {fallback_exc.response.status_code}: "
                    f"{fallback_exc.response.text[:500]}"
                ) from fallback_exc

    async def _claim_next_request_fallback(
        self,
        provider: str,
        client_id: str,
        lease_duration_sec: int,
    ) -> Optional[Dict[str, Any]]:
        res = await self.client.get(
            "/rest/v1/requests"
            f"?provider=eq.{provider}"
            "&status=eq.queued"
            "&select=*"
            "&order=created_at.asc"
            "&limit=1"
        )
        res.raise_for_status()
        rows = res.json()
        if not rows:
            return None
        request_id = rows[0]["id"]
        lease_expires = (datetime.now(timezone.utc) + timedelta(seconds=lease_duration_sec)).isoformat().replace("+00:00", "Z")
        patch = {
            "status": "running",
            "claimed_by": client_id,
            "lease_expires_at": lease_expires,
        }
        res = await self.client.patch(f"/rest/v1/requests?id=eq.{request_id}", json=patch)
        res.raise_for_status()
        patched = res.json()
        return patched[0] if patched else {**rows[0], **patch}

    async def renew_request_lease(
        self,
        request_id: str,
        client_id: str,
        lease_duration_sec: int
    ) -> Dict[str, Any]:
        """Gia hÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡n lease job ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ang chÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡y ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¹nh kÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â³ (Atomic Heartbeat)."""
        payload = {
            "p_request_id": request_id,
            "p_client_id": client_id,
            "p_lease_duration_sec": lease_duration_sec
        }
        try:
            res = await self.client.post("/rest/v1/rpc/renew_request_lease", json=payload)
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else {}
        except httpx.HTTPStatusError as exc:
            logger.warning("renew_request_lease RPC failed; using fallback: %s", exc.response.text[:300])
            lease_expires = (datetime.now(timezone.utc) + timedelta(seconds=lease_duration_sec)).isoformat().replace("+00:00", "Z")
            res = await self.client.patch(
                f"/rest/v1/requests?id=eq.{request_id}&claimed_by=eq.{client_id}",
                json={"lease_expires_at": lease_expires},
            )
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else {"id": request_id, "lease_expires_at": lease_expires}

    async def update_request_progress(
        self,
        request_id: str,
        client_id: str,
        progress_stage: str,
        progress: int
    ) -> Dict[str, Any]:
        """CÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â­p nhÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â­t phÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢n ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“oÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡n tiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿n trÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¬nh (Atomic Progress Update)."""
        payload = {
            "p_request_id": request_id,
            "p_client_id": client_id,
            "p_progress_stage": progress_stage,
            "p_progress": progress
        }
        try:
            res = await self.client.post("/rest/v1/rpc/update_request_progress", json=payload)
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else {}
        except httpx.HTTPStatusError as exc:
            logger.warning("update_request_progress RPC failed; using fallback: %s", exc.response.text[:300])
            patch = {"progress_stage": progress_stage, "progress": progress}
            res = await self.client.patch(
                f"/rest/v1/requests?id=eq.{request_id}&claimed_by=eq.{client_id}",
                json=patch,
            )
            if res.status_code >= 400:
                logger.warning("progress fallback patch skipped: %s", res.text[:300])
                return {"id": request_id, "progress_stage": progress_stage, "progress": progress}
            rows = res.json()
            return rows[0] if rows else {"id": request_id, **patch}

    async def complete_request_with_assets(
        self,
        request_id: str,
        client_id: str,
        output_result: Dict[str, Any],
        assets: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Ghi nhÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â­n hoÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â n thÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â nh cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â´ng viÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡c vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  chÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¨n Assets ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œng bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ (Atomic Complete)."""
        payload = {
            "p_request_id": request_id,
            "p_client_id": client_id,
            "p_output_result": output_result,
            "p_assets": assets
        }
        try:
            res = await self.client.post("/rest/v1/rpc/complete_request_with_assets", json=payload)
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else {}
        except httpx.HTTPStatusError as exc:
            logger.warning("complete_request_with_assets RPC failed; using fallback: %s", exc.response.text[:300])
            req = await self._get_request(request_id)
            user_id = req.get("user_id") if req else None
            for asset in assets or []:
                row = {
                    "user_id": user_id,
                    "request_id": request_id,
                    "source_provider": asset.get("source_provider"),
                    "file_name": asset.get("file_name"),
                    "storage_key": asset.get("storage_key"),
                    "mime_type": asset.get("mime_type"),
                    "byte_size": asset.get("byte_size"),
                    "checksum": asset.get("checksum"),
                    "prompt_snapshot": asset.get("prompt_snapshot"),
                }
                row = {k: v for k, v in row.items() if v is not None}
                res = await self.client.post("/rest/v1/assets", json=row)
                res.raise_for_status()
            patch = {
                "status": "completed",
                "output_result": output_result,
                "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            res = await self.client.patch(
                f"/rest/v1/requests?id=eq.{request_id}&claimed_by=eq.{client_id}",
                json=patch,
            )
            res.raise_for_status()
            await self._append_request_event(request_id, "completed", {"asset_count": len(assets or [])})
            rows = res.json()
            return rows[0] if rows else {"id": request_id, **patch}

    async def fail_request_with_event(
        self,
        request_id: str,
        client_id: str,
        error_message: str,
        debug_snapshot_bucket: Optional[str] = None,
        debug_snapshot_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Ghi nhÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â­n job thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¥t bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡i vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  append debug snapshot (Atomic Fail)."""
        payload = {
            "p_request_id": request_id,
            "p_client_id": client_id,
            "p_error_message": error_message,
            "p_debug_snapshot_bucket": debug_snapshot_bucket,
            "p_debug_snapshot_key": debug_snapshot_key
        }
        try:
            res = await self.client.post("/rest/v1/rpc/fail_request_with_event", json=payload)
            res.raise_for_status()
            rows = res.json()
            return rows[0] if rows else {}
        except httpx.HTTPStatusError as exc:
            logger.warning("fail_request_with_event RPC failed; using fallback: %s", exc.response.text[:300])
            patch = {
                "status": "failed",
                "error_message": error_message,
                "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
            res = await self.client.patch(
                f"/rest/v1/requests?id=eq.{request_id}&claimed_by=eq.{client_id}",
                json=patch,
            )
            if res.status_code >= 400:
                patch.pop("error_message", None)
                patch["error"] = error_message
                res = await self.client.patch(
                    f"/rest/v1/requests?id=eq.{request_id}&claimed_by=eq.{client_id}",
                    json=patch,
                )
            res.raise_for_status()
            await self._append_request_event(request_id, "failed", {"error_message": error_message})
            rows = res.json()
            return rows[0] if rows else {"id": request_id, **patch}

    async def _get_request(self, request_id: str) -> Optional[Dict[str, Any]]:
        res = await self.client.get(f"/rest/v1/requests?id=eq.{request_id}&select=*")
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else None

    async def _append_request_event(self, request_id: str, event_type: str, payload: Dict[str, Any]) -> None:
        try:
            res = await self.client.post(
                "/rest/v1/request_events",
                json={"request_id": request_id, "event_type": event_type, "payload": payload},
            )
            if res.status_code >= 400:
                logger.warning("request_events fallback insert skipped: %s", res.text[:300])
        except Exception as exc:
            logger.warning("request_events fallback insert failed: %s", exc)
    async def recover_stale_requests(self) -> None:
        """QuÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â©t vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  khÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â´i phÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¥c tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â± ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ng cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡c job bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¹ mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¥t kÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿t nÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“i (Cron Stale Recovery)."""
        res = await self.client.post("/rest/v1/rpc/recover_stale_requests", json={})
        res.raise_for_status()

    # =========================================================================
    # 2. PAIRING & SECURITY ENVELOPE VERIFICATIONS
    # =========================================================================

    async def validate_pairing(self, client_id: str, secret: str) -> bool:
        """XÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡c thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â±c pairing secret kÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¨m bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ lÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Âc khoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â£ng ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡m xoay vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â²ng 24h."""
        url = f"/rest/v1/pairings?extension_client_id=eq.{client_id}&is_active=eq.true"
        res = await self.client.get(url)
        res.raise_for_status()
        pairings = res.json()

        if not pairings:
            return False

        given_hash = self.hash_secret(secret)
        for p in pairings:
            # 1. KhÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºp mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ secret hash hiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡n tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡i ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â constant-time ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€ Ã¢â‚¬â„¢ trÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¡nh timing attacks
            current_hash = p.get("current_secret_hash") or ""
            if secrets.compare_digest(current_hash, given_hash):
                return True
            # 2. KhÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºp mÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â£ secret hash cÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â© nÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â±m trong khoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â£ng ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡m 24h ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â constant-time
            prev_hash = p.get("previous_secret_hash") or ""
            valid_until = p.get("previous_secret_valid_until")
            if prev_hash and valid_until:
                try:
                    expiry = datetime.fromisoformat(valid_until.replace("Z", "+00:00"))
                    if expiry > datetime.now(timezone.utc) and secrets.compare_digest(prev_hash, given_hash):
                        return True
                except Exception:
                    pass
        return False

    async def get_client_user_id(self, client_id: str) -> Optional[str]:
        """Tra cÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â©u user_id sÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€¦Ã‚Â¸ hÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¯u extension_client tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â« client_id."""
        url = f"/rest/v1/extension_clients?id=eq.{client_id}"
        res = await self.client.get(url)
        res.raise_for_status()
        clients = res.json()
        return clients[0].get("user_id") if clients else None

    async def verify_supabase_jwt(self, token: str) -> Optional[str]:
        """Verify Supabase JWT against Supabase Auth API endpoint `/auth/v1/user`."""
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                res = await client.get(
                    f"{SUPABASE_URL}/auth/v1/user",
                    headers={
                        "apikey": SUPABASE_SERVICE_ROLE_KEY,
                        "Authorization": f"Bearer {token}"
                    }
                )
                if res.status_code == 200:
                    user_data = res.json()
                    return user_data.get("id")
        except Exception as e:
            logger.error(f"Error verifying Supabase JWT: {e}")
        return None

    async def get_user_asset(self, user_id: str, asset_id: str) -> Optional[Dict[str, Any]]:
        """Get an asset by ID if it belongs to the user."""
        url = f"/rest/v1/assets?id=eq.{asset_id}&user_id=eq.{user_id}"
        res = await self.client.get(url)
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else None

    async def get_user_pairing(self, user_id: str, pairing_id: str) -> Optional[Dict[str, Any]]:
        """Get a pairing by ID if it belongs to the user."""
        url = f"/rest/v1/pairings?id=eq.{pairing_id}&user_id=eq.{user_id}"
        res = await self.client.get(url)
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else None

    async def register_pairing(
        self,
        user_id: str,
        client_name: str,
        client_installation_id: str,
        secret: str
    ) -> Dict[str, Any]:
        """TÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡o/LÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¥y Client ID vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â±c hiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡n tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡o Pairing mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºi cho thiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿t bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¹."""
        # 1. KiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€ Ã¢â‚¬â„¢m tra hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â·c tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡o mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºi client_id
        url = f"/rest/v1/extension_clients?user_id=eq.{user_id}&client_installation_id=eq.{client_installation_id}"
        res = await self.client.get(url)
        res.raise_for_status()
        clients = res.json()

        if clients:
            client_id = clients[0]["id"]
        else:
            client_payload = {
                "user_id": user_id,
                "client_name": client_name,
                "client_installation_id": client_installation_id,
                "is_online": True,
            }
            res = await self.client.post("/rest/v1/extension_clients", json=client_payload)
            res.raise_for_status()
            client_id = res.json()[0]["id"]

        # 2. VÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â´ hiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡u hÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³a pairings cÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â© (Revoke old active pairings)
        # Note: revoked_at is omitted here because DB triggers automatically handle revoked_at updates
        await self.client.patch(
            f"/rest/v1/pairings?user_id=eq.{user_id}&extension_client_id=eq.{client_id}&is_active=eq.true",
            json={"is_active": False}
        )

        # 3. TÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡o bÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â£n ghi Pairing hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡t ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ng mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºi
        secret_hash = self.hash_secret(secret)
        pairing_payload = {
            "user_id": user_id,
            "extension_client_id": client_id,
            "current_secret_hash": secret_hash,
            "is_active": True
        }
        res = await self.client.post("/rest/v1/pairings", json=pairing_payload)
        res.raise_for_status()
        return {"client_id": client_id, "pairing": res.json()[0]}

    async def rotate_pairing_secret(self, pairing_id: str, new_secret: str, user_id: Optional[str] = None) -> Dict[str, Any]:
        """Xoay vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â²ng pairing secret (current -> previous) vÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Âºi 24h grace overlap window."""
        # 1. LÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¥y dÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¯ liÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡u pairing cÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â© ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â scope by user_id nÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿u cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³ ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€ Ã¢â‚¬â„¢ tÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€ Ã¢â‚¬â„¢ng defense-in-depth
        if user_id:
            url = f"/rest/v1/pairings?id=eq.{pairing_id}&user_id=eq.{user_id}"
        else:
            url = f"/rest/v1/pairings?id=eq.{pairing_id}"
        res = await self.client.get(url)
        res.raise_for_status()
        rows = res.json()
        if not rows:
            raise ValueError("Pairing record not found")
        old_pairing = rows[0]

        # 2. Xoay vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â²ng secret vÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â  lÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â°u hash cÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â©
        from datetime import timedelta
        new_hash = self.hash_secret(new_secret)
        grace_expiry = datetime.now(timezone.utc) + timedelta(days=1)
        grace_expiry_str = grace_expiry.isoformat().replace("+00:00", "Z")
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        update_payload = {
            "current_secret_hash": new_hash,
            "previous_secret_hash": old_pairing["current_secret_hash"],
            "previous_secret_valid_until": grace_expiry_str,
            "rotated_at": now_iso
        }
        # Scope PATCH by both id AND user_id for defense-in-depth (TOCTOU protection)
        if user_id:
            patch_url = f"/rest/v1/pairings?id=eq.{pairing_id}&user_id=eq.{user_id}"
        else:
            patch_url = f"/rest/v1/pairings?id=eq.{pairing_id}"
        res = await self.client.patch(patch_url, json=update_payload)
        res.raise_for_status()
        return res.json()[0]

    # =========================================================================
    # 3. CLOUDFLARE R2 PRESIGNED S3v4 URL SIGNATURES
    # =========================================================================

    def generate_read_url(self, storage_key: str) -> str:
        """Sinh signed URL thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Âi gian ngÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¯n (15 phÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âºt) ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€ Ã¢â‚¬â„¢ tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â£i file R2 vÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â hiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€ Ã¢â‚¬â„¢n thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¹."""
        s3 = self._get_s3_client()
        return s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": R2_BUCKET, "Key": storage_key},
            ExpiresIn=900 # 15 minutes
        )

    def generate_upload_url(self, storage_key: str, content_type: str, expires_in: int = 900) -> str:
        """Sinh presigned URL cho phÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â©p frontend/extension upload tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡p trÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â±c tiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿p lÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªn R2."""
        s3 = self._get_s3_client()
        return s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": R2_BUCKET,
                "Key": storage_key,
                "ContentType": content_type
            },
            ExpiresIn=expires_in
        )

# Global singleton instance
control_plane_service = ControlPlaneService()
