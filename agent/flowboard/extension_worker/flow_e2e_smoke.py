"""Staging E2E smoke test for the Flow Visual Extension Worker.

Runs a controlled E2E flow that exercises:
FlowAPIDriver -> real Flow API (batchGenerateImages) -> AssetUploader -> R2 PUT -> complete -> DB verify -> cleanup.

Requires: Chrome extension connected to the agent (Bearer token captured).
Only runs if environment variable FLOW_E2E_ENABLED=1 is set.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import boto3
from botocore.config import Config

import httpx

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("flow_e2e_smoke")


def _looks_like_placeholder(value: str) -> bool:
    upper = value.upper()
    return (
        not value
        or "YOUR_" in upper
        or "PASTE_" in upper
        or "EXISTING_AUTH_USER_UUID" in upper
        or "DAN_" in upper
        or "DÁN_" in upper
    )


def _load_env_staging() -> None:
    """Load local .env.staging without printing secrets.

    Values from the file override missing or placeholder shell variables only.
    Real shell variables still win, which keeps CI/manual overrides possible.
    """
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

# -------------------------------------------------------------------------
# Environment & Opt-In Guard
# -------------------------------------------------------------------------

if os.getenv("FLOW_E2E_ENABLED") != "1":
    sys.stderr.write(
        "SKIPPED: Staging Flow E2E test is disabled.\n"
        "To enable it, make sure you have Chrome debugging active on port 9222 and logged in,\n"
        "then set environment variable FLOW_E2E_ENABLED=1 and run:\n"
        "  python -m flowboard.extension_worker.flow_e2e_smoke\n"
    )
    sys.exit(0)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FLOW_E2E_USER_ID = os.getenv("FLOW_E2E_USER_ID", "")
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")
FLOW_CDP_URL = os.getenv("FLOW_CDP_URL", "http://localhost:9222")

R2_ENDPOINT = os.getenv("R2_ENDPOINT", "")
R2_BUCKET = os.getenv("R2_BUCKET", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")

POLL_INTERVAL_SEC = 2.0
MAX_WAIT_SEC = 30.0


def _validate_env() -> None:
    missing = [
        v for v in (
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "R2_ENDPOINT",
            "R2_BUCKET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY"
        ) if not os.getenv(v)
    ]
    if missing:
        log.error("FATAL: missing required env vars: %s", ", ".join(missing))
        sys.exit(2)

    if not SUPABASE_URL.startswith(("http://", "https://")):
        log.error("FATAL: SUPABASE_URL must start with http:// or https://")
        sys.exit(2)

    if _looks_like_placeholder(SUPABASE_SERVICE_ROLE_KEY):
        log.error("FATAL: SUPABASE_SERVICE_ROLE_KEY is still a placeholder")
        sys.exit(2)

    try:
        SUPABASE_SERVICE_ROLE_KEY.encode("ascii")
    except UnicodeEncodeError:
        log.error("FATAL: SUPABASE_SERVICE_ROLE_KEY must be an ASCII JWT, not placeholder text")
        sys.exit(2)

    if FLOW_E2E_USER_ID and not _looks_like_placeholder(FLOW_E2E_USER_ID) and not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        FLOW_E2E_USER_ID,
    ):
        log.error("FATAL: FLOW_E2E_USER_ID must be a UUID when supplied")
        sys.exit(2)


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


# -------------------------------------------------------------------------
# DB postgREST client
# -------------------------------------------------------------------------

def _sb_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


class StagingDB:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def insert(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        res = await self._c.post(f"/rest/v1/{table}", json=row)
        if not res.is_success:
            raise RuntimeError(f"HTTP {res.status_code} inserting {table}: {res.text}")
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
            log.warning("Delete %s?%s -> HTTP %d", table, filters, res.status_code)

    async def get_auth_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        res = await self._c.get(f"/auth/v1/admin/users/{user_id}")
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return res.json()

    async def create_auth_user(self, run_id: str) -> Dict[str, Any]:
        payload = {
            "email": f"flow-e2e-{run_id}@example.invalid",
            "password": f"secure-pass-{run_id}",
            "email_confirm": True,
        }
        res = await self._c.post("/auth/v1/admin/users", json=payload)
        res.raise_for_status()
        return res.json()

    async def delete_auth_user(self, user_id: str) -> None:
        res = await self._c.delete(f"/auth/v1/admin/users/{user_id}")
        if res.status_code not in (200, 204, 404):
            log.warning("Delete auth user %s -> HTTP %d", user_id, res.status_code)


class SmokeResult:
    def __init__(self) -> None:
        self.steps: List[Dict[str, Any]] = []
        self.passed = True

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        status_label = "[OK]" if ok else "[FAIL]"
        log.info("%s  %s  %s", status_label, name, detail)

    def print_summary(self) -> None:
        print("\n" + "=" * 60)
        print("FLOW E2E SMOKE TEST SUMMARY")
        print("=" * 60)
        for s in self.steps:
            status_label = "[OK]" if s["ok"] else "[FAIL]"
            print(f"  {status_label}  {s['name']}")
            if s["detail"]:
                print(f"       {s['detail']}")
        total = len(self.steps)
        passed = sum(1 for s in self.steps if s["ok"])
        print(f"\n  {passed}/{total} checks passed")
        print("=" * 60)


async def _run_smoke(run_id: str, result: SmokeResult) -> None:
    from flowboard.extension_worker.client import WorkerClient
    from flowboard.extension_worker.flow_executor import FlowExecutor
    from flowboard.extension_worker.flow_api_driver import FlowAPIDriver
    from flowboard.extension_worker.asset_uploader import AssetUploader
    from flowboard.extension_worker.worker_loop import WorkerLoop
    from flowboard.services.flow_client import flow_client as _flow_client

    test_user_id = FLOW_E2E_USER_ID if (FLOW_E2E_USER_ID and not _looks_like_placeholder(FLOW_E2E_USER_ID)) else None
    test_secret = f"smoke-secret-{run_id}"
    test_board_id = str(uuid.uuid4())
    test_node_id = str(uuid.uuid4())
    test_client_id: Optional[str] = None
    test_pairing_id: Optional[str] = None
    test_request_id = str(uuid.uuid4())
    did_create_user = False
    storage_key = ""

    log.info("Run ID: %s", run_id)

    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(15.0),
    ) as sb_raw:
        db = StagingDB(sb_raw)

        # ------------------------------------------------------------------ #
        # Step 0 — Reachability pre-check
        # ------------------------------------------------------------------ #
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                await c.get(CONTROL_PLANE_BASE_URL)
            result.record("Gateway reachable", True, CONTROL_PLANE_BASE_URL)
        except Exception as exc:
            result.record("Gateway reachable", False, f"Gateway at {CONTROL_PLANE_BASE_URL} unreachable: {exc}")
            return

        try:
            # ------------------------------------------------------------------ #
            # Step 1 — Auth owner setup
            # ------------------------------------------------------------------ #
            if test_user_id:
                user = await db.get_auth_user(test_user_id)
                if not user:
                    result.record("Resolve auth user", False, f"Supplied USER_ID {test_user_id} not found in staging auth")
                    return
                result.record("Resolve auth user", True, f"Using existing user={test_user_id[:8]}...")
            else:
                try:
                    user = await db.create_auth_user(run_id)
                    test_user_id = user["id"]
                    did_create_user = True
                    result.record("Create auth user", True, f"Created temporary user={test_user_id[:8]}...")
                except Exception as exc:
                    result.record("Create auth user", False, str(exc))
                    return

            # ------------------------------------------------------------------ #
            # Step 2 — Seed Board
            # ------------------------------------------------------------------ #
            try:
                board = await db.insert("boards", {
                    "id": test_board_id,
                    "user_id": test_user_id,
                    "name": f"smoke-board-{run_id}",
                })
                result.record("Seed board", bool(board.get("id")), f"board_id={test_board_id[:8]}...")
            except Exception as exc:
                result.record("Seed board", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # Step 3 — Seed Node
            # ------------------------------------------------------------------ #
            try:
                node = await db.insert("nodes", {
                    "id": test_node_id,
                    "user_id": test_user_id,
                    "board_id": test_board_id,
                    "type": "variant",
                    "position_x": 0,
                    "position_y": 0,
                    "data": {"type": "variant"}
                })
                result.record("Seed node", bool(node.get("id")), f"node_id={test_node_id[:8]}...")
            except Exception as exc:
                result.record("Seed node", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # Step 4 — Seed client + pairing
            # ------------------------------------------------------------------ #
            try:
                ec = await db.insert("extension_clients", {
                    "user_id": test_user_id,
                    "client_name": f"smoke-worker-{run_id}",
                    "client_installation_id": str(uuid.uuid4()),
                })
                test_client_id = ec["id"]
                result.record("Seed extension_client", bool(test_client_id), f"client_id={test_client_id[:8]}...")
            except Exception as exc:
                result.record("Seed extension_client", False, str(exc))
                return

            try:
                secret_hash = _hash_secret(test_secret)
                pairing = await db.insert("pairings", {
                    "user_id": test_user_id,
                    "extension_client_id": test_client_id,
                    "current_secret_hash": secret_hash,
                    "is_active": True
                })
                test_pairing_id = pairing["id"]
                result.record("Seed pairing", bool(test_pairing_id), f"pairing_id={test_pairing_id[:8]}...")
            except Exception as exc:
                result.record("Seed pairing", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # Step 5 — Seed request
            # ------------------------------------------------------------------ #
            try:
                req = await db.insert("requests", {
                    "id": test_request_id,
                    "user_id": test_user_id,
                    "board_id": test_board_id,
                    "node_id": test_node_id,
                    "provider": "flow",
                    "task_type": "txt2img",
                    "status": "queued",
                    "input_data": {"prompt": "A spectacular scenic valley view"},
                    "expected_output": "image",
                    "idempotency_key": f"idemp-{run_id}",
                })
                result.record("Seed request", bool(req.get("id")), f"request_id={test_request_id[:8]}...")
            except Exception as exc:
                result.record("Seed request", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # Step 6 — Spin up worker loop (mock PNG R2 integration execution)
            # ------------------------------------------------------------------ #
            storage_key = ""  # Dynamically resolved from DB asset row
            log.info("Starting worker loop context run...")

            async with WorkerClient(
                base_url=CONTROL_PLANE_BASE_URL,
                client_id=test_client_id,
                pairing_secret=test_secret
            ) as wc:
                uploader = AssetUploader(wc)

                # Use FlowAPIDriver — extension bridge (Bearer token via WS),
                # no DOM automation. Requires extension to be connected.
                if not _flow_client.connected:
                    log.warning(
                        "[smoke] Flow extension is not connected — "
                        "FlowAPIDriver will fail; ensure extension is running and paired."
                    )
                _driver = FlowAPIDriver(
                    client=_flow_client,
                    # tier resolved live from extension; default PAYGATE_TIER_ONE if cold
                )
                _uploader = uploader
                executor_class = lambda *args, **kwargs: FlowExecutor(
                    driver=_driver,
                    uploader=_uploader,
                    **{k: v for k, v in kwargs.items() if k not in ("uploader", "driver")}
                )

                worker = WorkerLoop(
                    client=wc,
                    provider="flow",
                    poll_interval_sec=1.0,
                    executor_class=executor_class,
                    stop_after_jobs=1
                )

                try:
                    await asyncio.wait_for(worker.run(), timeout=25.0)
                    worker_req = await db.get_one("requests", f"id=eq.{test_request_id}", select="status")
                    worker_status = worker_req.get("status") if worker_req else "null"
                    result.record(
                        "Worker processed job successfully",
                        worker_status == "completed",
                        f"status={worker_status}",
                    )
                except Exception as exc:
                    result.record("Worker processed job successfully", False, f"Worker loop errored: {exc}")
                    return

            # ------------------------------------------------------------------ #
            # Step 7 — Staging verification
            # ------------------------------------------------------------------ #
            start_wait = asyncio.get_event_loop().time()
            is_completed = False
            while asyncio.get_event_loop().time() - start_wait < MAX_WAIT_SEC:
                req_status = await db.get_one("requests", f"id=eq.{test_request_id}", select="status")
                if req_status and req_status["status"] == "completed":
                    is_completed = True
                    break
                await asyncio.sleep(POLL_INTERVAL_SEC)

            result.record("Request status completed", is_completed, f"status={req_status.get('status') if req_status else 'null'}")

            # Verify request events exists
            events = await db.get_many("request_events", f"request_id=eq.{test_request_id}")
            result.record("Verify DB request events", len(events) >= 2, f"count={len(events)}")

            # Verify DB asset exists
            asset_row = await db.get_one("assets", f"request_id=eq.{test_request_id}")
            if asset_row:
                storage_key = asset_row["storage_key"]
                result.record("Verify DB asset row presence", True, f"asset_id={asset_row['id'][:8]}...")
                
                expected_prefix = f"users/{test_user_id}/flow/{test_request_id}/output-0."
                matches_prefix = storage_key.startswith(expected_prefix)
                result.record("Verify storage key prefix matches sandbox format", matches_prefix, f"key={storage_key}")
            else:
                result.record("Verify DB asset row presence", False, "No asset row found in DB")

        except Exception as exc:
            result.record("Flow E2E test execution", False, str(exc))

        finally:
            log.info("Starting safe E2E cleanup routine...")

            # Safe cleanup of R2 object under exact folder sandbox prefix
            if test_user_id and test_request_id and storage_key:
                try:
                    s3 = boto3.client(
                        "s3",
                        endpoint_url=R2_ENDPOINT,
                        aws_access_key_id=R2_ACCESS_KEY_ID,
                        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
                        config=Config(signature_version="s3v4"),
                        region_name="auto"
                    )
                    s3.delete_object(Bucket=R2_BUCKET, Key=storage_key)
                    log.info("R2 sandbox output object cleaned successfully.")
                except Exception as e:
                    log.warning("Failed to clean up R2 sandbox object: %s", e)

            # Reverse FK deletion order
            if test_request_id:
                await db.delete("request_events", f"request_id=eq.{test_request_id}")
                await db.delete("assets", f"request_id=eq.{test_request_id}")
                await db.delete("requests", f"id=eq.{test_request_id}")
            if test_pairing_id:
                await db.delete("pairings", f"id=eq.{test_pairing_id}")
            if test_client_id:
                await db.delete("extension_clients", f"id=eq.{test_client_id}")
            if test_node_id:
                await db.delete("nodes", f"id=eq.{test_node_id}")
            if test_board_id:
                await db.delete("boards", f"id=eq.{test_board_id}")
            if did_create_user and test_user_id:
                await db.delete_auth_user(test_user_id)

            log.info("Database E2E cleanup completed successfully.")


async def main() -> None:
    _validate_env()
    run_id = str(uuid.uuid4())[:8]
    result = SmokeResult()

    log.info("============================================================")
    log.info("Flow Visual Staging E2E Smoke Script starting...")
    log.info("============================================================")

    try:
        await _run_smoke(run_id, result)
    except Exception as exc:
        result.record("E2E loop execution", False, str(exc))

    result.print_summary()
    if not result.passed:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
