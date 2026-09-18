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
    """Pin the tier so tests assert one checkpoint, not the configured default.

    Most tests exercise downstream behaviour (variant_count, ref_media_ids,
    envelope shape) and don't care where the tier came from. They do care that
    it is stable: since the Flow migration the resolution chain ends in
    FLOWBOARD_PAYGATE_TIER, whose default is PAYGATE_TIER_TWO, so without this
    fixture a test asserting a Pro checkpoint would pass or fail depending on
    the developer's environment.

    Simulating "the extension pushed Pro" keeps that deterministic and keeps
    the fixture honest about which link of the chain it is standing in for.
    Tests exercising the chain itself (test_processor_tier_fallback.py) clear
    this in their own module-local autouse fixture, which runs after this one
    and wins.
    """
    from flowboard.services.flow_client import flow_client
    flow_client._paygate_tier = "PAYGATE_TIER_ONE"
    yield
    flow_client._paygate_tier = None


@pytest.fixture(autouse=True)
def _no_image_submit_cadence(monkeypatch):
    """Drop the image-wave submit cadence to zero for tests.

    Production staggers variant submits by up to 2.5s to match Flow's own UI
    (see flow_sdk.IMAGE_UI_SUBMIT_OFFSETS_S). No test wants to sit through
    that, and none asserts on timing — except
    test_image_submit_cadence_is_staggered, which reads the constant directly
    and so is unaffected by this patch.
    """
    from flowboard.services import flow_sdk
    monkeypatch.setattr(
        flow_sdk, "IMAGE_UI_SUBMIT_OFFSETS_S", (0.0, 0.0, 0.0, 0.0)
    )
    yield


@pytest.fixture
def client():
    return TestClient(app)

