from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent.parent.parent


def _looks_like_placeholder(value: str) -> bool:
    upper = value.upper()
    return (
        not value
        or "YOUR_" in upper
        or "PASTE_" in upper
        or "EXISTING_AUTH_USER_UUID" in upper
        or "DAN_" in upper
        or "DÁN_" in upper
    )


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key:
            continue
        current = os.getenv(key, "")
        if not current or _looks_like_placeholder(current):
            os.environ[key] = value


_load_env_file(ROOT / "agent" / ".env.staging")

STORAGE_DIR = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
DB_PATH = Path(os.getenv("FLOWBOARD_DB", STORAGE_DIR / "flowboard.db"))

HTTP_PORT = int(os.getenv("FLOWBOARD_HTTP_PORT", "8101"))
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "9223"))

PLANNER_MODEL = os.getenv("FLOWBOARD_PLANNER_MODEL", "claude-sonnet-4-6")
# "cli" → always use claude CLI; "mock" → always mock; "auto" → CLI if available,
# otherwise mock. Default auto.
PLANNER_BACKEND = os.getenv("FLOWBOARD_PLANNER_BACKEND", "auto")

# Supabase Control Plane Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://onlezkczgbmfsximobbc.supabase.co")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
CONTROL_PLANE_CRON_TOKEN = os.getenv("CONTROL_PLANE_CRON_TOKEN", "default_cron_secret_token_123")

# Extension Worker Configuration (loaded by mock/real extension workers)
# Base URL of the Control Plane Gateway (defaults to local dev server)
CONTROL_PLANE_BASE_URL = os.getenv("CONTROL_PLANE_BASE_URL", "http://127.0.0.1:8101")
# Worker identity — populated by pairing registration flow
EXT_CLIENT_ID = os.getenv("EXT_CLIENT_ID", "")
EXT_PAIRING_SECRET = os.getenv("EXT_PAIRING_SECRET", "")
# Provider this worker handles (e.g. "flow", "gemini", "mock")
EXT_PROVIDER = os.getenv("EXT_PROVIDER", "mock")
# Poll interval between claim attempts (seconds)
EXT_POLL_INTERVAL_SEC = float(os.getenv("EXT_POLL_INTERVAL_SEC", "5"))
# Heartbeat interval while job is running (seconds)
EXT_HEARTBEAT_INTERVAL_SEC = float(os.getenv("EXT_HEARTBEAT_INTERVAL_SEC", "20"))
# Lease duration requested on each claim/heartbeat
EXT_LEASE_DURATION_SEC = int(os.getenv("EXT_LEASE_DURATION_SEC", "60"))

# Cloudflare R2 Object Storage Configuration
R2_ENDPOINT = os.getenv("R2_ENDPOINT", "")
R2_BUCKET = os.getenv("R2_BUCKET", "flowboard-assets")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
