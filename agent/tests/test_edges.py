def _scaffold(client):
    b = client.post("/api/boards", json={"name": "T"}).json()
    a = client.post("/api/nodes", json={"board_id": b["id"], "type": "character"}).json()
    c = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    return b, a, c


def test_create_and_delete_edge(client):
    b, a, c = _scaffold(client)
    r = client.post(
        "/api/edges",
        json={"board_id": b["id"], "source_id": a["id"], "target_id": c["id"]},
    )
    assert r.status_code == 200
    edge = r.json()
    assert edge["source_id"] == a["id"]
    assert edge["target_id"] == c["id"]
    assert edge["kind"] == "ref"
    # Default — no variant pin set yet (single-variant case or
    # multi-variant where the user hasn't picked).
    assert edge["source_variant_idx"] is None

    detail = client.get(f"/api/boards/{b['id']}").json()
    assert len(detail["edges"]) == 1

    r = client.delete(f"/api/edges/{edge['id']}")
    assert r.status_code == 200
    detail = client.get(f"/api/boards/{b['id']}").json()
    assert detail["edges"] == []


def test_create_edge_with_variant_pin(client):
    """The frontend can pre-pin a variant when drawing the edge — used by
    the variant-click flow (Stage 2) so the new edge already binds the
    user's chosen variant."""
    b, a, c = _scaffold(client)
    r = client.post(
        "/api/edges",
        json={
            "board_id": b["id"], "source_id": a["id"], "target_id": c["id"],
            "source_variant_idx": 2,
        },
    )
    assert r.status_code == 200
    assert r.json()["source_variant_idx"] == 2


def test_patch_edge_variant_pin(client):
    """PATCH updates the variant pin in place. Setting an int pins;
    explicit null clears the pin (revert to source.mediaId)."""
    b, a, c = _scaffold(client)
    edge = client.post(
        "/api/edges",
        json={"board_id": b["id"], "source_id": a["id"], "target_id": c["id"]},
    ).json()

    r = client.patch(f"/api/edges/{edge['id']}", json={"source_variant_idx": 3})
    assert r.status_code == 200
    assert r.json()["source_variant_idx"] == 3

    # Round-trip via GET to confirm persistence.
    detail = client.get(f"/api/boards/{b['id']}").json()
    assert detail["edges"][0]["source_variant_idx"] == 3

    # Explicit null clears the pin.
    r = client.patch(f"/api/edges/{edge['id']}", json={"source_variant_idx": None})
    assert r.status_code == 200
    assert r.json()["source_variant_idx"] is None


def test_patch_edge_empty_body_leaves_pin_untouched(client):
    """An empty PATCH body must NOT silently clear the pin — Pydantic's
    `model_fields_set` check distinguishes "unset" from "explicit null"."""
    b, a, c = _scaffold(client)
    edge = client.post(
        "/api/edges",
        json={
            "board_id": b["id"], "source_id": a["id"], "target_id": c["id"],
            "source_variant_idx": 1,
        },
    ).json()
    r = client.patch(f"/api/edges/{edge['id']}", json={})
    assert r.status_code == 200
    assert r.json()["source_variant_idx"] == 1


def test_patch_unknown_edge_returns_404(client):
    r = client.patch("/api/edges/9999", json={"source_variant_idx": 0})
    assert r.status_code == 404


def test_edge_self_loop_rejected(client):
    b, a, _ = _scaffold(client)
    r = client.post(
        "/api/edges",
        json={"board_id": b["id"], "source_id": a["id"], "target_id": a["id"]},
    )
    assert r.status_code == 400


def test_edge_crossing_board_rejected(client):
    b1, a, _ = _scaffold(client)
    b2 = client.post("/api/boards", json={"name": "other"}).json()
    other = client.post(
        "/api/nodes", json={"board_id": b2["id"], "type": "image"}
    ).json()

    r = client.post(
        "/api/edges",
        json={"board_id": b1["id"], "source_id": a["id"], "target_id": other["id"]},
    )
    assert r.status_code == 400


def test_edge_missing_node_returns_404(client):
    b = client.post("/api/boards", json={"name": "T"}).json()
    a = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    r = client.post(
        "/api/edges",
        json={"board_id": b["id"], "source_id": a["id"], "target_id": 999},
    )
    assert r.status_code == 404


def test_delete_missing_edge_returns_404(client):
    r = client.delete("/api/edges/999")
    assert r.status_code == 404
