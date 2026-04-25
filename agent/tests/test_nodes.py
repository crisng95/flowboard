def _make_board(client, name="Test"):
    return client.post("/api/boards", json={"name": name}).json()


def test_create_node_assigns_short_id(client):
    b = _make_board(client)
    r = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image", "x": 10, "y": 20},
    )
    assert r.status_code == 200
    node = r.json()
    assert node["board_id"] == b["id"]
    assert node["type"] == "image"
    assert node["x"] == 10 and node["y"] == 20
    assert len(node["short_id"]) == 4
    assert node["status"] == "idle"


def test_short_ids_unique_within_board(client):
    b = _make_board(client)
    ids = set()
    for _ in range(50):
        n = client.post(
            "/api/nodes", json={"board_id": b["id"], "type": "note"}
        ).json()
        assert n["short_id"] not in ids
        ids.add(n["short_id"])


def test_patch_node_partial(client):
    b = _make_board(client)
    n = client.post(
        "/api/nodes",
        json={"board_id": b["id"], "type": "image", "x": 0, "y": 0},
    ).json()

    r = client.patch(f"/api/nodes/{n['id']}", json={"x": 123.5, "status": "running"})
    assert r.status_code == 200
    out = r.json()
    assert out["x"] == 123.5
    assert out["status"] == "running"
    assert out["y"] == 0  # unchanged


def test_patch_missing_node_returns_404(client):
    r = client.patch("/api/nodes/999", json={"x": 1})
    assert r.status_code == 404


def test_delete_node_cascades_edges(client):
    b = _make_board(client)
    a = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    c = client.post("/api/nodes", json={"board_id": b["id"], "type": "image"}).json()
    e = client.post(
        "/api/edges",
        json={"board_id": b["id"], "source_id": a["id"], "target_id": c["id"]},
    ).json()

    r = client.delete(f"/api/nodes/{a['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert e["id"] in body["deleted_edges"]

    # edge is gone server-side
    detail = client.get(f"/api/boards/{b['id']}").json()
    assert detail["edges"] == []
