"""The request types whose whole purpose is to render media.

Lives at the top level, next to ``timestamps``, because two modules that
sit on opposite sides of the app need the same list and neither owns it:
``worker/processor.py`` uses it to decide whether a clean-looking result
that carried no media should be treated as a failure, and
``routes/boards.py`` uses it to decide which in-flight rows are worth
handing to a reloading page.

Sharing it as a module rather than letting the route reach into the
worker for a private ``_MEDIA_PRODUCING_TYPES`` keeps a route module from
importing the worker — which drags in the Flow SDK, the extension client
and the media service — just to read four strings. It is the same move
``utc_iso`` made out of ``routes/activity.py``.

Everything NOT in here (``proxy``, ``create_project``, and the
synchronous LLM activities ``vision`` / ``auto_prompt`` /
``auto_prompt_batch`` / ``planner``) legitimately settles with a bare
envelope and no media ids at all. That is why both callers ask this
question as an allowlist: a new activity type is excluded by default
rather than by someone remembering to exclude it.
"""
from __future__ import annotations

MEDIA_PRODUCING_TYPES: frozenset[str] = frozenset(
    {"gen_image", "gen_video", "gen_video_omni", "edit_image"}
)
