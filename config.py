"""
Bina configuration — paths, model constants, and settings persistence.
"""
import json
import os
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────────────
BINA_HOME = Path.home() / ".bina"
DB_PATH = BINA_HOME / "bina.db"
CHROMA_PATH = BINA_HOME / "chroma"
WATCHED_FOLDER_FILE = BINA_HOME / "watched_folder.txt"
SETTINGS_PATH = BINA_HOME / "settings.json"
ENV_PATH = BINA_HOME / ".env"

BINA_HOME.mkdir(parents=True, exist_ok=True)

# ── Load .env files ───────────────────────────────────────────────────────────
# Priority (highest → lowest):
#   1. Environment variables already set in the process
#   2. Project-level .env  (bundled with the app — your API keys go here)
#   3. ~/.bina/.env         (per-user overrides)

def _load_env(path: Path) -> None:
    """Load key=value lines from a .env file into os.environ (no-overwrite)."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

# Project root .env lives next to this file (one level up from backend/)
_PROJECT_ENV = Path(__file__).parent / ".env"
_load_env(_PROJECT_ENV)

# Per-user override (created by the Settings UI "Save key" button)
_load_env(ENV_PATH)

# ── Hosted GPT-OSS (free, OpenAI-compatible) ─────────────────────────────────
HOSTED_API_BASE = "https://vjioo4r1vyvcozuj.us-east-2.aws.endpoints.huggingface.cloud/v1"
HOSTED_API_KEY = "test"              # server accepts any key
HOSTED_MODEL = "openai/gpt-oss-120b"

# ── Local Ollama models ──────────────────────────────────────────────────────
OLLAMA_BASE_URL = "http://localhost:11434"
LOCAL_MODEL = "qwen3.5:2b"
LOCAL_EMBED_MODEL = "nomic-embed-text"

# ── Compatibility aliases (used by existing code) ────────────────────────────
MODEL = LOCAL_MODEL
LLM_MODEL = MODEL
VISION_MODEL = MODEL
EMBED_MODEL = LOCAL_EMBED_MODEL

# ── Moorcheh ──────────────────────────────────────────────────────────────────
MOORCHEH_API_KEY = os.environ.get("MOORCHEH_API_KEY", "")
MOORCHEH_NAMESPACE = "bina-vault"

# ── Thresholds & limits ──────────────────────────────────────────────────────
SIMILARITY_THRESHOLD = 0.65
ENTITY_BOOST = 0.15
MAX_GRAPH_NEIGHBOURS = 5

SUPPORTED_EXTENSIONS = {
    ".pdf", ".docx", ".txt", ".md", ".csv",
    ".png", ".jpg", ".jpeg", ".webp",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

CHAR_BUDGET = 24_000
LLM_CHAR_BUDGET = 8_000


# ── Settings persistence ─────────────────────────────────────────────────────

_DEFAULTS = {
    "model": "qwen3.5:2b",
    "similarity_threshold": 0.65,
    "max_graph_neighbours": 5,
}


def load_settings() -> dict:
    """Load persisted settings (or defaults) from ~/.bina/settings.json."""
    global MODEL, LLM_MODEL, VISION_MODEL, SIMILARITY_THRESHOLD, MAX_GRAPH_NEIGHBOURS
    try:
        if SETTINGS_PATH.exists():
            data = json.loads(SETTINGS_PATH.read_text())
        else:
            data = {}
    except Exception:
        data = {}

    merged = {**_DEFAULTS, **data}
    MODEL = LLM_MODEL = VISION_MODEL = (
        merged.get("model") or merged.get("llm_model") or "qwen3.5:2b"
    )
    SIMILARITY_THRESHOLD = float(merged["similarity_threshold"])
    MAX_GRAPH_NEIGHBOURS = int(str(merged["max_graph_neighbours"]))
    return merged


def save_settings(
    llm_model: str | None = None,
    similarity_threshold: float | None = None,
    max_graph_neighbours: int | None = None,
) -> dict:
    """Persist updated settings to ~/.bina/settings.json and hot-reload."""
    global MODEL, LLM_MODEL, VISION_MODEL, SIMILARITY_THRESHOLD, MAX_GRAPH_NEIGHBOURS
    current = load_settings()
    if llm_model is not None:
        current["model"] = llm_model
    if similarity_threshold is not None:
        current["similarity_threshold"] = float(similarity_threshold)
    if max_graph_neighbours is not None:
        current["max_graph_neighbours"] = int(max_graph_neighbours)
    SETTINGS_PATH.write_text(json.dumps(current, indent=2))
    MODEL = LLM_MODEL = VISION_MODEL = (
        current.get("model") or current.get("llm_model") or "qwen3.5:2b"
    )
    SIMILARITY_THRESHOLD = current["similarity_threshold"]
    MAX_GRAPH_NEIGHBOURS = current["max_graph_neighbours"]
    return current


# Load on import so all modules see correct values.
load_settings()
