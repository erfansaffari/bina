import json
from pathlib import Path

BINA_HOME = Path.home() / ".bina"
DB_PATH = BINA_HOME / "bina.db"
CHROMA_PATH = BINA_HOME / "chroma"
WATCHED_FOLDER_FILE = BINA_HOME / "watched_folder.txt"
SETTINGS_PATH = BINA_HOME / "settings.json"

OLLAMA_BASE_URL = "http://localhost:11434"
LLM_MODEL = "qwen3:4b"
VISION_MODEL = "qwen2.5vl:3b"
EMBED_MODEL = "nomic-embed-text"

SIMILARITY_THRESHOLD = 0.72
ENTITY_BOOST = 0.15
MAX_GRAPH_NEIGHBOURS = 5

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".csv"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

# Embedding text budget: more text → better vector quality (~6000 tokens)
CHAR_BUDGET = 24_000

# LLM summarisation budget: llama3.2:3b performs best with shorter prompts;
# beyond ~4000 chars the 3b model tends to return empty fields.
LLM_CHAR_BUDGET = 4_000

BINA_HOME.mkdir(parents=True, exist_ok=True)


_DEFAULTS = {
    "llm_model": "llama3.2:3b",
    "similarity_threshold": 0.72,
    "max_graph_neighbours": 5,
}


def load_settings() -> dict:
    """Load persisted settings (or defaults) from ~/.bina/settings.json."""
    global LLM_MODEL, SIMILARITY_THRESHOLD, MAX_GRAPH_NEIGHBOURS
    try:
        if SETTINGS_PATH.exists():
            data = json.loads(SETTINGS_PATH.read_text())
        else:
            data = {}
    except Exception:
        data = {}

    merged = {**_DEFAULTS, **data}
    LLM_MODEL = merged["llm_model"]
    VISION_MODEL = merged.get("vision_model", "qwen2.5vl:3b")
    SIMILARITY_THRESHOLD = float(merged["similarity_threshold"])
    MAX_GRAPH_NEIGHBOURS = int(str(merged["max_graph_neighbours"]))
    return merged


def save_settings(llm_model: str | None = None,
                  similarity_threshold: float | None = None,
                  max_graph_neighbours: int | None = None) -> dict:
    """Persist updated settings to ~/.bina/settings.json and hot-reload."""
    global LLM_MODEL, SIMILARITY_THRESHOLD, MAX_GRAPH_NEIGHBOURS
    current = load_settings()
    if llm_model is not None:
        current["llm_model"] = llm_model
    if similarity_threshold is not None:
        current["similarity_threshold"] = float(similarity_threshold)
    if max_graph_neighbours is not None:
        current["max_graph_neighbours"] = int(max_graph_neighbours)
    SETTINGS_PATH.write_text(json.dumps(current, indent=2))
    # Hot-reload into module-level vars
    LLM_MODEL = current["llm_model"]
    SIMILARITY_THRESHOLD = current["similarity_threshold"]
    MAX_GRAPH_NEIGHBOURS = current["max_graph_neighbours"]
    return current


# Load persisted settings on import so all modules see the correct values.
load_settings()
