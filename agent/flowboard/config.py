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

# There is deliberately no HTTP_PORT here. Nothing in `flowboard` reads
# one — uvicorn takes the port from `--port` in the Makefile, which is the
# single real knob (`FLOWBOARD_HTTP_PORT ?= 8434` there). A constant that
# nothing imports reads like configuration and silently isn't.
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")

# This one IS live — `ws_server.py` binds it. Default moved off 9223,
# which collides with Chrome's own remote-debugging port and with common
# local services. Changing it is not enough on its own: the extension
# hardcodes the agent's ports in `extension/background.js` and
# `extension/manifest.json`, so both have to be hand-edited to match.
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "8355"))

# The planner's model + reasoning effort live per-feature in
# ~/.flowboard/secrets.json (`featureConfig.planner`), set from
# Settings → AI Providers. There is deliberately no env-var override:
# a second knob that silently loses to the stored config is worse than
# no knob at all.
#
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

# ── Muse provider (Pax, the assistant itself) ─────────────────────────────
#
# The "muse" provider is a *delegated* backend: generation and LLM jobs are
# published to the provider-job queue and fulfilled by an external worker
# (Pax) instead of the Chrome extension → Google Flow path. No credentials,
# no CLI, no Flow plan needed on this path.

# Default media backend for gen_image / gen_video / gen_video_omni /
# edit_image dispatches: "flow" (Chrome extension → Google Flow) or "muse"
# (provider-job queue → Pax worker). A per-request `media_provider` param
# overrides this; the GenerationDialog stamps the user's sticky choice.
MEDIA_PROVIDER_DEFAULT = os.getenv("FLOWBOARD_MEDIA_PROVIDER", "flow").strip().lower() or "flow"

# How long a producer waits for a Pax worker to finish one job before
# giving up. LLM jobs (auto-prompt/vision/planner) are quick; media jobs
# (image/video renders) can take many minutes.
MUSE_LLM_TIMEOUT_S = float(os.getenv("FLOWBOARD_MUSE_LLM_TIMEOUT_S", "600"))
MUSE_MEDIA_TIMEOUT_S = float(os.getenv("FLOWBOARD_MUSE_MEDIA_TIMEOUT_S", "1800"))

# Worker presence TTL: a worker that hasn't polled within this window is
# treated as offline (drives the Settings UI's availability tick).
MUSE_WORKER_PRESENCE_TTL_S = float(os.getenv("FLOWBOARD_MUSE_WORKER_TTL_S", "300"))
