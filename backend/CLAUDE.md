# Backend Rules

## Stack
FastAPI (port 8765) · SQLAlchemy · Ollama · OpenAI SDK · Railtracks · Moorcheh

## File Ownership (do not mix concerns)
- inference.py   — all LLM + embedding calls, 3 paths (hosted/local/user_api)
- pipeline.py    — process_file(path, workspace_id), dedup, calls inference.py
- graph.py       — NetworkX per-workspace, mark_dirty(workspace_id)
- store.py       — all SQLite CRUD, workspace CRUD
- vector_store.py — Moorcheh wrapper (primary)
- vector_store_local.py — ChromaDB (local privacy mode only)
- agent.py       — Railtracks tool nodes + agent builder
- watcher.py     — FSEvents watcher, workspace-aware
- api.py         — FastAPI routes only, no business logic

## Hosted GPT-OSS Config
base_url = "https://vjioo4r1vyvcozuj.us-east-2.aws.endpoints.huggingface.cloud/v1"
api_key  = "test"   (any value accepted)
model    = "openai/gpt-oss-120b"

## Railtracks Pattern
Tool nodes are thin wrappers — no logic inside them.
Call index_file() directly from watchdog (not via agent).
One agent per workspace cached in _agents dict.
Invalidate with invalidate_agent(workspace_id) on config change.

## Testing After Changes
curl http://localhost:8765/global/status
curl -X POST http://localhost:8765/query \
  -H "Content-Type: application/json" \
  -d '{"query":"test","workspace_id":"<id>","mode":"agent"}'