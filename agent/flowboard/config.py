from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent.parent
STORAGE_DIR = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
DB_PATH = Path(os.getenv("FLOWBOARD_DB", STORAGE_DIR / "flowboard.db"))

HTTP_PORT = int(os.getenv("FLOWBOARD_HTTP_PORT", "8100"))
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "9222"))

PLANNER_MODEL = os.getenv("FLOWBOARD_PLANNER_MODEL", "claude-sonnet-4-6")
# "cli" → always use claude CLI; "mock" → always mock; "auto" → CLI if available,
# otherwise mock. Default auto.
PLANNER_BACKEND = os.getenv("FLOWBOARD_PLANNER_BACKEND", "auto")

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
