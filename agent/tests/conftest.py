import os
import tempfile
from pathlib import Path

import pytest

# Point Flowboard at an isolated temp dir BEFORE importing the app.
_TMPDIR = tempfile.mkdtemp(prefix="flowboard-test-")
os.environ["FLOWBOARD_STORAGE"] = _TMPDIR
os.environ["FLOWBOARD_DB"] = str(Path(_TMPDIR) / "test.db")
# Force the deterministic mock planner in tests — never spawn `claude` subprocess.
# Individual tests that want to exercise the CLI path patch the module directly.
os.environ["FLOWBOARD_PLANNER_BACKEND"] = "mock"

from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from flowboard.db.session import engine  # noqa: E402
from flowboard.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_db():
    """Drop + recreate all tables before each test so state is isolated."""
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield


@pytest.fixture(autouse=True)
def _seed_default_paygate_tier():
    """Most tests exercise downstream behaviour (variant_count, ref_media_ids,
    SDK payload shape, etc.) and don't care about the upstream tier-resolution
    chain. Pre-Phase-1, the worker silently defaulted to PAYGATE_TIER_ONE when
    no signal was present, so tests didn't have to think about tier at all.
    Phase 1 made that fail loud — every gen now requires a tier signal — so
    we keep the test-time ergonomics by simulating the "extension already
    sniffed Pro" state by default. Tests that specifically want to exercise
    the no-tier path (e.g. test_processor_tier_fallback.py) reset the cache
    in their own module-local autouse fixture, which runs after this one and
    wins.
    """
    from flowboard.services.flow_client import flow_client
    flow_client._paygate_tier = "PAYGATE_TIER_ONE"
    yield
    flow_client._paygate_tier = None


@pytest.fixture
def client():
    return TestClient(app)
