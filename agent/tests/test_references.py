"""Tests for the /api/references CRUD endpoints (Phase 1)."""
from flowboard.config import STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import Reference
from sqlmodel import select


def test_create_reference_minimal(client):
    """POST with just (media_id, kind) → 200 with row; the default label
    rule fires because the user didn't pass ai_brief or short_id, so
    the synthesized label is "Untitled"."""
    r = client.post(
        "/api/references",
        json={"media_id": "m1", "kind": "image"},
    )
    assert r.status_code == 200, r.text
    row = r.json()
    assert row["media_id"] == "m1"
    assert row["kind"] == "image"
    assert row["label"] == "Untitled"
    assert row["pinned"] is False
    assert row["position"] == 0
    assert row["tags"] == []
    assert "id" in row


def test_create_reference_idempotent(client):
    """Saving the same media_id twice returns the SAME id and leaves
    exactly one row in the DB. Lets ★ Save behave as a set-membership
    toggle without a pre-check round-trip."""
    a = client.post(
        "/api/references",
        json={"media_id": "dupe", "kind": "image", "label": "first"},
    ).json()
    b = client.post(
        "/api/references",
        json={"media_id": "dupe", "kind": "image", "label": "second"},
    ).json()
    assert a["id"] == b["id"]
    # Idempotent: re-POST does NOT clobber the original label.
    assert b["label"] == "first"

    with get_session() as s:
        rows = s.exec(select(Reference).where(Reference.media_id == "dupe")).all()
    assert len(rows) == 1


def test_create_reference_default_label_from_ai_brief(client):
    """When label omitted but ai_brief present, default label is ai_brief
    truncated to 80 chars."""
    brief = (
        "young Korean woman in beige blazer, soft window light, editorial "
        "portrait, shallow depth of field, 35mm — extra tail that should be cut"
    )
    assert len(brief) > 80  # sanity for the test
    r = client.post(
        "/api/references",
        json={"media_id": "brief1", "kind": "image", "ai_brief": brief},
    )
    assert r.status_code == 200
    row = r.json()
    assert row["label"] == brief[:80]
    assert len(row["label"]) == 80


def test_list_references_pinned_first(client):
    """Sort order: pinned rows first regardless of insertion order."""
    a = client.post(
        "/api/references", json={"media_id": "a", "kind": "image", "label": "A"}
    ).json()
    b = client.post(
        "/api/references", json={"media_id": "b", "kind": "image", "label": "B"}
    ).json()
    c = client.post(
        "/api/references", json={"media_id": "c", "kind": "image", "label": "C"}
    ).json()
    # Pin the middle one — it must surface first.
    client.patch(f"/api/references/{b['id']}", json={"pinned": True})

    rows = client.get("/api/references").json()
    assert len(rows) == 3
    assert rows[0]["id"] == b["id"]
    assert rows[0]["pinned"] is True
    # The two unpinned rows follow; both should appear.
    rest_ids = {rows[1]["id"], rows[2]["id"]}
    assert rest_ids == {a["id"], c["id"]}


def test_list_references_q_filter(client):
    """?q substring matches label OR ai_brief, case-insensitive."""
    client.post(
        "/api/references",
        json={"media_id": "rd", "kind": "image", "label": "Red dress"},
    )
    client.post(
        "/api/references",
        json={"media_id": "bj", "kind": "image", "label": "Blue jeans"},
    )

    # Case-insensitive: "red" matches "Red dress".
    r1 = client.get("/api/references", params={"q": "red"}).json()
    assert len(r1) == 1
    assert r1[0]["label"] == "Red dress"

    r2 = client.get("/api/references", params={"q": "jeans"}).json()
    assert len(r2) == 1
    assert r2[0]["label"] == "Blue jeans"

    # No hit.
    r3 = client.get("/api/references", params={"q": "green"}).json()
    assert r3 == []


def test_list_references_q_filter_matches_ai_brief(client):
    """?q also matches against ai_brief (not just label)."""
    client.post(
        "/api/references",
        json={
            "media_id": "ab",
            "kind": "image",
            "label": "Editorial",
            "ai_brief": "young woman in beige blazer",
        },
    )
    rows = client.get("/api/references", params={"q": "blazer"}).json()
    assert len(rows) == 1
    assert rows[0]["media_id"] == "ab"


def test_patch_reference_label_and_pinned(client):
    """PATCH updates only supplied fields; missing id → 404."""
    row = client.post(
        "/api/references",
        json={"media_id": "p1", "kind": "image", "label": "old"},
    ).json()

    r = client.patch(
        f"/api/references/{row['id']}",
        json={"label": "new", "pinned": True},
    )
    assert r.status_code == 200
    updated = r.json()
    assert updated["label"] == "new"
    assert updated["pinned"] is True
    # Unspecified field stays untouched.
    assert updated["position"] == row["position"]

    r404 = client.patch("/api/references/999999", json={"label": "x"})
    assert r404.status_code == 404


def test_delete_reference_returns_204(client):
    """DELETE existing → 204 (no body). DELETE missing → 404."""
    row = client.post(
        "/api/references", json={"media_id": "d1", "kind": "image"}
    ).json()
    res = client.delete(f"/api/references/{row['id']}")
    assert res.status_code == 204
    # Row really gone.
    listed = client.get("/api/references").json()
    assert all(r["id"] != row["id"] for r in listed)

    miss = client.delete("/api/references/999999")
    assert miss.status_code == 404


def test_delete_does_not_touch_media_file(client):
    """DELETE on a reference must NOT remove the underlying media file —
    the Asset cache owns that lifetime."""
    media_dir = STORAGE_DIR / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    media_file = media_dir / "m1.png"
    media_file.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fake-png-bytes")
    assert media_file.exists()

    try:
        row = client.post(
            "/api/references", json={"media_id": "m1", "kind": "image"}
        ).json()
        res = client.delete(f"/api/references/{row['id']}")
        assert res.status_code == 204
        # Critical invariant: storage file untouched.
        assert media_file.exists()
        assert media_file.read_bytes().startswith(b"\x89PNG")
    finally:
        # Clean up the fixture file so we don't leak into the test temp dir.
        if media_file.exists():
            media_file.unlink()
