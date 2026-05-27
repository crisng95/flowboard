"""WorkerClient — thin async HTTP wrapper around Control Plane extension endpoints.

All requests carry X-Client-Id + X-Pairing-Secret headers.
Callers get raw dicts back; error handling is left to WorkerLoop.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

# HTTP status considered "no job available" on /claim
_NO_JOB_STATUS = 409


class WorkerClientError(Exception):
    """Raised when the gateway returns a non-2xx / unexpected response."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(f"HTTP {status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


class WorkerAuthError(WorkerClientError):
    """Raised specifically on 401 Unauthorized (wrong / expired pairing secret)."""


class NoJobAvailableError(Exception):
    """Raised when the gateway returns 409 — queue is empty for this provider."""


class WorkerClient:
    """Async HTTP client for the Control Plane extension API.

    Usage::

        async with WorkerClient(base_url, client_id, pairing_secret) as wc:
            job = await wc.claim("mock")
    """

    def __init__(
        self,
        base_url: str,
        client_id: str,
        pairing_secret: str,
        timeout: float = 15.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client_id = client_id
        self._pairing_secret = pairing_secret
        self._timeout = timeout
        self._http: Optional[httpx.AsyncClient] = None

    # ------------------------------------------------------------------ #
    # Context-manager lifecycle
    # ------------------------------------------------------------------ #

    async def __aenter__(self) -> "WorkerClient":
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            headers={
                "X-Client-Id": self._client_id,
                "X-Pairing-Secret": self._pairing_secret,
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(self._timeout),
        )
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._http:
            await self._http.aclose()

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _assert_open(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("WorkerClient must be used as an async context manager.")
        return self._http

    def _raise_for(self, res: httpx.Response) -> None:
        if res.status_code == 401:
            detail = res.json().get("detail", "Unauthorized")
            raise WorkerAuthError(401, detail)
        if res.status_code == 409:
            raise NoJobAvailableError("No queued job for this provider")
        if not res.is_success:
            try:
                detail = res.json().get("detail", res.text)
            except Exception:
                detail = res.text
            raise WorkerClientError(res.status_code, detail)

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    async def claim(self, provider: str, lease_duration_sec: int = 60) -> Dict[str, Any]:
        """Atomically claim the next queued job.

        Raises:
            WorkerAuthError: on 401 (bad credentials).
            NoJobAvailableError: on 409 (empty queue).
            WorkerClientError: on any other gateway error.
        """
        http = self._assert_open()
        res = await http.post(
            "/api/extension/claim",
            json={"provider": provider, "lease_duration_sec": lease_duration_sec},
        )
        self._raise_for(res)
        logger.info("[worker] claimed job %s", res.json().get("id"))
        return res.json()

    async def heartbeat(self, request_id: str, lease_duration_sec: int = 60) -> Dict[str, Any]:
        """Renew the lease on an active job."""
        http = self._assert_open()
        res = await http.post(
            "/api/extension/heartbeat",
            json={"request_id": request_id, "lease_duration_sec": lease_duration_sec},
        )
        self._raise_for(res)
        logger.debug("[worker] heartbeat ok for %s", request_id)
        return res.json()

    async def progress(
        self, request_id: str, progress_stage: str, progress: int
    ) -> Dict[str, Any]:
        """Report intermediate progress percentage (0-100)."""
        http = self._assert_open()
        res = await http.post(
            "/api/extension/progress",
            json={
                "request_id": request_id,
                "progress_stage": progress_stage,
                "progress": progress,
            },
        )
        self._raise_for(res)
        logger.debug("[worker] progress %s%% (%s) for %s", progress, progress_stage, request_id)
        return res.json()

    async def complete(
        self,
        request_id: str,
        output_result: Dict[str, Any],
        assets: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Mark the job as completed and attach asset metadata."""
        http = self._assert_open()
        res = await http.post(
            "/api/extension/complete",
            json={
                "request_id": request_id,
                "output_result": output_result,
                "assets": assets or [],
            },
        )
        self._raise_for(res)
        logger.info("[worker] completed job %s", request_id)
        return res.json()

    async def fail(
        self,
        request_id: str,
        error_message: str,
        debug_snapshot_bucket: Optional[str] = None,
        debug_snapshot_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Mark the job as failed and attach optional debug snapshot reference."""
        http = self._assert_open()
        res = await http.post(
            "/api/extension/fail",
            json={
                "request_id": request_id,
                "error_message": error_message,
                "debug_snapshot_bucket": debug_snapshot_bucket,
                "debug_snapshot_key": debug_snapshot_key,
            },
        )
        self._raise_for(res)
        logger.warning("[worker] failed job %s — %s", request_id, error_message)
        return res.json()

    async def sign_upload(
        self,
        storage_key: str,
        content_type: str,
        expires_in: int = 900,
    ) -> Dict[str, Any]:
        """Request a presigned upload URL from the Control Plane."""
        http = self._assert_open()
        res = await http.post(
            "/api/extension/sign-upload",
            json={
                "storage_key": storage_key,
                "content_type": content_type,
                "expires_in": expires_in,
            },
        )
        self._raise_for(res)
        return res.json()
