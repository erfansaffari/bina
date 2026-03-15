# Bina — AI Semantic File Manager for macOS

## What This Project Is
Local-first AI file manager. User points it at a folder, Bina reads every
PDF/DOCX/TXT/MD/CSV/image, runs AI analysis (local Ollama or hosted GPT-OSS),
builds a semantic knowledge graph (NetworkX), stores vectors in Moorcheh,
and lets users find files via natural language. Everything runs on-device
except hosted inference path. No cloud sync. No telemetry.

## Monorepo Structure
- `backend/` — Python FastAPI sidecar on port 8765
- `frontend/` — Electron + React + Vite + Tailwind + TypeScript
- `docs/` — architecture, devlog, API contract (read with @docs/filename.md)
- `~/.bina/` — runtime data: bina.db (SQLite), chroma/ (ChromaDB fallback)
- `~/.ollama/models/` — Ollama models (NEVER delete these)

## Current Model Stack
- Inference: qwen3.5:2b (local) OR openai/gpt-oss-120b (hosted, default)
- Embeddings: nomic-embed-text via Ollama (always local)
- Vector store: Moorcheh (hosted) or ChromaDB (local fallback)
- Graph: NetworkX in-memory, per-workspace, rebuilt from SQLite

## Database Schema (SQLite at ~/.bina/bina.db)
- file_records: hash(PK), path, summary, keywords, entities, doc_type,
  status, embedding_model, processed_at
- workspaces: id, name, emoji, colour, processing_path, model_name,
  user_api_key, vector_backend, created_at, last_opened
- workspace_folders: workspace_id, folder_path, added_at
- workspace_files: workspace_id, file_hash, added_at
Key rule: file_records keyed by MD5 hash not path — dedup is critical.

## Do Not Touch (working, stable)
- extractor.py — all file type extraction logic
- sampler.py — smart page sampling
- GraphCanvas.tsx lines 210–215 — collision force config
- Inspector.tsx — null guards and image preview
- SearchBar.tsx — Cmd+K and debounce

## How to Run
```bash
# Backend
cd backend && source ../.venv/bin/activate && python api.py

# Frontend (separate terminal)
cd frontend && npm run dev

# Reset all indexed data (nuclear option)
cd backend && python reset.py

# CLI only
python main.py index ~/path/to/folder
python main.py search "query"
python main.py status
```

## Key Rules
- Never use datetime.utcnow() — use datetime.now(timezone.utc)
- Always pass workspace_id through every pipeline, graph, and search call
- Dedup check: file_already_indexed(hash) before any AI processing
- _repair_json() must strip <think>...</think> tags (qwen3.5 thinking mode)
- ChromaDB IDs and Moorcheh IDs are file hash, not path
- Three processing paths: "hosted" | "local" | "user_api" — per workspace
- Graph is per-workspace dict: _graphs[workspace_id]

## Architecture Docs
For full details: @docs/architecture.md
For recent changes: @docs/devlog.md
For all API endpoints: @docs/api-contract.md