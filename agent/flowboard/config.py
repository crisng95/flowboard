from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent.parent


def _load_dotenv(path: Path) -> None:
    """Fill in unset environment variables from a ``.env`` file.

    Exists because the Flow migration made two settings mandatory
    (FLOWBOARD_FLOW_PROJECT_ID, FLOWBOARD_PAYGATE_TIER) and there was nowhere
    durable to put them: ``make agent`` runs uvicorn directly, so anything
    only `export`ed is lost with the shell it was typed into.

    The real environment always wins — this only supplies what is missing, so
    `FLOWBOARD_PAYGATE_TIER=... make agent` and the test suite's own env still
    override the file. Not python-dotenv: the agent has no other use for the
    dependency and the format worth supporting is three lines of parsing.
    """
    try:
        raw = path.read_text()
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key] = value


_load_dotenv(ROOT / ".env")

STORAGE_DIR = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
DB_PATH = Path(os.getenv("FLOWBOARD_DB", STORAGE_DIR / "flowboard.db"))

HTTP_PORT = int(os.getenv("FLOWBOARD_HTTP_PORT", "8101"))
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "9223"))

PLANNER_MODEL = os.getenv("FLOWBOARD_PLANNER_MODEL", "claude-sonnet-4-6")
# "cli" → always use claude CLI; "mock" → always mock; "auto" → CLI if available,
# otherwise mock. Default auto.
PLANNER_BACKEND = os.getenv("FLOWBOARD_PLANNER_BACKEND", "auto")

STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# ── Google Flow, after the September 2026 migration ────────────────────────
#
# Flow moved to flow.google.com and signs every call in the page. Two things
# that used to be discovered at runtime now have to be stated here, because the
# Bearer token they were read from is no longer minted at all.

# Flow stopped letting us create projects: `project.createProject` lived on the
# labs.google tRPC frontend, which the migration unauthenticated. Make a project
# in the Flow UI once and pin its uuid in `.env` at the repo root (see the
# Quickstart), or pass `flow_project_id` per call.
FLOW_PROJECT_ID = os.getenv("FLOWBOARD_FLOW_PROJECT_ID", "")

# The paygate tier came from /v1/credits, fetched with the sniffed Bearer. That
# fetch cannot succeed any more. The tier is NOT cosmetic — it still selects the
# video checkpoint (Ultra reaches `veo_3_1_i2v_s_fast_ultra`, everything else
# lands on a lite model), so it must not be guessed per request either. Declare
# the account's plan once; an unrecognised value fails loudly rather than
# silently serving Pro to an Ultra account.
DEFAULT_PAYGATE_TIER = os.getenv("FLOWBOARD_PAYGATE_TIER", "PAYGATE_TIER_TWO")
