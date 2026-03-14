# Bina — Phase 0 CLI

> بینا — "one who sees clearly"

A local AI semantic file manager CLI. Watch any folder, let Bina read and understand every document using fully on-device AI, then find anything with a natural language question.

**100% private. No API keys. No internet after first model download.**

---

## Prerequisites

1. **Python 3.11+**
2. **Ollama** installed and running:
   ```bash
   brew install ollama
   ollama serve   # keep this running in a separate terminal
   ```
3. **Pull the required models** (one-time, ~2.3 GB total):
   ```bash
   ollama pull llama3.2:3b
   ollama pull nomic-embed-text
   ```

---

## Installation

```bash
# Clone / navigate to this directory, then:
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## Usage

### Index a folder (and watch it for changes)

```bash
python main.py index /path/to/your/documents
```

Bina will:
- Scan all PDF, DOCX, TXT, and MD files recursively
- Process each file through the local AI pipeline (summary, keywords, entities, embedding)
- Store everything in `~/.bina/` (SQLite + ChromaDB)
- Continue watching the folder for new or modified files

### Search

```bash
python main.py search
```

Launches an interactive REPL:

```
bina> reports about renewable energy subsidies in Europe
bina> that invoice from the design project last year
bina> open 3        ← opens result #3 in its default macOS app
bina> q             ← quit
```

### Check status

```bash
python main.py status
```

### Force re-index everything

```bash
python main.py reindex
```

---

## Data Storage

All data lives in `~/.bina/`:

| Path | Contents |
|---|---|
| `~/.bina/bina.db` | SQLite: file paths, hashes, summaries, keywords, entities |
| `~/.bina/chroma/` | ChromaDB: 384-dim embedding vectors |
| `~/.bina/watched_folder.txt` | Last selected folder (persists across launches) |

---

## Architecture

```
Watched Folder
     │ FSEvents (watchdog)
     ▼
extractor.py  →  sampler.py  →  pipeline.py (Ollama)
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
                     store.py             vector_store.py
                     (SQLite)              (ChromaDB)
                          │                     │
                          └──────────┬──────────┘
                                     ▼
                                  graph.py
                                (NetworkX)
                                     │
                                     ▼
                                  search.py
                                  (REPL)
```

---

## Model Tiers

| Mode | Model | Download | Speed | RAM |
|---|---|---|---|---|
| Fast (default) | `llama3.2:3b` | ~2 GB | 3–5s/file | 4 GB+ |
| Smart | `llama3.1:8b` | ~5 GB | 8–15s/file | 8 GB+ |
| Embedding (both) | `nomic-embed-text` | 274 MB | <200ms/chunk | Any |

Switch model by editing `LLM_MODEL` in `config.py`.
