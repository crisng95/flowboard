"""Gemini provider — subprocess wrapper around the ``agy`` CLI.

**Why ``agy`` and not ``gemini``.** This provider used to drive Google's
own ``gemini`` CLI. That binary no longer works for this account tier: every
non-interactive call now dies with ::

    IneligibleTierError: This client is no longer supported for
    Gemini Code Assist for individuals

``agy`` (v1.2.7 at the time of writing) is the replacement front-end and
serves the same Gemini model family, so the *provider id stays ``gemini``*
— only the binary, its flags and the response envelope changed. Keeping
the id means existing ``secrets.json`` files, feature pins and frontend
dropdowns all keep working across the upgrade; renaming the provider
would have silently unconfigured every install.

**Invocation.** ::

    agy --print "<prompt>" --output-format json --print-timeout <N>s \
        [--model <id>] [--effort low|medium|high]

The prompt MUST be the *value* of ``--print``. ``--print -`` does **not**
read stdin — verified: agy ignores the piped bytes and answers the empty
prompt generically. That rules out the stdin-delivery trick the Claude and
Codex providers use for Windows ``.cmd`` shims; agy's prompt travels as an
argv token like the old ``gemini -p`` did.

**Envelope.** stdout is a single JSON object::

    {"conversation_id": "...", "status": "SUCCESS", "response": "<text>",
     "duration_seconds": N, "num_turns": N, "usage": {...}}

Two failure shapes hide inside an HTTP-200-looking envelope and both are
treated as ``LLMError`` here:

1. ``status != "SUCCESS"``.
2. ``response`` is empty / whitespace while ``status`` is still
   ``"SUCCESS"``. This happens when agy — which is an *agentic* CLI, not a
   one-shot completion endpoint — decided to use a tool that gets
   auto-denied in a headless run. The envelope then carries
   ``"denied_actions": [{"action": "command", "display_name": "RunCommand"}]``
   and an empty ``response``. Returning that empty string is the exact bug
   that makes downstream JSON parsers (batch auto-prompt synth, planner
   plan extraction) fail with a mystifying "expected a JSON array, got
   nothing". We name the denied actions in the error instead.

**Attachments.** ``@<abspath>`` alone makes agy try to shell out to read
the file, which is auto-denied headlessly (see #2 above). The verified fix
is to steer it at its own file-reading tool in prose: the attachment block
appends an explicit "use your file-reading tool, do not run any shell
command" instruction. That returns a correct answer with no dangerous
flags — we never pass ``--dangerously-skip-permissions``.

**Model catalog.** ``agy models`` prints ``<id>\\t<Label>`` lines preceded
by a ``Fetching available models...`` status line. Any line without a tab
is skipped. The catalog is cached in-process for ``_MODELS_TTL_S`` so
opening the Settings panel doesn't shell out on every poll, with a
force-refresh escape hatch for the panel's Refresh button.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from typing import Optional

from .base import LLMError
from .cli_utils import (
    resolve_cli_binary,
    validate_prompt_size,
    validate_attachment_paths,
    DEFAULT_SUBPROCESS_TIMEOUT,
    CLI_PROBE_TIMEOUT,
)

logger = logging.getLogger(__name__)

_CLI_BIN = "agy"
_DEFAULT_TIMEOUT = DEFAULT_SUBPROCESS_TIMEOUT
_PROBE_TIMEOUT = CLI_PROBE_TIMEOUT

# ``agy --help``: "--effort  Reasoning effort for the current CLI session
# (low|medium|high)". Narrower than Claude's ladder — no xhigh / max.
_EFFORTS: list[str] = ["low", "medium", "high"]

# How long a fetched ``agy models`` catalog stays fresh. Five minutes is
# long enough that the Settings panel's polling never re-shells out, short
# enough that a model added upstream shows up without restarting the agent.
_MODELS_TTL_S = 300.0

# Advisory default for the Settings panel's initial selection only —
# dispatch never substitutes it (an unpinned model must stay unpinned so
# agy's own session default applies). A stale id here is harmless: the
# live catalog from ``agy models`` is what the dropdown actually renders.
_DEFAULT_MODEL: Optional[str] = "gemini-3.8-flash-low"

# Appended after the ``@<path>`` tokens. Without it agy reaches for a
# shell command to read the image, which is denied headlessly and comes
# back as an empty response. See module docstring.
_ATTACHMENT_INSTRUCTION = (
    "Read the image file(s) at {paths} using your file-reading tool only. "
    "Do NOT run any shell command."
)


class GeminiProvider:
    """Conforms to ``LLMProvider`` (structural typing).

    Concurrency note: calls are serialized behind one
    ``asyncio.Semaphore(1)``. This started as a workaround for Google's
    CodeAssist backend, which 429'd ``MODEL_CAPACITY_EXHAUSTED`` on
    concurrent calls per session and then retried with backoff, inflating
    the second call's wall time by 30+ seconds. That specific backend is
    no longer in the path — ``agy`` is — but we have **not** verified
    agy's own concurrency limits, so the semaphore is retained as a
    precaution. Sequential calls are fast enough that queueing costs us
    little; discovering agy's ceiling the hard way in production would
    cost a lot more. Drop it once agy's parallel behaviour is measured.

    Other providers (Claude, OpenAI Codex) don't need this — Anthropic's
    and OpenAI's backends handle parallel calls fine.
    """

    name: str = "gemini"
    supports_vision: bool = True  # Gemini Flash + Pro both have vision
    supports_effort: bool = True
    efforts: list[str] = _EFFORTS
    default_model: Optional[str] = _DEFAULT_MODEL
    # `agy models` asks the backend what this account can actually reach,
    # so a model outside it is a typo rather than a gap in our list. The
    # one catalog the HTTP layer is allowed to validate against.
    catalog_is_authoritative: bool = True
    test_timeout_secs: float = 180.0  # Agentic turns can take several minutes

    def __init__(self) -> None:
        self._available: Optional[bool] = None
        # Module-level singleton in registry → one semaphore for the
        # process lifetime. Lazy-allocated on first run() because asyncio
        # Semaphore wants a running event loop in some Python versions.
        self._call_lock: Optional[asyncio.Semaphore] = None
        # ``agy models`` catalog cache. ``_models_at`` is a monotonic
        # timestamp; None means "never fetched".
        self._models: Optional[list[dict]] = None
        self._models_at: Optional[float] = None

    # ── availability ──────────────────────────────────────────────────

    async def is_available(self) -> bool:
        """Cached check: does ``agy --version`` exit 0?

        Doesn't verify auth — the user could have the CLI installed but
        not signed in. The Test endpoint catches that by actually
        invoking the model. Mirrors the claude_cli pattern.
        """
        if self._available is None:
            self._available = await self._probe_version()
            logger.info("gemini(agy): available=%s", self._available)
        return self._available

    def reset_cache(self) -> None:
        """Testing hook + Settings panel rescan support."""
        self._available = None
        self._models = None
        self._models_at = None

    async def _probe_version(self) -> bool:
        """Check agy CLI availability using subprocess (Windows-compatible).

        ``subprocess.run`` is kept — see ``_invoke_locked`` for why — but
        handed to ``asyncio.to_thread`` so the probe never parks the event
        loop. ``resolve_cli_binary`` goes with it: on Windows it shells out
        to ``npm`` locations itself.
        """
        try:
            agy_bin = await asyncio.to_thread(
                resolve_cli_binary, _CLI_BIN, _PROBE_TIMEOUT
            )
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    [agy_bin, "--version"],
                    capture_output=True,
                    timeout=_PROBE_TIMEOUT,
                )
            )
            if result.returncode == 0:
                logger.info("gemini(agy): found at %s", agy_bin)
                return True
            logger.warning("gemini(agy): version probe returned code %d", result.returncode)
            return False
        except subprocess.TimeoutExpired:
            logger.warning("gemini(agy): probe timed out")
            return False
        except Exception as e:  # noqa: BLE001
            logger.warning("gemini(agy): probe failed: %s", e)
            return False

    # ── model catalog ─────────────────────────────────────────────────

    async def list_models(self, force: bool = False) -> list[dict]:
        """Return ``agy models`` as ``[{"id", "label"}]``, TTL-cached.

        Never raises — a missing binary, a timeout or a garbled listing
        all come back as an empty list so the Settings panel degrades to
        a free-text model field instead of erroring out.
        """
        now = time.monotonic()
        if (
            not force
            and self._models is not None
            and self._models_at is not None
            and now - self._models_at < _MODELS_TTL_S
        ):
            return [dict(m) for m in self._models]

        try:
            agy_bin = await asyncio.to_thread(
                resolve_cli_binary, _CLI_BIN, _PROBE_TIMEOUT
            )
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    [agy_bin, "models"],
                    capture_output=True,
                    timeout=DEFAULT_SUBPROCESS_TIMEOUT,
                )
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("gemini(agy): model listing failed: %s", exc)
            return []

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:200]
            logger.warning(
                "gemini(agy): `agy models` exited %d: %s", result.returncode, stderr
            )
            return []

        models = _parse_models(result.stdout.decode(errors="replace"))
        # Only cache a non-empty listing. Caching an empty one would pin
        # the Settings panel to "no models" for the whole TTL after a
        # transient network blip during the fetch.
        if models:
            self._models = models
            self._models_at = now
        return [dict(m) for m in models]

    # ── dispatch ──────────────────────────────────────────────────────

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
        """Invoke ``agy --print PROMPT --output-format json`` and return the text.

        System prompt + image attachments are folded into the prompt body
        because the CLI doesn't expose them as flags — see module docstring.

        ``model`` / ``effort`` map to ``--model`` / ``--effort`` and are
        omitted entirely when None so agy's own session settings apply.

        The actual subprocess invocation is serialized through
        ``self._call_lock`` (Semaphore(1)) — see class docstring for why
        that's retained. Time spent waiting in the lock counts against the
        caller's ``timeout`` budget; if a Vision call holds the lock for 7s
        and an Auto-Prompt is queued behind it with a 90s timeout,
        Auto-Prompt has 83s of work time once it acquires.
        """
        # Validate inputs
        try:
            validate_prompt_size(user_prompt)
            if system_prompt:
                validate_prompt_size(system_prompt)
            validate_attachment_paths(attachments)
        except ValueError as exc:
            raise LLMError(f"Invalid input: {exc}") from exc

        # Build the composite prompt: system block, user prompt, attachments.
        parts: list[str] = []
        if system_prompt:
            parts.append(f"[System: {system_prompt}]")
        parts.append(user_prompt)
        if attachments:
            abs_paths = [os.path.abspath(p) for p in attachments]
            parts.append(" ".join(f"@{p}" for p in abs_paths))
            parts.append(
                _ATTACHMENT_INSTRUCTION.format(paths=", ".join(abs_paths))
            )
        full_prompt = "\n\n".join(parts)

        agy_bin = await asyncio.to_thread(resolve_cli_binary, _CLI_BIN, _PROBE_TIMEOUT)
        args: list[str] = [
            agy_bin,
            "--print", full_prompt,
            "--output-format", "json",
            # Give agy its own deadline just under ours so it can tear the
            # turn down and still emit a JSON envelope, instead of being
            # SIGKILLed mid-write by subprocess's timeout and leaving us
            # with truncated stdout to parse.
            "--print-timeout", f"{max(1, int(timeout))}s",
        ]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]

        # Lazy-init the semaphore on the running loop. The wait + the
        # subprocess + communicate all live inside the lock so a second
        # caller can't slip in between proc spawn and proc.communicate.
        if self._call_lock is None:
            self._call_lock = asyncio.Semaphore(1)
        async with self._call_lock:
            return await self._invoke_locked(args, timeout=timeout)

    async def _invoke_locked(
        self, args: list[str], *, timeout: float
    ) -> str:
        """Subprocess invocation using subprocess.run (Windows-compatible).

        Assumed to be holding ``_call_lock``. Deliberately still
        ``subprocess.run`` and not ``asyncio.create_subprocess_exec``:
        npm-installed CLIs on Windows are ``.cmd`` shims that the asyncio
        subprocess transport cannot spawn reliably. ``asyncio.to_thread``
        keeps that compatibility and only moves the *blocking* off the
        event loop — which matters because an agy turn can run for
        minutes, and everything else the agent serves (the worker, the
        extension WS, every HTTP route) shares that loop."""
        # Shutdown cost, known and accepted: `asyncio.to_thread` is not
        # cancellable. Cancelling this coroutine returns control to the
        # caller, but the thread keeps running until agy exits or its
        # timeout fires, so a shutdown mid-turn can wait out the full
        # deadline (timeout + 5s — up to ~185s) before the process is
        # free. Still strictly better than blocking the loop, which froze
        # the worker, the extension WS and every HTTP route for the same
        # duration.
        try:
            result = await asyncio.to_thread(
                lambda: subprocess.run(
                    args,
                    capture_output=True,
                    # Give the subprocess a little more wall time than agy's
                    # own --print-timeout so agy wins the race and we get an
                    # envelope.
                    timeout=timeout + 5.0,
                    text=False,  # Keep as bytes for .decode() below
                )
            )
        except FileNotFoundError as exc:
            raise LLMError("agy CLI not found on PATH") from exc
        except subprocess.TimeoutExpired as exc:
            raise LLMError(
                f"agy CLI timed out after {timeout}s "
                f"(likely a long agentic turn or a network issue)"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"agy CLI error: {exc}") from exc

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")[:400]
            # Check for quota exhaustion error
            if "429" in stderr or "exhausted" in stderr.lower() or "quota" in stderr.lower():
                raise LLMError(f"Gemini quota exhausted: {stderr}")
            raise LLMError(f"agy CLI exited {result.returncode}: {stderr}")

        stdout = result.stdout.decode(errors="replace").strip()
        try:
            envelope = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise LLMError(
                f"agy CLI returned non-JSON output: {stdout[:200]}"
            ) from exc
        if not isinstance(envelope, dict):
            raise LLMError("agy CLI envelope is not an object")

        status = envelope.get("status")
        if status != "SUCCESS":
            raise LLMError(f"agy CLI reported status {status!r}: {stdout[:200]}")

        response = envelope.get("response")
        if not isinstance(response, str):
            raise LLMError("agy CLI envelope missing string 'response' field")
        if not response.strip():
            # status was SUCCESS but nothing came back — almost always a
            # tool agy couldn't run headlessly. Name the denied actions so
            # the user can see WHY instead of debugging an empty string
            # three layers downstream. See module docstring, failure #2.
            denied = _denied_action_names(envelope)
            if denied:
                raise LLMError(
                    f"agy returned an empty response after denying {', '.join(denied)}: "
                    f"the prompt triggered a tool agy cannot run headlessly. "
                    f"Rephrase the prompt so it only needs agy's built-in tools."
                )
            raise LLMError("agy CLI returned an empty response")
        return response.strip()


# ── helpers ───────────────────────────────────────────────────────────


def _parse_models(stdout: str) -> list[dict]:
    """Parse ``agy models`` stdout into ``[{"id", "label"}]``.

    The real output opens with a bare ``Fetching available models...``
    status line and then one ``<id>\\t<Label>`` row per model. Filtering on
    "line contains a tab" drops the status line without having to
    hard-code its text — any future banner agy adds is dropped the same way.
    """
    out: list[dict] = []
    for line in stdout.splitlines():
        if "\t" not in line:
            continue
        model_id, _, label = line.partition("\t")
        model_id = model_id.strip()
        label = label.strip()
        if not model_id:
            continue
        out.append({"id": model_id, "label": label or model_id})
    return out


def _denied_action_names(envelope: dict) -> list[str]:
    """Pull human-readable names out of the envelope's ``denied_actions``.

    Shape is ``[{"action": "command", "display_name": "RunCommand"}]``;
    we prefer ``display_name`` and fall back to ``action`` so a future
    entry without a display name still names something useful.
    """
    denied = envelope.get("denied_actions")
    if not isinstance(denied, list):
        return []
    names: list[str] = []
    for item in denied:
        if not isinstance(item, dict):
            continue
        name = item.get("display_name") or item.get("action")
        if isinstance(name, str) and name:
            names.append(name)
    return names
