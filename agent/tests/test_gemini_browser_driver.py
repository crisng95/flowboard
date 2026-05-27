"""Unit tests for Phase 4.2C: Gemini Browser Driver Real Adapter.

Mocks Playwright CDP layer to cover all driver execution paths without running a real browser.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flowboard.extension_worker.gemini_browser_driver import (
    GeminiBrowserDriver,
    GeminiDriverError,
)
from flowboard.extension_worker.gemini_executor import GeminiExecutor
from flowboard.extension_worker.mock_executor import ExecutionError


class TestGeminiBrowserDriver:

    @pytest.fixture
    def mock_playwright(self):
        """Mock the entire async_playwright context manager hierarchy."""
        with patch("flowboard.extension_worker.gemini_browser_driver.async_playwright") as mock_ap, \
             patch("flowboard.extension_worker.gemini_browser_driver.PLAYWRIGHT_AVAILABLE", True):

            # Setup page mocks
            mock_page = MagicMock()
            mock_page.url = "https://gemini.google.com/app"
            mock_page.bring_to_front = AsyncMock()
            mock_page.wait_for_selector = AsyncMock()
            mock_page.keyboard = MagicMock()
            mock_page.keyboard.press = AsyncMock()
            mock_page.keyboard.insert_text = AsyncMock()

            # Mocks for input elements
            mock_input = MagicMock()
            mock_input.click = AsyncMock()
            mock_input.is_visible = AsyncMock(return_value=True)

            # Mocks for send button
            mock_send = MagicMock()
            mock_send.click = AsyncMock()
            mock_send.is_visible = AsyncMock(return_value=True)
            
            # Setup context and pages
            mock_context = MagicMock()
            mock_context.pages = [mock_page]

            mock_browser = MagicMock()
            mock_browser.contexts = [mock_context]
            # Mock disconnect capability
            mock_browser.disconnect = AsyncMock()
            mock_browser.close = AsyncMock()

            # Ensure query_selector_all has a default async return value
            mock_page.query_selector_all = AsyncMock(return_value=[])

            # Async context manager mock for playwright
            mock_playwright_instance = MagicMock()
            mock_playwright_instance.chromium = MagicMock()
            mock_playwright_instance.chromium.connect_over_cdp = AsyncMock(return_value=mock_browser)

            # Context manager entry
            mock_ap.return_value.__aenter__ = AsyncMock(return_value=mock_playwright_instance)
            mock_ap.return_value.__aexit__ = AsyncMock(return_value=None)

            yield {
                "page": mock_page,
                "browser": mock_browser,
                "input": mock_input,
                "send_button": mock_send,
                "cdp_connect": mock_playwright_instance.chromium.connect_over_cdp,
            }

    @pytest.mark.asyncio
    async def test_connect_success_finds_gemini_tab(self, mock_playwright):
        """Driver connects over CDP and successfully locates active Gemini tab."""
        page = mock_playwright["page"]
        
        # Elements returned during query_selectors
        mock_el = MagicMock()
        mock_el.is_visible = AsyncMock(return_value=True)
        mock_el.inner_text = AsyncMock(return_value="My funny response text")
        
        async def mock_query_selector(selector):
            # If checking generating indicator, return None (not generating)
            if any(term in selector for term in ["Stop", "Cancel", "generating", "progress-bar"]):
                return None
            if any(term in selector for term in ["Send", "send", "submit"]):
                return mock_playwright["send_button"]
            if any(term in selector for term in ["prompt", "textarea"]):
                return mock_playwright["input"]
            return mock_el

        page.query_selector.side_effect = mock_query_selector
        
        # Ensure first_visible_selector_all resolves [mock_el] after submission
        called_selectors = set()
        async def mock_query_selector_all(selector):
            if any(term in selector for term in ["message-content", "chat-entry", "message-text"]):
                if selector not in called_selectors:
                    called_selectors.add(selector)
                    return []
                return [mock_el]
            return []
        page.query_selector_all.side_effect = mock_query_selector_all

        driver = GeminiBrowserDriver(connect_timeout_sec=5.0, generation_timeout_sec=5.0)
        res = await driver.generate("Test prompt")
        
        assert res["text"] == "My funny response text"
        assert res["model"] == "gemini-attached-tab"
        mock_playwright["cdp_connect"].assert_called_once_with("http://localhost:9222")
        page.bring_to_front.assert_called_once()
        # Verify safe disconnect called instead of close
        mock_playwright["browser"].disconnect.assert_called_once()
        mock_playwright["browser"].close.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_gemini_tab_raises_driver_error(self, mock_playwright):
        """If url is not gemini.google.com, raises GeminiDriverError."""
        page = mock_playwright["page"]
        page.url = "https://google.com"  # Wrong URL

        driver = GeminiBrowserDriver()
        with pytest.raises(GeminiDriverError, match="Active Google Gemini tab was not found"):
            await driver.generate("Test prompt")

    @pytest.mark.asyncio
    async def test_session_not_ready_raises_driver_error(self, mock_playwright):
        """If prompt input selector does not attach, raises GeminiDriverError."""
        page = mock_playwright["page"]
        page.query_selector.return_value = None  # never visible

        driver = GeminiBrowserDriver(page_ready_timeout_sec=0.1)
        with pytest.raises(GeminiDriverError, match="Gemini session is not ready or user is not logged in"):
            await driver.generate("Test prompt")

    @pytest.mark.asyncio
    async def test_submit_prompt_success_with_click_retry(self, mock_playwright):
        """Driver inputs text and successfully clicks submit on retry."""
        page = mock_playwright["page"]
        
        input_el = mock_playwright["input"]
        send_btn = mock_playwright["send_button"]
        
        # Simulate click fail on attempt 1, success on attempt 2
        click_count = 0
        async def mock_click():
            nonlocal click_count
            click_count += 1
            if click_count == 1:
                raise RuntimeError("Button not interactable yet")
            return None
        send_btn.click.side_effect = mock_click

        mock_bubble = MagicMock()
        mock_bubble.is_visible = AsyncMock(return_value=True)
        mock_bubble.inner_text = AsyncMock(return_value="Response text")

        async def mock_query_selector(selector):
            # If checking generating indicator, return None (not generating)
            if any(term in selector for term in ["Stop", "Cancel", "generating", "progress-bar"]):
                return None
            if any(term in selector for term in ["Send", "send"]):
                return send_btn
            if any(term in selector for term in ["prompt", "textarea"]):
                return input_el
            return None

        page.query_selector.side_effect = mock_query_selector
        
        # Ensure first_visible_selector_all resolves [mock_bubble] after submission
        called_selectors = set()
        async def mock_query_selector_all(selector):
            if any(term in selector for term in ["message-content", "chat-entry", "message-text"]):
                if selector not in called_selectors:
                    called_selectors.add(selector)
                    return []
                return [mock_bubble]
            return []
        page.query_selector_all.side_effect = mock_query_selector_all

        driver = GeminiBrowserDriver(connect_timeout_sec=5.0, generation_timeout_sec=5.0)
        await driver.generate("My prompt")

        input_el.click.assert_called_once()
        page.keyboard.press.assert_any_call("Control+A")
        page.keyboard.press.assert_any_call("Backspace")
        page.keyboard.insert_text.assert_called_once_with("My prompt")
        assert click_count == 2  # retry was triggered and click succeeded!

    @pytest.mark.asyncio
    async def test_timeout_waiting_for_response(self, mock_playwright):
        """If generation indicators remain active or no bubbles are generated, raise driver error with reason."""
        page = mock_playwright["page"]
        
        mock_indicator = MagicMock()
        mock_indicator.is_visible = AsyncMock(return_value=True)

        async def mock_query_selector(selector):
            if any(term in selector for term in ["Send", "send"]):
                return mock_playwright["send_button"]
            if any(term in selector for term in ["prompt", "textarea"]):
                return mock_playwright["input"]
            return mock_indicator

        page.query_selector.side_effect = mock_query_selector
        page.query_selector_all = AsyncMock(return_value=[])

        driver = GeminiBrowserDriver(generation_timeout_sec=0.05)
        with pytest.raises(GeminiDriverError, match="still generating|no response bubble appeared"):
            await driver.generate("Test prompt", timeout=0.05)

    @pytest.mark.asyncio
    async def test_empty_response_rejected_via_executor(self):
        """If the driver returns empty/whitespace, GeminiExecutor raises ExecutionError."""

        class EmptyTextDriver:
            async def generate(self, prompt: str, timeout: float = 30.0) -> dict[str, Any]:
                return {"text": "   ", "model": "fake"}

        executor = GeminiExecutor(driver=EmptyTextDriver(), timeout_sec=5.0)
        job = {"id": "job-1", "input_data": {"prompt": "Hello"}}

        with pytest.raises(ExecutionError, match="missing, null, or empty 'text' key"):
            async for _ in executor.run(job):
                pass

    @pytest.mark.asyncio
    async def test_cancellation_propagates(self, mock_playwright):
        """If generating task is cancelled, the CancelledError propagates."""
        page = mock_playwright["page"]
        
        async def slow_connect(*a, **k):
            await asyncio.sleep(2.0)
            return mock_playwright["browser"]
            
        mock_playwright["cdp_connect"].side_effect = slow_connect

        driver = GeminiBrowserDriver()
        task = asyncio.create_task(driver.generate("Hello"))
        await asyncio.sleep(0.05)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

