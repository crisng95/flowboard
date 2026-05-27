"""Cloud Worker E2E smoke test.

This orchestrator validates the production-style Chrome Extension worker path.
It does not start WorkerLoop, CDP, Playwright, or the local extension WS bridge.

Flow:
    seed queued request in staging DB
    -> installed Chrome extension claims/executes it through /api/extension/*
    -> extension calls Google Flow, uploads generated media to R2
    -> script polls DB, verifies asset metadata and R2 object checksum
    -> cleanup DB rows and R2 object

Opt-in guard:
    set CLOUD_WORKER_E2E_ENABLED=1 before running.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import boto3
from botocore.config import Config
import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("cloud_worker_e2e")

DEFAULT_USER_ID = "04f92ad6-527d-4bb2-83d9-f24fbba8d280"
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")
POLL_INTERVAL_SEC = float(os.getenv("CLOUD_WORKER_E2E_POLL_SEC", "2"))
MAX_WAIT_SEC = float(os.getenv("CLOUD_WORKER_E2E_TIMEOUT_SEC", "180"))


def _looks_like_placeholder(value: str) -> bool:
    upper = value.upper()
    return (
        not value
        or "YOUR_" in upper
        or "PASTE_" in upper
        or "EXISTING_AUTH_USER_UUID" in upper
        or "DAN_" in upper
        or "DAN-" in upper
    )


def _load_env_staging() -> None:
    env_path = Path.cwd() / ".env.staging"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        current = os.getenv(key, "")
        if not current or _looks_like_placeholder(current):
            os.environ[key] = value


_load_env_staging()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
TARGET_USER_ID = os.getenv("CLOUD_WORKER_E2E_USER_ID") or DEFAULT_USER_ID
R2_ENDPOINT = os.getenv("R2_ENDPOINT", "")
R2_BUCKET = os.getenv("R2_BUCKET", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")


def _validate_env() -> None:
    missing = [
        name
        for name in (
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "R2_ENDPOINT",
            "R2_BUCKET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
        )
        if not os.getenv(name)
    ]
    if missing:
        raise RuntimeError(f"missing required env vars: {', '.join(missing)}")
    if not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        TARGET_USER_ID,
    ):
        raise RuntimeError("CLOUD_WORKER_E2E_USER_ID must be a UUID")


def _sb_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _r2_client():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


class StagingDB:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def insert(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        res = await self._c.post(f"/rest/v1/{table}", json=row)
        if not res.is_success:
            raise RuntimeError(f"insert {table} HTTP {res.status_code}: {res.text}")
        rows = res.json()
        return rows[0] if rows else {}

    async def get_one(self, table: str, filters: str, select: str = "*") -> Optional[Dict[str, Any]]:
        res = await self._c.get(f"/rest/v1/{table}?{filters}&select={select}")
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else None

    async def get_many(self, table: str, filters: str, select: str = "*") -> List[Dict[str, Any]]:
        res = await self._c.get(f"/rest/v1/{table}?{filters}&select={select}")
        res.raise_for_status()
        return res.json()

    async def delete(self, table: str, filters: str) -> None:
        res = await self._c.delete(f"/rest/v1/{table}?{filters}")
        if res.status_code not in (200, 204, 404):
            log.warning("delete %s?%s -> HTTP %d: %s", table, filters, res.status_code, res.text[:200])

    async def get_auth_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        res = await self._c.get(f"/auth/v1/admin/users/{user_id}")
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return res.json()


class SmokeResult:
    def __init__(self) -> None:
        self.steps: List[Dict[str, Any]] = []
        self.passed = True

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        log.info("%s  %s  %s", "[OK]" if ok else "[FAIL]", name, detail)

    def print_summary(self) -> None:
        print("\n" + "=" * 72)
        print("CLOUD WORKER E2E SMOKE TEST SUMMARY")
        print("=" * 72)
        for step in self.steps:
            print(f"  {'[OK]' if step['ok'] else '[FAIL]'}  {step['name']}")
            if step["detail"]:
                print(f"       {step['detail']}")
        passed = sum(1 for s in self.steps if s["ok"])
        print(f"\n  {passed}/{len(self.steps)} checks passed")
        print("=" * 72)


async def _gateway_preflight(result: SmokeResult) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(f"{CONTROL_PLANE_BASE_URL.rstrip('/')}/api/health")
        ok = res.status_code == 200
        result.record("Gateway reachable", ok, f"HTTP {res.status_code} {CONTROL_PLANE_BASE_URL}")
    except Exception as exc:
        result.record("Gateway reachable", False, str(exc))


async def _run() -> int:
    if os.getenv("CLOUD_WORKER_E2E_ENABLED") != "1":
        sys.stderr.write(
            "SKIPPED: Cloud Worker E2E is disabled.\n"
            "Set CLOUD_WORKER_E2E_ENABLED=1 when the Chrome extension is active and paired.\n"
        )
        return 0

    _validate_env()
    run_id = uuid.uuid4().hex[:8]
    board_id = str(uuid.uuid4())
    node_id = str(uuid.uuid4())
    request_id = str(uuid.uuid4())
    storage_keys: List[str] = []
    result = SmokeResult()

    log.info("Run ID: %s", run_id)
    log.info("Target user: %s", TARGET_USER_ID)

    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(20.0),
    ) as raw:
        db = StagingDB(raw)
        try:
            await _gateway_preflight(result)
            if not result.passed:
                return 2

            auth_user = await db.get_auth_user(TARGET_USER_ID)
            result.record("Target auth user exists", bool(auth_user), f"user={TARGET_USER_ID[:8]}...")
            if not auth_user:
                return 2

            board = await db.insert("boards", {
                "id": board_id,
                "user_id": TARGET_USER_ID,
                "name": f"cloud-worker-e2e-{run_id}",
            })
            result.record("Seed board", bool(board.get("id")), f"board_id={board_id[:8]}...")

            node = await db.insert("nodes", {
                "id": node_id,
                "user_id": TARGET_USER_ID,
                "board_id": board_id,
                "type": "variant",
                "position_x": 0,
                "position_y": 0,
                "data": {"type": "variant", "smoke": True},
            })
            result.record("Seed node", bool(node.get("id")), f"node_id={node_id[:8]}...")

            prompt = "A beautiful ultra-detailed crystal flower inside a cosmic forest"
            req = await db.insert("requests", {
                "id": request_id,
                "user_id": TARGET_USER_ID,
                "board_id": board_id,
                "node_id": node_id,
                "provider": "flow",
                "task_type": "txt2img",
                "status": "queued",
                "input_data": {"prompt": prompt, "smoke": True},
                "expected_output": "image",
                "idempotency_key": f"cloud-worker-e2e-{run_id}",
            })
            result.record("Seed queued flow request", bool(req.get("id")), f"request_id={request_id[:8]}...")

            last_status = None
            deadline = time.monotonic() + MAX_WAIT_SEC
            final_req: Optional[Dict[str, Any]] = None
            while time.monotonic() < deadline:
                final_req = await db.get_one("requests", f"id=eq.{request_id}")
                status = final_req.get("status") if final_req else "missing"
                if status != last_status:
                    log.info("request status transition: %s", status)
                    last_status = status
                if status in {"completed", "failed", "timeout", "canceled"}:
                    break
                await asyncio.sleep(POLL_INTERVAL_SEC)

            final_status = final_req.get("status") if final_req else "missing"
            result.record("Request completed", final_status == "completed", f"status={final_status}")
            if final_status != "completed":
                events = await db.get_many("request_events", f"request_id=eq.{request_id}")
                result.record("Failure diagnostics", False, f"request={final_req} events={events[:3]}")
                return 1

            asset = await db.get_one("assets", f"request_id=eq.{request_id}")
            result.record("DB asset row exists", bool(asset), f"asset_id={(asset or {}).get('id', '')}")
            if not asset:
                return 1

            storage_key = asset.get("storage_key") or ""
            storage_keys.append(storage_key)
            expected_prefix = f"users/{TARGET_USER_ID}/flow/{request_id}/output-0."
            result.record("Asset storage key prefix", storage_key.startswith(expected_prefix), storage_key)

            checksum = (asset.get("checksum") or "").lower()
            result.record("Asset checksum shape", bool(re.fullmatch(r"[0-9a-f]{64}", checksum)), checksum[:12])

            s3 = _r2_client()
            obj = s3.get_object(Bucket=R2_BUCKET, Key=storage_key)
            content = obj["Body"].read()
            actual_checksum = hashlib.sha256(content).hexdigest()
            result.record("R2 object exists", bool(content), f"bytes={len(content)}")
            result.record("R2 checksum matches DB", actual_checksum == checksum, actual_checksum[:12])

            return 0 if result.passed else 1
        finally:
            log.info("Starting cleanup for run_id=%s", run_id)
            if storage_keys:
                s3 = _r2_client()
                for key in storage_keys:
                    if key:
                        try:
                            s3.delete_object(Bucket=R2_BUCKET, Key=key)
                            log.info("deleted R2 object %s", key)
                        except Exception as exc:
                            log.warning("failed deleting R2 object %s: %s", key, exc)
            await db.delete("request_events", f"request_id=eq.{request_id}")
            await db.delete("assets", f"request_id=eq.{request_id}")
            await db.delete("requests", f"id=eq.{request_id}")
            await db.delete("nodes", f"id=eq.{node_id}")
            await db.delete("boards", f"id=eq.{board_id}")
            result.print_summary()


def main() -> None:
    raise SystemExit(asyncio.run(_run()))


if __name__ == "__main__":
    main()