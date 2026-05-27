"""Staging E2E smoke test for the Gemini Extension Worker.

Run against a live Control Plane server + real Supabase staging + active Chrome Gemini tab::

    # Terminal 1 — start the server
    cd flowboard/agent
    .venv/Scripts/uvicorn.exe flowboard.main:app --port 8101

    # Terminal 2 — Chrome debugging
    chrome.exe --remote-debugging-port=9222

    # Terminal 3 — run the E2E smoke test
    $env:GEMINI_E2E_ENABLED="1"
    $env:SUPABASE_URL="..."
    $env:SUPABASE_SERVICE_ROLE_KEY="..."
    python -m flowboard.extension_worker.gemini_e2e_smoke

Environment Variables Required
-------------------------------
GEMINI_E2E_ENABLED        Opt-in flag (must be set to 1)
SUPABASE_URL              Full Supabase project URL
SUPABASE_SERVICE_ROLE_KEY Service-role key (bypasses RLS for seeding)
GEMINI_E2E_USER_ID        Optional existing Supabase auth.users UUID to own seeded rows
CONTROL_PLANE_BASE_URL    Gateway base URL (default: http://127.0.0.1:8101)
GEMINI_CDP_URL            Chrome remote debugging endpoint (default: http://localhost:9222)
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

import httpx

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("gemini_e2e_smoke")


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

if os.getenv("GEMINI_E2E_ENABLED") != "1":
    sys.stderr.write(
        "SKIPPED: Staging Gemini E2E test is disabled.\n"
        "To enable it, make sure you have Chrome debugging active on port 9222 and logged in,\n"
        "then set environment variable GEMINI_E2E_ENABLED=1 and run:\n"
        "  python -m flowboard.extension_worker.gemini_e2e_smoke\n"
    )
    sys.exit(0)

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
GEMINI_E2E_USER_ID = os.getenv("GEMINI_E2E_USER_ID", "")
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")
GEMINI_CDP_URL = os.getenv("GEMINI_CDP_URL", "http://localhost:9222")

POLL_INTERVAL_SEC = 2.0
MAX_WAIT_SEC = 30.0


def _validate_env() -> None:
    missing = [v for v in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not os.getenv(v)]
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

    if GEMINI_E2E_USER_ID and not _looks_like_placeholder(GEMINI_E2E_USER_ID) and not re.fullmatch(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        GEMINI_E2E_USER_ID,
    ):
        log.error("FATAL: GEMINI_E2E_USER_ID must be a UUID when supplied")
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

    async def rpc(self, fn: str, params: Dict[str, Any]) -> Any:
        res = await self._c.post(f"/rest/v1/rpc/{fn}", json=params)
        res.raise_for_status()
        return res.json()

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
            log.warning("Delete %s?%s → HTTP %d", table, filters, res.status_code)


    async def get_auth_user(self, user_id: str) -> Optional[Dict[str, Any]]:
        res = await self._c.get(f"/auth/v1/admin/users/{user_id}")
        if res.status_code == 404:
            return None
        res.raise_for_status()
        return res.json()

    async def create_auth_user(self, run_id: str) -> Dict[str, Any]:
        payload = {
            "email": f"flowboard-e2e-{run_id}@example.invalid",
            "password": f"flowboard-e2e-{uuid.uuid4().hex}",
            "email_confirm": True,
            "user_metadata": {"flowboard_e2e": True, "run_id": run_id},
        }
        res = await self._c.post("/auth/v1/admin/users", json=payload)
        if not res.is_success:
            raise RuntimeError(f"HTTP {res.status_code} creating auth user: {res.text}")
        return res.json()

    async def delete_auth_user(self, user_id: str) -> None:
        res = await self._c.delete(f"/auth/v1/admin/users/{user_id}")
        if res.status_code not in (200, 204, 404):
            log.warning("Delete auth user %s... -> HTTP %d", user_id[:8], res.status_code)


# -------------------------------------------------------------------------
# Smoke Result Tracker
# -------------------------------------------------------------------------

class SmokeResult:
    def __init__(self) -> None:
        self.steps: List[Dict[str, Any]] = []
        self.passed = True

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        icon = "[OK]" if ok else "[FAIL]"
        log.info("%s  %s  %s", icon, name, detail)

    def print_summary(self) -> None:
        print("\n" + "=" * 60)
        print("GEMINI E2E SMOKE TEST SUMMARY")
        print("=" * 60)
        for s in self.steps:
            icon = "[OK]" if s["ok"] else "[FAIL]"
            print(f"  {icon}  {s['name']}")
            if s["detail"]:
                print(f"       {s['detail']}")
        total = len(self.steps)
        passed = sum(1 for s in self.steps if s["ok"])
        print(f"\n  {passed}/{total} checks passed")
        print("=" * 60)


# -------------------------------------------------------------------------
# Core test runner
# -------------------------------------------------------------------------

async def _run_e2e(run_id: str, result: SmokeResult) -> None:
    from flowboard.extension_worker.client import WorkerClient
    from flowboard.extension_worker.gemini_browser_driver import GeminiBrowserDriver
    from flowboard.extension_worker.gemini_executor import GeminiExecutor
    from flowboard.extension_worker.worker_loop import WorkerLoop

    test_user_id = ""
    created_auth_user_id: Optional[str] = None
    test_secret = f"gemini-smoke-secret-{run_id}"
    test_board_id = str(uuid.uuid4())
    test_node_id = str(uuid.uuid4())
    test_client_id: Optional[str] = None
    test_pairing_id: Optional[str] = None
    test_request_id: Optional[str] = None

    log.info("Run ID: %s", run_id)

    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(15.0),
    ) as sb_raw:
        db = StagingDB(sb_raw)

        try:
            # -------------------------------------------------------------- #
            # STEP 1 — Seed board
            # -------------------------------------------------------------- #
            supplied_user_id = GEMINI_E2E_USER_ID
            if supplied_user_id and not _looks_like_placeholder(supplied_user_id):
                existing_user = await db.get_auth_user(supplied_user_id)
                if existing_user:
                    test_user_id = supplied_user_id
                    result.record("Use existing auth user", True, f"user_id={test_user_id[:8]}...")
                else:
                    result.record(
                        "Use existing auth user",
                        True,
                        f"user_id={supplied_user_id[:8]}... not found; creating temporary user",
                    )

            if not test_user_id:
                auth_user = await db.create_auth_user(run_id)
                test_user_id = auth_user["id"]
                created_auth_user_id = test_user_id
                result.record("Create temporary auth user", True, f"user_id={test_user_id[:8]}...")

            try:
                board = await db.insert("boards", {
                    "id": test_board_id,
                    "user_id": test_user_id,
                    "name": f"smoke-board-{run_id}",
                })
                result.record("Seed board", bool(board.get("id")), f"board_id={test_board_id[:8]}…")
            except Exception as exc:
                result.record("Seed board", False, str(exc))
                return

            # -------------------------------------------------------------- #
            # STEP 2 — Seed node
            # -------------------------------------------------------------- #
            try:
                node = await db.insert("nodes", {
                    "id": test_node_id,
                    "user_id": test_user_id,
                    "board_id": test_board_id,
                    "type": "reference",
                    "position_x": 0,
                    "position_y": 0,
                    "data": {"title": f"smoke-node-{run_id}"},
                })
                result.record("Seed node", bool(node.get("id")), f"node_id={test_node_id[:8]}…")
            except Exception as exc:
                result.record("Seed node", False, str(exc))
                return

            # -------------------------------------------------------------- #
            # STEP 3 — Seed extension_client + pairing
            # -------------------------------------------------------------- #
            try:
                ec = await db.insert("extension_clients", {
                    "user_id": test_user_id,
                    "client_name": f"gemini-smoke-worker-{run_id}",
                    "client_installation_id": str(uuid.uuid4()),
                })
                test_client_id = ec["id"]
                result.record("Seed extension_client", bool(test_client_id),
                              f"client_id={str(test_client_id)[:8]}…")
            except Exception as exc:
                result.record("Seed extension_client", False, str(exc))
                return

            try:
                now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                pairing = await db.insert("pairings", {
                    "user_id": test_user_id,
                    "extension_client_id": test_client_id,
                    "current_secret_hash": _hash_secret(test_secret),
                    "is_active": True,
                    "paired_at": now_iso,
                })
                test_pairing_id = pairing["id"]
                result.record("Seed pairing", bool(test_pairing_id),
                              f"pairing_id={str(test_pairing_id)[:8]}…")
            except Exception as exc:
                result.record("Seed pairing", False, str(exc))
                return

            # -------------------------------------------------------------- #
            # STEP 4 — Seed queued request via RPC (provider="gemini")
            # -------------------------------------------------------------- #
            try:
                req_rows = await db.rpc("create_or_reset_request", {
                    "p_user_id": test_user_id,
                    "p_board_id": test_board_id,
                    "p_node_id": test_node_id,
                    "p_provider": "gemini",
                    "p_task_type": "txt2txt",
                    "p_input_data": {
                        "prompt": f"Reply with a short sentence saying 'E2E Gemini Staging E2E Smoke is working! {run_id}'"
                    },
                    "p_idempotency_key": f"gemini-smoke-{run_id}",
                    "p_expected_output": "text",
                })
                req = req_rows[0] if isinstance(req_rows, list) else req_rows
                test_request_id = req.get("id") or req.get("request_id")
                result.record(
                    "Seed queued request",
                    bool(test_request_id) and req.get("status") in ("queued", "pending_reset"),
                    f"request_id={str(test_request_id)[:8]}… status={req.get('status')}",
                )
            except Exception as exc:
                result.record("Seed queued request", False, str(exc))
                return

            # -------------------------------------------------------------- #
            # STEP 5 — Check gateway reachable
            # -------------------------------------------------------------- #
            try:
                async with httpx.AsyncClient(timeout=5.0) as probe:
                    ping = await probe.get(f"{CONTROL_PLANE_BASE_URL}/health")
                result.record("Gateway reachable", ping.is_success,
                              f"HTTP {ping.status_code}")
            except Exception as exc:
                result.record("Gateway reachable", False,
                              f"{exc} — is `uvicorn flowboard.main:app` running?")
                return

            # -------------------------------------------------------------- #
            # STEP 6 — Run WorkerLoop with GeminiExecutor
            # -------------------------------------------------------------- #
            driver = GeminiBrowserDriver(
                cdp_url=GEMINI_CDP_URL,
                connect_timeout_sec=5.0,
                page_ready_timeout_sec=5.0,
                generation_timeout_sec=20.0,
            )

            class _ConfiguredGeminiExecutor(GeminiExecutor):
                def __init__(self) -> None:
                    super().__init__(driver=driver, timeout_sec=20.0)

            worker_error: Optional[Exception] = None
            completed_req: Optional[Dict[str, Any]] = None

            async def _run_worker_and_poll() -> None:
                nonlocal worker_error, completed_req
                async with WorkerClient(
                    base_url=CONTROL_PLANE_BASE_URL,
                    client_id=str(test_client_id),
                    pairing_secret=test_secret,
                ) as wc:
                    loop = WorkerLoop(
                        client=wc,
                        provider="gemini",
                        poll_interval_sec=0.5,
                        heartbeat_interval_sec=30.0,
                        lease_duration_sec=60,
                        executor_class=_ConfiguredGeminiExecutor,
                        stop_after_jobs=1,  # Halts cleanly after processing the seeded job!
                    )
                    worker_task = asyncio.create_task(loop.run())

                    # Poll DB concurrently
                    deadline = asyncio.get_event_loop().time() + MAX_WAIT_SEC
                    while asyncio.get_event_loop().time() < deadline:
                        completed_req = await db.get_one(
                            "requests",
                            f"id=eq.{test_request_id}",
                        )
                        if completed_req and completed_req.get("status") in ("completed", "failed"):
                            break
                        await asyncio.sleep(POLL_INTERVAL_SEC)

                    # Make sure worker loop finishes
                    try:
                        await asyncio.wait_for(worker_task, timeout=5.0)
                    except asyncio.TimeoutError:
                        log.warning("Worker task did not stop cleanly after E2E complete")
                        loop.request_shutdown()
                        await worker_task
                    except Exception as exc:
                        worker_error = exc

            try:
                await _run_worker_and_poll()
                result.record("E2E worker processed job", worker_error is None,
                              str(worker_error) if worker_error else "")
            except Exception as exc:
                result.record("E2E worker processed job", False, str(exc))

            # -------------------------------------------------------------- #
            # STEP 7 — Verify Request Status = completed
            # -------------------------------------------------------------- #
            final_status = completed_req.get("status") if completed_req else "not_found"
            result.record(
                "Request status = completed",
                final_status == "completed",
                f"status={final_status}",
            )

            # -------------------------------------------------------------- #
            # STEP 8 — Verify Output Result fields (redacted logging)
            # -------------------------------------------------------------- #
            if completed_req and final_status == "completed":
                out = completed_req.get("output_result") or {}
                prov = out.get("provider")
                txt = out.get("text", "")
                
                txt_len = len(str(txt))
                txt_hash = hashlib.sha256(str(txt).encode("utf-8")).hexdigest()[:12]

                result.record(
                    "Output result valid",
                    prov == "gemini" and txt_len > 0,
                    f"provider={prov} response_len={txt_len} response_hash={txt_hash}",
                )
            else:
                result.record("Output result valid", False, "Request was not completed successfully")

            # -------------------------------------------------------------- #
            # STEP 9 — Verify request_events
            # -------------------------------------------------------------- #
            try:
                events = await db.get_many(
                    "request_events",
                    f"request_id=eq.{test_request_id}",
                )
                has_events = len(events) > 0
                event_types = [e.get("event_type") for e in events]
                result.record(
                    "request_events populated",
                    has_events,
                    f"count={len(events)} types={event_types}",
                )
            except Exception as exc:
                result.record("request_events populated", False, str(exc))

        finally:
            # -------------------------------------------------------------- #
            # CLEANUP — always runs (reverse FK order)
            # -------------------------------------------------------------- #
            log.info("Cleaning up E2E seeded rows…")
            if test_request_id:
                try:
                    await db.delete("assets", f"request_id=eq.{test_request_id}")
                    await db.delete("request_events", f"request_id=eq.{test_request_id}")
                    await db.delete("requests", f"id=eq.{test_request_id}")
                except Exception as exc:
                    log.warning("Failed to clean up requests/assets: %s", exc)
            if test_pairing_id:
                try:
                    await db.delete("pairings", f"id=eq.{test_pairing_id}")
                except Exception as exc:
                    log.warning("Failed to clean up pairings: %s", exc)
            if test_client_id:
                try:
                    await db.delete("extension_clients", f"id=eq.{test_client_id}")
                except Exception as exc:
                    log.warning("Failed to clean up extension clients: %s", exc)
            try:
                await db.delete("nodes", f"id=eq.{test_node_id}")
                await db.delete("boards", f"id=eq.{test_board_id}")
            except Exception as exc:
                log.warning("Failed to clean up nodes/boards: %s", exc)
            if created_auth_user_id:
                try:
                    await db.delete_auth_user(created_auth_user_id)
                except Exception as exc:
                    log.warning("Failed to clean up temporary auth user: %s", exc)
            result.record("Cleanup complete", True, "all E2E seeded rows removed")


async def main() -> int:
    _validate_env()
    run_id = str(uuid.uuid4())[:8]
    result = SmokeResult()
    log.info("Starting Staging E2E Gemini Worker smoke test — run_id=%s gateway=%s cdp=%s",
             run_id, CONTROL_PLANE_BASE_URL, GEMINI_CDP_URL)
    try:
        await _run_e2e(run_id, result)
    except Exception:
        log.exception("Unhandled error in Gemini E2E run")
        result.passed = False
    finally:
        result.print_summary()
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
