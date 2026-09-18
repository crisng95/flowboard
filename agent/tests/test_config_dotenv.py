"""Tests for the .env loader.

The Flow migration made FLOWBOARD_FLOW_PROJECT_ID and FLOWBOARD_PAYGATE_TIER
mandatory, and `make agent` runs uvicorn directly — so a shell `export` is
lost with the shell. The loader gives those a durable home. What it must never
do is override the real environment, because the test suite and
`VAR=... make agent` both depend on that precedence.
"""
from __future__ import annotations

import os

from flowboard.config import _load_dotenv


def _write(tmp_path, body: str):
    path = tmp_path / ".env"
    path.write_text(body)
    return path


def test_sets_unset_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("FB_TEST_A", raising=False)
    _load_dotenv(_write(tmp_path, "FB_TEST_A=hello\n"))
    assert os.environ["FB_TEST_A"] == "hello"


def test_the_real_environment_always_wins(monkeypatch, tmp_path):
    """The precedence the test suite and `VAR=... make agent` rely on."""
    monkeypatch.setenv("FB_TEST_B", "from-shell")
    _load_dotenv(_write(tmp_path, "FB_TEST_B=from-file\n"))
    assert os.environ["FB_TEST_B"] == "from-shell"


def test_ignores_comments_blanks_and_junk(tmp_path, monkeypatch):
    for key in ("FB_TEST_C", "FB_TEST_HASH", "FB_TEST_NOEQ"):
        monkeypatch.delenv(key, raising=False)
    _load_dotenv(_write(tmp_path, "\n".join([
        "# FB_TEST_HASH=nope",
        "",
        "   ",
        "FB_TEST_NOEQ",
        "  FB_TEST_C = spaced  ",
    ])))
    assert os.environ["FB_TEST_C"] == "spaced"
    assert "FB_TEST_HASH" not in os.environ
    assert "FB_TEST_NOEQ" not in os.environ


def test_strips_matching_quotes_but_not_inner_ones(tmp_path, monkeypatch):
    for key in ("FB_TEST_D", "FB_TEST_E", "FB_TEST_F"):
        monkeypatch.delenv(key, raising=False)
    _load_dotenv(_write(tmp_path, "\n".join([
        'FB_TEST_D="quoted"',
        "FB_TEST_E='single'",
        'FB_TEST_F=say "hi"',
    ])))
    assert os.environ["FB_TEST_D"] == "quoted"
    assert os.environ["FB_TEST_E"] == "single"
    assert os.environ["FB_TEST_F"] == 'say "hi"'


def test_accepts_an_export_prefix(tmp_path, monkeypatch):
    """People paste the line they were using in their shell."""
    monkeypatch.delenv("FB_TEST_G", raising=False)
    _load_dotenv(_write(tmp_path, "export FB_TEST_G=exported\n"))
    assert os.environ["FB_TEST_G"] == "exported"


def test_a_missing_file_is_not_an_error(tmp_path):
    _load_dotenv(tmp_path / "definitely-absent.env")


def test_a_directory_in_place_of_the_file_is_not_an_error(tmp_path):
    """ROOT/.env could be anything; config import must not die on it."""
    d = tmp_path / ".env"
    d.mkdir()
    _load_dotenv(d)
