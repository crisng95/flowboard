"""POST /api/chat/attachments — multipart upload of 1–5 images."""
import os
from pathlib import Path

# Minimal magic-byte-valid images (the route sniffs, never trusts the
# declared Content-Type).
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff" + b"\x00" * 32
GIF = b"GIF89a" + b"\x00" * 32
NOT_AN_IMAGE = b"hello world, this is plain text" * 4


def _board(client, name="T"):
    return client.post("/api/boards", json={"name": name}).json()


def _upload(client, board_id, files):
    return client.post(
        "/api/chat/attachments",
        data={"board_id": str(board_id)},
        files=[("files", (name, data, ctype)) for name, data, ctype in files],
    )


def _upload_dir() -> Path:
    return Path(os.environ["FLOWBOARD_STORAGE"]) / "chat_uploads"


def test_upload_single_image_ok(client):
    b = _board(client)
    r = _upload(client, b["id"], [("a.png", PNG, "image/png")])
    assert r.status_code == 200
    assets = r.json()["assets"]
    assert len(assets) == 1
    a = assets[0]
    assert a["id"] and a["mime"] == "image/png"
    assert a["url"] == f"/api/chat/attachments/{a['id']}/file"
    # bytes landed under storage/chat_uploads/
    stored = list(_upload_dir().glob("*.png"))
    assert len(stored) == 1
    assert stored[0].read_bytes() == PNG


def test_upload_five_images_ok(client):
    b = _board(client)
    files = [(f"{i}.jpg", JPEG, "image/jpeg") for i in range(5)]
    r = _upload(client, b["id"], files)
    assert r.status_code == 200
    assert len(r.json()["assets"]) == 5


def test_upload_six_images_rejected(client):
    b = _board(client)
    files = [(f"{i}.jpg", JPEG, "image/jpeg") for i in range(6)]
    r = _upload(client, b["id"], files)
    assert r.status_code == 400


def test_upload_non_image_rejected(client):
    b = _board(client)
    r = _upload(client, b["id"], [("x.txt", NOT_AN_IMAGE, "text/plain")])
    assert r.status_code == 400
    # lying Content-Type doesn't help either
    r = _upload(client, b["id"], [("x.png", NOT_AN_IMAGE, "image/png")])
    assert r.status_code == 400


def test_upload_oversize_rejected(client):
    b = _board(client)
    big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (11 * 1024 * 1024)
    r = _upload(client, b["id"], [("big.png", big, "image/png")])
    assert r.status_code == 400


def test_upload_unknown_board_rejected(client):
    r = _upload(client, 999999, [("a.png", PNG, "image/png")])
    assert r.status_code == 404


def test_get_attachment_file_serves_bytes(client):
    b = _board(client)
    r = _upload(client, b["id"], [("a.gif", GIF, "image/gif")])
    url = r.json()["assets"][0]["url"]
    g = client.get(url)
    assert g.status_code == 200
    assert g.content == GIF
    assert g.headers["content-type"] == "image/gif"


def test_get_attachment_file_unknown_id_404(client):
    assert client.get("/api/chat/attachments/987654321/file").status_code == 404


def test_mixed_valid_formats_ok(client):
    b = _board(client)
    r = _upload(
        client,
        b["id"],
        [
            ("a.png", PNG, "image/png"),
            ("b.jpg", JPEG, "image/jpeg"),
            ("c.gif", GIF, "image/gif"),
        ],
    )
    assert r.status_code == 200
    mimes = [a["mime"] for a in r.json()["assets"]]
    assert mimes == ["image/png", "image/jpeg", "image/gif"]
