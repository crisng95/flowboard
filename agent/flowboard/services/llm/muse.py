"""Muse provider — the assistant itself (Pax), via the provider-job queue.

Unlike the CLI providers (Claude / Gemini / Codex), there is no subprocess
and no API key: ``run()`` publishes a ``llm`` job to the provider-job queue
and blocks until an external worker — Pax, the assistant — answers it with
its own language and vision tools. This is the same "the agent itself"
pattern flowkit uses for its ``muse`` provider.

Because there is nothing to configure, ``is_available()`` is driven by
worker presence: a Pax worker that polled ``wait-next`` within
``MUSE_WORKER_PRESENCE_TTL_S`` means the provider is up. The Settings UI
test button exercises the real round-trip, so a green tick means a worker
actually answered — not just that one polled recently.

Attachments are absolute file paths on the agent host; the worker runs on
the same host and reads them directly (the protocol never ships bytes).

**muse2api transport.** When ``FLOWBOARD_MUSE2API_BASE`` is set, ``run()``
calls the muse2api gateway's ``/v1/chat/completions`` directly instead of
queueing (attachments go as data URLs), availability is its ``/readyz``,
and the catalog is its live chat-model list. See ``services/muse2api.py``.
"""
from __future__ import annotations

import logging
from typing import Optional

from flowboard import config
from flowboard.services import muse2api
from flowboard.services import provider_jobs as pq
from flowboard.services import worker_presence
from flowboard.services.llm.base import LLMError
from flowboard.services.provider_jobs import KIND_LLM

logger = logging.getLogger(__name__)

_QUEUE_MODEL_ID = "muse-spark"


class MuseProvider:
    """Delegated LLM provider: the muse2api gateway, or a Pax worker via the queue."""

    name = "muse"
    supports_vision = True

    # No reasoning-effort flags: effort is meaningless when the worker is
    # the assistant itself. The Settings UI hides the effort dropdown and
    # the HTTP layer accepts only null for this provider.
    supports_effort = False
    efforts: list[str] = []
    catalog_is_authoritative = False

    # Test-button ceiling. A real round-trip needs a worker to claim the
    # job and answer; 120s is enough for a warm worker, and without one
    # `is_available()` already short-circuits before we get here.
    test_timeout_secs = 120.0

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = 90.0,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> str:
        if muse2api.is_configured():
            try:
                return await muse2api.chat(
                    user_prompt,
                    system_prompt=system_prompt,
                    attachments=attachments,
                    # The queue-era placeholder id means nothing to muse2api;
                    # omit it so the gateway picks its default chat model.
                    model=model if model and model != _QUEUE_MODEL_ID else None,
                    timeout=min(timeout, config.MUSE_LLM_TIMEOUT_S),
                )
            except muse2api.Muse2APIError as exc:
                raise LLMError(str(exc)[:300]) from exc
        job = pq.create_provider_job(
            provider=self.name,
            kind=KIND_LLM,
            prompt=user_prompt,
            extra={
                "system_prompt": system_prompt,
                "attachments": list(attachments or []),
                "model": model,
            },
        )
        logger.info("muse: llm job %s queued — waiting for worker", job.id[:12])
        # Never wait longer than the feature's own ceiling allows; the
        # registry passes the per-call-site timeout (vision 120s, planner
        # higher), but a misconfigured caller must not hang the worker.
        wait_s = min(timeout, config.MUSE_LLM_TIMEOUT_S)
        final = await pq.wait_for_provider_job(job.id, timeout_s=wait_s)
        if final is None:
            raise LLMError(
                f"Muse provider timed out after {wait_s:.0f}s with no worker "
                f"answer (job {job.id[:12]}). Start a Pax worker — see "
                f"docs/muse-provider.md."
            )
        if final.status == "SUCCEEDED":
            text = (final.result or {}).get("text", "")
            if not isinstance(text, str) or not text:
                raise LLMError(
                    f"Muse worker returned an empty answer (job {job.id[:12]})"
                )
            return text
        if final.status == "CANCELLED":
            raise LLMError(f"Muse provider job {job.id[:12]} was cancelled")
        raise LLMError(
            (final.error_message or f"Muse provider job {job.id[:12]} failed")[:300]
        )

    @property
    def default_model(self) -> Optional[str]:
        return "muse-chat" if muse2api.is_configured() else _QUEUE_MODEL_ID

    @property
    def mode(self) -> str:
        """``gateway`` (muse2api) or ``assistant`` (queue + Pax worker)."""
        return "gateway" if muse2api.is_configured() else "assistant"

    def reset_cache(self) -> None:
        muse2api.reset_cache()

    async def is_available(self) -> bool:
        """muse2api: its ``/readyz``. Queue: a Pax worker polled recently."""
        if muse2api.is_configured():
            return await muse2api.is_ready()
        return worker_presence.any_recent(
            self.name, within_s=config.MUSE_WORKER_PRESENCE_TTL_S
        )

    async def list_models(self, force: bool = False) -> list[dict]:
        """muse2api: its live chat models. Queue: the worker IS the model.
        Never raises."""
        if muse2api.is_configured():
            return await muse2api.list_models("chat")
        return [{"id": _QUEUE_MODEL_ID, "label": "Muse Spark — this assistant (Pax)"}]
