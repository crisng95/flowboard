"""Tests for Run 2 polish: enum constraints, coord bounds, FK enforcement."""


def _board(client):
    return client.post("/api/boards", json={"name": "T"}).json()


def test_node_type_enum_rejects_unknown(client):
    b = _board(client)
    r = client.post("/api/nodes", json={"board_id": b["id"], "type": "robot"})
    assert r.status_code == 422


def test_node_status_enum_rejects_unknown_on_update(client):
    b = _board(client)
    n = client.post(
        "/api/nodes", json={"board_id": b["id"], "type": "image"}
    ).json()
    r = client.patch(f"/api/nodes/{n['id']}", json={"status": "cooking"})
    assert r.status_code == 422


def test_node_coord_upper_bound(client):
    b = _board(client)
    r = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image", "x": 1e8, "y": 0},
    )
    assert r.status_code == 422


def test_node_coord_lower_bound(client):
    b = _board(client)
    r = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image", "x": -1e8, "y": 0},
    )
    assert r.status_code == 422


def test_node_size_must_be_positive(client):
    b = _board(client)
    r = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image", "w": 0, "h": 10},
    )
    assert r.status_code == 422


def test_edge_kind_enum_rejects_unknown(client):
    b = _board(client)
    a = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    c = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    r = client.post(
        "/api/edges",
        json={
            "board_id": b["id"],
            "source_id": a["id"],
            "target_id": c["id"],
            "kind": "spaghetti",
        },
    )
    assert r.status_code == 422


def test_node_on_missing_board_returns_404(client):
    """With the existence check in Run 2, orphan nodes are rejected before FK."""
    r = client.post("/api/nodes", json={"board_id": 9999, "type": "image"})
    assert r.status_code == 404
