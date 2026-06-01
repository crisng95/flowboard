"""Retirement smoke test for the Playwright Gemini driver (Req 10.4).

Confirms the LLM registry still imports cleanly and that the retired Playwright
``gemini_browser_driver`` module is gone, with no ``ImportError`` referencing it.
"""
from __future__ import annotations

import importlib

import pytest


def test_llm_registry_imports() -> None:
    """The LLM registry imports with no reference to the removed driver."""
    registry = importlib.import_module("flowboard.services.llm.registry")
    assert registry is not None


def test_gemini_executor_still_present() -> None:
    """The abstract base GeminiExecutor/GeminiDriver module must stay."""
    module = importlib.import_module("flowboard.extension_worker.gemini_executor")
    assert module is not None


def test_playwright_gemini_browser_driver_is_retired() -> None:
    """The Playwright concrete driver module must no longer be importable."""
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("flowboard.extension_worker.gemini_browser_driver")
