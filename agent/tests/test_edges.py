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

    detail = client.get(f"/api/boards/{b['id']}").json()
    assert len(detail["edges"]) == 1

    r = client.delete(f"/api/edges/{edge['id']}")
    assert r.status_code == 200
    detail = client.get(f"/api/boards/{b['id']}").json()
    assert detail["edges"] == []


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
