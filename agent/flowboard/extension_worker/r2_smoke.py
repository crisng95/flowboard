"""Manual smoke test script for Phase 4.2H: R2 Asset Upload Integration.

Only runs if environment variable R2_SMOKE_ENABLED=1 is set.
Performs end-to-end seed, upload, completes job, signs read, downloads, and cleans up completely.
"""
from __future__ import annotations

import os
import sys
import uuid
import httpx
import boto3
import asyncio
import logging
import hashlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from botocore.config import Config

from flowboard.extension_worker.client import WorkerClient
from flowboard.extension_worker.asset_uploader import AssetUploader

# Setup logging to stdout
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("r2_smoke")

if os.getenv("R2_SMOKE_ENABLED") != "1":
    sys.stderr.write(
        "SKIPPED: Manual R2 smoke test is disabled.\n"
        "To enable it, set environment variable R2_SMOKE_ENABLED=1 and run:\n"
        "  python -m flowboard.extension_worker.r2_smoke\n"
    )
    sys.exit(0)


SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")

R2_ENDPOINT = os.getenv("R2_ENDPOINT", "")
R2_BUCKET = os.getenv("R2_BUCKET", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")


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
        log.error("FATAL: missing env vars: %s", ", ".join(missing))
        sys.exit(2)


def _sb_headers() -> dict:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


class StagingDB:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def insert(self, table: str, row: dict) -> dict:
        res = await self._c.post(f"/rest/v1/{table}", json=row)
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else {}

    async def delete(self, table: str, filters: str) -> None:
        res = await self._c.delete(f"/rest/v1/{table}?{filters}")
        if res.status_code not in (200, 204, 404):
            log.warning("Delete %s?%s failed: HTTP %d", table, filters, res.status_code)

    async def get_one(self, table: str, filters: str, select: str = "*") -> Optional[dict]:
        res = await self._c.get(f"/rest/v1/{table}?{filters}&select={select}")
        res.raise_for_status()
        rows = res.json()
        return rows[0] if rows else None


class SmokeResult:
    def __init__(self) -> None:
        self.steps = []
        self.passed = True

    def record(self, name: str, ok: bool, detail: str = "") -> None:
        self.steps.append({"name": name, "ok": ok, "detail": detail})
        if not ok:
            self.passed = False
        status_label = "[OK]" if ok else "[FAIL]"
        log.info("%s  %s  %s", status_label, name, detail)

    def print_summary(self) -> None:
        print("\n" + "=" * 60)
        print("R2 UPLOAD SMOKE TEST SUMMARY")
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


async def main() -> None:
    _validate_env()
    run_id = str(uuid.uuid4())[:8]
    result = SmokeResult()

    test_user_id = str(uuid.uuid4())
    test_secret = f"smoke-secret-{run_id}"
    test_board_id = str(uuid.uuid4())
    test_node_id = str(uuid.uuid4())
    test_client_id = None
    test_pairing_id = None
    test_request_id = str(uuid.uuid4())

    log.info("Starting R2 Integration Smoke Test...")
    log.info("Run ID: %s", run_id)
    log.info("Test user_id: %s", test_user_id)

    async with httpx.AsyncClient(
        base_url=SUPABASE_URL,
        headers=_sb_headers(),
        timeout=httpx.Timeout(15.0),
    ) as sb_raw:
        db = StagingDB(sb_raw)

        try:
            # 1. Seed board
            board = await db.insert("boards", {
                "id": test_board_id,
                "user_id": test_user_id,
                "name": f"smoke-board-{run_id}",
            })
            result.record("Seed board", bool(board.get("id")), f"board_id={test_board_id[:8]}...")

            # 2. Seed node
            node = await db.insert("nodes", {
                "id": test_node_id,
                "user_id": test_user_id,
                "board_id": test_board_id,
                "type": "reference",
                "title": f"smoke-node-{run_id}",
            })
            result.record("Seed node", bool(node.get("id")), f"node_id={test_node_id[:8]}...")

            # 3. Seed extension_client
            ec = await db.insert("extension_clients", {
                "user_id": test_user_id,
                "client_name": f"smoke-worker-{run_id}",
                "client_installation_id": f"smoke-{run_id}",
            })
            test_client_id = ec["id"]
            result.record("Seed extension_client", bool(test_client_id), f"client_id={test_client_id[:8]}...")

            # 4. Seed pairing
            secret_hash = hashlib.sha256(test_secret.encode("utf-8")).hexdigest()
            pairing = await db.insert("pairings", {
                "user_id": test_user_id,
                "extension_client_id": test_client_id,
                "current_secret_hash": secret_hash,
                "is_active": True
            })
            test_pairing_id = pairing["id"]
            result.record("Seed pairing", bool(test_pairing_id), f"pairing_id={test_pairing_id[:8]}...")

            # 5. Seed request
            req = await db.insert("requests", {
                "id": test_request_id,
                "user_id": test_user_id,
                "board_id": test_board_id,
                "node_id": test_node_id,
                "provider": "flow",
                "task_type": "txt2img",
                "status": "processing",
                "input_data": {"prompt": "A scenic view"},
                "expected_output": "image",
                "idempotency_key": f"idemp-{run_id}",
                "claimed_by": test_client_id,
                "lease_expires_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            })
            result.record("Seed request", bool(req.get("id")), f"request_id={test_request_id[:8]}...")

            # 6. Initialize WorkerClient & AssetUploader
            storage_key = f"users/{test_user_id}/flow/{test_request_id}/output-0.png"
            tiny_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
            
            async with WorkerClient(
                base_url=CONTROL_PLANE_BASE_URL,
                client_id=test_client_id,
                pairing_secret=test_secret
            ) as wc:
                uploader = AssetUploader(wc)
                
                # 7. Upload to R2 via AssetUploader
                metadata = await uploader.upload(
                    file_path_or_bytes=tiny_png,
                    storage_key=storage_key,
                    mime_type="image/png",
                    file_name="output-0.png",
                    prompt_snapshot="A scenic view"
                )
                result.record("AssetUploader.upload to R2", bool(metadata.get("checksum")), f"checksum={metadata['checksum'][:12]}")

                # 8. Complete request
                complete_res = await wc.complete(
                    request_id=test_request_id,
                    output_result={"provider": "flow", "task_type": "txt2img", "asset_count": 1},
                    assets=[metadata]
                )
                result.record("Complete job with asset metadata", complete_res.get("status") == "completed")

            # 9. Verify asset read (sign-read and download)
            # Create a separate user client or direct DB lookup to verify
            # Let's query db assets table to find the asset id
            asset_row = await db.get_one("assets", f"request_id=eq.{test_request_id}")
            if asset_row:
                asset_id = asset_row["id"]
                # We can sign read URL via control plane, but that requires Supabase JWT token.
                # Alternatively, we can verify directly using boto3 S3 signed URL download!
                s3 = boto3.client(
                    "s3",
                    endpoint_url=R2_ENDPOINT,
                    aws_access_key_id=R2_ACCESS_KEY_ID,
                    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
                    config=Config(signature_version="s3v4"),
                    region_name="auto"
                )
                read_url = s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": R2_BUCKET, "Key": storage_key},
                    ExpiresIn=60
                )
                async with httpx.AsyncClient() as http:
                    dl_res = await http.get(read_url)
                    result.record("Presigned read URL download", dl_res.status_code == 200, f"size={len(dl_res.content)}")
            else:
                result.record("Verify asset in DB", False, "No asset found in DB")

        except Exception as exc:
            result.record("Smoke test execution", False, str(exc))

        finally:
            log.info("Cleaning up smoke test resources...")
            
            # Delete R2 object
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
                log.info("R2 object deleted cleanly.")
            except Exception as e:
                log.warning("Failed to delete R2 object: %s", e)

            # Delete seeded DB rows (reverse order of dependencies)
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
            
            log.info("Database cleanup completed.")

    result.print_summary()
    if not result.passed:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
