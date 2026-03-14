"""
Bina FastAPI sidecar — v2 with workspace support.

Spawned by Electron as a child process. Exposes a REST API on
http://localhost:8765 that the React renderer calls over HTTP.

Endpoints
---------
GET  /status?workspace_id=         → per-workspace stats
GET  /progress                     → current indexing progress
POST /search                       → semantic search (workspace-scoped)
GET  /graph?workspace_id=          → full workspace graph
POST /watch                        → start watcher for a workspace folder
DELETE /watch                      → stop watcher for a workspace folder
DELETE /file                       → remove a file from a workspace
GET  /files                        → list all indexed file records
GET  /global/status                → global stats (dedup savings)

GET  /workspaces                   → list all workspaces
POST /workspaces                   → create workspace
PATCH /workspaces/:id              → update workspace (name/emoji/colour)
DELETE /workspaces/:id             → delete workspace + orphan purge
GET  /workspaces/:id/folders       → list folders in workspace
POST /workspaces/:id/folders       → add folder + start watcher + scan
DELETE /workspaces/:id/folders     → remove folder + stop watcher + purge
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hashlib
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import store
import vector_store
import pipeline as _pipeline
import graph as _graph
from config import SUPPORTED_EXTENSIONS
from graph import get_graph, subgraph_for_paths, mark_dirty, mark_all_dirty
from search import search as _search
from watcher import FolderWatcher


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

# (workspace_id, folder_path) → FolderWatcher
_watchers: dict[tuple[str, str], FolderWatcher] = {}
_watchers_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Watcher helpers
# ---------------------------------------------------------------------------

def _start_watcher(workspace_id: str, folder_path: str) -> None:
    key = (workspace_id, folder_path)
    with _watchers_lock:
        if key in _watchers and _watchers[key].is_alive():
            return
        watcher = FolderWatcher(
            workspace_id=workspace_id,
            folder_path=folder_path,
            pipeline_fn=_pipeline.process_file,
            remove_fn=_pipeline.remove_file,
            on_processed=lambda _: None,
        )
        watcher.start()
        _watchers[key] = watcher


def _stop_watcher(workspace_id: str, folder_path: str) -> None:
    key = (workspace_id, folder_path)
    with _watchers_lock:
        if key in _watchers:
            try:
                _watchers[key].stop()
            except Exception:
                pass
            del _watchers[key]


def _stop_all_watchers_for_workspace(workspace_id: str) -> None:
    with _watchers_lock:
        keys = [k for k in _watchers if k[0] == workspace_id]
    for k in keys:
        _stop_watcher(k[0], k[1])


# ---------------------------------------------------------------------------
# Startup orphan purge
# ---------------------------------------------------------------------------

def _purge_orphans() -> None:
    """Remove index records for files that no longer exist on disk."""
    removed = 0
    for rec in store.get_all_files():
        if not Path(rec.path).exists():
            store.delete_file(rec.hash)
            vector_store.delete(rec.hash)
            removed += 1
    if removed:
        mark_all_dirty()
        print(f"[startup] Purged {removed} orphaned record(s).", flush=True)


# ---------------------------------------------------------------------------
# Startup resume: re-index files interrupted by a previous crash/restart
# ---------------------------------------------------------------------------

def _md5_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _resume_unfinished(workspace_ids: list[str]) -> None:
    """
    Called once at startup in a background thread.

    For every registered workspace folder, collect files that are on disk
    but don't have a status='done' record in SQLite yet.  These are files
    that were mid-flight when the app was last killed.  Re-run them through
    the full pipeline; already-indexed files skip quickly (MD5 + DB lookup,
    no LLM call), so this is safe to run even when nothing is pending.
    """
    pending: list[tuple[Path, str]] = []  # (file_path, workspace_id)

    for workspace_id in workspace_ids:
        for folder_path in store.get_folders_for_workspace(workspace_id):
            folder = Path(folder_path)
            if not folder.is_dir():
                continue
            for f in _collect_files(folder):
                try:
                    if not store.file_already_indexed(_md5_file(f)):
                        pending.append((f, workspace_id))
                except Exception:
                    pass

    if not pending:
        return

    print(f"[startup] Resuming {len(pending)} unfinished file(s) from previous session.", flush=True)

    # Group pending files by workspace so mark_dirty is called per workspace
    by_workspace: dict[str, list[Path]] = {}
    for f, wsid in pending:
        by_workspace.setdefault(wsid, []).append(f)

    with _progress_lock:
        _progress.update(
            running=True, total=len(pending), current=0,
            current_file="", done=False, ok=0, failed=0,
        )

    processed = 0
    for workspace_id, files in by_workspace.items():
        for f in files:
            with _progress_lock:
                _progress["current"] = processed
                _progress["current_file"] = f.name

            result = _pipeline.process_file(str(f), workspace_id)
            with _progress_lock:
                if result.get("status") in ("ok", "skipped"):
                    _progress["ok"] += 1
                else:
                    _progress["failed"] += 1
            processed += 1

        mark_dirty(workspace_id)

    _pipeline.unload_models()

    with _progress_lock:
        _progress.update(running=False, current=len(pending), done=True)

    print(f"[startup] Resume complete — {_progress['ok']} ok, {_progress['failed']} failed.", flush=True)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _lifespan(app: FastAPI):
    store.init_db()

    # Purge stale records (files deleted from disk) before anything else
    _purge_orphans()

    # Restart watchers for all known workspaces + folders
    workspace_ids: list[str] = []
    for ws in store.list_workspaces():
        workspace_ids.append(ws.id)
        for folder_path in store.get_folders_for_workspace(ws.id):
            if Path(folder_path).is_dir():
                _start_watcher(ws.id, folder_path)

    # Resume any files that were mid-indexing when the app was last killed
    threading.Thread(
        target=_resume_unfinished,
        args=(workspace_ids,),
        daemon=True,
    ).start()

    yield

    # Shutdown — stop all watchers
    with _watchers_lock:
        keys = list(_watchers.keys())
    for k in keys:
        try:
            _watchers[k].stop()
        except Exception:
            pass
    _watchers.clear()


app = FastAPI(title="Bina API", version="2.0.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        "id": rec.hash,
        "name": Path(rec.path).name,
        "path": rec.path,
        "label": Path(rec.path).name,
        "summary": rec.summary or "",
        "keywords": store.parse_keywords(rec),
        "entities": store.parse_entities(rec),
        "doc_type": rec.doc_type or "Other",
        "status": rec.status,
        "score": score,
        "from_graph": from_graph,
        "relevance_score": score,
    }


def _graph_to_json(G, workspace_id: str) -> dict:
    nodes = []
    edges = []
    for node_hash in G.nodes:
        rec = store.get_file_by_hash(node_hash)
        if rec:
            n = _node_from_record(rec)
            n["community_id"] = G.nodes[node_hash].get("community_id", 0)
            nodes.append(n)
    for u, v, data in G.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": round(data.get("weight", 0.0), 4),
            "forced": bool(data.get("forced", False)),
        })
    return {"nodes": nodes, "edges": edges}


def _run_indexing(folder: Path, workspace_id: str) -> None:
    files = _collect_files(folder)

    with _progress_lock:
        _progress.update(running=True, total=len(files), current=0,
                         current_file="", done=False, ok=0, failed=0)

    for i, f in enumerate(files):
        with _progress_lock:
            _progress["current"] = i
            _progress["current_file"] = f.name

        result = _pipeline.process_file(str(f), workspace_id)
        with _progress_lock:
            if result.get("status") in ("ok", "skipped"):
                _progress["ok"] += 1
            else:
                _progress["failed"] += 1

    _pipeline.unload_models()
    mark_dirty(workspace_id)

    with _progress_lock:
        _progress.update(running=False, current=len(files), done=True)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SearchRequest(BaseModel):
    query: str
    workspace_id: str
    limit: int = 20

class WatchRequest(BaseModel):
    path: str
    workspace_id: str

class DeleteWatchRequest(BaseModel):
    path: str
    workspace_id: str

class DeleteFileRequest(BaseModel):
    path: str
    workspace_id: str

class CreateWorkspaceRequest(BaseModel):
    name: str
    emoji: str = "📁"
    colour: str = "#4F46E5"

class UpdateWorkspaceRequest(BaseModel):
    name: str | None = None
    emoji: str | None = None
    colour: str | None = None

class AddFolderRequest(BaseModel):
    path: str

class RemoveFolderRequest(BaseModel):
    path: str


# ---------------------------------------------------------------------------
# Routes — core
# ---------------------------------------------------------------------------

@app.get("/status")
def status(workspace_id: str | None = None):
    if workspace_id:
        ws = store.get_workspace(workspace_id)
        if not ws:
            raise HTTPException(status_code=404, detail="Workspace not found")

        files = store.get_files_for_workspace(workspace_id)
        indexed = sum(1 for f in files if f.status == "done")
        failed = sum(1 for f in files if f.status == "failed")

        G = get_graph(workspace_id)
        folders = store.get_folders_for_workspace(workspace_id)

        return {
            "indexed": indexed,
            "failed": failed,
            "vectors": vector_store.count(),
            "watched_folder": folders[0] if folders else None,
            "watched_folders": folders,
            "graph_nodes": G.number_of_nodes(),
            "graph_edges": G.number_of_edges(),
        }
    else:
        # Legacy / global status
        all_files = store.get_all_files()
        indexed = sum(1 for f in all_files if f.status == "done")
        failed = sum(1 for f in all_files if f.status == "failed")
        return {
            "indexed": indexed,
            "failed": failed,
            "vectors": vector_store.count(),
            "watched_folder": None,
            "watched_folders": [],
            "graph_nodes": 0,
            "graph_edges": 0,
        }


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

    G = get_graph(req.workspace_id)
    ws_files = store.get_files_for_workspace(req.workspace_id)
    ws_hashes = [f.hash for f in ws_files]

    results = _search(req.query, G, n_results=req.limit, workspace_hashes=ws_hashes)

    seed_hashes = [r["hash"] for r in results]
    sub = subgraph_for_paths(G, seed_hashes, expand_depth=1)

    score_map = {r["hash"]: r["score"] for r in results}

    nodes = []
    for node_hash in sub.nodes:
        rec = store.get_file_by_hash(node_hash)
        if rec:
            score = score_map.get(node_hash, 0.0)
            from_graph = node_hash not in score_map
            n = _node_from_record(rec, score=score, from_graph=from_graph)
            n["community_id"] = sub.nodes[node_hash].get("community_id", 0)
            nodes.append(n)

    edges = []
    for u, v, data in sub.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": round(data.get("weight", 0.0), 4),
            "forced": bool(data.get("forced", False)),
        })

    ms = int((time.time() - t) * 1000)
    return {"nodes": nodes, "edges": edges, "query": req.query, "ms": ms}


@app.get("/graph")
def full_graph(workspace_id: str | None = None):
    if not workspace_id:
        return {"nodes": [], "edges": []}
    G = get_graph(workspace_id)
    return _graph_to_json(G, workspace_id)


@app.post("/watch")
def start_watch(req: WatchRequest):
    folder = Path(req.path)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    store.add_folder_to_workspace(req.workspace_id, str(folder))
    _start_watcher(req.workspace_id, str(folder))
    return {"status": "watching", "folder": str(folder)}


@app.delete("/watch")
def stop_watch(req: DeleteWatchRequest):
    _stop_watcher(req.workspace_id, req.path)
    return {"status": "stopped"}


@app.delete("/file")
def delete_file(req: DeleteFileRequest):
    path = str(Path(req.path).resolve())
    _pipeline.remove_file(path, req.workspace_id)
    return {"removed": True, "path": path}


@app.get("/files")
def list_files():
    records = store.get_all_files()
    return [
        {
            "path": r.path,
            "hash": r.hash,
            "label": Path(r.path).name,
            "doc_type": r.doc_type or "Other",
            "status": r.status,
            "summary": r.summary or "",
        }
        for r in records
    ]


@app.get("/global/status")
def global_status():
    all_files = store.get_all_files()
    workspaces = store.list_workspaces()
    total_ws_files = sum(store.get_workspace_file_count(ws.id) for ws in workspaces)
    return {
        "total_files_indexed": len(all_files),
        "total_workspaces": len(workspaces),
        "chroma_count": vector_store.count(),
        "dedup_savings": max(0, total_ws_files - len(all_files)),
    }


# ---------------------------------------------------------------------------
# Routes — workspaces
# ---------------------------------------------------------------------------

@app.get("/workspaces")
def list_workspaces():
    workspaces = store.list_workspaces()
    result = []
    for ws in workspaces:
        result.append({
            "id": ws.id,
            "name": ws.name,
            "emoji": ws.emoji,
            "colour": ws.colour,
            "file_count": store.get_workspace_file_count(ws.id),
            "folder_count": len(store.get_folders_for_workspace(ws.id)),
            "created_at": ws.created_at.isoformat() if ws.created_at else None,
            "last_opened": ws.last_opened.isoformat() if ws.last_opened else None,
        })
    return result


@app.post("/workspaces")
def create_workspace(req: CreateWorkspaceRequest):
    ws = store.create_workspace(name=req.name, emoji=req.emoji, colour=req.colour)
    return {
        "id": ws.id,
        "name": ws.name,
        "emoji": ws.emoji,
        "colour": ws.colour,
        "file_count": 0,
        "folder_count": 0,
        "created_at": ws.created_at.isoformat() if ws.created_at else None,
        "last_opened": ws.last_opened.isoformat() if ws.last_opened else None,
    }


@app.patch("/workspaces/{workspace_id}")
def update_workspace(workspace_id: str, req: UpdateWorkspaceRequest):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    fields: dict[str, Any] = {"last_opened": datetime.utcnow()}
    if req.name is not None:
        fields["name"] = req.name
    if req.emoji is not None:
        fields["emoji"] = req.emoji
    if req.colour is not None:
        fields["colour"] = req.colour

    ws = store.update_workspace(workspace_id, **fields)
    return {
        "id": ws.id,
        "name": ws.name,
        "emoji": ws.emoji,
        "colour": ws.colour,
        "file_count": store.get_workspace_file_count(ws.id),
        "folder_count": len(store.get_folders_for_workspace(ws.id)),
        "created_at": ws.created_at.isoformat() if ws.created_at else None,
        "last_opened": ws.last_opened.isoformat() if ws.last_opened else None,
    }


@app.delete("/workspaces/{workspace_id}")
def delete_workspace(workspace_id: str):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Stop all watchers for this workspace
    _stop_all_watchers_for_workspace(workspace_id)

    # Collect hashes to purge from ChromaDB (those that will become orphaned)
    ws_files = store.get_files_for_workspace(workspace_id)
    will_orphan = [
        f.hash for f in ws_files
        if store.count_workspace_refs(f.hash) == 1  # only this workspace
    ]

    # Delete workspace from SQLite (cascades workspace_files + workspace_folders,
    # and deletes orphaned file_records)
    orphaned_count = store.delete_workspace(workspace_id)

    # Purge orphaned hashes from ChromaDB
    for h in will_orphan:
        vector_store.delete(h)

    # Remove workspace graph from cache
    import graph as _g
    _g._graphs.pop(workspace_id, None)
    _g._dirty.discard(workspace_id)

    return {"deleted": True, "files_purged": orphaned_count}


# ---------------------------------------------------------------------------
# Routes — workspace folders
# ---------------------------------------------------------------------------

@app.get("/workspaces/{workspace_id}/folders")
def get_workspace_folders(workspace_id: str):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    folders = store.get_folders_for_workspace(workspace_id)
    result = []
    for folder_path in folders:
        # Count files in this workspace that live under this folder
        ws_files = store.get_files_for_workspace(workspace_id)
        folder_file_count = sum(
            1 for f in ws_files
            if f.path.startswith(folder_path)
        )
        result.append({
            "folder_path": folder_path,
            "file_count": folder_file_count,
            "added_at": None,
        })
    return result


@app.post("/workspaces/{workspace_id}/folders")
def add_workspace_folder(
    workspace_id: str,
    req: AddFolderRequest,
    background_tasks: BackgroundTasks,
):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    folder = Path(req.path)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {req.path}")

    folder_str = str(folder.resolve())
    store.add_folder_to_workspace(workspace_id, folder_str)
    _start_watcher(workspace_id, folder_str)

    # Count files available for indexing
    files = _collect_files(folder)
    file_count = len(files)

    # Background scan + index
    background_tasks.add_task(_run_indexing, folder, workspace_id)

    return {"watching": True, "file_count": file_count}


@app.delete("/workspaces/{workspace_id}/folders")
def remove_workspace_folder(workspace_id: str, req: RemoveFolderRequest):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    folder_path = str(Path(req.path).resolve())
    _stop_watcher(workspace_id, folder_path)
    store.remove_folder_from_workspace(workspace_id, folder_path)

    # Remove all files in this workspace that live under this folder
    ws_files = store.get_files_for_workspace(workspace_id)
    purged = 0
    for f in ws_files:
        if f.path.startswith(folder_path):
            _pipeline.remove_file(f.path, workspace_id)
            purged += 1

    return {"stopped": True, "files_purged": purged}


# ---------------------------------------------------------------------------
# Legacy /index endpoint (kept for CLI compatibility)
# ---------------------------------------------------------------------------

class IndexRequest(BaseModel):
    folder: str
    workspace_id: str | None = None


@app.post("/index")
def start_index(req: IndexRequest, background_tasks: BackgroundTasks):
    folder = Path(req.folder)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {req.folder}")

    workspace_id = req.workspace_id
    if not workspace_id:
        # Create a default workspace if none exists
        workspaces = store.list_workspaces()
        if workspaces:
            workspace_id = workspaces[0].id
        else:
            ws = store.create_workspace(name=folder.name, emoji="📁")
            workspace_id = ws.id

    store.add_folder_to_workspace(workspace_id, str(folder))
    _start_watcher(workspace_id, str(folder))

    if _progress.get("running"):
        raise HTTPException(status_code=409, detail="Indexing already in progress")

    background_tasks.add_task(_run_indexing, folder, workspace_id)
    return {"status": "started", "folder": str(folder), "workspace_id": workspace_id}


if __name__ == "__main__":
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
