"""Which Google Flow project Flowboard generates into, right now.

Since Flow stopped exposing ``project.createProject`` there is exactly one
Flow project behind every board, and until now the only way to name it was
``FLOWBOARD_FLOW_PROJECT_ID`` in ``.env``. ``config`` reads that once at
import, so switching projects meant editing a file and restarting the agent —
and anyone who edited the file without restarting kept generating into the old
project while believing they had moved.

So the id is resolved through :func:`effective_project_id` instead of read
from a constant. **Never import ``config.FLOW_PROJECT_ID`` at a call site.**
An import binds the env value at module load and a later override would be
silently ignored there while every other call site honoured it — which is the
worst of the two failures, because generation would keep succeeding into the
wrong project.

Precedence: the persisted override, else the env default, else nothing.
``.env`` alone still behaves exactly as it did — with no override stored, the
resolver hands back ``config.FLOW_PROJECT_ID`` unchanged.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import select

from flowboard import config
from flowboard.db import get_session
from flowboard.db.models import (
    FLOW_PROJECT_SETTING_KEY,
    AppSetting,
    BoardFlowProject,
)

logger = logging.getLogger(__name__)

#: What the 400 says when what was pasted is not a project id. Written for
#: whoever is standing in the Settings dialog, not for a stack trace.
INVALID_PROJECT_ID_MESSAGE = (
    "That is not a Flow project ID. Open the project in Flow and copy the "
    "address out of your browser's address bar — you can paste the whole "
    "address here, or just the ID inside it, which looks like "
    "1dfd992a-4149-4f97-9d68-a1ede77d3fc3. Letters, digits, dashes and "
    "underscores only, up to 128 characters."
)

#: A Flow project id as Flow itself mints them: a canonical uuid. The
#: lookarounds matter — without them a search would happily accept the first
#: 36 characters of a longer hex run and store a truncated id.
_UUID_RE = re.compile(
    r"(?<![0-9a-fA-F-])"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    r"(?![0-9a-fA-F-])"
)


# ── reading is loose, writing is strict, and that asymmetry is deliberate ──
#
# `_is_valid` below is `flow_sdk.is_valid_project_id`, i.e.
# `^[A-Za-z0-9_-]{1,128}$`. That is a "safe to put in a URL path" check, not a
# project-id check: `not-a-uuid` passes it. It is the right rule for READING,
# because whatever is already in someone's `.env` works today and must keep
# working tomorrow whatever shape it has.
#
# It is the wrong rule for WRITING. The write path exists precisely to catch a
# user pasting an id they got wrong, and every Flow project id anyone has seen
# is a uuid, so `set_override` demands one via `normalize_project_id`. Please
# do not "fix" the inconsistency by loosening the write path — accepting
# `not-a-uuid` here once silently rebound a real board onto it.


def _is_valid(project_id: str) -> bool:
    """Loose shape check for the READ path, shared with the worker's validator.

    Imported inside the function on purpose: ``flow_sdk`` imports this module
    for :func:`effective_project_id`, so naming it at module level would close
    an import cycle.
    """
    from flowboard.services.flow_sdk import is_valid_project_id

    return is_valid_project_id(project_id)


def normalize_project_id(value: str) -> Optional[str]:
    """The uuid in *value*, or ``None`` when there is not one to find.

    Accepts a bare uuid or anything a uuid can be pasted inside — in practice
    the Flow address, because "copy the ID out of the address bar" gets read as
    "copy the address bar", and rejecting that would be blaming the user for
    following the instruction. ``https://flow.google.com/project/<uuid>``, the
    same with a trailing slash, and the same with ``?foo=bar`` after it all
    reduce to ``<uuid>``, which is what gets stored.

    The FIRST uuid wins. Flow puts the project ahead of the scene in its URLs,
    so on a deep link that is the right one; there is no way to tell them apart
    from the text alone, and picking the first at least makes it predictable.
    """
    text = (value or "").strip()
    if not text:
        return None
    match = _UUID_RE.search(text)
    return match.group(0) if match else None


def _stored_override() -> Optional[str]:
    """The persisted override, or ``None`` when unset, blank or malformed.

    A malformed stored value is treated as absent rather than raised on: the
    write path validates, so the only way to get one is by hand-editing the
    database, and refusing every generation over it would be worse than
    quietly falling back to the env default.
    """
    try:
        with get_session() as s:
            row = s.get(AppSetting, FLOW_PROJECT_SETTING_KEY)
    except SQLAlchemyError:
        # The settings table is missing on a database that predates it and has
        # not been through init_db yet. An env-only install never needed this
        # table and must not lose generation to it.
        logger.warning(
            "could not read the Flow project override — "
            "falling back to FLOWBOARD_FLOW_PROJECT_ID",
            exc_info=True,
        )
        return None
    if row is None:
        return None
    value = (row.value or "").strip()
    if not value or not _is_valid(value):
        return None
    return value


def _env_project_id() -> str:
    """``FLOWBOARD_FLOW_PROJECT_ID``, read through the module every time.

    Reading ``config.FLOW_PROJECT_ID`` as an attribute rather than importing
    the name is what lets the test suite pin it; more importantly it keeps
    this module honest about having exactly one place the env value enters.
    """
    return (config.FLOW_PROJECT_ID or "").strip()


def effective_project_id() -> str:
    """The Flow project id every RPC falls back to. ``""`` when there is none."""
    override = _stored_override()
    if override:
        return override
    env = _env_project_id()
    if env and _is_valid(env):
        return env
    return ""


def project_setting() -> dict:
    """The effective id plus where it came from, for the Settings dialog.

    ``source`` is the part worth reporting: "env" and "override" resolve to
    the same id after someone pins the value already in ``.env``, and without
    it the dialog cannot say whether clearing the override would change
    anything.
    """
    override = _stored_override()
    env = _env_project_id()
    if override:
        source, effective = "override", override
    elif env and _is_valid(env):
        source, effective = "env", env
    else:
        source, effective = "none", ""
    return {
        "flow_project_id": effective or None,
        "source": source,
        # Reported even when it is malformed and therefore unused — the dialog
        # showing "none" while .env plainly holds a value is a bug report
        # waiting to happen.
        "env_project_id": env or None,
    }


def set_override(value: Optional[str]) -> int:
    """Pin (or clear) the Flow project, and rebind the boards that followed it.

    ``None`` — or an empty string, or whitespace, which is what an emptied form
    field sends — clears the override and falls back to
    ``FLOWBOARD_FLOW_PROJECT_ID``.

    Anything else must contain a uuid: a bare one, or a pasted Flow address to
    pull it out of (:func:`normalize_project_id`). Only the uuid is stored.
    This is stricter than the read path on purpose — see the note above
    :func:`_is_valid`.

    Raises :class:`ValueError` with a message meant for the user when there is
    no uuid in *value*. Nothing is written in that case.

    Returns how many boards were rebound; see :func:`_rebind_boards`.
    """
    new_value: Optional[str]
    if value is None or not str(value).strip():
        new_value = None
    else:
        new_value = normalize_project_id(str(value))
        if new_value is None:
            raise ValueError(INVALID_PROJECT_ID_MESSAGE)

    previous = effective_project_id()

    with get_session() as s:
        row = s.get(AppSetting, FLOW_PROJECT_SETTING_KEY)
        if new_value is None:
            if row is not None:
                s.delete(row)
        elif row is None:
            s.add(AppSetting(key=FLOW_PROJECT_SETTING_KEY, value=new_value))
        else:
            row.value = new_value
            row.updated_at = datetime.now(timezone.utc)
            s.add(row)
        s.commit()

    current = effective_project_id()
    if current == previous:
        return 0
    logger.info(
        "flow project override %s: effective project %s → %s",
        "cleared" if new_value is None else "set",
        previous or "(none)",
        current or "(none)",
    )
    return _rebind_boards(previous, current)


def _rebind_boards(old: str, new: str) -> int:
    """Move the boards that were following the old effective id onto the new one.

    ``BoardFlowProject`` rows persist whichever project a board was bound to.
    Leaving them alone would have those boards keep generating into the OLD
    Flow project while the dashboard reported the new one — a silent
    wrong-target write, which is exactly the failure this setting exists to
    remove.

    Rows pointing at anything else are deliberately left untouched. Those were
    bound to a project chosen for that board specifically, and silently
    retargeting them would be a worse surprise than leaving them where the
    user put them.

    Clearing down to no project at all rebinds nothing either: ``""`` is not a
    project any board could generate into, so a board keeps the last real
    binding it had, which still works.
    """
    if not old or not new:
        return 0
    with get_session() as s:
        rows = s.exec(
            select(BoardFlowProject).where(BoardFlowProject.flow_project_id == old)
        ).all()
        for row in rows:
            row.flow_project_id = new
            s.add(row)
        s.commit()
        count = len(rows)
    if count:
        logger.info("rebound %d board(s) from flow project %s to %s", count, old, new)
    return count
