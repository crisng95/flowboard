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
    "1dfd992a-4149-4f97-9d68-a1ede77d3fc3."
)

#: A Flow project id as Flow itself mints them: a canonical uuid. The
#: lookarounds matter — without them a search would happily accept the first
#: 36 characters of a longer hex run and store a truncated id.
_UUID = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_UUID_RE = re.compile(r"(?<![0-9a-fA-F-])" + _UUID + r"(?![0-9a-fA-F-])")

#: The uuid that is genuinely the project: the one right after a ``project/``
#: segment. Without this, "first uuid anywhere" pins whatever rode along in a
#: share or tracking parameter — ``/project/new?ref=<uuid>`` has no project
#: uuid in its path at all, and quietly pinned the referrer's.
_PROJECT_SEGMENT_RE = re.compile(r"project/(" + _UUID + r")(?![0-9a-fA-F-])")

#: Whether the text names a project path at all. If it does but the segment is
#: not a uuid — ``/project/new`` — then the text is a Flow URL that does not
#: identify a project, and falling back to "first uuid anywhere" would pin
#: whatever rode along in a query parameter.
_HAS_PROJECT_SEGMENT_RE = re.compile(r"project/")


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

    A uuid directly after a ``project/`` segment wins outright — that is the
    project by construction, whatever else the URL carries. If the text has a
    ``project/`` segment that is NOT a uuid (``/project/new``), nothing is
    returned: the URL is a Flow address that does not identify a project, and
    taking the first uuid anywhere would pin whatever rode along in a share or
    tracking parameter. Only text with no ``project/`` segment at all falls
    back to the first uuid, which is the right answer for a bare paste.

    The result is lower-cased. Flow mints these in lower case; storing an
    uppercase paste verbatim left the pin no longer byte-matching what Flow
    issued, and made `_rebind_boards` "move" every board from a uuid to the
    same uuid in a different case, announcing a change that changed nothing.
    """
    text = (value or "").strip()
    if not text:
        return None
    segment = _PROJECT_SEGMENT_RE.search(text)
    if segment:
        return segment.group(1).lower()
    if _HAS_PROJECT_SEGMENT_RE.search(text):
        return None
    match = _UUID_RE.search(text)
    return match.group(0).lower() if match else None


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


def _resolve(override: Optional[str]) -> str:
    """Effective id for a given override, without reading the database.

    Split out so :func:`set_override` can work out what the new effective id
    *will be* from inside its own uncommitted transaction, where re-reading
    would still return the old value.
    """
    if override:
        return override
    env = _env_project_id()
    if env and _is_valid(env):
        return env
    return ""


def effective_project_id() -> str:
    """The Flow project id every RPC falls back to. ``""`` when there is none."""
    return _resolve(_stored_override())


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
    # Resolved from the pending value, not re-read: the write below has not
    # committed yet, so a read would still answer with the old override.
    current = _resolve(new_value)

    # The setting and the board bindings move together or not at all. Split
    # across two transactions, a failure between them left the pin saying one
    # project while every board still generated into the other — and a retry
    # then saw `current == previous`, rebound nothing, and stranded them there
    # permanently.
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
        rebound = _rebind_boards(s, previous, current) if current != previous else 0
        s.commit()

    if current != previous:
        logger.info(
            "flow project override %s: effective project %s → %s (%d board(s) moved)",
            "cleared" if new_value is None else "set",
            previous or "(none)",
            current or "(none)",
            rebound,
        )
    return rebound


def _rebind_boards(s, old: str, new: str) -> int:
    """Move every board on the old effective id onto the new one.

    Runs in the caller's session and does NOT commit — the setting row and
    these rows have to land together, or the pin and the boards disagree.

    ``BoardFlowProject`` rows persist whichever project a board was bound to.
    Leaving them alone would have those boards keep generating into the OLD
    Flow project while the dashboard reported the new one — a silent
    wrong-target write, which is exactly the failure this setting exists to
    remove.

    Every binding moves, not just the ones equal to the outgoing id.

    That reads aggressive and is not, because no binding in this application
    was ever chosen deliberately. Exactly two lines write
    ``BoardFlowProject.flow_project_id``: ``routes/projects.py``, whose value
    comes from ``create_project()`` and is therefore always the pin of the
    moment, and a line inside ``sync_up``, which is unreachable behind an
    unconditional 501. There is no rebind endpoint. So every row is a snapshot
    of whatever the pin was when that board first generated, and adopting them
    all is what the user means by changing the pin.

    Matching only ``== old`` had a hole with no workaround: clearing the pin
    and then setting a new one left ``old`` empty on the second step, so the
    rebind bailed and every board stayed on the project from before the clear
    — ``GET /pinned`` naming one project while generation used another,
    permanently, after two clicks and with no error anywhere.

    Clearing down to no project still rebinds nothing: ``""`` is not a project
    any board could generate into, so a board keeps the last real binding it
    had, which still works.
    """
    if not new:
        return 0
    rows = s.exec(
        select(BoardFlowProject).where(BoardFlowProject.flow_project_id != new)
    ).all()
    for row in rows:
        row.flow_project_id = new
        s.add(row)
    count = len(rows)
    if count:
        logger.info("rebound %d board(s) from flow project %s to %s", count, old, new)
    return count
