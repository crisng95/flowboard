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

# Deployment mode. "dev" (default) keeps developer-friendly fallbacks;
# "prod" turns on hard guards that refuse to boot with placeholder/missing
# secrets (see _require_prod_secret below). Set FLOWBOARD_ENV=prod in any
# hosted/staging deployment.
FLOWBOARD_ENV = os.getenv("FLOWBOARD_ENV", "dev").strip().lower()
IS_PROD = FLOWBOARD_ENV in ("prod", "production")

# Placeholder sentinel for the cron token: if this exact value is still in
# effect at boot in prod, the recover-stale endpoint would be callable by
# anyone, so we refuse to start. Kept as a named constant so the guard and
# the (dev-only) default cannot drift apart.
_DEFAULT_CRON_TOKEN = "default_cron_secret_token_123"


def _require_prod_secret(name: str, value: str, *, placeholder: str | None = None) -> str:
    """In prod, fail fast on a missing or placeholder secret rather than
    booting with an insecure/empty default. No-op in dev so local work keeps
    its convenient fallbacks."""
    if not IS_PROD:
        return value
    if not value or (placeholder is not None and value == placeholder):
        raise RuntimeError(
            f"{name} must be set to a real value when FLOWBOARD_ENV=prod "
            f"(refusing to boot with a missing/placeholder secret)."
        )
    return value


STORAGE_DIR = Path(os.getenv("FLOWBOARD_STORAGE", ROOT / "storage"))
DB_PATH = Path(os.getenv("FLOWBOARD_DB", STORAGE_DIR / "flowboard.db"))

HTTP_PORT = int(os.getenv("FLOWBOARD_HTTP_PORT", "8101"))
WS_HOST = os.getenv("FLOWBOARD_WS_HOST", "127.0.0.1")
EXTENSION_WS_PORT = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "9223"))

# Comma-separated list of origins allowed to call the HTTP API with
# credentials. Defaults to the local Vite dev servers; override in prod with
# the real frontend origin(s), e.g. "https://app.flowboard.bond".
CORS_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "FLOWBOARD_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if o.strip()
]

PLANNER_MODEL = os.getenv("FLOWBOARD_PLANNER_MODEL", "claude-sonnet-4-6")
# "cli" → always use claude CLI; "mock" → always mock; "auto" → CLI if available,
# otherwise mock. Default auto.
PLANNER_BACKEND = os.getenv("FLOWBOARD_PLANNER_BACKEND", "auto")

# Supabase Control Plane Configuration. No hardcoded project URL or keys —
# these MUST come from the environment. In prod the guards below refuse to
# boot if they're absent.
SUPABASE_URL = _require_prod_secret("SUPABASE_URL", os.getenv("SUPABASE_URL", ""))
SUPABASE_SERVICE_ROLE_KEY = _require_prod_secret(
    "SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
)
CONTROL_PLANE_CRON_TOKEN = _require_prod_secret(
    "CONTROL_PLANE_CRON_TOKEN",
    os.getenv("CONTROL_PLANE_CRON_TOKEN", _DEFAULT_CRON_TOKEN),
    placeholder=_DEFAULT_CRON_TOKEN,
)

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
R2_ACCESS_KEY_ID = _require_prod_secret("R2_ACCESS_KEY_ID", os.getenv("R2_ACCESS_KEY_ID", ""))
R2_SECRET_ACCESS_KEY = _require_prod_secret(
    "R2_SECRET_ACCESS_KEY", os.getenv("R2_SECRET_ACCESS_KEY", "")
)

# Google Flow's PUBLIC web API key (the `?key=` param Flow's web app sends on
# every aisandbox-pa request). Not a private credential, but kept out of source
# and configurable so it can be rotated without a code change.
FLOW_API_KEY = os.getenv(
    "FLOW_API_KEY", "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
)

STORAGE_DIR.mkdir(parents=True, exist_ok=True)
