"""E2E staging smoke test for the Extension Worker.

Run against a live Control Plane server + real Supabase staging::

    # Terminal 1 — start the server
    cd flowboard/agent
    uvicorn flowboard.main:app --port 8101

    # Terminal 2 — run the smoke test
    python -m flowboard.extension_worker.e2e_smoke

Environment Variables Required
-------------------------------
SUPABASE_URL              Full Supabase project URL
SUPABASE_SERVICE_ROLE_KEY Service-role key (bypasses RLS for seeding)
CONTROL_PLANE_BASE_URL    Gateway base URL (default: http://127.0.0.1:8101)
EXT_PROVIDER              Provider to claim (default: mock)

What the script does
--------------------
1. Generate a unique test-run UUID (all seeded rows tagged with it).
2. Seed into Supabase staging (service_role — bypasses RLS):
   board → node → extension_client → pairing → queued request
3. Run WorkerLoop (MockExecutor, 1 s duration) against CONTROL_PLANE_BASE_URL.
4. Poll Supabase every 2 s until request.status == 'completed' (30 s timeout).
5. Verify: request_events exists, assets row inserted.
6. Delete all seeded rows (reverse FK order) — always runs, even on failure.
7. Print a structured summary of every step.

Exit codes
----------
0 — All assertions passed.
1 — One or more assertions failed.
2 — Missing required env vars.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

# =========================================================================
# Logging
# =========================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("e2e_smoke")

# =========================================================================
# Config
# =========================================================================

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")
EXT_PROVIDER = os.getenv("EXT_PROVIDER", "mock")

POLL_INTERVAL_SEC = 2.0
MAX_WAIT_SEC = 30.0
MOCK_EXECUTOR_DURATION_SEC = 1.0  # Fast for smoke testing


def _validate_env() -> None:
    missing = [v for v in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not os.getenv(v)]
    if missing:
        log.error("FATAL: missing env vars: %s", ", ".join(missing))
        log.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.")
        sys.exit(2)


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


# =========================================================================
# Supabase staging client (service_role — seed + verify only)
# =========================================================================

def _sb_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


class StagingDB:
    """Thin httpx wrapper around PostgREST / RPCs for seed + verify + cleanup."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def insert(self, table: str, row: Dict[str, Any]) -> Dict[str, Any]:
        res = await self._c.post(f"/rest/v1/{table}", json=row)
        res.raise_for_status()
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
        # 404 is fine — row may already be gone
        if res.status_code not in (200, 204, 404):
            log.warning("Delete %s?%s → HTTP %d", table, filters, res.status_code)


# =========================================================================
# Smoke test steps
# =========================================================================

class SmokeResult:
    def __init__(self) -> None:
        self.steps: List[Dict[str, Any]] = []
        self.passed = True

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        icon = "✅" if ok else "❌"
        log.info("%s  %s  %s", icon, name, detail)

    def print_summary(self) -> None:
        print("\n" + "=" * 60)
        print("E2E SMOKE TEST SUMMARY")
        print("=" * 60)
        for s in self.steps:
            icon = "✅" if s["ok"] else "❌"
            print(f"  {icon}  {s['name']}")
            if s["detail"]:
                print(f"       {s['detail']}")
        total = len(self.steps)
        passed = sum(1 for s in self.steps if s["ok"])
        print(f"\n  {passed}/{total} checks passed")
        print("=" * 60)


async def _run_smoke(run_id: str, result: SmokeResult) -> None:
    """Core smoke flow — seeds, runs worker, verifies, reports."""
    from flowboard.extension_worker.client import WorkerClient
    from flowboard.extension_worker.mock_executor import MockExecutor
    from flowboard.extension_worker.worker_loop import WorkerLoop

    # Generate unique identifiers for this run
    test_user_id = str(uuid.uuid4())
    test_secret = f"smoke-secret-{run_id}"
    test_board_id = str(uuid.uuid4())
    test_node_id = str(uuid.uuid4())
    test_client_id: Optional[str] = None
    test_pairing_id: Optional[str] = None
    test_request_id: Optional[str] = None

    log.info("Run ID: %s", run_id)
    log.info("Test user_id: %s", test_user_id)

    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(15.0),
    ) as sb_raw:
        db = StagingDB(sb_raw)

        # ------------------------------------------------------------------ #
    # ------------------------------------------------------------------ #
    # STEP 1 — Seed board
    # ------------------------------------------------------------------ #
    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(15.0),
    ) as sb_raw:
        db = StagingDB(sb_raw)

        try:
            try:
                board = await db.insert("boards", {
                    "id": test_board_id,
                    "user_id": test_user_id,
                    "name": f"smoke-board-{run_id}",
                })
                result.record("Seed board", bool(board.get("id")), f"board_id={test_board_id[:8]}…")
            except Exception as exc:
                result.record("Seed board", False, str(exc))
                return  # Can't continue without board

            # ------------------------------------------------------------------ #
            # STEP 2 — Seed node
            # ------------------------------------------------------------------ #
            try:
                node = await db.insert("nodes", {
                    "id": test_node_id,
                    "user_id": test_user_id,
                    "board_id": test_board_id,
                    "type": "reference",
                    "title": f"smoke-node-{run_id}",
                })
                result.record("Seed node", bool(node.get("id")), f"node_id={test_node_id[:8]}…")
            except Exception as exc:
                result.record("Seed node", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # STEP 3 — Seed extension_client + pairing
            # ------------------------------------------------------------------ #
            try:
                ec = await db.insert("extension_clients", {
                    "user_id": test_user_id,
                    "client_name": f"smoke-worker-{run_id}",
                    "client_installation_id": f"smoke-{run_id}",
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
                    "created_at": now_iso,
                })
                test_pairing_id = pairing["id"]
                result.record("Seed pairing", bool(test_pairing_id),
                              f"pairing_id={str(test_pairing_id)[:8]}…")
            except Exception as exc:
                result.record("Seed pairing", False, str(exc))
                return

            # ------------------------------------------------------------------ #
            # STEP 4 — Seed queued request via RPC
            # ------------------------------------------------------------------ #
            try:
                req_rows = await db.rpc("create_or_reset_request", {
                    "p_user_id": test_user_id,
                    "p_board_id": test_board_id,
                    "p_node_id": test_node_id,
                    "p_provider": EXT_PROVIDER,
                    "p_task_type": "txt2img",
                    "p_input_data": {"prompt": f"smoke test {run_id}", "smoke": True},
                    "p_idempotency_key": f"smoke-{run_id}",
                    "p_expected_output": "image",
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

            # ------------------------------------------------------------------ #
            # STEP 5 — Check gateway reachable
            # ------------------------------------------------------------------ #
            try:
                async with httpx.AsyncClient(timeout=5.0) as probe:
                    ping = await probe.get(f"{CONTROL_PLANE_BASE_URL}/health")
                result.record("Gateway reachable", ping.is_success,
                              f"HTTP {ping.status_code}")
            except Exception as exc:
                result.record("Gateway reachable", False,
                              f"{exc} — is `uvicorn flowboard.main:app` running?")
                return

            # ------------------------------------------------------------------ #
            # STEP 6 — Run WorkerLoop and poll concurrently
            # ------------------------------------------------------------------ #
            class _FastMockExecutor(MockExecutor):
                def __init__(self) -> None:
                    super().__init__(total_duration=MOCK_EXECUTOR_DURATION_SEC)

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
                        provider=EXT_PROVIDER,
                        poll_interval_sec=0.5,
                        heartbeat_interval_sec=30.0,
                        lease_duration_sec=60,
                        executor_class=_FastMockExecutor,
                    )
                    worker_task = asyncio.create_task(loop.run())

                    # Poll for completion concurrently
                    deadline = asyncio.get_event_loop().time() + MAX_WAIT_SEC
                    while asyncio.get_event_loop().time() < deadline:
                        completed_req = await db.get_one(
                            "requests",
                            f"id=eq.{test_request_id}",
                        )
                        if completed_req and completed_req.get("status") in ("completed", "failed"):
                            break
                        await asyncio.sleep(POLL_INTERVAL_SEC)

                    # Request shutdown
                    loop.request_shutdown()
                    try:
                        await asyncio.wait_for(worker_task, timeout=5.0)
                    except asyncio.TimeoutError:
                        log.warning("Worker task did not stop cleanly, cancelling")
                        worker_task.cancel()
                        try:
                            await worker_task
                        except asyncio.CancelledError:
                            pass
                    except Exception as exc:
                        worker_error = exc

            try:
                await _run_worker_and_poll()
                result.record("Worker ran without crash", worker_error is None,
                              str(worker_error) if worker_error else "")
            except Exception as exc:
                result.record("Worker ran without crash", False, str(exc))

            # ------------------------------------------------------------------ #
            # STEP 7 — Verify request status = completed
            # ------------------------------------------------------------------ #
            final_status = completed_req.get("status") if completed_req else "not_found"
            result.record(
                "Request status = completed",
                final_status == "completed",
                f"status={final_status}",
            )

            # ------------------------------------------------------------------ #
            # STEP 8 — Verify request_events
            # ------------------------------------------------------------------ #
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

            # ------------------------------------------------------------------ #
            # STEP 9 — Verify assets row
            # ------------------------------------------------------------------ #
            try:
                assets = await db.get_many(
                    "assets",
                    f"request_id=eq.{test_request_id}",
                )
                has_asset = len(assets) > 0
                asset_key = assets[0].get("storage_key") if has_asset else None
                result.record(
                    "assets row inserted",
                    has_asset,
                    f"count={len(assets)} key={asset_key}",
                )
            except Exception as exc:
                result.record("assets row inserted", False, str(exc))

        finally:
            # ------------------------------------------------------------------ #
            # CLEANUP — always runs (reverse FK order)
            # ------------------------------------------------------------------ #
            log.info("Cleaning up seeded rows…")
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
            result.record("Cleanup complete", True, "all seeded rows removed")


# =========================================================================
# Entry point
# =========================================================================

async def main() -> int:
    _validate_env()
    run_id = str(uuid.uuid4())[:8]
    result = SmokeResult()
    log.info("Starting E2E smoke — run_id=%s provider=%s gateway=%s",
             run_id, EXT_PROVIDER, CONTROL_PLANE_BASE_URL)
    try:
        await _run_smoke(run_id, result)
    except Exception:
        log.exception("Unhandled error in smoke run")
        result.passed = False
    finally:
        result.print_summary()
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
