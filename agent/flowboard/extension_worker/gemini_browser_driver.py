"""GeminiBrowserDriver — implements Playwright/CDP remote attachment to an active Gemini session.

No authentication or credentials are managed inside this driver. It attaches to an existing
Chrome remote debugging session, locates the active Gemini tab, inputs prompts, and extracts responses.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from typing import Any, Dict, Optional

# Try to import playwright; handle nicely if not installed in CI
try:
    from playwright.async_api import Page, async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    Page = Any  # type: ignore
    async_playwright = None

from flowboard.extension_worker.gemini_executor import GeminiDriver

logger = logging.getLogger(__name__)

# Centralized Playwright Selectors for gemini.google.com
SELECTORS = {
    "prompt_input": [
        "gconnect-prompt-input",
        "rich-textarea",
        "textarea",
        "[contenteditable='true']"
    ],
    "send_button": [
        "button[aria-label*='Send']",
        "button.send-button",
        ".send-button-container button",
        "button[type='submit']"
    ],
    "response_elements": [
        "message-content",
        ".message-content",
        ".chat-entry",
        ".message-text"
    ],
    "generating_indicators": [
        "button[aria-label*='Stop']",
        "button[aria-label*='Cancel']",
        ".generating",
        ".progress-bar"
    ],
}


class GeminiDriverError(RuntimeError):
    """Base exception for Gemini driver failures."""


class GeminiBrowserDriver(GeminiDriver):
    """Playwright/CDP driver attaching to an active Google Gemini tab.

    No passwords or cookies are handled. Relies entirely on Chrome Remote Debugging on port 9222.
    """

    def __init__(
        self,
        cdp_url: str = "http://localhost:9222",
        connect_timeout_sec: float = 10.0,
        page_ready_timeout_sec: float = 10.0,
        generation_timeout_sec: float = 30.0,
    ) -> None:
        self.cdp_url = cdp_url
        self.connect_timeout = connect_timeout_sec
        self.page_ready_timeout = page_ready_timeout_sec
        self.generation_timeout = generation_timeout_sec

    async def _first_visible_selector(self, page: Page, selector_group: list[str]) -> Optional[Any]:
        """Query and return the first element in the group that is attached and visible."""
        for sel in selector_group:
            try:
                el = await page.query_selector(sel)
                if el and await el.is_visible():
                    return el
            except Exception:
                continue
        return None

    async def _first_visible_selector_all(self, page: Page, selector_group: list[str]) -> list[Any]:
        """Query and return all matching elements for the first responsive selector in the group."""
        for sel in selector_group:
            try:
                els = await page.query_selector_all(sel)
                if els:
                    # Filter for visible elements
                    visible_els = []
                    for el in els:
                        if await el.is_visible():
                            visible_els.append(el)
                    if visible_els:
                        return visible_els
            except Exception:
                continue
        return []

    async def generate(self, prompt: str, timeout: float = 30.0) -> Dict[str, Any]:
        """Submit prompt to active Gemini tab and extract response."""
        if not PLAYWRIGHT_AVAILABLE:
            raise GeminiDriverError("Playwright library is not installed in the current environment.")

        # Override default timeout with caller timeout if supplied
        effective_timeout = min(self.generation_timeout, timeout)

        # Redact prompt for log safety
        prompt_len = len(prompt)
        prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:12]
        logger.info(
            "event=gemini_driver_start cdp=%s prompt_len=%d prompt_hash=%s",
            self.cdp_url, prompt_len, prompt_hash
        )

        async with async_playwright() as p:
            # 1. Connect over CDP to remote Chrome debugging session
            try:
                browser = await asyncio.wait_for(
                    p.chromium.connect_over_cdp(self.cdp_url),
                    timeout=self.connect_timeout
                )
            except Exception as exc:
                logger.error("event=gemini_driver_connect_failed error=%s", exc)
                raise GeminiDriverError(
                    f"Could not connect to Chrome debugging port at {self.cdp_url}. "
                    "Make sure Chrome is running with remote debugging enabled."
                ) from exc

            try:
                # 2. Locate the active Gemini tab with advanced multi-tab selection
                gemini_candidates: list[Page] = []
                for context in browser.contexts:
                    for page in context.pages:
                        if "gemini.google.com" in page.url:
                            # Log with redacted titles/URLs only
                            title_len = len(page.url)
                            logger.info("event=gemini_driver_tab_discovered url_len=%d", title_len)
                            gemini_candidates.append(page)

                if not gemini_candidates:
                    logger.error("event=gemini_driver_tab_not_found contexts_checked=%d", len(browser.contexts))
                    raise GeminiDriverError("Active Google Gemini tab was not found in browser sessions.")

                # Try to pick the best tab
                gemini_page: Optional[Page] = None
                
                # Rank 1: Active/frontmost page that has prompt input ready
                for page in gemini_candidates:
                    # Playwright doesn't have page.is_active(), but we can check if it has prompt ready
                    input_el = await self._first_visible_selector(page, SELECTORS["prompt_input"])
                    if input_el:
                        gemini_page = page
                        break

                # Rank 2: Fall back to first candidate
                if not gemini_page:
                    gemini_page = gemini_candidates[0]

                # Ensure page focus
                await gemini_page.bring_to_front()

                # 3. Detect page ready & logged in status
                prompt_input_el = None
                start_ready = time.monotonic()
                ready_deadline = start_ready + self.page_ready_timeout
                while time.monotonic() < ready_deadline:
                    prompt_input_el = await self._first_visible_selector(gemini_page, SELECTORS["prompt_input"])
                    if prompt_input_el:
                        break
                    await asyncio.sleep(0.5)

                if not prompt_input_el:
                    logger.error("event=gemini_driver_session_not_ready")
                    raise GeminiDriverError(
                        "Gemini session is not ready or user is not logged in. "
                        "Make sure the prompt textarea is visible."
                    )

                # Count current response elements before submission to track newly created ones
                existing_bubbles = await self._first_visible_selector_all(gemini_page, SELECTORS["response_elements"])
                initial_bubble_count = len(existing_bubbles)
                initial_latest_text = ""
                if existing_bubbles:
                    try:
                        initial_latest_text = (await existing_bubbles[-1].inner_text()).strip()
                    except Exception:
                        initial_latest_text = ""
                logger.debug("event=gemini_driver_initial_state bubbles=%d", initial_bubble_count)

                # 4. Input prompt & submit with click retry (up to 2 attempts)
                try:
                    await prompt_input_el.click()
                    await gemini_page.keyboard.press("Control+A")
                    await gemini_page.keyboard.press("Backspace")
                    await gemini_page.keyboard.insert_text(prompt)

                    # Click retry logic for send button
                    clicked_successfully = False
                    for attempt in range(1, 3):
                        send_btn = await self._first_visible_selector(gemini_page, SELECTORS["send_button"])
                        if send_btn:
                            try:
                                await send_btn.click()
                                clicked_successfully = True
                                logger.info("event=gemini_driver_submitted attempt=%d", attempt)
                                break
                            except Exception as click_err:
                                logger.warning("event=gemini_driver_click_attempt_failed attempt=%d error=%s", attempt, click_err)
                        await asyncio.sleep(0.5)

                    if not clicked_successfully:
                        raise GeminiDriverError("send button unavailable or could not be clicked successfully after 2 attempts.")

                except Exception as exc:
                    logger.error("event=gemini_driver_submit_failed error=%s", exc)
                    raise GeminiDriverError(f"Failed to submit prompt to Gemini page: {exc}") from exc

                # 5. Wait for generation to complete with text stability checks
                start_gen = time.monotonic()
                deadline = start_gen + effective_timeout
                response_text = ""
                
                # Stability tracking
                last_stable_text = ""
                stable_ticks = 0
                REQUIRED_STABLE_TICKS = 3

                while time.monotonic() < deadline:
                    # Look for active generation indicators
                    generating = False
                    for indicator in SELECTORS["generating_indicators"]:
                        el = await gemini_page.query_selector(indicator)
                        if el and await el.is_visible():
                            generating = True
                            break

                    # Fetch response elements
                    bubbles = await self._first_visible_selector_all(gemini_page, SELECTORS["response_elements"])
                    current_count = len(bubbles)

                    temp_text = ""
                    if current_count > initial_bubble_count:
                        # Grab the latest bubble's text
                        latest_bubble = bubbles[-1]
                        temp_text = (await latest_bubble.inner_text()).strip()
                    elif current_count > 0:
                        latest_bubble = bubbles[-1]
                        temp_text = (await latest_bubble.inner_text()).strip()
                        if temp_text == initial_latest_text:
                            # Not updated yet
                            temp_text = ""

                    # Verify progress/stability
                    if temp_text:
                        if temp_text == last_stable_text:
                            stable_ticks += 1
                        else:
                            last_stable_text = temp_text
                            stable_ticks = 0

                        # Generation completes when indicators stop and text is completely stable
                        if not generating and stable_ticks >= REQUIRED_STABLE_TICKS:
                            response_text = temp_text
                            break
                    else:
                        stable_ticks = 0

                    await asyncio.sleep(0.5)

                if not response_text.strip():
                    elapsed = time.monotonic() - start_gen
                    # Differentiate timeout details
                    bubbles = await self._first_visible_selector_all(gemini_page, SELECTORS["response_elements"])
                    generating = False
                    for indicator in SELECTORS["generating_indicators"]:
                        el = await gemini_page.query_selector(indicator)
                        if el and await el.is_visible():
                            generating = True
                            break

                    if len(bubbles) <= initial_bubble_count:
                        reason = "no response bubble appeared"
                    elif generating:
                        reason = "still generating"
                    else:
                        reason = "empty response extracted"

                    logger.error("event=gemini_driver_generation_timeout elapsed=%.1fs reason=%s", elapsed, reason)
                    raise GeminiDriverError(f"Gemini text generation timed out after {effective_timeout}s: {reason}")

                # Redact response for safety
                resp_len = len(response_text)
                resp_hash = hashlib.sha256(response_text.encode("utf-8")).hexdigest()[:12]
                logger.info(
                    "event=gemini_driver_success elapsed=%.2fs response_len=%d response_hash=%s",
                    time.monotonic() - start_gen, resp_len, resp_hash
                )

                return {
                    "text": response_text.strip(),
                    "model": "gemini-attached-tab",
                    "raw": {"prompt_hash": prompt_hash, "elapsed_sec": time.monotonic() - start_gen},
                }

            finally:
                # Cleanup CDP browser connection cleanly via helper
                await self._close_browser_connection(browser)

    async def _close_browser_connection(self, browser: Any) -> None:
        """Encapsulated helper to close the CDP connection safely.

        Ensures the user's active Chrome window is not closed by checking capability.
        """
        try:
            disconnect = getattr(browser, "disconnect", None)
            if callable(disconnect):
                await disconnect()
                logger.info("event=gemini_driver_disconnected_safely")
            else:
                await browser.close()
                logger.warning("event=gemini_driver_closed_fallback")
        except Exception as exc:
            logger.warning("event=gemini_driver_disconnect_error error=%s", exc)

