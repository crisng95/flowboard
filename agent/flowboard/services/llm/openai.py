"""OpenAI provider — dual-mode (Codex CLI preferred · REST API fallback).

OpenAI is the only provider that supports two transports:

1. **Codex CLI** (`@openai/codex`) — preferred. Authenticates via the
   user's ChatGPT Plus/Pro OAuth, no API key needed. Same
   "use your existing subscription" benefit as Claude / Gemini CLIs.

2. **REST API** — fallback. Used when:
   - Codex CLI isn't installed, OR
   - Codex CLI is installed but the user's version is text-only AND
     this dispatch needs vision.

Vision capability of Codex CLI varies between versions. We probe
``codex --help`` once at first vision call and detect which image flag
(if any) is advertised. If none, the provider treats Codex as text-only
and routes vision requests through the API mode (assuming an API key
is configured; raises if not).

The class API contract: ``is_available()`` is True if at least one mode
is usable. ``run()`` picks the right mode automatically based on
attachment presence + cached probe results. Callers stay ignorant of
which transport ran.

**Codex CLI flag migration (codex-cli 0.155.0).** The invocation this
module used to emit — ``codex exec --output-format json -p -`` — is dead
on current Codex and fails before the model is ever reached::

    error: unexpected argument '--output-format' found

Two things changed upstream and both had to be unwound:

- ``--output-format`` no longer exists on ``codex exec``. The structured
  replacement is ``-o/--output-last-message <FILE>``, which writes the
  agent's final message (and nothing else) to a file. ``--json`` exists
  too but emits a JSONL *event stream* meant for progress UIs, so it
  would leave us re-implementing "find the last assistant message".
  ``-o`` into a ``NamedTemporaryFile`` is the clean read.
- ``-p`` was repurposed: it now means ``--profile``, not "prompt". The
  prompt is a **positional** argument. Passing ``-p -`` therefore asked
  Codex to load a config profile literally named ``-``. This is why the
  prompt must no longer travel over stdin here even though the Claude
  provider still does that for its own Windows ``.cmd`` reasons.

The dispatch also pins ``--skip-git-repo-check`` (Flowboard's cwd is not
guaranteed to be a git repo) and ``--sandbox read-only`` (we want a text
answer, never a filesystem mutation). ``--sandbox read-only`` is a
deliberate safety floor, not a performance tweak: Codex is agentic and
would otherwise be free to write files while answering a prompt-synthesis
question. stdin is pointed at ``DEVNULL`` because Codex appends piped
stdin to the prompt as a ``<stdin>`` block when it is not a terminal.

**Model / effort.** ``-m <model>`` selects the model;
``-c model_reasoning_effort="<effort>"`` selects reasoning depth (Codex
has no dedicated effort flag — it goes through the generic ``-c`` config
override, whose value is parsed as TOML). Both are omitted when the
caller passes None so the user's ``~/.codex/config.toml`` keeps applying.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx

from .base import LLMError
from . import secrets
from .cli_utils import (
    resolve_cli_binary,
    validate_prompt_size,
    validate_attachment_paths,
    CLI_PROBE_TIMEOUT,
)

logger = logging.getLogger(__name__)


_CLI_BIN = "codex"
_API_URL = "https://api.openai.com/v1/chat/completions"
_PROBE_TIMEOUT = 5.0
_DEFAULT_TIMEOUT = 90.0
_DEFAULT_TEXT_MODEL = "gpt-5"
_DEFAULT_VISION_MODEL = "gpt-4o"
_AVAILABILITY_TTL_S = 60.0
_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

# Image-flag candidates ordered by likelihood. First match wins.
_IMAGE_FLAG_CANDIDATES = ("--image", "--attach", "--file", "--input")

# Static catalog. Unlike ``agy models``, Codex has no headless listing:
# ``codex models`` exits with "Error: stdin is not a terminal", so there
# is nothing to shell out to from a FastAPI worker. These slugs were read
# off the CLI's own model cache (``~/.codex/models_cache.json``) at
# codex-cli 0.155.0, filtered to the entries marked ``visibility: list``
# — the hidden ones (``gpt-reserve``, ``codex-auto-review``) are internal
# routing targets, not user-selectable models. Refresh this list from
# that same file when bumping the pinned Codex version.
_MODELS: list[dict] = [
    {"id": "gpt-6-astra", "label": "GPT-6-Astra"},
    {"id": "gpt-5.6-sol", "label": "GPT-5.6-Sol"},
    {"id": "gpt-5.6-terra", "label": "GPT-5.6-Terra"},
    {"id": "gpt-5.6-luna", "label": "GPT-5.6-Luna"},
    {"id": "gpt-5.5", "label": "GPT-5.5"},
]

# Reasoning efforts. The API's own enum (surfaced verbatim when you send a
# bad value) is "none, minimal, low, medium, high, xhigh, max"; the CLI's
# model cache lists "low, medium, high, xhigh, max" (+ "ultra" on some
# models) as the per-model supported set. We expose the intersection —
# every value here is accepted by the API *and* supported by every model
# in ``_MODELS``. ``none``/``minimal`` are API-only and ``ultra`` is
# model-specific, so offering either would let the UI build a
# model+effort pair that fails at dispatch time.
_EFFORTS: list[str] = ["low", "medium", "high", "xhigh", "max"]


class OpenAIProvider:
    """Conforms to ``LLMProvider``. Dual-mode dispatch."""

    name: str = "openai"
    supports_vision: bool = True  # via at least one of the two modes
    supports_effort: bool = True
    efforts: list[str] = _EFFORTS
    # Advisory only — pre-selects a row in Settings. Dispatch leaves an
    # unpinned model unpinned so ~/.codex/config.toml's `model` wins.
    default_model: Optional[str] = "gpt-5.6-sol"
    # Five slugs read by hand off ONE pinned Codex build's model cache
    # (`codex models` can't run headlessly — see `_MODELS`). A user on a
    # different build has models this list has never heard of, so it must
    # not be validated against.
    catalog_is_authoritative: bool = False

    def __init__(self) -> None:
        # CLI probe state (set by `_probe_cli`).
        # `cli_available` = True when binary present + version probe succeeds.
        # `cli_image_flag` = resolved flag string, or None for "text-only Codex".
        self._cli_probed: bool = False
        self._cli_available: bool = False
        self._cli_image_flag: Optional[str] = None

        # API availability cache (separate from CLI — they're independent).
        self._api_cached_at: Optional[float] = None
        self._api_value: Optional[bool] = None

    def reset_cache(self) -> None:
        """Testing hook + Settings panel rescan support."""
        self._cli_probed = False
        self._cli_available = False
        self._cli_image_flag = None
        self._api_cached_at = None
        self._api_value = None

    # ── CLI probe ────────────────────────────────────────────────────

    async def _probe_cli(self) -> None:
        """Resolve `_cli_available` + `_cli_image_flag` once per agent
        lifetime. Called lazily on the first availability check."""
        if self._cli_probed:
            return
        self._cli_probed = True

        # Step 1: does the binary exist + run `--version`?
        #
        # Both probes go through `asyncio.to_thread`: this runs from
        # `is_available()`, which the /api/llm/providers route awaits, and
        # that route is polled every 30s by an always-mounted badge.
        # Blocking the loop here stalls the worker and the extension WS
        # along with every other request.
        try:
            codex_bin = await asyncio.to_thread(
                resolve_cli_binary, _CLI_BIN, CLI_PROBE_TIMEOUT
            )
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    [codex_bin, "--version"],
                    capture_output=True,
                    timeout=CLI_PROBE_TIMEOUT,
                )
            )
            self._cli_available = result.returncode == 0
        except (FileNotFoundError, PermissionError):
            self._cli_available = False
            return
        except (subprocess.TimeoutExpired, Exception):  # noqa: BLE001
            self._cli_available = False
            return

        if not self._cli_available:
            return

        # Step 2: parse `--help` for an image-attachment flag.
        try:
            codex_bin = await asyncio.to_thread(
                resolve_cli_binary, _CLI_BIN, CLI_PROBE_TIMEOUT
            )
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    [codex_bin, "--help"],
                    capture_output=True,
                    timeout=CLI_PROBE_TIMEOUT,
                )
            )
            stdout_b = result.stdout
        except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired):
            return
        except Exception:  # noqa: BLE001
            logger.exception("openai: unexpected error during codex --help probe")
            return

        help_text = stdout_b.decode(errors="replace")
        for candidate in _IMAGE_FLAG_CANDIDATES:
            if re.search(rf"(^|\s){re.escape(candidate)}(\s|=|\b)", help_text):
                self._cli_image_flag = candidate
                logger.info("openai: codex image flag = %s", candidate)
                return
        logger.info("openai: codex --help advertises no image flag (text-only)")

    # ── API probe ────────────────────────────────────────────────────

    async def _api_available(self) -> bool:
        """True when an API key is configured. We don't ping the API
        here — `/v1/models` costs a request, and the key presence alone
        is enough for the routing decision (the actual Test endpoint
        confirms by sending a real ping)."""
        now = time.monotonic()
        if (
            self._api_value is not None
            and self._api_cached_at is not None
            and now - self._api_cached_at < _AVAILABILITY_TTL_S
        ):
            return self._api_value
        key = secrets.get_api_key("openai")
        ok = bool(key)
        self._api_value = ok
        self._api_cached_at = now
        return ok

    # ── public API ───────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """True when at least one of CLI / API is usable."""
        await self._probe_cli()
        if self._cli_available:
            return True
        return await self._api_available()

    async def list_models(self, force: bool = False) -> list[dict]:
        """Static catalog — see ``_MODELS`` for why there's nothing live
        to fetch. ``force`` is accepted for protocol symmetry."""
        return [dict(m) for m in _MODELS]

    async def run(
        self,
        user_prompt: str,
        *,
        system_prompt: Optional[str] = None,
        attachments: Optional[list[str]] = None,
        timeout: float = _DEFAULT_TIMEOUT,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> str:
        await self._probe_cli()
        api_ok = await self._api_available()

        # Mode resolution table (see plan UI Spec for the user-visible
        # version; this is its functional twin):
        #   CLI status × attachments → which mode
        #     cli_available + flag found:           CLI (any dispatch)
        #     cli_available + no flag + no attach:  CLI (text dispatch fine)
        #     cli_available + no flag + attach:     API fallback (requires key)
        #     cli_unavailable:                      API (requires key)
        if self._cli_available:
            wants_vision = bool(attachments)
            cli_supports_this = (self._cli_image_flag is not None) or not wants_vision
            if cli_supports_this:
                return await self._run_cli(
                    user_prompt, system_prompt, attachments, timeout, model, effort
                )
            # Codex is text-only — fall through to API for this dispatch.
            if not api_ok:
                raise LLMError(
                    "OpenAI Codex CLI does not support vision in your version. "
                    "Either upgrade Codex CLI or configure an OpenAI API key."
                )
            return await self._run_api(
                user_prompt, system_prompt, attachments, timeout, model
            )

        # No CLI — API only.
        if not api_ok:
            raise LLMError("OpenAI is not configured (no Codex CLI, no API key)")
        return await self._run_api(
            user_prompt, system_prompt, attachments, timeout, model
        )

    @property
    def mode(self) -> str:
        """Reported by /api/llm/providers so the UI knows which row state
        to render. Returns the mode that `run()` would currently pick for
        a TEXT dispatch (vision can fall through to API even when this
        says 'cli'). Values: 'cli' / 'api' / 'none'."""
        # Probe-on-read so the property stays sync; callers that want
        # freshness should await `is_available()` first.
        if self._cli_probed and self._cli_available:
            return "cli"
        if self._api_value:
            return "api"
        return "none"

    # ── CLI dispatch ─────────────────────────────────────────────────

    async def _run_cli(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
        timeout: float,
        model: Optional[str] = None,
        effort: Optional[str] = None,
    ) -> str:
        """Spawn ``codex exec`` and read the final answer back from the
        ``-o`` output file. See the module docstring for the flag
        migration this replaced."""
        # Validate inputs
        try:
            validate_prompt_size(user_prompt)
            if system_prompt:
                validate_prompt_size(system_prompt)
            validate_attachment_paths(attachments)
        except ValueError as exc:
            raise LLMError(f"Invalid input: {exc}") from exc

        codex_bin = await asyncio.to_thread(
            resolve_cli_binary, _CLI_BIN, CLI_PROBE_TIMEOUT
        )

        # ``codex exec`` has no --system flag, so the system prompt is
        # folded into the prompt body the same way the Gemini provider
        # does it. (The old code passed ``--system``, which this version
        # of Codex also rejects.)
        full_prompt = (
            f"[System: {system_prompt}]\n\n{user_prompt}"
            if system_prompt
            else user_prompt
        )

        # NamedTemporaryFile(delete=False) + explicit unlink: we need the
        # path to survive being handed to a child process on every
        # platform, and Codex opens it itself for writing.
        tmp = tempfile.NamedTemporaryFile(
            prefix="flowboard-codex-", suffix=".txt", delete=False
        )
        tmp.close()
        out_path = tmp.name

        args: list[str] = [
            codex_bin, "exec",
            "--skip-git-repo-check",
            "--sandbox", "read-only",
            "-o", out_path,
        ]
        if model:
            args += ["-m", model]
        if effort:
            # Value is parsed as TOML, hence the embedded quotes. `effort`
            # is whitelist-validated on every path that can reach here —
            # PUT /config and POST /providers/{name}/test share
            # `routes/llm.py::_validate_effort`, and `registry.run_llm`
            # re-checks what it read out of secrets.json — so there is
            # nothing to escape. That claim was once true of the save path
            # only, while Test forwarded the field raw into this same `-c`
            # override that also configures `sandbox_mode`.
            args += ["-c", f'model_reasoning_effort="{effort}"']
        if attachments and self._cli_image_flag:
            for path in attachments:
                args += [self._cli_image_flag, os.path.abspath(path)]
        # Prompt is positional and must come last.
        args.append(full_prompt)

        # `subprocess.run` (not asyncio's subprocess transport) for the
        # same Windows `.cmd`-shim reason the Claude provider documents,
        # wrapped in `asyncio.to_thread` so a multi-minute Codex turn
        # doesn't park the loop the worker and the extension WS run on.
        # Shutdown cost, known and accepted: `asyncio.to_thread` is not
        # cancellable. Cancelling this coroutine returns control to the
        # caller, but the thread keeps running until codex exits or its
        # timeout fires, so a shutdown mid-turn can wait out the full
        # deadline (the caller's timeout) before the process is free. Still
        # strictly better than blocking the loop, which froze the worker,
        # the extension WS and every HTTP route for the same duration.
        try:
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    args,
                    # Codex appends piped stdin to the prompt as a `<stdin>`
                    # block when stdin isn't a terminal. DEVNULL keeps the
                    # prompt exactly what we passed positionally.
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=timeout,
                )
            )
        except FileNotFoundError as exc:
            _unlink_quietly(out_path)
            raise LLMError("codex CLI not found on PATH") from exc
        except subprocess.TimeoutExpired as exc:
            _unlink_quietly(out_path)
            raise LLMError(f"codex CLI timed out after {timeout}s") from exc
        except Exception as exc:  # noqa: BLE001
            _unlink_quietly(out_path)
            raise LLMError(f"codex CLI error: {exc}") from exc

        try:
            if result.returncode != 0:
                # Codex writes its failures to stdout (the event log), not
                # stderr, so include both — a 400 from the API shows up as
                # an `ERROR: {...}` block in stdout with stderr empty.
                detail = (
                    result.stderr.decode(errors="replace").strip()
                    or result.stdout.decode(errors="replace").strip()
                )
                raise LLMError(
                    f"codex CLI exited {result.returncode}: {detail[:400]}"
                )

            try:
                answer = Path(out_path).read_text(errors="replace")
            except OSError as exc:
                raise LLMError(
                    f"codex CLI did not write an output file: {exc}"
                ) from exc
        finally:
            _unlink_quietly(out_path)

        if not answer.strip():
            # Exit 0 with nothing written means the turn ended without a
            # final assistant message. Fail loud rather than handing
            # callers an empty string to parse (same class of bug as the
            # Gemini provider's empty-response guard).
            raise LLMError("codex CLI returned an empty response")
        return answer.strip()

    # ── API dispatch ─────────────────────────────────────────────────

    async def _run_api(
        self,
        user_prompt: str,
        system_prompt: Optional[str],
        attachments: Optional[list[str]],
        timeout: float,
        model: Optional[str],
    ) -> str:
        key = secrets.get_api_key("openai")
        if not key:
            raise LLMError("OpenAI API key not configured")

        chosen_model = model or (
            _DEFAULT_VISION_MODEL if attachments else _DEFAULT_TEXT_MODEL
        )

        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        if attachments:
            content: list[dict] = [{"type": "text", "text": user_prompt}]
            for path in attachments:
                content.append(_image_url_block(path))
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": user_prompt})

        payload = {"model": chosen_model, "messages": messages}

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    _API_URL,
                    headers={
                        "authorization": f"Bearer {key}",
                        "content-type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as exc:
            raise LLMError(f"openai request timed out after {timeout}s") from exc
        except httpx.HTTPError as exc:
            raise LLMError(f"openai transport error: {exc}") from exc

        if resp.status_code != 200:
            raise LLMError(
                f"openai HTTP {resp.status_code}: {_safe_error_message(resp)}"
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise LLMError("openai response was not JSON") from exc
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"openai response missing content: {data!r:.200}") from exc


# ── helpers ───────────────────────────────────────────────────────────

def _unlink_quietly(path: str) -> None:
    """Remove the ``-o`` scratch file; a missing file is not an error.

    Called on every exit path (including the error ones) so a long-running
    agent doesn't leak one temp file per failed Codex dispatch.
    """
    try:
        os.unlink(path)
    except OSError:
        pass


def _image_url_block(path: str) -> dict:
    p = Path(path)
    size = p.stat().st_size
    if size > _MAX_ATTACHMENT_BYTES:
        raise LLMError(
            f"attachment too large for openai: "
            f"{size // (1024 * 1024)}MB > 5MB cap"
        )
    mime = mimetypes.guess_type(path)[0] or "image/jpeg"
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


def _safe_error_message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return "(non-JSON body)"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            msg = err.get("message")
            if isinstance(msg, str):
                return msg[:200]
        msg = body.get("message")
        if isinstance(msg, str):
            return msg[:200]
    return "(unrecognised body)"
