"""The runtime-settable pinned Flow project.

Flowboard generates into one Google Flow project, and until this shipped the
only way to name it was FLOWBOARD_FLOW_PROJECT_ID, which `config` binds once at
import. Two failures follow from that binding, and most of the tests here exist
for the second one:

  1. Changing projects needed a restart. Annoying, but visible.
  2. Any call site that did `from flowboard.config import FLOW_PROJECT_ID`
     keeps the boot-time value forever. If one such site survives, generation
     quietly goes to the OLD project while the dashboard reports the new one —
     and nothing fails, so nobody finds out until the wrong Flow project is
     full of renders.

`test_an_override_reaches_the_generation_envelope` is the guard for (2): it
drives a real `gen_image` through the batch recorder and reads the project id
out of the wire payload, so reverting any call site back to the import-time
constant fails it.

The env default is pinned with monkeypatch throughout. The repo's own .env sets
FLOWBOARD_FLOW_PROJECT_ID, so a test that read whatever the developer happened
to have configured would pass or fail by machine.
"""
import pytest

from flowboard import config
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import (
    FLOW_PROJECT_SETTING_KEY,
    AppSetting,
    Board,
    BoardFlowProject,
)
from flowboard.services import flow_batch as fb
from flowboard.services.flow_project import (
    effective_project_id,
    project_setting,
    set_override,
)
from flowboard.services import flow_project
from flowboard.services.flow_sdk import FlowSDK
from tests.batch_harness import BatchRecorder, image_recorder

# Real hex, letters included. All-digit uuids would make
# `test_uppercase_hex_is_accepted` assert nothing, since "1111".upper() is
# "1111" — which is how a case-sensitivity regression got through once.
ENV_PID = "1a1d7e3c-1111-4b1c-8d1e-111111111111"
OVERRIDE_PID = "2b2e8f4a-2222-4c2d-9e2f-222222222222"
OTHER_PID = "3c3f9a5b-3333-4d3e-8f3a-333333333333"


@pytest.fixture
def env_pinned(monkeypatch):
    """Pretend .env pinned ENV_PID, whatever the developer's .env really says."""
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", ENV_PID)
    return ENV_PID


@pytest.fixture
def no_env(monkeypatch):
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", "")
    return ""


def _bind_board(client, project_id: str) -> int:
    """A board bound to *project_id*. Returns its id."""
    with get_session() as s:
        board = Board(name="b")
        s.add(board)
        s.commit()
        s.refresh(board)
        s.add(BoardFlowProject(board_id=board.id, flow_project_id=project_id))
        s.commit()
        return board.id


def _board_binding():
    """The single bound board's project id, for the atomicity tests."""
    with get_session() as s:
        rows = s.exec(select(BoardFlowProject)).all()
        return rows[0].flow_project_id if rows else None


def _stored():
    with get_session() as s:
        row = s.get(AppSetting, FLOW_PROJECT_SETTING_KEY)
        return None if row is None else row.value


def _bind(client, name, project_id):
    """A board bound to `project_id`, as generation would leave it."""
    board = client.post("/api/boards", json={"name": name}).json()
    with get_session() as s:
        s.add(BoardFlowProject(board_id=board["id"], flow_project_id=project_id))
        s.commit()
    return board["id"]


def _binding(board_id):
    with get_session() as s:
        row = s.get(BoardFlowProject, board_id)
        return None if row is None else row.flow_project_id


# ── the resolver's precedence ─────────────────────────────────────────────


def test_env_is_used_when_no_override_is_stored(env_pinned):
    """The whole point of the fallback: .env users are unaffected by this feature."""
    assert effective_project_id() == ENV_PID


def test_an_override_wins_over_env(env_pinned):
    set_override(OVERRIDE_PID)
    assert effective_project_id() == OVERRIDE_PID


def test_nothing_pinned_resolves_to_empty_rather_than_raising(no_env):
    """flow_sdk turns "" into NO_FLOW_PROJECT with a fix in it. The resolver
    must not raise first, or that message never reaches the caller."""
    assert effective_project_id() == ""


def test_a_malformed_stored_value_falls_back_to_env(env_pinned):
    """Only a hand-edited DB can produce one — the write path validates. Falling
    back beats failing every generation over a value nothing put there."""
    with get_session() as s:
        s.add(AppSetting(key=FLOW_PROJECT_SETTING_KEY, value="../../admin"))
        s.commit()
    assert effective_project_id() == ENV_PID


def test_a_malformed_env_value_is_not_used(monkeypatch):
    """A typo'd .env should read as "nothing pinned", not get sent to Flow."""
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", "has space")
    assert effective_project_id() == ""
    assert project_setting()["source"] == "none"


# ── the override actually reaching the SDK ────────────────────────────────


@pytest.mark.asyncio
async def test_an_override_reaches_the_generation_envelope(env_pinned):
    """The load-bearing one. Fails if any flow_sdk call site goes back to
    importing FLOW_PROJECT_ID, because that binding predates the override.

    No mocking of the resolver: a real gen_image with no explicit project runs
    and the project id is read out of the batchexecute payload Flow would have
    received — slot 5 of the shared generate context.
    """
    set_override(OVERRIDE_PID)

    rec = image_recorder(1)
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id="", paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out.get("error") is None

    context = rec.payload(fb.RPC_GEN_IMAGE)[3]
    assert context[5] == OVERRIDE_PID, "generation went to the pre-override project"


@pytest.mark.asyncio
async def test_clearing_the_override_sends_generation_back_to_env(env_pinned):
    set_override(OVERRIDE_PID)
    set_override(None)

    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id="", paygate_tier="PAYGATE_TIER_ONE",
    )
    assert rec.payload(fb.RPC_GEN_IMAGE)[3][5] == ENV_PID


@pytest.mark.asyncio
async def test_an_explicit_project_id_still_beats_the_override(env_pinned):
    """The override is a fallback, not an override of the caller. A board that
    passes its own binding must keep generating into it."""
    set_override(OVERRIDE_PID)

    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=OTHER_PID, paygate_tier="PAYGATE_TIER_ONE",
    )
    assert rec.payload(fb.RPC_GEN_IMAGE)[3][5] == OTHER_PID


@pytest.mark.asyncio
async def test_create_project_hands_back_the_override(env_pinned):
    """create_project reuses the pinned project. It has to reuse the live one,
    or the first board bootstrapped after an override is bound to the old id."""
    set_override(OVERRIDE_PID)
    out = await FlowSDK(client=BatchRecorder()).create_project("Board")
    assert out["project_id"] == OVERRIDE_PID
    assert out["reused"] is True


# ── validation ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", [
    "../../admin",
    "has space",
    "slash/path",
    "a" * 129,
    # Everything below this line passes flow_sdk.is_valid_project_id — the
    # URL-safety check the write path used to lean on. `not-a-uuid` matched it
    # and was accepted, and a real board was rebound onto it. That is the bug
    # this whole block guards.
    "not-a-uuid",
    "banana",
    "1dfd992a-4149-4f97-a1ede77d3fc3",            # a block short
    "1dfd992a-4149-4f97-9d68-a1ede77d3fcg",       # g is not hex
    "1dfd992a41494f979d68a1ede77d3fc3",           # unhyphenated
    "1dfd992a-4149-4f97-9d68-a1ede77d3fc3f",      # one character too long
])
def test_a_bad_shape_is_rejected_and_writes_nothing(client, env_pinned, bad):
    """400 AND an untouched setting.

    The 400 alone is not enough to assert: the first version of this feature
    rejected nothing and rebound a live board onto `not-a-uuid`, so what needs
    proving is that a refused write left the database exactly as it was.
    """
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": bad})
    assert r.status_code == 400
    assert isinstance(r.json()["detail"], str)
    assert "Flow" in r.json()["detail"]
    assert _stored() is None
    assert effective_project_id() == ENV_PID


@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_whitespace_clears_rather_than_erroring(client, env_pinned, blank):
    """An emptied field can arrive with the whitespace still in it. Treating
    that as a bad id would make "clear this" look like a validation error."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": blank})
    assert r.status_code == 200
    assert r.json()["source"] == "env"
    assert _stored() is None


def test_a_rejected_write_does_not_disturb_an_existing_override(client, env_pinned):
    """The dangerous version of the bug: a bad paste over a good setting."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    board_id = _bind(client, "Follows", OVERRIDE_PID)

    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": "not-a-uuid"})
    assert r.status_code == 400
    assert _stored() == OVERRIDE_PID
    assert effective_project_id() == OVERRIDE_PID
    assert _binding(board_id) == OVERRIDE_PID


def test_the_400_explains_where_to_find_the_id(client, env_pinned):
    """The person hitting this is in a Settings dialog, not a stack trace."""
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": "not valid"})
    detail = r.json()["detail"]
    assert "address bar" in detail
    # The old message documented the loose rule it was wrongly validating with.
    assert "128 characters" not in detail


def test_set_override_raises_on_a_bad_shape(env_pinned):
    with pytest.raises(ValueError):
        set_override("has space")
    with pytest.raises(ValueError):
        set_override("not-a-uuid")


# ── what the user actually pastes ─────────────────────────────────────────


@pytest.mark.parametrize("pasted", [
    f"https://flow.google.com/project/{OVERRIDE_PID}",
    f"https://flow.google.com/project/{OVERRIDE_PID}/",
    f"https://flow.google.com/project/{OVERRIDE_PID}?tab=assets",
    f"https://flow.google.com/u/0/project/{OVERRIDE_PID}/edit#scene",
    f"  {OVERRIDE_PID}  ",
])
def test_a_pasted_address_is_accepted_and_only_the_uuid_is_stored(
    client, env_pinned, pasted
):
    """Someone told to copy the ID out of the address bar copies the address
    bar. Storing the whole URL would send it to Flow as a project id."""
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": pasted})
    assert r.status_code == 200
    assert r.json()["flow_project_id"] == OVERRIDE_PID
    assert _stored() == OVERRIDE_PID


@pytest.mark.parametrize("run_on", [
    OVERRIDE_PID + "abcdef",   # extra hex glued to the tail
    OVERRIDE_PID + "f",        # a 13-character final block
    "ff" + OVERRIDE_PID,       # extra hex glued to the head
    OVERRIDE_PID + "-dead",    # another dash-joined hex run after it
])
def test_a_longer_hex_run_is_rejected_rather_than_truncated(
    client, env_pinned, run_on
):
    """The lookarounds in `_UUID_RE` are what stop this, and nothing else was
    proving they earn their keep.

    A plain search finds a uuid *inside* a longer hex run and returns the first
    36 characters of it. That is the worst shape of failure this endpoint can
    have: no error, a stored id that is subtly not the one the user pasted, and
    every board silently rebound onto it. Refusing is the only safe answer —
    we cannot know which 36 characters they meant.
    """
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": run_on})
    assert r.status_code == 400
    assert _stored() is None


def test_a_url_without_a_uuid_in_it_is_still_rejected(client, env_pinned):
    """Being forgiving about URLs must not become accepting any URL."""
    r = client.put(
        "/api/flow/projects/pinned",
        json={"flow_project_id": "https://flow.google.com/project/new"},
    )
    assert r.status_code == 400
    assert _stored() is None


def test_a_deep_link_takes_the_project_not_the_scene(client, env_pinned):
    """Flow puts the project ahead of the scene in its URLs."""
    r = client.put("/api/flow/projects/pinned", json={
        "flow_project_id":
            f"https://flow.google.com/project/{OVERRIDE_PID}/scene/{OTHER_PID}",
    })
    assert r.json()["flow_project_id"] == OVERRIDE_PID


def test_uppercase_hex_is_accepted(client, env_pinned):
    """Nothing says a copied id arrives lowercased, and Flow's own uuids are
    case-insensitive. Rejecting one would be a baffling error to receive."""
    r = client.put(
        "/api/flow/projects/pinned",
        json={"flow_project_id": OVERRIDE_PID.upper()},
    )
    assert r.status_code == 200
    assert r.json()["flow_project_id"] == OVERRIDE_PID.upper()


def test_a_plain_uuid_still_works(client, env_pinned):
    r = client.put(
        "/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID}
    )
    assert r.status_code == 200
    assert _stored() == OVERRIDE_PID


def test_the_read_path_stays_permissive_about_env(monkeypatch):
    """Strictness is asymmetric on purpose. Someone whose .env holds a
    non-uuid id that Flow accepts today must not be locked out tomorrow by a
    rule that only ever existed to catch a bad paste."""
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", "legacy_project_42")
    assert effective_project_id() == "legacy_project_42"
    assert project_setting()["source"] == "env"


def test_the_read_path_stays_permissive_about_a_stored_non_uuid(env_pinned):
    """The same for a value already in the database from before the rule."""
    with get_session() as s:
        s.add(AppSetting(key=FLOW_PROJECT_SETTING_KEY, value="legacy_project_42"))
        s.commit()
    assert effective_project_id() == "legacy_project_42"


# ── the endpoints ─────────────────────────────────────────────────────────


def test_get_reports_env_when_nothing_is_overridden(client, env_pinned):
    body = client.get("/api/flow/projects/pinned").json()
    assert body == {
        "flow_project_id": ENV_PID,
        "source": "env",
        "env_project_id": ENV_PID,
    }


def test_get_reports_override_and_still_names_the_env_value(client, env_pinned):
    """Both are reported because they differ in what clearing would do, and the
    dialog cannot say "revert to .env" without knowing what .env holds."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    body = client.get("/api/flow/projects/pinned").json()
    assert body == {
        "flow_project_id": OVERRIDE_PID,
        "source": "override",
        "env_project_id": ENV_PID,
    }


def test_get_reports_none_when_nothing_is_pinned_anywhere(client, no_env):
    body = client.get("/api/flow/projects/pinned").json()
    assert body == {
        "flow_project_id": None,
        "source": "none",
        "env_project_id": None,
    }


def test_put_null_clears_the_override_back_to_env(client, env_pinned):
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": None})
    assert r.status_code == 200
    assert r.json()["source"] == "env"
    assert r.json()["flow_project_id"] == ENV_PID
    assert _stored() is None


def test_the_sync_status_route_reports_the_override(client, env_pinned):
    """Two endpoints naming the same project must not disagree — this one used
    to read the import-time constant."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    body = client.get("/api/flow/projects").json()
    assert body["flow_listing"]["pinned_project_id"] == OVERRIDE_PID


def test_sync_up_reports_the_override_in_its_refusal(client, env_pinned):
    """Its 501 tells the user which project everything falls back to. Naming
    the stale one there is how someone concludes the override did not work."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    r = client.post("/api/flow/projects/sync-up")
    assert r.status_code == 501
    assert r.json()["detail"]["pinned_project_id"] == OVERRIDE_PID


# ── rebinding boards ──────────────────────────────────────────────────────


def test_boards_on_the_previous_effective_project_follow_it(client, env_pinned):
    """Without this a board keeps its old binding and generates into the old
    Flow project while the dashboard shows the new one."""
    board_id = _bind(client, "Follows", ENV_PID)
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    assert r.json()["rebound_boards"] == 1
    assert _binding(board_id) == OVERRIDE_PID


def test_boards_bound_elsewhere_are_left_alone(client, env_pinned):
    """A board pointing at a project the user chose for it specifically is not
    the pinned default following along — retargeting it would be the surprise."""
    follower = _bind(client, "Follows", ENV_PID)
    elsewhere = _bind(client, "Elsewhere", OTHER_PID)

    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    assert r.json()["rebound_boards"] == 1
    assert _binding(follower) == OVERRIDE_PID
    assert _binding(elsewhere) == OTHER_PID


def test_clearing_an_override_rebinds_followers_back_to_env(client, env_pinned):
    board_id = _bind(client, "Follows", ENV_PID)
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    assert _binding(board_id) == OVERRIDE_PID

    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": None})
    assert r.json()["rebound_boards"] == 1
    assert _binding(board_id) == ENV_PID


def test_setting_the_same_project_twice_rebinds_nothing(client, env_pinned):
    """The effective id did not move, so no board is on a stale one. Reporting
    a rebind here would have the UI announce work that never happened."""
    board_id = _bind(client, "Follows", ENV_PID)
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    assert r.json()["rebound_boards"] == 0
    assert _binding(board_id) == OVERRIDE_PID


def test_pinning_the_env_value_itself_rebinds_nothing(client, env_pinned):
    """Same id, different source. Nothing is stale, so nothing moves."""
    board_id = _bind(client, "Follows", ENV_PID)
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": ENV_PID})
    assert r.json()["rebound_boards"] == 0
    assert r.json()["source"] == "override"
    assert _binding(board_id) == ENV_PID


def test_clearing_down_to_no_project_leaves_bindings_alone(client, no_env):
    """"" is not a project any board can generate into, so a board keeps the
    last real binding it had rather than being emptied into an unusable state."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    board_id = _bind(client, "Follows", OVERRIDE_PID)

    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": None})
    assert r.json()["rebound_boards"] == 0
    assert r.json()["source"] == "none"
    assert _binding(board_id) == OVERRIDE_PID


# ── persistence ───────────────────────────────────────────────────────────


def test_the_override_survives_a_fresh_read(client, env_pinned):
    """It is stored, not memoised. A module-level cache would be read once per
    process and lose the override on the next worker that started."""
    client.put("/api/flow/projects/pinned", json={"flow_project_id": OVERRIDE_PID})
    assert _stored() == OVERRIDE_PID

    with get_session() as s:
        assert s.get(Board, 0) is None  # unrelated read: the session is fresh
    assert effective_project_id() == OVERRIDE_PID


# ── the setting and the bindings move together, or not at all ──────────────


def test_a_failed_rebind_rolls_the_setting_back_too(client, env_pinned, monkeypatch):
    """These were two transactions once, and the gap between them was the bug.

    A failure after the setting committed left the pin saying one project
    while every board still generated into the other — and because the retry
    then saw the setting already at the new value, it computed
    ``current == previous``, rebound nothing, and stranded those boards for
    good. One transaction means a failure leaves nothing behind to be stranded.
    """
    _bind_board(client, OTHER_PID if False else ENV_PID)

    def boom(*a, **k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(flow_project, "_rebind_boards", boom)

    with pytest.raises(RuntimeError):
        flow_project.set_override(OVERRIDE_PID)

    assert _stored() is None, "the setting must not survive a failed rebind"
    assert effective_project_id() == ENV_PID
    assert _board_binding() == ENV_PID, "the board must not have moved either"


def test_a_successful_change_moves_both(client, env_pinned):
    """The other half: normally both land."""
    _bind_board(client, ENV_PID)
    assert flow_project.set_override(OVERRIDE_PID) == 1
    assert _stored() == OVERRIDE_PID
    assert _board_binding() == OVERRIDE_PID


# ── clearing the pin has to be asked for by name ───────────────────────────


def test_an_omitted_field_is_a_422_not_a_silent_clear(client, env_pinned):
    """``PUT {}`` used to return 200 and destroy the override, because an
    omitted field and an explicit ``null`` were the same value once the model
    had a default. A truncated body, or a client that forgot its payload,
    became a destructive no-arg call against every board.
    """
    flow_project.set_override(OVERRIDE_PID)
    _bind_board(client, OVERRIDE_PID)

    r = client.put("/api/flow/projects/pinned", json={})

    assert r.status_code == 422
    assert _stored() == OVERRIDE_PID, "an omitted field must change nothing"
    assert _board_binding() == OVERRIDE_PID


def test_an_explicit_null_still_clears(client, env_pinned):
    """Being strict about omission must not break the documented way to clear."""
    flow_project.set_override(OVERRIDE_PID)
    r = client.put("/api/flow/projects/pinned", json={"flow_project_id": None})
    assert r.status_code == 200
    assert _stored() is None
    assert r.json()["source"] == "env"
