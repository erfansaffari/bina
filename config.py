from pathlib import Path

BINA_HOME = Path.home() / ".bina"
DB_PATH = BINA_HOME / "bina.db"
CHROMA_PATH = BINA_HOME / "chroma"
WATCHED_FOLDER_FILE = BINA_HOME / "watched_folder.txt"

OLLAMA_BASE_URL = "http://localhost:11434"
LLM_MODEL = "llama3.2:3b"
EMBED_MODEL = "nomic-embed-text"

SIMILARITY_THRESHOLD = 0.72
ENTITY_BOOST = 0.15
MAX_GRAPH_NEIGHBOURS = 1

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

# Embedding text budget: more text → better vector quality (~6000 tokens)
CHAR_BUDGET = 24_000

# LLM summarisation budget: llama3.2:3b performs best with shorter prompts;
# beyond ~4000 chars the 3b model tends to return empty fields.
LLM_CHAR_BUDGET = 4_000

BINA_HOME.mkdir(parents=True, exist_ok=True)
