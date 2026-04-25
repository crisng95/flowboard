def test_create_list_get_board(client):
    r = client.post("/api/boards", json={"name": "Scene 01"})
    assert r.status_code == 200
    board = r.json()
    assert board["name"] == "Scene 01"
    assert isinstance(board["id"], int)

    r = client.get("/api/boards")
    assert r.status_code == 200
    listing = r.json()
    assert any(b["id"] == board["id"] for b in listing)

    r = client.get(f"/api/boards/{board['id']}")
    assert r.status_code == 200
    detail = r.json()
    assert detail["board"]["id"] == board["id"]
    assert detail["nodes"] == []
    assert detail["edges"] == []


def test_get_missing_board_returns_404(client):
    r = client.get("/api/boards/999")
    assert r.status_code == 404


def test_patch_board_rename(client):
    b = client.post("/api/boards", json={"name": "Old"}).json()
    r = client.patch(f"/api/boards/{b['id']}", json={"name": "New"})
    assert r.status_code == 200
    assert r.json()["name"] == "New"

    # persistence
    r = client.get(f"/api/boards/{b['id']}")
    assert r.json()["board"]["name"] == "New"


def test_patch_missing_board_returns_404(client):
    r = client.patch("/api/boards/999", json={"name": "x"})
    assert r.status_code == 404
