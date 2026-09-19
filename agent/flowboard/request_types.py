"""How the app classifies its ``Request.type`` values.

Lives at the top level, next to ``timestamps``, because modules that sit
on opposite sides of the app need the same lists and none of them owns
the lists: ``worker/processor.py`` uses ``MEDIA_PRODUCING_TYPES`` to
decide whether a clean-looking result that carried no media should be
treated as a failure, and ``routes/boards.py`` uses both sets to decide
which in-flight rows are worth handing to a reloading page.

Sharing them as a module rather than letting the route reach into the
worker for a private ``_MEDIA_PRODUCING_TYPES`` keeps a route module from
importing the worker — which drags in the Flow SDK, the extension client
and the media service — just to read four strings. It is the same move
``utc_iso`` made out of ``routes/activity.py``.

Both sets are allowlists, on purpose. A new activity type is excluded
from every behaviour keyed off them until someone deliberately adds it,
rather than being opted in by whoever forgot to exclude it.
"""
from __future__ import annotations

# Dispatched to the worker, and settle by producing media ids. These are
# the only rows a generation poll can act on: it reads `media_ids` off the
# result and writes them onto the node.
MEDIA_PRODUCING_TYPES: frozenset[str] = frozenset(
    {"gen_image", "gen_video", "gen_video_omni", "edit_image"}
)

# The synchronous LLM activities. They are NOT worker requests — each one
# runs to completion inside its own HTTP handler and settles its own row
# (see services/activity.py) — but they are node-attached and long enough
# (5-120s) that a reload lands in the middle of one, so a reloading page
# still wants to know they are in flight.
#
# What they are not is resumable the way a generation is: their result is
# text (`description` / `prompt` / `prompts`), carries no `media_ids`, and
# handing one to the generation poll makes it read that absence as "this
# node rendered nothing" and wipe the node's image. Hence two sets rather
# than one flag — the caller has to say which kind it can handle.
#
# `planner` is deliberately absent: it is node-less, so it never reaches a
# board listing in the first place.
SIDECAR_REQUEST_TYPES: frozenset[str] = frozenset(
    {"vision", "auto_prompt", "auto_prompt_batch"}
)
