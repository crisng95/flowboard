"""FlowBrowserDriver — Raw CDP/WebSocket driver for Google Flow.

Attaches to an active, pre-authenticated Google Flow tab via
Chrome Remote Debugging Protocol (WebSocket, port 9222).
Does NOT use Playwright — communicates directly over the CDP JSON/WS protocol.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import websockets  # plain CDP WebSocket — no Playwright dependency

from flowboard.extension_worker.flow_executor import FlowDriver

logger = logging.getLogger(__name__)

# CDP-compatible CSS selectors for Google Flow on Google Labs/Fx.
SELECTORS = {
    "prompt_input": [
        "textarea[placeholder*='prompt']",
        "textarea",
        "[contenteditable='true']"
    ],
    "send_button": [
        "button[aria-label*='generate']",
        "button[type='submit']",
        "button.generate-btn",
        "button"
    ],
    "generating_indicators": [
        ".progress-bar",
        ".generating",
        ".loading-spinner",
        "button[aria-label*='Stop']",
        "div[role='progressbar']"
    ],
    "output_media": [
        "img.output-media",
        ".result-container img",
        "video.output-media",
        ".result-container video",
        "img[src^='blob:']",
        "img[src^='data:']",
        "video[src^='blob:']",
        "video[src^='data:']",
        "img",
        "video"
    ]
}


class FlowDriverError(RuntimeError):
    """Base exception for Flow driver failures."""


class _CDPSession:
    """Minimal raw CDP WebSocket session for one browser tab."""

    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._ws: Any = None
        self._next_id = 1
        self._pending: Dict[int, asyncio.Future] = {}
        self._listener_task: Optional[asyncio.Task] = None

    async def connect(self) -> None:
        self._ws = await websockets.connect(
            self._ws_url,
            max_size=50 * 1024 * 1024,  # 50 MB for large base64 payloads
            open_timeout=10,
        )
        self._listener_task = asyncio.create_task(self._listen())

    async def disconnect(self) -> None:
        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

    async def _listen(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                msg_id = msg.get("id")
                if msg_id and msg_id in self._pending:
                    fut = self._pending.pop(msg_id)
                    if not fut.done():
                        fut.set_result(msg)
        except (websockets.exceptions.ConnectionClosed, asyncio.CancelledError):
            pass
        except Exception as exc:
            logger.debug("[cdp-session] listener error: %s", exc)

    async def send(self, method: str, params: Optional[Dict] = None, timeout: float = 15.0) -> Dict:
        cmd_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[cmd_id] = fut
        payload = json.dumps({"id": cmd_id, "method": method, "params": params or {}})
        await self._ws.send(payload)
        try:
            result = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise FlowDriverError(f"CDP command '{method}' timed out after {timeout}s")
        if "error" in result:
            raise FlowDriverError(f"CDP error on '{method}': {result['error']}")
        return result.get("result", {})

    async def evaluate(self, expression: str, timeout: float = 15.0) -> Any:
        """Execute a JS expression and return its value."""
        result = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
            timeout=timeout,
        )
        exc_details = result.get("exceptionDetails")
        if exc_details:
            desc = exc_details.get("exception", {}).get("description", str(exc_details))
            raise FlowDriverError(f"JS exception: {desc}")
        return result.get("result", {}).get("value")

    async def evaluate_async(self, expression: str, timeout: float = 30.0) -> Any:
        """Execute an async JS expression and await the Promise."""
        wrapped = f"(async () => {{ {expression} }})()"
        return await self.evaluate(wrapped, timeout=timeout)

    async def dispatch_mouse_click(self, x: float, y: float) -> None:
        """Dispatch a left mouse click at (x, y) in page coordinates."""
        for event_type in ("mousePressed", "mouseReleased"):
            await self.send("Input.dispatchMouseEvent", {
                "type": event_type,
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            })
            await asyncio.sleep(0.05)


class FlowBrowserDriver(FlowDriver):
    """Raw CDP/WebSocket driver attaching to an active Google Flow tab.

    Connects to Chrome Remote Debugging on port 9222.
    Does NOT use Playwright.
    """

    def __init__(
        self,
        cdp_url: str = "http://localhost:9222",
        connect_timeout_sec: float = 5.0,
        page_ready_timeout_sec: float = 5.0,
        generation_timeout_sec: float = 20.0,
    ) -> None:
        super().__init__()
        self.cdp_url = cdp_url
        self.connect_timeout = connect_timeout_sec
        self.page_ready_timeout = page_ready_timeout_sec
        self.generation_timeout = generation_timeout_sec

    # ---------------------------------------------------------------------- #
    # Internal helpers
    # ---------------------------------------------------------------------- #

    def _sniff_mime_type(self, content_bytes: bytes) -> Optional[str]:
        """Sniff magic bytes for PNG, JPEG, and MP4 formats."""
        if content_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if content_bytes.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if len(content_bytes) > 8 and content_bytes[4:8] == b"ftyp":
            return "video/mp4"
        return None

    def _redact_url(self, url: str) -> str:
        """Redact URL queries, long tokens, or raw data URL payloads for logs."""
        if not url:
            return ""
        if url.startswith("data:"):
            parts = url.split(",", 1)
            return f"{parts[0]},[REDACTED base64]"
        if url.startswith("blob:"):
            return "blob:[REDACTED]"
        try:
            parsed = urlparse(url)
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?[REDACTED]"
        except Exception:
            return "[UNPARSABLE URL]"

    def _is_flow_app_url(self, url: str) -> bool:
        """Return True for known Google Flow application URLs."""
        try:
            parsed = urlparse(url)
            host = parsed.netloc.lower()
            path = parsed.path.lower()
        except Exception:
            return False

        return (
            host == "flow.google.com"
            or host.endswith(".flow.google.com")
            or (host == "labs.google" and "/tools/flow" in path)
        )

    def _is_allowed_media_url(self, url: str) -> bool:
        """Allow only media URLs expected from Google Flow output elements."""
        src_lower = url.lower()
        if src_lower.startswith("data:image/png") or src_lower.startswith("data:image/jpeg"):
            return True
        if src_lower.startswith("blob:"):
            return True
        if not src_lower.startswith("https://"):
            return False

        try:
            parsed = urlparse(url)
            host = parsed.netloc.lower()
        except Exception:
            return False

        return (
            host == "flow.google.com"
            or host.endswith(".flow.google.com")
            or host == "labs.google"
            or host.endswith(".googleusercontent.com")
            or host.endswith(".google.com")
        )

    async def _get_flow_tab_ws_url(self) -> str:
        """Fetch /json from Chrome debugging port and return the WS URL of the Google Flow tab."""
        import httpx
        debug_base = self.cdp_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=self.connect_timeout) as client:
                resp = await client.get(f"{debug_base}/json")
                resp.raise_for_status()
                tabs = resp.json()
        except Exception as exc:
            raise FlowDriverError(f"Cannot reach Chrome debugging port at {debug_base}: {exc}")

        for tab in tabs:
            url = tab.get("url", "")
            ws_url = tab.get("webSocketDebuggerUrl", "")
            if ws_url and self._is_flow_app_url(url):
                logger.info("[flow-driver] found Flow tab: %s ws=%s", url[:60], ws_url[:60])
                return ws_url

        # Fall back: any Google-hosted tab with a Flow path in the URL.
        for tab in tabs:
            url = tab.get("url", "")
            ws_url = tab.get("webSocketDebuggerUrl", "")
            if ws_url and "flow" in url.lower() and "google" in url.lower():
                logger.info("[flow-driver] fallback Flow tab: %s", url[:60])
                return ws_url

        tab_urls = [t.get("url", "")[:80] for t in tabs[:10]]
        raise FlowDriverError(
            f"No Google Flow tab found in active browser sessions. "
            f"Open tabs: {tab_urls}"
        )

    async def _first_visible_selector_rect(self, session: _CDPSession, selectors: List[str]) -> Optional[Dict]:
        """Return bounding rect of first visible element matching any selector."""
        for sel in selectors:
            try:
                js = f"""
                (() => {{
                    const el = document.querySelector({json.dumps(sel)});
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return null;
                    const style = getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') return null;
                    return {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tag: el.tagName, sel: {json.dumps(sel)} }};
                }})()
                """
                result = await session.evaluate(js)
                if result:
                    return result
            except Exception:
                continue
        return None

    async def _query_all_src(self, session: _CDPSession, selectors: List[str]) -> set:
        """Return the set of non-empty src attributes for all matching elements."""
        srcs: set = set()
        for sel in selectors:
            try:
                js = f"""
                (() => {{
                    const els = Array.from(document.querySelectorAll({json.dumps(sel)}));
                    return els
                        .map(el => el.getAttribute('src') || el.src || '')
                        .filter(s => s && s.trim());
                }})()
                """
                result = await session.evaluate(js)
                if isinstance(result, list):
                    srcs.update(s for s in result if s)
            except Exception:
                continue
        return srcs

    async def _check_indicator_visible(self, session: _CDPSession) -> bool:
        """Return True if any generating indicator is visible on the page."""
        rect = await self._first_visible_selector_rect(session, SELECTORS["generating_indicators"])
        return rect is not None

    # ---------------------------------------------------------------------- #
    # Main public method
    # ---------------------------------------------------------------------- #

    async def generate_assets(
        self, prompt: str, user_id: str, request_id: str, timeout: float = 30.0
    ) -> List[Dict[str, Any]]:
        """Flow asset generation using raw CDP/WebSocket."""
        await asyncio.sleep(0.01)

        prompt_len = len(prompt)
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        logger.info("[flow-driver] starting generation: len=%d hash=%s", prompt_len, prompt_hash)

        # 1. Find the Flow tab WS URL
        ws_url = await asyncio.wait_for(
            self._get_flow_tab_ws_url(),
            timeout=self.connect_timeout,
        )

        session = _CDPSession(ws_url)
        try:
            await session.connect()
            await session.send("Runtime.enable")

            # 2. Ready check — prompt input visible?
            start_ready = time.monotonic()
            prompt_rect = None
            while time.monotonic() - start_ready < self.page_ready_timeout:
                prompt_rect = await self._first_visible_selector_rect(session, SELECTORS["prompt_input"])
                if prompt_rect:
                    break
                await asyncio.sleep(0.5)

            if not prompt_rect:
                raise FlowDriverError("Google Flow tab is not ready or unauthenticated")

            # 3. Snapshot existing media srcs before submission
            existing_srcs = await self._query_all_src(session, SELECTORS["output_media"])

            # 4. Clear + fill prompt input
            px, py = prompt_rect["x"], prompt_rect["y"]
            # Click to focus
            await session.dispatch_mouse_click(px, py)
            await asyncio.sleep(0.15)
            # Select all + type replacement
            await session.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "a", "modifiers": 8})
            await session.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "modifiers": 8})
            await asyncio.sleep(0.05)
            # Use evaluate to set textarea value directly (most reliable for React-controlled inputs)
            fill_js = f"""
            (() => {{
                const el = document.querySelector({json.dumps(prompt_rect['sel'])});
                if (!el) return false;
                const setter = Object.getOwnPropertyDescriptor(
                    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype,
                    'value'
                );
                if (setter && setter.set) {{
                    setter.set.call(el, {json.dumps(prompt)});
                }} else {{
                    el.value = {json.dumps(prompt)};
                }}
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
            }})()
            """
            filled = await session.evaluate(fill_js)
            if not filled:
                raise FlowDriverError("Failed to fill prompt input field")

            await asyncio.sleep(0.1)

            # 5. Find + click submit button
            send_rect = await self._first_visible_selector_rect(session, SELECTORS["send_button"])
            if not send_rect:
                raise FlowDriverError("Google Flow submit button is unavailable")

            await session.dispatch_mouse_click(send_rect["x"], send_rect["y"])
            logger.info("[flow-driver] prompt submitted, waiting for generation...")

            # 6. Monitor generation progress
            start_gen = time.monotonic()
            gen_timeout = min(timeout, self.generation_timeout)
            new_media_src: Optional[str] = None
            new_media_sel: Optional[str] = None
            indicator_seen = False
            indicator_visible_last = False

            while time.monotonic() - start_gen < gen_timeout:
                indicator_active = await self._check_indicator_visible(session)
                if indicator_active:
                    indicator_seen = True
                    indicator_visible_last = True
                    await asyncio.sleep(0.5)
                    continue
                indicator_visible_last = False

                # Search for a new src
                current_srcs = await self._query_all_src(session, SELECTORS["output_media"])
                new_srcs = current_srcs - existing_srcs
                for src in new_srcs:
                    if src.strip():
                        # Find which selector matched this src
                        for sel in SELECTORS["output_media"]:
                            try:
                                js_find = f"""
                                (() => {{
                                    const els = Array.from(document.querySelectorAll({json.dumps(sel)}));
                                    const el = els.find(e => (e.getAttribute('src') || e.src || '') === {json.dumps(src)});
                                    if (!el) return null;
                                    const rect = el.getBoundingClientRect();
                                    return rect.width > 0 && rect.height > 0 ? {json.dumps(sel)} : null;
                                }})()
                                """
                                matched_sel = await session.evaluate(js_find)
                                if matched_sel:
                                    new_media_src = src
                                    new_media_sel = matched_sel
                                    break
                            except Exception:
                                continue
                        if new_media_src:
                            break

                if new_media_src:
                    break

                await asyncio.sleep(0.5)

            # Timeout classification
            if not new_media_src:
                if indicator_seen and indicator_visible_last:
                    raise FlowDriverError("generating indicator did not disappear")
                raise FlowDriverError("no output media element found")

            logger.info("[flow-driver] new output media detected: src=%s", self._redact_url(new_media_src))

            # 7. Scheme allowlist check
            src_lower = new_media_src.lower()
            if not self._is_allowed_media_url(new_media_src):
                raise FlowDriverError("MIME or size validation failed: Unsafe or unallowed media URL scheme")

            # 8. Extract bytes
            content_bytes = b""
            mime_type: Optional[str] = None

            if src_lower.startswith("data:"):
                try:
                    header, b64_data = new_media_src.split(",", 1)
                    if len(b64_data) > 34 * 1024 * 1024:
                        raise FlowDriverError("MIME or size validation failed: Asset size exceeds the 25MB limit")
                    content_bytes = base64.b64decode(b64_data)
                    if "image/png" in header:
                        mime_type = "image/png"
                    elif "image/jpeg" in header:
                        mime_type = "image/jpeg"
                    elif "video/mp4" in header:
                        mime_type = "video/mp4"
                except FlowDriverError:
                    raise
                except Exception as exc:
                    raise FlowDriverError(f"download bytes failed: Failed to decode data URL: {exc}")
            else:
                # blob: or https: — use in-page fetch via CDP evaluate
                try:
                    fetch_js = f"""
                    (async () => {{
                        const sel = {json.dumps(new_media_sel)};
                        const expectedSrc = {json.dumps(new_media_src)};
                        const candidates = Array.from(document.querySelectorAll(sel));
                        const el = candidates.find(c => (c.getAttribute('src') || c.src || '') === expectedSrc);
                        if (!el) throw new Error('no output media element found');
                        const actualSrc = el.getAttribute('src') || el.src;
                        if (actualSrc !== expectedSrc) throw new Error('Source mismatch');
                        const resp = await fetch(expectedSrc);
                        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
                        const blob = await resp.blob();
                        if (blob.size > 25 * 1024 * 1024) throw new Error('EXCEEDED_SIZE_LIMIT');
                        const reader = new FileReader();
                        const dataUrl = await new Promise((resolve, reject) => {{
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = () => reject(new Error('Failed to read blob'));
                            reader.readAsDataURL(blob);
                        }});
                        return {{ dataUrl, size: blob.size, contentType: blob.type || resp.headers.get('content-type') || '' }};
                    }})()
                    """
                    result = await session.evaluate_async(fetch_js, timeout=30.0)
                    if not result or not isinstance(result, dict):
                        raise FlowDriverError("download bytes failed: empty response from in-page fetch")
                    header, b64_data = result["dataUrl"].split(",", 1)
                    content_bytes = base64.b64decode(b64_data)
                    reported_mime = result["contentType"].split(";")[0].strip().lower()
                    if reported_mime in ("image/png", "image/jpeg", "video/mp4"):
                        mime_type = reported_mime
                except FlowDriverError:
                    raise
                except Exception as exc:
                    err_msg = str(exc)
                    if "EXCEEDED_SIZE_LIMIT" in err_msg:
                        raise FlowDriverError("MIME or size validation failed: Asset size exceeds the 25MB limit")
                    raise FlowDriverError(f"download bytes failed: {err_msg}")

            # 9. Size guard
            if len(content_bytes) > 25 * 1024 * 1024:
                raise FlowDriverError("MIME or size validation failed: Asset size exceeds the 25MB limit")

            # 10. MIME sniff hierarchy
            final_mime: Optional[str] = None
            if mime_type in ("image/png", "image/jpeg", "video/mp4"):
                final_mime = mime_type
            sniffed = self._sniff_mime_type(content_bytes)
            if sniffed:
                final_mime = sniffed

            if not final_mime:
                raise FlowDriverError("MIME or size validation failed: Unrecognized or disallowed media MIME type")

            ext = "png"
            if final_mime == "image/jpeg":
                ext = "jpg"
            elif final_mime == "video/mp4":
                ext = "mp4"

            file_name = f"flow_output.{ext}"
            checksum = hashlib.sha256(content_bytes).hexdigest()

            logger.info(
                "[flow-driver] extraction OK, MIME=%s bytes=%d checksum=%s",
                final_mime, len(content_bytes), checksum[:12]
            )
            return [
                {
                    "source_provider": "flow",
                    "file_name": file_name,
                    "storage_key": f"users/{user_id}/flow/{request_id}/output-0.{ext}",
                    "mime_type": final_mime,
                    "byte_size": len(content_bytes),
                    "checksum": checksum,
                    "prompt_snapshot": prompt,
                    "content_bytes": content_bytes,
                }
            ]

        finally:
            try:
                await session.disconnect()
            except Exception as exc:
                logger.warning("[flow-driver] failed to disconnect CDP session: %s", exc)
