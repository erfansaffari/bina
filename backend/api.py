"""
Bina FastAPI sidecar — v3 with workspace model selection.

Spawned by Electron as a child process. Exposes a REST API on
http://localhost:8765 that the React renderer calls over HTTP.

Endpoints
---------
GET  /status?workspace_id=         → per-workspace stats
GET  /progress                     → current indexing progress
POST /search                       → semantic search (workspace-scoped)
POST /query                        → agent or search query
GET  /graph?workspace_id=          → full workspace graph
POST /watch                        → start watcher for a workspace folder
DELETE /watch                      → stop watcher for a workspace folder
DELETE /file                       → remove a file from a workspace
GET  /files                        → list all indexed file records
GET  /global/status                → global stats (dedup savings)

GET  /workspaces                   → list all workspaces
POST /workspaces                   → create workspace (with model config)
PATCH /workspaces/:id              → update workspace (name/emoji/colour)
DELETE /workspaces/:id             → delete workspace + orphan purge
GET  /workspaces/:id/folders       → list folders in workspace
POST /workspaces/:id/folders       → add folder + start watcher + scan
DELETE /workspaces/:id/folders     → remove folder + stop watcher + purge
GET  /workspaces/:id/model         → get workspace AI config
PATCH /workspaces/:id/model        → update workspace AI config

GET  /settings/app                 → check global app settings (Moorcheh key status)
POST /settings/app                 → save global app settings to ~/.bina/.env
"""
from __future__ import annotations

import sys
import os
import logging

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
import vector_store_router
import pipeline as _pipeline
import graph as _graph
from config import SUPPORTED_EXTENSIONS
from graph import get_graph, subgraph_for_paths, mark_dirty, mark_all_dirty
from search import search as _search
from watcher import FolderWatcher

logger = logging.getLogger(__name__)


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
    vstore = vector_store_router.get_store()
    for rec in store.get_all_files():
        if not Path(rec.path).exists():
            store.delete_file(rec.hash)
            vstore.delete(rec.hash)
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


app = FastAPI(title="Bina API", version="3.0.0", lifespan=_lifespan)

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
            n["community_label"] = G.nodes[node_hash].get("community_label", "Other")
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

class QueryRequest(BaseModel):
    query: str
    workspace_id: str
    mode: str = "agent"  # "agent" | "search"

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
    processing_path: str = "hosted"
    model_name: str | None = None
    user_api_key: str | None = None
    user_api_base: str | None = None
    vector_backend: str = "moorcheh"

class UpdateWorkspaceRequest(BaseModel):
    name: str | None = None
    emoji: str | None = None
    colour: str | None = None

class WorkspaceModelConfig(BaseModel):
    processing_path: str | None = None
    model_name: str | None = None
    user_api_key: str | None = None
    user_api_base: str | None = None
    vector_backend: str | None = None

class AddFolderRequest(BaseModel):
    path: str

class RemoveFolderRequest(BaseModel):
    path: str

class AppSettingsRequest(BaseModel):
    moorcheh_api_key: str | None = None

class AppSettingsResponse(BaseModel):
    moorcheh_api_key_set: bool
    moorcheh_connected: bool


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

        failed_reasons = list({
            f.error for f in files
            if f.status == "failed" and getattr(f, "error", None)
        })[:3]

        G = get_graph(workspace_id)
        folders = store.get_folders_for_workspace(workspace_id)

        vstore = vector_store_router.get_store(workspace_id)
        return {
            "indexed": indexed,
            "failed": failed,
            "failed_reasons": failed_reasons,
            "vectors": vstore.count(),
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
        vstore = vector_store_router.get_store()
        return {
            "indexed": indexed,
            "failed": failed,
            "vectors": vstore.count(),
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
    # Guard: use SQLite (always reliable) to check if anything is indexed.
    # Vector store count() is unreliable (Moorcheh returns 0 on namespace issues).
    ws_files = store.get_files_for_workspace(req.workspace_id)
    if not ws_files:
        return {"nodes": [], "edges": [], "query": req.query, "ms": 0}

    import time
    t = time.time()

    G = get_graph(req.workspace_id)
    ws_files = store.get_files_for_workspace(req.workspace_id)
    ws_hashes = [f.hash for f in ws_files]

    results = _search(
        req.query, G, n_results=req.limit,
        workspace_hashes=ws_hashes, workspace_id=req.workspace_id,
    )

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


@app.get("/graph/groups")
def graph_groups(workspace_id: str | None = None):
    """Collapsed group-level graph data for the overview zoom level."""
    if not workspace_id:
        return {"groups": [], "edges": []}
    G = get_graph(workspace_id)

    groups: dict[int, dict] = {}
    for h in G.nodes:
        label = G.nodes[h].get("community_label", "Other")
        cid = G.nodes[h].get("community_id", 0)
        if cid not in groups:
            groups[cid] = {"label": label, "count": 0}
        groups[cid]["count"] += 1

    group_edges: dict[tuple[int, int], int] = {}
    for u, v, _data in G.edges(data=True):
        cid_u = G.nodes[u].get("community_id", 0)
        cid_v = G.nodes[v].get("community_id", 0)
        if cid_u != cid_v:
            key = (min(cid_u, cid_v), max(cid_u, cid_v))
            group_edges[key] = group_edges.get(key, 0) + 1

    return {
        "groups": [
            {"id": k, "label": v["label"], "count": v["count"]}
            for k, v in groups.items()
        ],
        "edges": [
            {"source": k[0], "target": k[1], "weight": v}
            for k, v in group_edges.items()
        ],
    }


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
    vstore = vector_store_router.get_store()
    return {
        "total_files_indexed": len(all_files),
        "total_workspaces": len(workspaces),
        "vector_count": vstore.count(),
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
            "processing_path": getattr(ws, "processing_path", "hosted"),
            "model_name": getattr(ws, "model_name", None),
            "vector_backend": getattr(ws, "vector_backend", "moorcheh"),
        })
    return result


@app.post("/workspaces")
def create_workspace(req: CreateWorkspaceRequest):
    ws = store.create_workspace(
        name=req.name,
        emoji=req.emoji,
        colour=req.colour,
        processing_path=req.processing_path,
        model_name=req.model_name,
        user_api_key=req.user_api_key,
        user_api_base=req.user_api_base,
        vector_backend=req.vector_backend,
    )
    return {
        "id": ws.id,
        "name": ws.name,
        "emoji": ws.emoji,
        "colour": ws.colour,
        "file_count": 0,
        "folder_count": 0,
        "created_at": ws.created_at.isoformat() if ws.created_at else None,
        "last_opened": ws.last_opened.isoformat() if ws.last_opened else None,
        "processing_path": ws.processing_path,
        "model_name": ws.model_name,
        "vector_backend": ws.vector_backend,
    }


@app.patch("/workspaces/{workspace_id}")
def update_workspace(workspace_id: str, req: UpdateWorkspaceRequest):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    fields: dict[str, Any] = {"last_opened": datetime.now(timezone.utc)}
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

    # Collect hashes to purge from vector store (those that will become orphaned)
    ws_files = store.get_files_for_workspace(workspace_id)
    vstore = vector_store_router.get_store(workspace_id)
    will_orphan = [
        f.hash for f in ws_files
        if store.count_workspace_refs(f.hash) == 1  # only this workspace
    ]

    # Delete workspace from SQLite (cascades workspace_files + workspace_folders,
    # and deletes orphaned file_records)
    orphaned_count = store.delete_workspace(workspace_id)

    # Purge orphaned hashes from vector store
    for h in will_orphan:
        vstore.delete(h)

    # Remove workspace graph from cache
    import graph as _g
    _g._graphs.pop(workspace_id, None)
    _g._dirty.discard(workspace_id)

    # Invalidate agent cache
    try:
        from agent import invalidate_agent
        invalidate_agent(workspace_id)
    except Exception:
        pass

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


# ---------------------------------------------------------------------------
# Routes — settings
# ---------------------------------------------------------------------------

import config as _config


class UpdateSettingsRequest(BaseModel):
    llm_model: str | None = None
    similarity_threshold: float | None = None
    max_graph_neighbours: int | None = None


@app.get("/settings")
def get_settings():
    return _config.load_settings()


@app.post("/settings")
def update_settings(req: UpdateSettingsRequest):
    updated = _config.save_settings(
        llm_model=req.llm_model,
        similarity_threshold=req.similarity_threshold,
        max_graph_neighbours=req.max_graph_neighbours,
    )
    # Invalidate all workspace graphs so next access picks up new threshold /
    # neighbour count.
    mark_all_dirty()
    return updated


@app.get("/settings/app")
def get_app_settings():
    """Check current global app settings status."""
    key_set = bool(os.environ.get("MOORCHEH_API_KEY"))
    connected = False
    if key_set:
        try:
            from vector_store_moorcheh import ping as moorcheh_ping
            moorcheh_ping()
            connected = True
        except Exception:
            connected = False
    return AppSettingsResponse(
        moorcheh_api_key_set=key_set,
        moorcheh_connected=connected,
    )


@app.post("/settings/app")
def save_app_settings(request: AppSettingsRequest):
    """
    Save global app settings to ~/.bina/.env.
    Rewrites the key in the .env file and hot-reloads into os.environ.
    """
    env_path = Path.home() / ".bina" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text().splitlines()

    if request.moorcheh_api_key is not None:
        key_line = f"MOORCHEH_API_KEY={request.moorcheh_api_key}"
        updated = False
        for i, line in enumerate(lines):
            if line.startswith("MOORCHEH_API_KEY="):
                lines[i] = key_line
                updated = True
                break
        if not updated:
            lines.append(key_line)
        os.environ["MOORCHEH_API_KEY"] = request.moorcheh_api_key

    env_path.write_text("\n".join(lines) + "\n")

    # Reset cached Moorcheh client so new key is picked up immediately
    try:
        from vector_store_moorcheh import reset_client as moorcheh_reset
        moorcheh_reset()
    except Exception:
        pass

    return {"saved": True}


@app.delete("/index/clear")
def clear_index():
    """Wipe all indexed data — SQLite file records + vector store."""
    # Stop all watchers before wiping
    with _watchers_lock:
        keys = list(_watchers.keys())
    for k in keys:
        try:
            _watchers[k].stop()
        except Exception:
            pass
    _watchers.clear()

    # Clear the in-memory graph cache
    import graph as _g
    with _g._lock:
        _g._graphs.clear()
        _g._dirty.clear()

    # Wipe vector store
    vstore = vector_store_router.get_store()
    vstore.clear_all()

    # Wipe SQLite: drop all tables and recreate schema
    import store as _store
    from sqlalchemy import text as _text
    with _store.get_session() as session:
        session.execute(_text("DELETE FROM workspace_files"))
        session.execute(_text("DELETE FROM workspace_folders"))
        session.execute(_text("DELETE FROM file_records"))
        session.execute(_text("DELETE FROM workspaces"))
        session.commit()

    # Reset progress state
    with _progress_lock:
        _progress.update(running=False, total=0, current=0,
                         current_file="", done=True, ok=0, failed=0)

    return {"cleared": True}


# ---------------------------------------------------------------------------
# Routes — model management
# ---------------------------------------------------------------------------

import threading as _threading

try:
    import ollama
except ImportError:
    ollama = None

# Required models for local path only
_REQUIRED_MODELS = [
    {"name": "qwen3.5:2b",      "role": "Text & image understanding (multimodal)", "size_gb": 2.7},
    {"name": "nomic-embed-text", "role": "Semantic embeddings",                     "size_gb": 0.3},
]

# Pull progress store: model_name → {status, percent, total, completed, error}
_pull_progress: dict[str, dict] = {}
_pull_lock = _threading.Lock()


@app.get("/models/status")
def get_models_status():
    """Check which required models are currently installed in Ollama."""
    if ollama is None:
        return {"error": "ollama not installed", "models": [], "all_ready": False}
    try:
        result = ollama.list()
        raw_models = getattr(result, 'models', None)
        if raw_models is None:
            raw_models = result.get("models", []) if isinstance(result, dict) else []
        installed_names: list[str] = []
        for m in raw_models:
            n = (getattr(m, 'name', None) or getattr(m, 'model', None)
                 or m.get("name", "") or m.get("model", ""))
            if n:
                installed_names.append(n)
    except Exception as e:
        return {"error": str(e), "models": []}

    models_out = []
    for req in _REQUIRED_MODELS:
        name = req["name"]
        base = name.split(":")[0]
        installed = any(
            n == name or n.startswith(base + ":")
            for n in installed_names
        )
        models_out.append({
            "name": name,
            "role": req["role"],
            "size_gb": req["size_gb"],
            "installed": installed,
        })

    return {"models": models_out, "all_ready": all(m["installed"] for m in models_out)}


def _do_pull(model_name: str) -> None:
    """Background thread: stream pull progress from Ollama."""
    if ollama is None:
        with _pull_lock:
            _pull_progress[model_name] = {"status": "error", "percent": 0, "error": "ollama not installed"}
        return
    with _pull_lock:
        _pull_progress[model_name] = {"status": "pulling", "percent": 0, "error": None}
    try:
        for chunk in ollama.pull(model_name, stream=True):
            total = chunk.get("total", 0)
            completed = chunk.get("completed", 0)
            status = chunk.get("status", "pulling")
            percent = int(completed / total * 100) if total else 0
            with _pull_lock:
                _pull_progress[model_name] = {
                    "status": status,
                    "percent": percent,
                    "total": total,
                    "completed": completed,
                    "error": None,
                }
        with _pull_lock:
            _pull_progress[model_name]["status"] = "done"
            _pull_progress[model_name]["percent"] = 100
    except Exception as e:
        with _pull_lock:
            _pull_progress[model_name] = {"status": "error", "percent": 0, "error": str(e)}


@app.post("/models/pull/{model_name:path}")
def pull_model(model_name: str):
    """Start pulling a model in the background."""
    with _pull_lock:
        existing = _pull_progress.get(model_name, {})
        if existing.get("status") in ("pulling", "downloading manifest"):
            return {"started": False, "reason": "already pulling"}

    t = _threading.Thread(target=_do_pull, args=(model_name,), daemon=True)
    t.start()
    return {"started": True, "model": model_name}


@app.get("/models/pull-progress/{model_name:path}")
def get_pull_progress(model_name: str):
    """Get the current pull progress for a model being downloaded."""
    with _pull_lock:
        return _pull_progress.get(model_name, {"status": "idle", "percent": 0})


# ---------------------------------------------------------------------------
# Routes — query (agent / search)
# ---------------------------------------------------------------------------

@app.post("/query")
def query(req: QueryRequest):
    """
    Unified query endpoint.
    mode="agent": semantic search + LLM synthesis using workspace's AI config
    mode="search": direct vector search only (returns raw graph nodes)
    """
    try:
        from agent import answer_query as _answer_query, semantic_search as _sem_search

        if req.mode == "search":
            top_hits = _sem_search(req.query, req.workspace_id, top_k=20)
            return {
                "answer": None,
                "results": top_hits[:10],
                "mode": "search",
                "workspace_id": req.workspace_id,
            }

        # Agent mode: search relevant files then synthesise an answer with the LLM.
        # Uses workspace's processing_path (hosted / local / user_api) automatically.
        answer = _answer_query(req.query, req.workspace_id)
        top_hits = _sem_search(req.query, req.workspace_id, top_k=5)
        return {
            "answer": answer,
            "results": top_hits,
            "mode": "agent",
            "workspace_id": req.workspace_id,
        }

    except Exception as e:
        logger.error(f"Query failed: {e}")
        raise HTTPException(500, detail=str(e))


# ---------------------------------------------------------------------------
# Routes — workspace model configuration
# ---------------------------------------------------------------------------

@app.get("/workspaces/{workspace_id}/model")
def get_workspace_model(workspace_id: str):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(404, "Workspace not found")
    return {
        "processing_path": getattr(ws, "processing_path", "hosted"),
        "model_name": getattr(ws, "model_name", None),
        "embed_model": getattr(ws, "embed_model", "nomic-embed-text"),
        "vector_backend": getattr(ws, "vector_backend", "moorcheh"),
        "has_user_api_key": bool(getattr(ws, "user_api_key", None)),
    }


@app.patch("/workspaces/{workspace_id}/model")
def update_workspace_model(workspace_id: str, config: WorkspaceModelConfig):
    ws = store.get_workspace(workspace_id)
    if not ws:
        raise HTTPException(404, "Workspace not found")

    fields = {k: v for k, v in config.model_dump().items() if v is not None}
    ws = store.update_workspace(workspace_id, **fields)

    # Invalidate cached agent so it rebuilds with new config
    try:
        from agent import invalidate_agent
        invalidate_agent(workspace_id)
    except Exception:
        pass

    return {
        "processing_path": ws.processing_path,
        "model_name": ws.model_name,
        "embed_model": ws.embed_model,
        "vector_backend": ws.vector_backend,
    }


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
