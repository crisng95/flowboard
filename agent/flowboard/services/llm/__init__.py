"""Multi-LLM provider layer.

Public surface (consumed by ``prompt_synth``, ``vision``, ``planner``):

- ``run_llm(feature, prompt, ...)`` — feature-routed dispatch
- ``LLMProvider`` — Protocol every provider implements
- ``LLMError`` — single error type the registry + providers raise

The HTTP routes layer (``routes/llm.py``) additionally imports ``secrets``
and the per-provider classes from ``registry`` for status / test endpoints.
"""
from __future__ import annotations

from .base import LLMError, LLMProvider
from .registry import get_provider, list_providers, run_llm

__all__ = ["LLMError", "LLMProvider", "get_provider", "list_providers", "run_llm"]
