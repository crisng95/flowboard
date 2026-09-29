#!/usr/bin/env python3
"""Reference Pax worker for the Muse provider.

Long-polls Flowboard's provider-job queue, fulfils jobs with the
assistant's own tools, and posts results back. Run on the same host as
the agent:

    python agent/scripts/muse_worker.py --worker-id pax-1

Environment:
    FLOWBOARD_BASE   agent base URL (default http://127.0.0.1:8000)
    FLOWBOARD_WORKER_ID  default worker id (overridden by --worker-id)

Job kinds and how this reference implementation fulfils them:

    llm          Print the job; answer by editing the job's `result`
                 (a human/operator loop — replace `handle_llm` with your
                 own model call).
    image        Same — `handle_media` stubs print the prompt and the
    edit_image   input file:// URLs. Wire in your image/video tooling
    video        (e.g. this repo's media skills) and complete the job
    video_refs   with {"outputs": [{"output_url": "file:///..."}]}.

Completion contract — `POST /complete {"worker_id", "result"}`:
    llm:   {"text": "..."}
    media: {"outputs": [{"output_url": "file://..." | "https://...",
                         "media_id": "<optional uuid hex>"}]}
           file:// must be readable by the agent (same host). One entry
           per requested output (variants / start frames).

The worker heartbeats every lease/3 while working and reports progress
when it has something to say. A crashed worker's lease expires and the
job is reclaimed — jobs are never stranded.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
import urllib.request
import urllib.error

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger("muse_worker")

BASE = os.environ.get("FLOWBOARD_BASE", "http://127.0.0.1:8000").rstrip("/")
PROVIDER = "muse"
LEASE_TTL_S = 300
POLL_TIMEOUT_S = 60


def _api(method: str, path: str, body=None, timeout: float = 30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:300]
        except Exception:
            detail = ""
        return exc.code, {"http_error": exc.code, "detail": detail}
    except Exception as exc:  # connection refused etc.
        return 0, {"transport_error": str(exc)[:200]}


def _heartbeat_loop(job_id: str, worker_id: str, stop: threading.Event):
    while not stop.wait(LEASE_TTL_S / 3):
        status, _ = _api(
            "POST",
            f"/api/provider-jobs/{job_id}/heartbeat",
            {"worker_id": worker_id, "lease_ttl_s": LEASE_TTL_S},
        )
        if status != 200:
            logger.warning("heartbeat for %s -> %s; stopping", job_id[:12], status)
            return


def _progress(job_id: str, worker_id: str, pct: int, message: str = ""):
    _api(
        "POST",
        f"/api/provider-jobs/{job_id}/progress",
        {"worker_id": worker_id, "progress": pct, "message": message or None},
    )


def handle_llm(job: dict, worker_id: str) -> dict:
    """Reference LLM fulfilment — replace with a real model call.

    The job payload: prompt, extra.system_prompt, extra.attachments
    (absolute paths on this host — read them directly), extra.model.
    """
    prompt = job.get("prompt", "")
    extra = job.get("extra") or {}
    logger.info("llm job %s: %.120s", job["id"][:12], prompt.replace("\n", " "))
    for att in extra.get("attachments") or []:
        logger.info("  attachment: %s", att)
    # STUB: echo back a marker so the round-trip is observable end to
    # end. A real worker answers here with its own language model.
    return {
        "text": (
            "[muse_worker stub — wire handle_llm to a model]\n\n"
            f"Prompt was: {prompt[:500]}"
        )
    }


def handle_media(job: dict, worker_id: str) -> dict:
    """Reference media fulfilment — replace with real generation tooling.

    Inputs arrive as file:// URLs (same host) in source_url / start_url /
    reference_urls. Render with your image/video tools, write files
    somewhere the agent can read, and return them as outputs.
    """
    kind = job.get("kind")
    logger.info(
        "media job %s kind=%s prompt=%.120s",
        job["id"][:12],
        kind,
        (job.get("prompt") or "").replace("\n", " "),
    )
    logger.info("  source_url=%s start_url=%s", job.get("source_url"), job.get("start_url"))
    logger.info("  reference_urls=%s", job.get("reference_urls"))
    logger.info("  extra=%s", json.dumps(job.get("extra") or {})[:300])
    # STUB: fail loudly so nobody mistakes the stub for a render.
    raise RuntimeError(
        "muse_worker media stub: implement handle_media with your "
        "image/video tooling and complete with "
        '{"outputs": [{"output_url": "file:///..."}]}'
    )


def process_job(job: dict, worker_id: str) -> None:
    job_id = job["id"]
    stop = threading.Event()
    hb = threading.Thread(
        target=_heartbeat_loop, args=(job_id, worker_id, stop), daemon=True
    )
    hb.start()
    try:
        _progress(job_id, worker_id, 5, "started")
        if job["kind"] == "llm":
            result = handle_llm(job, worker_id)
        elif job["kind"] in ("image", "edit_image", "video", "video_refs"):
            result = handle_media(job, worker_id)
        else:
            raise RuntimeError(f"unknown job kind: {job.get('kind')}")
        status, body = _api(
            "POST",
            f"/api/provider-jobs/{job_id}/complete",
            {"worker_id": worker_id, "result": result},
        )
        logger.info("completed %s -> %s", job_id[:12], status)
    except Exception as exc:  # noqa: BLE001
        logger.exception("job %s failed", job_id[:12])
        status, _ = _api(
            "POST",
            f"/api/provider-jobs/{job_id}/fail",
            {"worker_id": worker_id, "error": str(exc)[:500]},
        )
        logger.info("failed %s -> %s", job_id[:12], status)
    finally:
        stop.set()


def main() -> int:
    ap = argparse.ArgumentParser(description="Reference Pax worker for the Muse provider")
    ap.add_argument("--worker-id", default=os.environ.get("FLOWBOARD_WORKER_ID", "pax-1"))
    args = ap.parse_args()
    worker_id = args.worker_id
    logger.info("muse worker %r polling %s", worker_id, BASE)
    backoff = 1.0
    while True:
        status, job = _api(
            "GET",
            f"/api/provider-jobs/wait-next?provider={PROVIDER}"
            f"&worker_id={worker_id}&lease_ttl_s={LEASE_TTL_S}"
            f"&timeout_s={POLL_TIMEOUT_S}",
            timeout=POLL_TIMEOUT_S + 15,
        )
        if status == 204:
            backoff = 1.0
            continue  # nothing available; long-poll again
        if status == 0:
            logger.warning("agent unreachable: %s", (job or {}).get("transport_error"))
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        if status != 200 or not isinstance(job, dict) or "id" not in job:
            logger.warning("wait-next -> %s %s", status, str(job)[:200])
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
            continue
        backoff = 1.0
        logger.info("claimed job %s kind=%s", job["id"][:12], job.get("kind"))
        process_job(job, worker_id)


if __name__ == "__main__":
    sys.exit(main())
