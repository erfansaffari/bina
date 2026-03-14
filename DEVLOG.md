# Bina — Development Log

> Everything we built, every bug we hit, every fix we applied, and everything still left to do.

---

## Table of Contents

1. [What Is Bina](#1-what-is-bina)
2. [Full Architecture](#2-full-architecture)
3. [Phase 0 — Python CLI](#3-phase-0--python-cli)
4. [Phase 1 — Electron Desktop App](#4-phase-1--electron-desktop-app)
5. [Phase 2 — Graph UI Overhaul](#5-phase-2--graph-ui-overhaul)
6. [All Bugs & Fixes](#6-all-bugs--fixes)
7. [Known Remaining Problems](#7-known-remaining-problems)
8. [Next Steps (Phase 3+)](#8-next-steps-phase-3)
9. [Config Reference](#9-config-reference)
10. [Running the Project](#10-running-the-project)

---

## 1. What Is Bina

Bina is a **100% local** AI semantic file manager for macOS.

- You point it at a folder.
- It reads every `.pdf`, `.docx`, `.txt`, and `.md` file.
- It uses a local LLM (`llama3.2:3b` via Ollama) to extract a summary, keywords, entities, and document type.
- It creates a 768-dimensional vector embedding (`nomic-embed-text`) for each file and stores it in ChromaDB.
- It builds a knowledge graph (NetworkX) where edges are drawn between files that are semantically similar or share named entities.
- You search in plain English. The query is embedded, matched against the vector store, expanded through the graph, and results are shown as an interactive Obsidian-style graph.

**Nothing leaves your machine. All AI runs locally through Ollama.**

---

## 2. Full Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Electron Shell                         │
│  frontend/electron/main.js  ←→  preload.js              │
│         ↕ IPC (contextBridge)                           │
│  React UI (Vite + Tailwind + TypeScript)                 │
│    App.tsx → Onboarding / MainLayout                     │
│      ├── SearchBar.tsx    (⌘K, debounce)                │
│      ├── GraphCanvas.tsx  (react-force-graph-2d)         │
│      ├── Inspector.tsx    (node detail panel)            │
│      └── Sidebar.tsx      (stats, progress)              │
│         ↕ HTTP fetch (api:get / api:post via IPC)        │
└──────────────┬──────────────────────────────────────────┘
               │  http://127.0.0.1:8765
┌──────────────▼──────────────────────────────────────────┐
│              FastAPI Sidecar  (backend/api.py)           │
│  /status  /index  /progress  /search                     │
│  /graph   /watch  /file  /files                          │
│         ↕ Python imports                                 │
│  pipeline.py  store.py  vector_store.py                  │
│  graph.py     search.py  watcher.py  extractor.py        │
└──────────────┬────────────────┬────────────────────────-┘
               │                │
    ┌──────────▼───┐   ┌────────▼──────────┐
    │  SQLite DB    │   │   ChromaDB         │
    │  ~/.bina/     │   │   ~/.bina/chroma/  │
    │  bina.db      │   │   768-dim vectors  │
    └──────────────┘   └───────────────────┘
               │
    ┌──────────▼────────────────────────────┐
    │  Ollama  (http://localhost:11434)      │
    │    LLM:   llama3.2:3b  (~2 GB RAM)    │
    │    Embed: nomic-embed-text (~270 MB)  │
    └───────────────────────────────────────┘
```

### Data flow for a single file

```
file.pdf
  → extractor.py      (PyMuPDF → list[str] pages + page count)
  → sampler.py        (smart sampling, picks representative slices → 24 000 chars max)
  → pipeline._call_llm()   (first 4 000 chars sent to llama3.2:3b → JSON: summary, keywords, entities, doc_type)
  → pipeline._call_embed() (summary + keywords + first 6 000 chars → nomic-embed-text → 768-dim vector)
  → store.upsert_file()    (SQLite: path, hash, summary, keywords, entities, doc_type, status, error)
  → vector_store.upsert()  (ChromaDB: path as ID, 768-dim embedding, metadata)
```

### Data flow for a search query

```
"lecture about unicode"
  → nomic-embed-text → 768-dim query vector
  → ChromaDB.query()  → top N closest documents (cosine similarity)
  → graph.subgraph_for_paths()  → expand 1 hop through NetworkX graph
  → return nodes (with scores) + edges (with weights)
  → React: scores overlaid on full graph as highlight/dim layer
```

---

## 3. Phase 0 — Python CLI

**Goal:** Validate that Ollama + ChromaDB + watchdog produces accurate semantic search before any UI work.

### Files built

| File | Purpose |
|---|---|
| `config.py` | All constants (paths, model names, budgets, thresholds) |
| `extractor.py` | Text extraction from PDF (PyMuPDF), DOCX (python-docx), TXT/MD |
| `sampler.py` | Smart text sampling — picks first + last + middle slices up to `CHAR_BUDGET` |
| `store.py` | SQLAlchemy model + CRUD for SQLite (`FileRecord` table) |
| `vector_store.py` | ChromaDB wrapper: `upsert`, `delete`, `query`, `count`, `get_all_embeddings` |
| `pipeline.py` | Core AI pipeline: hash → extract → sample → LLM → embed → persist |
| `graph.py` | NetworkX graph: nodes = files, edges = cosine similarity ≥ 0.72 or shared entities |
| `search.py` | Embed query → ChromaDB → expand via graph → pretty-print results |
| `watcher.py` | `watchdog` FSEvents watcher: new/modified/deleted files → pipeline |
| `main.py` | `click` CLI: `index`, `search`, `status`, `reindex` commands |

### CLI commands

```bash
# Activate venv first
source .venv/bin/activate

# Index a folder
python main.py index ~/Documents/cs135new

# Search
python main.py search "unicode and racket programming"

# Check status
python main.py status

# Re-index everything (force=True, skips hash-based dedup)
python main.py reindex ~/Documents/cs135new
```

### Outcome

- **37 files indexed** from a real university folder (lecture notes, assignments, README, etc.)
- **5 files failed** — image-only scanned PDFs with no extractable text (needs OCR — deferred)
- **768-dimensional vectors** from `nomic-embed-text`
- **155 graph edges** built from cosine similarity + shared entity overlap

---

## 4. Phase 1 — Electron Desktop App

**Goal:** Wrap the Python backend in a native macOS desktop app with a graph UI.

### Files built

| File | Purpose |
|---|---|
| `backend/api.py` | FastAPI sidecar on port 8765 |
| `frontend/electron/main.js` | Electron main process: spawns Python, creates BrowserWindow, IPC handlers |
| `frontend/electron/preload.js` | contextBridge: exposes `window.bina` API to renderer safely |
| `frontend/src/App.tsx` | Root component: routes between `Onboarding` and `MainLayout` |
| `frontend/src/api.ts` | HTTP client — uses IPC when in Electron, fetch otherwise |
| `frontend/src/types.ts` | TypeScript interfaces: `GraphNode`, `GraphEdge`, `SearchResult`, `StatusData`, etc. |
| `frontend/src/components/Onboarding.tsx` | 4-step flow: Welcome → Privacy → Model info → Folder picker |
| `frontend/src/components/MainLayout.tsx` | Main layout: Sidebar + Graph + Inspector |
| `frontend/src/components/SearchBar.tsx` | Debounced search input, ⌘K shortcut |
| `frontend/src/components/GraphCanvas.tsx` | `react-force-graph-2d` canvas with Obsidian-style rendering |
| `frontend/src/components/Inspector.tsx` | Selected node detail panel |
| `frontend/src/components/Sidebar.tsx` | Index stats, progress bar, privacy badge |
| `frontend/src/index.css` | Tailwind imports + drag region + scrollbar styles |
| `frontend/tailwind.config.js` | Custom `bina` colour palette, SF Pro fonts |

### Backend API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/status` | Index stats, watched folder, graph size |
| POST | `/index` | Start background indexing of a folder |
| GET | `/progress` | Polling: current indexing progress |
| POST | `/search` | Semantic search, returns scored nodes + edges |
| GET | `/graph` | Full graph as nodes + edges (initial load) |
| POST | `/watch` | Start FSEvents file watcher on a folder |
| DELETE | `/watch` | Stop the watcher |
| DELETE | `/file` | Remove one file from all stores |
| GET | `/files` | List all indexed files |

### How Electron talks to Python

```
Renderer (React)
  → window.bina.get('/search')   [preload.js contextBridge]
  → ipcRenderer.invoke('api:get', '/search')
  → ipcMain.handle('api:get')    [main.js]
  → fetch('http://127.0.0.1:8765/search')
  → FastAPI Python process
```

---

## 5. Phase 2 — Graph UI Overhaul

**Goal:** Make the graph look and behave like Obsidian's graph view, fix flickering.

### What was wrong

1. **Nodes piled into a ball** — d3's default charge strength is only `-30`, completely insufficient for 37 nodes. No custom forces were ever applied.
2. **Constant flickering / restarting** — Every 1.5s progress poll caused a React re-render → `useMemo` created a new `graphData` object → `react-force-graph-2d` sees a new object reference → **restarts the d3 simulation from scratch** → every node jumps to a random position.
3. **All 37 labels visible simultaneously** — completely unreadable.
4. **Nodes too large** — degree scaling went up to 10px, making "Assignment" nodes the size of planets.

### What was fixed

#### Fix 1: Stable graph data (no more flickering)

The key insight: the full graph topology never changes during normal use. Only the score overlay changes when searching.

- `MainLayout.tsx` now keeps `fullNodes` / `fullEdges` as permanent state.
- On search, only a `Map<id, score>` (`searchScores`) is updated — the topology is never swapped.
- `GraphCanvas.tsx` uses a `useRef` + `useEffect` pattern: it only calls `setGraphData()` (which triggers ForceGraph to reinitialize) when node IDs or edge count actually change. All other updates patch node properties **in-place** without touching the simulation.

#### Fix 2: Proper d3 force configuration

```typescript
useEffect(() => {
  if (!fgRef.current || graphData.nodes.length === 0) return
  const fg = fgRef.current
  const chargeStr = Math.max(-600, -150 - nodeCount * 8)  // ≈ -450 for 37 nodes
  fg.d3Force('charge')?.strength(chargeStr)   // strong repulsion
  fg.d3Force('link')?.distance(60).strength(0.4)  // target edge length
  fg.d3Force('center')?.strength(0.08)        // weak gravity
  fg.d3ReheatSimulation()
}, [graphData])
```

#### Fix 3: Labels only where needed

Labels now appear **only** for:
- The hovered node
- The selected node
- Top 3 search score matches (when zoom ≥ 0.6×)

Never for all nodes at once.

#### Fix 4: Obsidian-style rendering

- Background: `#0c0c0f` (near-black)
- Node size: `3 + sqrt(degree) × 0.5` → caps at ~8px (was going to 10px+)
- Glow halo: only for selected / hovered / top search match
- Dimming: search active → non-matching nodes fade to 10% alpha
- Hover: non-neighbours fade to 20% alpha, connected edges highlight to white
- Edges: default 8-12% white opacity, thickens on hover/match
- Colour legend: floating collapsible panel showing all doc types present in graph

---

## 6. All Bugs & Fixes

### Bug 1 — Ollama `sudo` install failure

**Symptom:** `curl | sh` installer failed because `sudo` requires a TTY: `sudo: a terminal is required to read the password`.

**Fix:** Manually symlinked the Ollama binary:
```bash
ln -s /Applications/Ollama.app/Contents/Resources/ollama ~/.local/bin/ollama
```
Added `~/.local/bin` to PATH in `.zshrc`.

---

### Bug 2 — LLM returning malformed JSON

**Symptom:** `llama3.2:3b` sometimes returned JSON with trailing commas, `//` comments, Python literals (`None`, `True`, `False`), or markdown code fences around the JSON.

**Fix:** Added `_repair_json()` in `pipeline.py`:
```python
def _repair_json(text: str) -> str:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r",\s*([}\]])", r"\1", text)
    text = re.sub(r"\bNone\b", "null", text)
    text = re.sub(r"\bTrue\b", "true", text)
    text = re.sub(r"\bFalse\b", "false", text)
    return text
```
Also added a regex fallback: `re.search(r"\{.*\}", text, re.DOTALL)` to extract the JSON object even if there's surrounding text.

---

### Bug 3 — LLM hanging on long documents

**Symptom:** `llama3.2:3b` would hang indefinitely when given the full 24 000-char sampled text. Empty JSON fields were also common.

**Root cause:** The 3B model is overwhelmed by long context. The `format="json"` Ollama option also caused hangs on some documents (constrained grammar sampling is slow).

**Fix:**
- Introduced `LLM_CHAR_BUDGET = 4_000` in `config.py` — LLM only sees first 4 000 chars.
- Removed `format="json"` entirely, using `_repair_json` post-processing instead.
- Dynamically calculate `num_ctx = max(1024, min(input_tokens + 512, 4096))` to keep KV-cache small.

---

### Bug 4 — Embedding model hanging on long text

**Symptom:** `nomic-embed-text` would stall on inputs longer than ~8 000 tokens.

**Fix:** Cap embedding input to 6 000 chars:
```python
embed_text = f"{summary}\n{' '.join(keywords)}\n{sampled_text[:6000]}"
```

---

### Bug 5 — High RAM usage during indexing

**Symptom:** RAM usage would spike to 6–8 GB during indexing. Both `llama3.2:3b` (~2 GB) and `nomic-embed-text` (~270 MB) would stay loaded in Ollama for 5 minutes after use.

**Fixes:**
1. Dynamic `num_ctx` (see Bug 3) — trims KV-cache allocation by 30–40%.
2. Added `unload_models()` — called after `index` and `reindex` in `main.py` and after `_run_indexing()` in `api.py`:
```python
def unload_models() -> None:
    ollama.chat(model=LLM_MODEL, messages=[], keep_alive=0)
    ollama.embeddings(model=EMBED_MODEL, prompt="", keep_alive=0)
```

---

### Bug 6 — Electron `require is not defined` error

**Symptom:** Adding `"type": "module"` to `frontend/package.json` made Electron's `main.js` and `preload.js` crash because they use CommonJS `require()`.

**Fix:** Reverted `"type": "module"`. Changed `tailwind.config.js` and `postcss.config.js` to use `module.exports =` syntax instead of `export default`.

---

### Bug 7 — Graph nodes piling into a ball (no force config)

**Symptom:** All nodes clumped in the center. d3's default charge is `-30` — way too weak for 37 nodes.

**Fix:** Applied forces via `fgRef.current.d3Force(...)` after topology changes (see Phase 2 section).

---

### Bug 8 — Graph flickering every 1.5 seconds

**Symptom:** The graph would reset positions every 1.5 seconds, matching the progress poll interval.

**Root cause:** `useMemo([nodes, edges])` created a new `graphData` object reference every time `MainLayout` re-rendered (even with same data), causing `react-force-graph-2d` to restart its simulation.

**Fix:** Separated graph topology from search scores. Topology only updates when IDs change, using ref-based in-place patching for property updates.

---

### Bug 9 — All 37 labels visible and overlapping

**Symptom:** Every node showed its filename label, making the graph an unreadable mess.

**Fix:** Labels only render for: selected node, hovered node, top-3 search matches.

---

### Bug 10 — Scanned PDFs silently failing

**Symptom:** 5 files from the test folder were image-only scanned PDFs. `PyMuPDF` returned 0 text pages. These were stored with `status="failed"` and error `"No text could be extracted from this file."`.

**Current state:** No fix yet. File shows as grey in the graph. **This is a known deferred issue.**

---

## 7. Known Remaining Problems

### P1 — OCR for scanned PDFs ⚠️ (Deferred — user confirmed)

Files that are pure image scans (no selectable text) return `"No text could be extracted"`. These need OCR.

**Solution path:**
- Add `pytesseract` + `pdf2image` as optional dependencies.
- In `extractor.py`: if `PyMuPDF` returns 0 pages of text, fall back to `pdf2image` + `pytesseract`.
- Requires `tesseract` to be installed on the system (`brew install tesseract`).

---

### P2 — Graph still rebuilds from scratch after indexing

After indexing completes, `api.py` sets `_graph_dirty = True`, `MainLayout` calls `loadFullGraph()` which replaces `fullNodes`/`fullEdges`, which triggers the topology-change path in `GraphCanvas` and restarts the simulation.

**Impact:** One-time restart after indexing — not a recurring flicker. Acceptable for now.

---

### P3 — No collision force between nodes

Nodes can visually overlap each other even after spreading out. d3 doesn't prevent overlap by default.

**Fix:** Add a `collide` force via:
```typescript
import * as d3 from 'd3-force'
fg.d3Force('collide', d3.forceCollide().radius(12))
```
This requires importing `d3-force` separately, which is already a transitive dep of `react-force-graph-2d`.

---

### P4 — No settings / preferences pane

There is no UI to change the watched folder, model selection, similarity threshold, or clear the index.

---

### P5 — No menu bar indicator

No macOS menu bar item to show indexing status or open the app when it's running in the background.

---

### P6 — FastAPI port hardcoded to 8765

If another process occupies port 8765, the sidecar silently fails. The Electron window shows an empty state with no useful error message.

**Fix:** Port-scan for a free port at startup, pass it to the React app via `window.__BINA_PORT__`.

---

### P7 — `graph.build_graph()` rebuilds the entire graph every time it's called

`_get_graph()` in `api.py` rebuilds the full NetworkX graph whenever `_graph_dirty = True`. For 37 files this is fast (~50ms), but at 500+ files it will become noticeable.

**Fix:** Incremental graph updates — add/remove only the changed node and its edges on file events.

---

### P8 — No authentication / CORS hardening on the API

`api.py` has `allow_origins=["*"]`. Any local process can call the API. Fine for personal use, not for production.

---

### P9 — `llama3.2:3b` is 3B parameters — mediocre quality

Summary and entity extraction quality is acceptable for lecture notes but weak for complex legal/technical documents. Empty summaries still appear occasionally.

**Fix path:** Allow model selection in settings (e.g. `llama3.1:8b` for better quality, `phi3:mini` for lower RAM).

---

### P10 — `graph.py` MAX_GRAPH_NEIGHBOURS = 1

Each node only connects to its 1 nearest graph neighbour beyond the similarity threshold. This creates a sparse graph.

**Fix:** Increase `MAX_GRAPH_NEIGHBOURS` to 3–5 for richer connections.

---

## 8. Next Steps (Phase 3+)

### Phase 3 — macOS Polish

- [ ] Menu bar item with indexing indicator (NSStatusItem via Electron `Tray`)
- [ ] Settings pane: watched folder, model selector, similarity threshold slider, "Clear index" button
- [ ] Smooth CSS transitions on Inspector open/close
- [ ] Node collision force so nodes never visually overlap
- [ ] "Re-index" button in Sidebar

### Phase 4 — OCR + More File Types

- [ ] OCR fallback for scanned PDFs (`pytesseract` + `pdf2image`)
- [ ] Support `.pptx` (python-pptx)
- [ ] Support `.xlsx` (openpyxl — extract cell text)
- [ ] Support `.html`, `.epub`

### Phase 5 — Performance & Scale

- [ ] Incremental graph updates (don't rebuild full graph on every file change)
- [ ] Background embedding worker (process files in a queue, not sequentially)
- [ ] Batch embedding calls (embed multiple files in one Ollama call)
- [ ] Cache `build_graph()` to disk (pickle) so app restarts don't re-build from scratch

### Phase 6 — Smarter Search

- [ ] Hybrid search: vector similarity + keyword BM25 (combine scores with RRF)
- [ ] Ask mode: send top-K document excerpts to LLM and synthesise a natural language answer
- [ ] Date-range filtering
- [ ] Filter by doc_type in graph view

---

## 9. Config Reference

```python
# config.py

BINA_HOME = Path.home() / ".bina"          # ~/.bina/ — all runtime data
DB_PATH   = BINA_HOME / "bina.db"          # SQLite database
CHROMA_PATH = BINA_HOME / "chroma"         # ChromaDB vector store

LLM_MODEL   = "llama3.2:3b"               # Ollama model for summarisation
EMBED_MODEL = "nomic-embed-text"           # Ollama model for embeddings (768-dim)

SIMILARITY_THRESHOLD = 0.72               # Min cosine similarity for graph edge
ENTITY_BOOST         = 0.15               # Score bonus for shared named entities
MAX_GRAPH_NEIGHBOURS = 1                  # Max extra edges per node from graph expansion

SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}

CHAR_BUDGET     = 24_000   # Max chars fed to the embedding model
LLM_CHAR_BUDGET = 4_000    # Max chars fed to the LLM (3B model works best under this)
```

---

## 10. Running the Project

### Prerequisites

```bash
# Python 3.11+
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Node 20+
cd frontend
npm install

# Ollama (running in background)
ollama serve &
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

### Development mode

```bash
# Terminal 1: Start Electron + Vite dev server
cd frontend
npm run dev

# Electron auto-spawns the Python sidecar from .venv/bin/python3
# React dev server: http://localhost:5173
# FastAPI:          http://localhost:8765
```

### CLI only (no UI)

```bash
source .venv/bin/activate

python main.py index ~/path/to/folder
python main.py search "your query here"
python main.py status
python main.py reindex ~/path/to/folder
```

### Data storage locations

```
~/.bina/
  bina.db          ← SQLite: file records, summaries, keywords, entities
  chroma/          ← ChromaDB: 768-dim vectors
  watched_folder.txt  ← Path of the currently watched folder
```

To fully reset everything:
```bash
rm -rf ~/.bina
```
