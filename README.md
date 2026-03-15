# Bina — AI Semantic File Manager for macOS

> **بینا** (Bina) — *"one who sees clearly"*

Bina is a **100% local-first** AI file manager for macOS. Point it at any folder and it reads, understands, and interconnects all your documents — PDFs, Word files, text, Markdown, CSVs, and images — into an Obsidian-style interactive knowledge graph. Find anything by meaning, not just keywords. Chat directly with your entire file vault using natural language.

Nothing is ever sent to the cloud unless you explicitly choose the hosted inference path. All AI reasoning, embeddings, and graph computations can run fully on-device.

---

## Table of Contents

1. [Features](#features)
2. [Architecture Overview](#architecture-overview)
3. [How It Works — The Full Pipeline](#how-it-works--the-full-pipeline)
4. [Math & Algorithms](#math--algorithms)
5. [AI Inference Paths](#ai-inference-paths)
6. [Vector Stores: Moorcheh & ChromaDB](#vector-stores-moorcheh--chromadb)
7. [Railtracks Agent](#railtracks-agent)
8. [Data Model](#data-model)
9. [File Map](#file-map)
10. [API Reference](#api-reference)
11. [How to Run](#how-to-run)
12. [Configuration](#configuration)
13. [Building for Distribution](#building-for-distribution)
14. [Design Decisions & Innovations](#design-decisions--innovations)
15. [Known Limitations](#known-limitations)

---

## Features

- **Semantic Search** — find files by meaning, not filenames. Ask "lecture notes about neural networks" and get the right slides even if they're named `lec07.pdf`.
- **Interactive Knowledge Graph** — Obsidian-style D3 canvas with community clustering, force simulation, pan/zoom, depth slider, and hover labels.
- **Ask Bina (Chat)** — conversational Q&A over your entire indexed vault using a Railtracks reasoning agent.
- **Multi-Workspace** — separate graphs for separate projects. Shared files are deduplicated (one stored record, many workspace memberships).
- **Live File Watching** — macOS FSEvents watcher via watchdog. New, modified, and deleted files update the graph automatically within seconds.
- **Three AI Paths** — Hosted free LLM (120B), fully local Ollama, or your own OpenAI key.
- **Image Understanding** — vision model reads and classifies PNG/JPG/WebP files.
- **Crash Recovery** — startup re-indexes any file that was mid-processing when the app was killed.
- **Per-workspace vector backend** — Moorcheh cloud-synced vectors (default) or local ChromaDB (offline/privacy mode).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Electron Shell                      │
│  ┌─────────────────────────────────────────────┐    │
│  │  React 18 + TypeScript + Vite + Tailwind    │    │
│  │                                             │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│  │  │ Graph    │  │Inspector │  │ AskBina  │  │    │
│  │  │ Canvas   │  │ Panel    │  │ Panel    │  │    │
│  │  │ (D3 v7)  │  │          │  │(Railtracks│  │    │
│  │  └──────────┘  └──────────┘  └──────────┘  │    │
│  │                                             │    │
│  │  Zustand State  ←→  window.bina IPC Bridge  │    │
│  └─────────────────────────────────────────────┘    │
│                         │ IPC (contextBridge)        │
│                         ▼                            │
│            Electron Main Process (main.js)           │
│            ├── Spawns Python sidecar                 │
│            └── HTTP proxy to localhost:8765          │
└─────────────────────────────────────────────────────┘
                          │ HTTP REST
                          ▼
┌─────────────────────────────────────────────────────┐
│           FastAPI Sidecar (backend/api.py)           │
│                  port 8765                           │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │pipeline.py│  │ graph.py │  │    agent.py      │   │
│  │(index flow│  │(NetworkX)│  │  (Railtracks)    │   │
│  └──────────┘  └──────────┘  └──────────────────┘   │
│        │              │               │               │
│        ▼              ▼               ▼               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │inference │  │ store.py │  │ vector_store_    │   │
│  │   .py    │  │(SQLite)  │  │ router.py        │   │
│  │(LLM+embed│  │          │  │ ├─ moorcheh      │   │
│  └──────────┘  └──────────┘  │ └─ chromadb      │   │
│        │                      └──────────────────┘   │
│        ▼                                             │
│  ┌─────────────────────────────────────────────┐    │
│  │  Ollama (local)  OR  Hosted GPT-OSS 120B    │    │
│  │  nomic-embed-text (local, always)            │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
    ~/.bina/bina.db          Moorcheh Cloud
    (SQLite metadata)      OR ~/.bina/chroma/
                           (ChromaDB local)
```

### Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 32 (CommonJS, not ESM) |
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| State management | Zustand (`src/store/appStore.ts`) |
| Graph visualization | D3 v7 force simulation + HTML Canvas (manual pan/zoom) |
| Backend API | FastAPI on `localhost:8765`, spawned as child process |
| AI inference | Ollama (`qwen3.5:2b`) or hosted `openai/gpt-oss-120b` |
| Embeddings | `nomic-embed-text` via Ollama (768 dimensions, always local) |
| Vector store (primary) | **Moorcheh** — hosted, cloud-synced, fast similarity search |
| Vector store (fallback) | **ChromaDB** — local, offline, used as embedding cache always |
| Metadata | SQLite at `~/.bina/bina.db` via SQLAlchemy |
| Knowledge graph | NetworkX in-memory, per-workspace |
| Agent framework | **Railtracks** — tool-node based reasoning agent |
| File watching | watchdog FSEvents (macOS native kernel events) |
| IPC | Electron contextBridge (`window.bina.api.*`) |

---

## How It Works — The Full Pipeline

### Indexing a File

When a file is added to a watched folder (or manually indexed), the following sequence executes:

```
1. MD5 hash the file bytes
       ↓
2. store.file_already_indexed(hash)?
   YES → add_file_to_workspace(workspace_id, hash)
         mark_dirty(workspace_id)
         return "skipped"  (zero AI cost for duplicate files)
   NO  → continue
       ↓
3. extractor.extract(path)
   → PDF: PyMuPDF page-by-page text
   → DOCX: paragraph chunks (30 para/page)
   → TXT/MD: line chunks (50 lines/page)
   → CSV: column summary + 20 sample rows
   → Images: raw bytes → vision model path
       ↓
4. sampler.sample(pages)
   → Smart sampling up to CHAR_BUDGET=24,000 chars
   → Takes beginning, middle, end proportionally
       ↓
5. inference.call_inference(text, workspace)
   → Sends to LLM (hosted/local/user_api per workspace)
   → Returns structured JSON:
     {
       "summary": "3-sentence plain-language summary",
       "keywords": ["keyword1", ...],
       "entities": {
         "persons": [...], "companies": [...],
         "dates": [...], "projects": [...], "locations": [...]
       },
       "doc_type": "Lecture Notes | Research Paper | ..."
     }
       ↓
6. pipeline._repair_json(response)
   → Strips <think>...</think> (qwen3.5 thinking mode)
   → Strips markdown code fences
   → Fixes trailing commas
   → Converts Python literals (None/True/False) to JSON
       ↓
7. inference.embed_text(summary + keywords + text[:6000])
   → nomic-embed-text via Ollama → 768-dim float vector
       ↓
8. store.upsert_file(hash, path, summary, ...)
   → INSERT OR REPLACE into file_records (SQLite)
       ↓
9. store.add_file_to_workspace(workspace_id, hash)
   → INSERT into workspace_files join table
   ⚠ CRITICAL: must come AFTER upsert_file to satisfy FK constraint
       ↓
10. vector_store_router.get_store(workspace_id).upsert(hash, embedding, metadata)
    → Moorcheh (if API key set and auth OK)
    → Falls back to ChromaDB on any Moorcheh error
       ↓
11. ChromaDB dual-write (always, regardless of primary store)
    → Stores embedding locally so graph.py can always retrieve
      raw vectors for cosine similarity without re-embedding
       ↓
12. graph.mark_dirty(workspace_id)
    → Next graph access triggers full rebuild
```

### Searching

```
1. User types query in SearchBar (debounced 300ms)
       ↓
2. inference.embed_text(query)
   → Same nomic-embed-text model → 768-dim query vector
       ↓
3. vector_store.query(query_vector, n_results=20, hashes=workspace_hashes)
   → Cosine similarity search in Moorcheh or ChromaDB
   → Returns top-20 matching document hashes + scores
       ↓
4. Graph expansion
   → For each result hash, get_neighbours(G, hash, depth=MAX_GRAPH_NEIGHBOURS)
   → Add neighbours with discounted score:
     neighbour_score = parent_score × edge_weight × 0.85
       ↓
5. Enrich from SQLite (summary, keywords, doc_type, path)
       ↓
6. Sort by score descending, return ranked list
       ↓
7. Frontend: overlay search scores on existing graph topology
   (no re-render of nodes/edges — only colour/glow changes)
```

### File Watching (Live Updates)

The macOS FSEvents watcher (`watcher.py`) fires on:
- **Created** → `process_file(path, workspace_id)` in daemon thread
- **Modified** → same, with 2-second debounce per path to avoid double-indexing
- **Deleted** → `remove_file(path, workspace_id)` → cascade purge if no other workspace references the hash
- **Moved** → remove old path, process new path

---

## Math & Algorithms

### Embedding Model: nomic-embed-text

- **Architecture:** BERT-style transformer (137M parameters)
- **Output:** 768-dimensional dense float vector, L2-normalized
- **Input cap:** 6,000 characters (trimmed before sending to Ollama)
- **Embedding content:** `f"{summary}\n{' '.join(keywords)}\n{raw_text[:6000]}"`
  - Leading with the AI-generated summary biases the vector toward semantics, not surface text patterns

### Cosine Similarity (Edge Formation)

For any two files with embeddings **a** and **b**:

```
cosine_similarity(a, b) = (a · b) / (‖a‖ × ‖b‖)
```

In code (`graph.py`):
```python
va = np.array(a, dtype=np.float32)
vb = np.array(b, dtype=np.float32)
return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb)))
```

An edge is added between two file nodes if and only if:
```
cosine_similarity(a, b) ≥ SIMILARITY_THRESHOLD   (default: 0.65)
```

### Entity Boost (Edge Weight Enhancement)

Raw cosine similarity is augmented by shared named entities:

```
edge_weight = cosine_similarity + (shared_entity_count × ENTITY_BOOST)
```

Where:
- `ENTITY_BOOST = 0.15` (per shared entity value)
- Entities checked: `persons`, `companies`, `projects`, `locations`
- Comparison is case-insensitive and strip-normalized

**Rationale:** Two documents about the same person/project/company should be linked even if their surface text is stylistically dissimilar (e.g., a meeting note and a contract about the same project).

### Max Neighbours Constraint

To prevent hub nodes from dominating the graph:

```python
top = sorted(candidates[hash_a], reverse=True)[:MAX_GRAPH_NEIGHBOURS]
```

Each node keeps only its top-N strongest connections (default N=5). This keeps the graph sparse and readable.

### Forced Edges for Isolated Nodes

Nodes with no edges above the similarity threshold would pile up at the graph origin in D3. Bina solves this with **forced edges**:

```python
isolated = [h for h in hashes_with_emb if G.degree(h) == 0]
for iso_hash in isolated:
    best_hash = argmax(cosine_similarity(iso, other) for other in all_hashes)
    G.add_edge(iso_hash, best_hash, weight=best_sim, forced=True)
```

Forced edges render as dashed lines in the UI to distinguish them from genuine semantic connections.

### Structural Group Assignment (Community Labels)

Instead of Louvain community detection (which requires iterative convergence and changes labels every rebuild), Bina uses **deterministic structural group assignment** based on folder name and document type:

```python
def _assign_structural_group(path, doc_type):
    folder = Path(path).parent.name.lower()
    # Folder patterns: a01, a02 → "Assignments", "lectures/" → "Lectures", etc.
    # doc_type fallback: "Lecture Notes" → "Lectures", "Assignment" → "Assignments"
    # Last resort: use folder name or doc_type verbatim
```

Benefits:
- **Deterministic** — same graph structure every rebuild; no community label flip-flopping
- **Human-readable** — labels say "Assignments", "Lectures", "Labs" not "Community 3"
- **Fast** — O(N) vs O(N log N) for Louvain
- `community_id` is the integer index into sorted unique group names

### Search Score Discounting for Graph-Expanded Nodes

When graph neighbours are added to search results, their relevance score is discounted:

```
neighbour_score = parent_score × edge_weight × 0.85
```

The 0.85 factor ensures graph-expanded nodes are always ranked below their direct-match parent, while still surfacing semantically adjacent files the user might want.

---

## AI Inference Paths

Each workspace independently chooses how its documents are analysed:

### Path A: Hosted (Default) — Free, fast, requires internet

- **Model:** `openai/gpt-oss-120b` hosted on HuggingFace Endpoints
- **API Base:** `https://vjioo4r1vyvcozuj.us-east-2.aws.endpoints.huggingface.cloud/v1`
- **Auth:** any key (server accepts `"test"`)
- **Latency:** ~2–4s per file (cold start), ~1s warm
- **Privacy:** document text is sent to HuggingFace infrastructure

### Path B: Local — 100% private, no internet required

- **Model:** `qwen3.5:2b` via Ollama
- **Features:** runs on Apple Silicon, qwen3.5 includes a thinking mode (`<think>...</think>` tags stripped by `_repair_json`)
- **Context window:** dynamically calculated: `num_ctx = max(1024, min(input_tokens + 512, 8192))`
- **Models needed:** `qwen3.5:2b` (2.7 GB) + `nomic-embed-text` (274 MB)
- **Privacy:** everything stays on-device

### Path C: User API — Your own OpenAI key

- **Model:** configurable (default `gpt-4o-mini`)
- **API Base:** configurable (default `https://api.openai.com/v1`)
- **Billing:** user's account
- **Use case:** enterprise users with existing API access

### Embedding (All Paths)

Embeddings **always** use local `nomic-embed-text` via Ollama regardless of the inference path. This ensures:
- Embedding vectors are always comparable across workspaces
- No embedding API costs on hosted or user_api paths
- The 768-dim space is consistent for cosine similarity comparisons

Fallback: if Ollama is unreachable and the workspace uses hosted/user_api, `text-embedding-3-small` via OpenAI is used.

---

## Vector Stores: Moorcheh & ChromaDB

Bina uses a **router pattern** (`vector_store_router.py`) to transparently switch between two backends.

### Moorcheh (Primary)

[Moorcheh](https://moorcheh.ai) is a hosted vector database with a Python SDK.

**Configuration:**
```bash
# In ~/.bina/.env or via Settings → Vector Search
MOORCHEH_API_KEY=your_key_here
```

**Namespace:** `bina-vault` (768 dimensions, `vector` type)

**Key behaviours:**
- Namespace auto-created on first `upsert()` call
- Auth failures cached (`_auth_failed=True`) to avoid log spam — resets when user saves a new key
- `get_embeddings_by_hashes()` returns `{}` (not supported by Moorcheh SDK) — graph building always uses the local ChromaDB cache instead
- `answer_query()` uses Moorcheh's built-in RAG `/answer` endpoint for direct natural-language answers

**Operations:**
```python
vector_store_moorcheh.upsert(file_hash, embedding, metadata)
vector_store_moorcheh.query(embedding, n_results=20, hashes=[...])
vector_store_moorcheh.delete(file_hash)
vector_store_moorcheh.clear_all()        # delete + recreate namespace
vector_store_moorcheh.ping()             # auth check
```

### ChromaDB (Fallback + Embedding Cache)

ChromaDB is always written to, even when Moorcheh is the primary store. This is because:

1. **Graph building requires raw embedding vectors** — Moorcheh doesn't support fetching stored vectors by ID, but ChromaDB does via `get_embeddings_by_hashes(hashes)`.
2. **Offline resilience** — if Moorcheh is unavailable during search, ChromaDB results are used transparently.
3. **No extra latency** — the write happens after the Moorcheh write, in the same indexing flow.

**Location:** `~/.bina/chroma/`

### Router Logic

```python
def get_store(workspace_id):
    ws = store.get_workspace(workspace_id)
    if ws.vector_backend == "moorcheh" and MOORCHEH_API_KEY and not _auth_failed:
        return vector_store_moorcheh
    return vector_store_local  # ChromaDB
```

The router respects:
1. The workspace's `vector_backend` setting (`"moorcheh"` or `"chromadb"`)
2. Whether a valid API key is set
3. Whether auth has previously failed this session

---

## Railtracks Agent

Bina uses [Railtracks](https://railtracks.ai) for the conversational "Ask Bina" feature. Railtracks is a **tool-node based agent framework** — each capability is exposed as a discrete function node the LLM can call.

### Tool Nodes

| Tool | Function | Description |
|---|---|---|
| `semantic_search` | `agent.semantic_search(query, workspace_id, top_k)` | Vector search + graph expansion |
| `answer_query` | `agent.answer_query(query, workspace_id)` | LLM synthesis from top summaries |
| `summarize_node` | `agent.summarize_node(node_id, workspace_id)` | Get stored AI summary for a specific file |
| `get_node_neighbors` | `agent.get_node_neighbors(node_id, workspace_id, depth)` | Explore related files in the graph |

### Agent System Prompt Strategy

The agent is instructed to:
1. **Factual questions** → `answer_query` first (direct LLM synthesis)
2. **"Find files about X"** → `semantic_search`
3. **"What's related to this file?"** → `get_node_neighbors`
4. **"What does this file say?"** → `summarize_node`
5. **Chain tools** when needed: search → get neighbours → summarize

### LLM Selection

The agent uses the same LLM as the workspace's inference path:
- `hosted` → `rt.llm.OpenAILLM(model="openai/gpt-oss-120b", base_url=HOSTED_API_BASE)`
- `local` → `rt.llm.OllamaLLM(LOCAL_MODEL)`
- `user_api` → `rt.llm.OpenAILLM(model=workspace.model_name, api_key=workspace.user_api_key)`

### Fallback

If Railtracks is not installed or the agent fails to build, `fallback_query()` runs the simple search-and-summarize flow without an agent loop.

### Agent Cache

One agent per workspace is cached in `_agents: dict[str, Any]`. Call `invalidate_agent(workspace_id)` after any workspace configuration change (model switch, path change).

---

## Data Model

### SQLite Schema (`~/.bina/bina.db`)

```sql
-- One row per unique file content (keyed by MD5 hash, not path)
CREATE TABLE file_records (
    hash           TEXT PRIMARY KEY,     -- MD5 hex digest of file bytes
    path           TEXT NOT NULL,         -- last known absolute path
    summary        TEXT,                  -- 3-sentence AI summary
    keywords       TEXT,                  -- JSON list[str]
    entities       TEXT,                  -- JSON {persons, companies, dates, projects, locations}
    doc_type       TEXT,                  -- Invoice | Lecture Notes | Research Paper | ...
    status         TEXT DEFAULT 'pending',-- "pending" | "done" | "failed"
    error          TEXT,                  -- error message if status="failed"
    processed_at   TEXT,                  -- ISO-8601 UTC timestamp
    embedding_model TEXT                  -- which model produced the embedding
);

-- Workspace registry
CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,     -- UUID
    name            TEXT NOT NULL,
    emoji           TEXT DEFAULT '📁',
    colour          TEXT DEFAULT '#4F46E5',
    created_at      TEXT,
    last_opened     TEXT,
    processing_path TEXT DEFAULT 'hosted', -- "hosted" | "local" | "user_api"
    model_name      TEXT,                  -- LLM model name
    embed_model     TEXT DEFAULT 'nomic-embed-text',
    user_api_key    TEXT,
    user_api_base   TEXT,
    vector_backend  TEXT DEFAULT 'moorcheh' -- "moorcheh" | "chromadb"
);

-- Folders tracked per workspace
CREATE TABLE workspace_folders (
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    folder_path  TEXT NOT NULL,
    added_at     TEXT,
    PRIMARY KEY (workspace_id, folder_path)
);

-- Many-to-many: workspace ↔ file (enables deduplication)
CREATE TABLE workspace_files (
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    file_hash    TEXT REFERENCES file_records(hash) ON DELETE CASCADE,
    added_at     TEXT,
    PRIMARY KEY (workspace_id, file_hash)
);
```

### Key Design Invariants

1. **File identity = MD5 hash, not path.** Rename a file and it's the same record. Move it and only the `path` column updates.
2. **Deduplication:** if two workspaces index the same file (identical bytes), only one `FileRecord` exists. `workspace_files` holds the memberships.
3. **FK ordering:** `add_file_to_workspace()` MUST be called AFTER `upsert_file()` for new files — the `workspace_files.file_hash → file_records.hash` FK is enforced.
4. **Three stores in sync:** SQLite, ChromaDB, and the NetworkX in-memory graph either all have a file or none do.

---

## File Map

### Backend (Python)

| File | Purpose |
|---|---|
| `config.py` | All constants, paths, model names, settings persistence to `~/.bina/settings.json` |
| `store.py` | SQLAlchemy ORM + all CRUD: `FileRecord`, `Workspace`, `WorkspaceFolder`, `WorkspaceFile` |
| `extractor.py` | Text extraction: PyMuPDF (PDF), python-docx (DOCX), plain text, CSV, Pillow (images) |
| `sampler.py` | Smart text sampling up to `CHAR_BUDGET=24,000` chars (proportional from beginning/middle/end) |
| `inference.py` | Unified LLM client: hosted GPT-OSS, local Ollama, user OpenAI key. Also `embed_text()` and `call_chat()` |
| `pipeline.py` | Core indexing flow: hash → dedup → extract → LLM → embed → SQLite → vector store → mark graph dirty |
| `graph.py` | Per-workspace NetworkX graphs: cosine similarity edges, entity boost, forced edges, structural groups |
| `search.py` | Semantic search: embed query → vector store → graph expansion → rank + enrich |
| `agent.py` | Railtracks tool nodes + agent builder + per-workspace agent cache |
| `vector_store_router.py` | Selects Moorcheh or ChromaDB based on workspace config and auth state |
| `vector_store_moorcheh.py` | Moorcheh SDK wrapper: upsert, delete, query, answer_query, ping |
| `vector_store_local.py` | ChromaDB wrapper: upsert, delete, query, `get_embeddings_by_hashes()` |
| `watcher.py` | watchdog FSEvents watcher, workspace-aware, debounced on_modified |
| `main.py` | Click CLI: `index`, `search`, `status`, `reindex`, `reset` |
| `backend/api.py` | FastAPI server: all REST endpoints, watcher management, startup lifespan |
| `backend/reset.py` | Wipes `~/.bina/` entirely for a clean slate |

### Frontend (TypeScript/React)

| File | Purpose |
|---|---|
| `frontend/electron/main.js` | Electron main: spawns Python sidecar, BrowserWindow, IPC handlers |
| `frontend/electron/preload.js` | contextBridge: exposes `window.bina` (api.get/post/patch/delete, confirm, pickFolder) |
| `frontend/src/App.tsx` | Root: polls `/global/status`, routes to `Onboarding` or `MainLayout` |
| `frontend/src/api.ts` | HTTP client: IPC bridge in Electron, direct fetch in dev browser |
| `frontend/src/types.ts` | TypeScript interfaces: `GraphNode` (id=MD5 hash), `GraphEdge`, `Workspace`, etc. |
| `frontend/src/store/appStore.ts` | Zustand: `activeWorkspaceId`, `workspaces[]`, `loadWorkspaces()` |
| `frontend/src/components/Onboarding.tsx` | 5-step setup: Welcome → Privacy → Model → Folder → Name/emoji/colour |
| `frontend/src/components/MainLayout.tsx` | Main view: graph, sidebar, inspector, search, polling |
| `frontend/src/components/GraphCanvas.tsx` | D3 v7 canvas: force simulation, pan/zoom, pointer events, community colours |
| `frontend/src/components/Inspector.tsx` | Selected node detail: summary, keywords, entities, open/reveal actions |
| `frontend/src/components/AskBinaPanel.tsx` | Chat interface: sends queries to `/query` endpoint (Railtracks agent) |
| `frontend/src/components/Sidebar.tsx` | Workspace folders, add/remove, stats, re-index button |
| `frontend/src/components/SearchBar.tsx` | Debounced search, ⌘K shortcut |
| `frontend/src/components/WorkspaceSwitcher.tsx` | Vertical emoji circles, file count badges, workspace switching |
| `frontend/src/components/WorkspaceModal.tsx` | Create/edit workspace: name, emoji picker, colour swatches, AI path selection |
| `frontend/src/components/SettingsModal.tsx` | LLM model, similarity threshold, Moorcheh key, max neighbours |
| `frontend/src/components/ModelSetupScreen.tsx` | Ollama model download UI (local path only) |

---

## API Reference

All endpoints served on `http://localhost:8765`.

### Core

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/global/status` | Total files, workspaces, vectors, dedup savings |
| `GET` | `/status?workspace_id=` | Per-workspace stats: indexed, failed, graph nodes/edges |
| `GET` | `/progress` | Current indexing progress (running, total, current, ok, failed) |
| `GET` | `/graph?workspace_id=` | Full workspace graph (nodes + edges) |
| `GET` | `/graph/groups?workspace_id=` | Collapsed group-level graph for overview zoom |
| `POST` | `/search` | Semantic search: `{query, workspace_id, limit}` |
| `POST` | `/query` | Agent/search query: `{query, workspace_id, mode: "agent"|"search"}` |
| `GET` | `/files` | List all indexed file records |

### Workspaces

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/workspaces` | List all workspaces |
| `POST` | `/workspaces` | Create workspace with AI config |
| `PATCH` | `/workspaces/:id` | Update name/emoji/colour |
| `DELETE` | `/workspaces/:id` | Delete workspace + cascade purge orphaned files |
| `GET` | `/workspaces/:id/folders` | List folders in workspace |
| `POST` | `/workspaces/:id/folders` | Add folder, start watcher, begin indexing |
| `DELETE` | `/workspaces/:id/folders` | Remove folder, stop watcher, purge files |
| `GET` | `/workspaces/:id/model` | Get workspace AI config (path, model, vector backend) |
| `PATCH` | `/workspaces/:id/model` | Update workspace AI config |

### Settings & Maintenance

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/settings` | Get current global settings (threshold, neighbours, model) |
| `POST` | `/settings` | Update global settings, invalidate all graphs |
| `GET` | `/settings/app` | Moorcheh API key status + connectivity |
| `POST` | `/settings/app` | Save Moorcheh API key to `~/.bina/.env` |
| `DELETE` | `/index/clear` | Wipe all indexed data (SQLite + vector store) |

### Models (Ollama, local path only)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/models/status` | Check which required Ollama models are installed |
| `POST` | `/models/pull/:model` | Start background pull of a model |
| `GET` | `/models/pull-progress/:model` | Stream pull progress |

---

## How to Run

### Prerequisites

- macOS 12+
- Python 3.11+
- Node.js 18+
- [Ollama](https://ollama.ai) (required for local path; auto-started by backend)
- A [Moorcheh](https://console.moorcheh.ai) API key (free tier available) OR set `vector_backend = "chromadb"` to stay fully offline

### Development (recommended)

This runs Electron + Vite + Python sidecar all at once:

```bash
# 1. Clone the repo
git clone <repo-url>
cd Bina2

# 2. Set up Python environment
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. (Optional) Add your Moorcheh key — skip to use local ChromaDB only
mkdir -p ~/.bina
echo "MOORCHEH_API_KEY=your_key_here" >> ~/.bina/.env

# 4. (Optional) Pull Ollama models for local AI path
ollama pull qwen3.5:2b
ollama pull nomic-embed-text

# 5. Install frontend dependencies
cd frontend
npm install
cd ..

# 6. Launch (Electron spawns Python sidecar automatically)
cd frontend
npm run dev
```

The app opens in an Electron window. On first launch, the 5-step onboarding guides you through model selection and folder setup.

### Backend Only (headless / CLI)

```bash
source .venv/bin/activate

# Start the API server
python backend/api.py

# OR use the CLI
python main.py index ~/Documents/MyProject
python main.py search "machine learning papers"
python main.py status
```

### Environment Variables

| Variable | Location | Description |
|---|---|---|
| `MOORCHEH_API_KEY` | `~/.bina/.env` or `.env` | Moorcheh vector store API key |

**Priority order for `.env` loading:**
1. Process environment variables (highest priority)
2. Project-level `.env` (next to `config.py`)
3. `~/.bina/.env` (per-user override, written by Settings UI)

### Reset Everything

```bash
# Nuclear option — wipes ~/.bina/ entirely
source .venv/bin/activate
python backend/reset.py
```

---

## Configuration

### Runtime Settings (`~/.bina/settings.json`)

Editable via the Settings gear icon in the app, or directly:

```json
{
  "model": "qwen3.5:2b",
  "similarity_threshold": 0.65,
  "max_graph_neighbours": 5
}
```

| Setting | Default | Description |
|---|---|---|
| `model` | `qwen3.5:2b` | Local Ollama model for the local AI path |
| `similarity_threshold` | `0.65` | Minimum cosine similarity to form a graph edge (0.0–1.0) |
| `max_graph_neighbours` | `5` | Maximum edges per node (caps hub formation) |

Settings hot-reload into all module-level config vars without a restart. All workspace graphs are invalidated when settings change.

### Workspace-Level Config

Each workspace independently sets:

| Field | Options | Description |
|---|---|---|
| `processing_path` | `hosted` \| `local` \| `user_api` | Which LLM to use for document analysis |
| `model_name` | e.g. `gpt-4o-mini`, `qwen3.5:2b` | Model name (for local and user_api paths) |
| `user_api_key` | your key | OpenAI API key (user_api path only) |
| `user_api_base` | URL | Custom OpenAI-compatible base URL |
| `vector_backend` | `moorcheh` \| `chromadb` | Where to store and query vectors |

---

## Building for Distribution

Bina ships as a `.dmg` for macOS (Apple Silicon). The Python sidecar is compiled to a single binary using PyInstaller.

### Build the Python binary

```bash
source .venv/bin/activate
pyinstaller bina_api.spec
# Output: frontend/resources/bina-api/bina-api
```

### Build the Electron app

```bash
cd frontend
npm run build          # Vite build
npx electron-builder   # packages into dist/Bina-0.1.0-arm64.dmg
```

The `.dmg` embeds:
- The compiled Vite React app
- The Electron shell
- The `bina-api` PyInstaller binary (in `resources/`)

Electron main (`main.js`) spawns `resources/bina-api/bina-api` as a child process on startup.

---

## Design Decisions & Innovations

### 1. MD5 Hash as Primary Key (not path)

Files are identified by their content hash, not their filesystem path. This means:
- Renaming a file doesn't trigger re-indexing (free)
- Two workspaces sharing a folder don't double-store the AI analysis
- Moving files only updates the `path` column, not the vector or summary
- True deduplication: identical files in different folders count once

### 2. Dual Vector Store Write

ChromaDB is always written to even when Moorcheh is the primary store. This solves a fundamental problem: Moorcheh doesn't expose raw embedding vectors by ID, but `graph.py` needs them to compute cosine similarity for edge building. Without the ChromaDB cache, the graph would have to re-embed every file on every rebuild — catastrophically slow for large vaults.

### 3. Deterministic Structural Groups vs. Louvain

Standard knowledge graph tools use Louvain community detection, which:
- Changes community IDs on every rebuild (causes UI flicker)
- Requires a full connected graph to converge
- Produces numeric IDs with no human meaning

Bina's `_assign_structural_group()` instead uses folder names and doc_type strings to produce stable, human-readable labels ("Lectures", "Assignments", "Exams"). This is faster, stable, and far more useful in practice for the university/work document use case.

### 4. JSON Repair Pipeline

Local LLMs (especially qwen3.5 in thinking mode) frequently return malformed JSON. Bina's `_repair_json()` handles:
- `<think>...</think>` blocks (qwen3.5's reasoning traces)
- Markdown code fences (````json ... ````
- Trailing commas before `}` or `]`
- Python literals (`None`, `True`, `False`) vs JSON (`null`, `true`, `false`)
- Comments (`// ...`)
- Multi-stage fallback: direct parse → regex extract → give up

### 5. Embedding Content Strategy

Instead of embedding raw document text, Bina embeds a composite string:
```
f"{ai_summary}\n{' '.join(keywords)}\n{raw_text[:6000]}"
```

Prepending the AI-generated summary concentrates the vector representation on *semantic meaning* rather than surface text patterns. A lecture about "gradient descent" and a problem set asking "minimize the cost function" end up close in vector space even if they share few exact words.

### 6. Graph Topology vs. Search Score Separation

The frontend maintains two separate data states:
- **Graph topology** (nodes, edges, positions) — rebuilt only when node IDs actually change
- **Search score overlay** (node glow, colour intensity) — patched in-place without a D3 restart

This eliminates graph flickering during search — a common problem with naive force graph implementations that re-render everything on every query.

### 7. Railtracks Tool-Node Architecture

Instead of a prompt-stuffed monolithic agent, Bina exposes discrete, typed function nodes to the Railtracks framework. Each tool has a clear signature and single responsibility. The LLM decides which tool to call and in what order. This means:
- Tool logic is testable in isolation
- New capabilities can be added as new tool nodes without touching the agent prompt
- The same tools are callable directly from Python code (not just via the agent)

### 8. Startup Crash Recovery

On every startup, `_resume_unfinished()` scans all watched folders and re-processes any file that doesn't have `status='done'` in SQLite. Files that were mid-processing when the app was killed (power outage, force-quit) are automatically recovered. Already-indexed files return immediately (MD5 check + DB lookup, no LLM call).

---

## Known Limitations

| Issue | Status |
|---|---|
| Scanned PDFs (image-only, no text layer) | Not supported — needs OCR integration |
| Moorcheh `get_embeddings_by_hashes()` unsupported | Worked around via ChromaDB dual-write cache |
| Apple Silicon only for `.dmg` distribution | `electron-builder` target is `arm64`; `x64` build possible but untested |
| Ollama must be running for local/embedding path | App shows setup screen if Ollama is unreachable |
| Large vaults (>10,000 files) graph performance | D3 canvas degrades past ~2,000 nodes; subgraph zoom planned |

---

## Project History

| Phase | Description |
|---|---|
| Phase 0 | Python CLI: validated full AI pipeline (Ollama + ChromaDB + watchdog), 37 test files, 155 graph edges |
| Phase 1 | Electron desktop app: FastAPI sidecar, React UI, Onboarding, GraphCanvas, Inspector, Sidebar |
| Phase 2 | Graph UI overhaul: D3 v7 canvas rewrite, fixed node pile-up, fixed flickering, Obsidian dark aesthetic |
| Phase 3 | macOS polish + settings: Inspector bugfix, SettingsModal, settings persistence, re-index button, surgical graph deletion |
| Phase 4 | v3 architecture: 3 inference paths (hosted/local/user_api), Moorcheh integration, Railtracks agent, multi-workspace model config, image support |

---

*Bina is built to be fast, private, and genuinely useful. If you're drowning in files, it sees clearly so you don't have to.*
