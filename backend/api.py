"""
Bina FastAPI sidecar.

Spawned by Electron as a child process. Exposes a REST API on
http://localhost:8765 that the React renderer calls over HTTP.

Endpoints
---------
GET  /status            → index stats + watched folder
POST /index             → start background indexing of a folder
GET  /progress          → polling: current indexing progress
POST /search            → semantic search, returns graph nodes + edges
GET  /graph             → full graph as nodes + edges (for initial load)
POST /watch             → set watched folder + start FSEvents watcher
DELETE /watch           → stop FSEvents watcher
DELETE /file            → remove one file from index
"""
from __future__ import annotations

import sys
import os

# Allow imports from the project root (Phase 0 modules)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import store
import vector_store
import pipeline as _pipeline
from config import SUPPORTED_EXTENSIONS
from graph import build_graph, subgraph_for_paths, get_graph, mark_dirty
from search import search as _search
from watcher import FolderWatcher


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Remove index records for files that no longer exist on disk.

    Runs once at sidecar startup so stale entries from previously-watched
    folders (or files deleted while the app was closed) are cleaned up
    automatically — no manual intervention required.
    """
    removed = 0
    for rec in store.get_all_files():
        if not Path(rec.path).exists():
            store.delete_file(rec.path)
            vector_store.delete(rec.path)
            removed += 1
    if removed:
        mark_dirty()
        print(f"[startup] Purged {removed} orphaned record(s) for missing files.", flush=True)
    yield  # app runs here


app = FastAPI(title="Bina API", version="0.1.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------

_progress: dict[str, Any] = {
    "running": False,
    "total": 0,
    "current": 0,
    "current_file": "",
    "done": True,
    "ok": 0,
    "failed": 0,
}
_progress_lock = threading.Lock()

_watcher: FolderWatcher | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _collect_files(folder: Path) -> list[Path]:
    return [
        p for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
    ]


def _node_from_record(rec, score: float = 0.0, from_graph: bool = False) -> dict:
    return {
        "id": rec.path,
        "label": Path(rec.path).name,
        "summary": rec.summary or "",
        "keywords": store.parse_keywords(rec),
        "entities": store.parse_entities(rec),
        "doc_type": rec.doc_type or "Other",
        "status": rec.status,
        "score": score,
        "from_graph": from_graph,
    }




def _graph_to_json(G) -> dict:
    nodes = []
    edges = []
    for path in G.nodes:
        rec = store.get_file(path)
        if rec:
            nodes.append(_node_from_record(rec))
    for u, v, data in G.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": round(data.get("weight", 0.0), 4),
        })
    return {"nodes": nodes, "edges": edges}


def _run_indexing(folder: Path) -> None:
    files = _collect_files(folder)

    with _progress_lock:
        _progress.update(running=True, total=len(files), current=0,
                         current_file="", done=False, ok=0, failed=0)

    for i, f in enumerate(files):
        with _progress_lock:
            _progress["current"] = i
            _progress["current_file"] = f.name

        result = _pipeline.process_file(f)
        with _progress_lock:
            if result.get("status") == "ok":
                _progress["ok"] += 1
            else:
                _progress["failed"] += 1

    _pipeline.unload_models()
    mark_dirty()

    with _progress_lock:
        _progress.update(running=False, current=len(files), done=True)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class IndexRequest(BaseModel):
    folder: str

class SearchRequest(BaseModel):
    query: str
    n_results: int = 20

class WatchRequest(BaseModel):
    folder: str

class DeleteFileRequest(BaseModel):
    path: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/status")
def status():
    from config import WATCHED_FOLDER_FILE
    watched = None
    if WATCHED_FOLDER_FILE.exists():
        p = Path(WATCHED_FOLDER_FILE.read_text().strip())
        if p.is_dir():
            watched = str(p)

    G = get_graph()
    return {
        "indexed": store.get_ok_count(),
        "failed": store.get_file_count() - store.get_ok_count(),
        "vectors": vector_store.count(),
        "watched_folder": watched,
        "graph_nodes": G.number_of_nodes(),
        "graph_edges": G.number_of_edges(),
    }


@app.post("/index")
def start_index(req: IndexRequest, background_tasks: BackgroundTasks):
    folder = Path(req.folder)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {req.folder}")

    from config import WATCHED_FOLDER_FILE
    WATCHED_FOLDER_FILE.write_text(str(folder))

    if _progress.get("running"):
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    background_tasks.add_task(_run_indexing, folder)
    return {"status": "started", "folder": str(folder)}


@app.get("/progress")
def progress():
    with _progress_lock:
        return dict(_progress)


@app.post("/search")
def search(req: SearchRequest):
    if vector_store.count() == 0:
        return {"nodes": [], "edges": [], "query": req.query, "ms": 0}

    import time
    t = time.time()

    G = get_graph()
    results = _search(req.query, G, n_results=req.n_results)

    # Build subgraph centred on search results
    seed_paths = [r["path"] for r in results]
    sub = subgraph_for_paths(G, seed_paths, expand_depth=1)

    nodes = []
    score_map = {r["path"]: r["score"] for r in results}

    for path in sub.nodes:
        rec = store.get_file(path)
        if rec:
            score = score_map.get(path, 0.0)
            from_graph = path not in score_map
            nodes.append(_node_from_record(rec, score=score, from_graph=from_graph))

    edges = []
    for u, v, data in sub.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": round(data.get("weight", 0.0), 4),
        })

    ms = int((time.time() - t) * 1000)
    return {"nodes": nodes, "edges": edges, "query": req.query, "ms": ms}


@app.get("/graph")
def full_graph():
    G = get_graph()
    return _graph_to_json(G)


@app.post("/watch")
def start_watch(req: WatchRequest):
    global _watcher
    folder = Path(req.folder)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    if _watcher and _watcher.is_alive():
        _watcher.stop()

    def _on_file(result: dict):
        mark_dirty()

    _watcher = FolderWatcher(folder, on_processed=_on_file)
    _watcher.start()
    return {"status": "watching", "folder": str(folder)}


@app.delete("/watch")
def stop_watch():
    global _watcher
    if _watcher:
        _watcher.stop()
        _watcher = None
    return {"status": "stopped"}


@app.delete("/file")
def delete_file(req: DeleteFileRequest):
    path = str(Path(req.path).resolve())
    removed = store.delete_file(path)
    vector_store.delete(path)
    mark_dirty()   # force graph rebuild from updated stores on next request
    return {"removed": removed, "path": path}


@app.get("/files")
def list_files():
    records = store.get_all_files()
    return [
        {
            "path": r.path,
            "label": Path(r.path).name,
            "doc_type": r.doc_type or "Other",
            "status": r.status,
            "summary": r.summary or "",
        }
        for r in records
    ]


if __name__ == "__main__":
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
