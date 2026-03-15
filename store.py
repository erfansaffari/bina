"""
SQLite metadata store via SQLAlchemy.

Schema
------
file_records:
    hash           TEXT PRIMARY KEY          -- MD5 of file bytes
    path           TEXT NOT NULL, indexed    -- last known absolute path
    summary        TEXT
    keywords       TEXT  -- JSON list[str]
    entities       TEXT  -- JSON dict{persons,companies,dates,projects,locations}
    doc_type       TEXT
    status         TEXT  -- "pending" | "done" | "failed"
    error          TEXT
    processed_at   TEXT  -- ISO-8601 timestamp
    embedding_model TEXT -- which model produced the stored embedding

workspaces:
    id              TEXT PRIMARY KEY  -- UUID
    name            TEXT NOT NULL
    emoji           TEXT
    colour          TEXT
    created_at      TEXT
    last_opened     TEXT
    processing_path TEXT  -- "hosted" | "local" | "user_api"
    model_name      TEXT
    embed_model     TEXT
    user_api_key    TEXT
    user_api_base   TEXT
    vector_backend  TEXT  -- "moorcheh" | "chromadb"

workspace_folders:
    workspace_id TEXT FK → workspaces.id (CASCADE DELETE)
    folder_path  TEXT
    added_at     TEXT
    PRIMARY KEY (workspace_id, folder_path)

workspace_files:
    workspace_id TEXT FK → workspaces.id (CASCADE DELETE)
    file_hash    TEXT FK → file_records.hash (CASCADE DELETE)
    added_at     TEXT
    PRIMARY KEY (workspace_id, file_hash)
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import (
    Column, String, Text, DateTime, ForeignKey,
    create_engine, event, inspect as sa_inspect, text,
)
from sqlalchemy.orm import DeclarativeBase, Session

from config import DB_PATH


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    """Timezone-aware UTC now (replaces deprecated datetime.utcnow)."""
    return datetime.now(timezone.utc)


class FileRecord(Base):
    __tablename__ = "file_records"

    hash            = Column(String, primary_key=True)
    path            = Column(String, nullable=False, index=True)
    summary         = Column(Text)
    keywords        = Column(Text)     # JSON list[str]
    entities        = Column(Text)     # JSON dict
    doc_type        = Column(String)
    status          = Column(String, default="pending")
    error           = Column(Text)
    processed_at    = Column(DateTime)
    embedding_model = Column(String, default="nomic-embed-text")


class Workspace(Base):
    __tablename__ = "workspaces"

    id              = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name            = Column(String, nullable=False)
    emoji           = Column(String, default="📁")
    colour          = Column(String, default="#4F46E5")
    created_at      = Column(DateTime, default=_utcnow)
    last_opened     = Column(DateTime, default=_utcnow)
    # v3 fields:
    processing_path = Column(String, default="hosted")      # "hosted" | "local" | "user_api"
    model_name      = Column(String, default="openai/gpt-oss-120b")
    embed_model     = Column(String, default="nomic-embed-text")
    user_api_key    = Column(String, nullable=True)
    user_api_base   = Column(String, nullable=True)
    vector_backend  = Column(String, default="moorcheh")     # "moorcheh" | "chromadb"


class WorkspaceFolder(Base):
    __tablename__ = "workspace_folders"

    workspace_id = Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    folder_path  = Column(String, primary_key=True)
    added_at     = Column(DateTime, default=_utcnow)


class WorkspaceFile(Base):
    __tablename__ = "workspace_files"

    workspace_id = Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    file_hash    = Column(String, ForeignKey("file_records.hash", ondelete="CASCADE"), primary_key=True)
    added_at     = Column(DateTime, default=_utcnow)


_engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)

# Enable foreign key enforcement for SQLite (off by default)
@event.listens_for(_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def init_db() -> None:
    """Create all tables if they don't already exist."""
    Base.metadata.create_all(_engine)


def _migrate_schema() -> None:
    """
    Add new columns to existing tables without Alembic.
    Safe to call repeatedly — only adds columns that don't exist yet.
    """
    inspector = sa_inspect(_engine)

    # ── file_records: add embedding_model ─────────────────────────────────
    fr_cols = {c["name"] for c in inspector.get_columns("file_records")}
    if "embedding_model" not in fr_cols:
        with _engine.begin() as conn:
            conn.execute(text(
                "ALTER TABLE file_records ADD COLUMN embedding_model TEXT DEFAULT 'nomic-embed-text'"
            ))

    # ── workspaces: add v3 columns ────────────────────────────────────────
    ws_cols = {c["name"] for c in inspector.get_columns("workspaces")}
    new_ws_cols = {
        "processing_path": "'hosted'",
        "model_name":      "'openai/gpt-oss-120b'",
        "embed_model":     "'nomic-embed-text'",
        "user_api_key":    "NULL",
        "user_api_base":   "NULL",
        "vector_backend":  "'moorcheh'",
    }
    for col_name, default in new_ws_cols.items():
        if col_name not in ws_cols:
            with _engine.begin() as conn:
                conn.execute(text(
                    f"ALTER TABLE workspaces ADD COLUMN {col_name} TEXT DEFAULT {default}"
                ))

    # Restore any workspaces that were auto-migrated to chromadb back to moorcheh,
    # now that the app bundles the Moorcheh key via the project .env.
    with _engine.begin() as conn:
        conn.execute(text(
            "UPDATE workspaces SET vector_backend='moorcheh' WHERE vector_backend='chromadb'"
        ))


# Create tables + migrate on import
init_db()
_migrate_schema()


# ---------------------------------------------------------------------------
# Session helper
# ---------------------------------------------------------------------------

def get_session() -> Session:
    return Session(_engine)


# ---------------------------------------------------------------------------
# FileRecord CRUD
# ---------------------------------------------------------------------------

def upsert_file(hash: str, path: str, **fields) -> FileRecord:
    """Insert or update a FileRecord keyed by hash."""
    with get_session() as session:
        record = session.get(FileRecord, hash)
        if record is None:
            record = FileRecord(hash=hash)
            session.add(record)
        record.path = path
        for k, v in fields.items():
            if hasattr(record, k):
                setattr(record, k, v)
        session.commit()
        session.refresh(record)
        # Detach before session closes
        session.expunge(record)
        return record


def delete_file(hash: str) -> bool:
    """Delete the FileRecord for *hash*. Returns True if a row was removed."""
    with get_session() as session:
        deleted = session.query(FileRecord).filter_by(hash=hash).delete()
        session.commit()
        return deleted > 0


def get_file_by_path(path: str) -> FileRecord | None:
    with get_session() as session:
        rec = session.query(FileRecord).filter_by(path=str(path)).first()
        if rec:
            session.expunge(rec)
        return rec


def get_file_by_hash(hash: str) -> FileRecord | None:
    with get_session() as session:
        rec = session.get(FileRecord, hash)
        if rec:
            session.expunge(rec)
        return rec


def get_files_for_workspace(workspace_id: str) -> list[FileRecord]:
    """Return all FileRecord rows belonging to a workspace."""
    with get_session() as session:
        rows = (
            session.query(FileRecord)
            .join(WorkspaceFile, WorkspaceFile.file_hash == FileRecord.hash)
            .filter(WorkspaceFile.workspace_id == workspace_id)
            .all()
        )
        for r in rows:
            session.expunge(r)
        return rows


def file_already_indexed(hash: str) -> bool:
    """Return True if a FileRecord with status 'done' exists for this hash."""
    with get_session() as session:
        rec = session.get(FileRecord, hash)
        return rec is not None and rec.status == "done"


def count_workspace_refs(hash: str) -> int:
    """Return the number of workspaces that reference this file hash."""
    with get_session() as session:
        return session.query(WorkspaceFile).filter_by(file_hash=hash).count()


def get_all_files() -> list[FileRecord]:
    """Return all FileRecord rows (for orphan purge etc.)."""
    with get_session() as session:
        rows = session.query(FileRecord).all()
        for r in rows:
            session.expunge(r)
        return rows


# ---------------------------------------------------------------------------
# Workspace CRUD
# ---------------------------------------------------------------------------

def create_workspace(
    name: str,
    emoji: str = "📁",
    colour: str = "#4F46E5",
    processing_path: str = "hosted",
    model_name: str | None = None,
    embed_model: str | None = None,
    user_api_key: str | None = None,
    user_api_base: str | None = None,
    vector_backend: str = "moorcheh",
) -> Workspace:
    with get_session() as session:
        ws = Workspace(
            id=str(uuid.uuid4()),
            name=name,
            emoji=emoji,
            colour=colour,
            created_at=_utcnow(),
            last_opened=_utcnow(),
            processing_path=processing_path,
            model_name=model_name or (
                "openai/gpt-oss-120b" if processing_path == "hosted" else "qwen3.5:2b"
            ),
            embed_model=embed_model or "nomic-embed-text",
            user_api_key=user_api_key,
            user_api_base=user_api_base,
            vector_backend=vector_backend,
        )
        session.add(ws)
        session.commit()
        session.refresh(ws)
        session.expunge(ws)
        return ws


def get_workspace(workspace_id: str) -> Workspace | None:
    with get_session() as session:
        ws = session.get(Workspace, workspace_id)
        if ws:
            session.expunge(ws)
        return ws


def list_workspaces() -> list[Workspace]:
    with get_session() as session:
        rows = session.query(Workspace).order_by(Workspace.last_opened.desc()).all()
        for r in rows:
            session.expunge(r)
        return rows


def update_workspace(workspace_id: str, **fields) -> Workspace | None:
    with get_session() as session:
        ws = session.get(Workspace, workspace_id)
        if ws is None:
            return None
        for k, v in fields.items():
            if hasattr(ws, k):
                setattr(ws, k, v)
        session.commit()
        session.refresh(ws)
        session.expunge(ws)
        return ws


def delete_workspace(workspace_id: str) -> int:
    """
    Delete a workspace and cascade-remove its folder/file associations.
    Orphaned file_records (not referenced by any other workspace) are also purged.
    Returns count of orphaned file_records removed.
    """
    with get_session() as session:
        # Collect hashes before deleting associations
        refs = session.query(WorkspaceFile).filter_by(workspace_id=workspace_id).all()
        hashes = [r.file_hash for r in refs]

        # Delete the workspace — CASCADE handles workspace_files + workspace_folders
        session.query(Workspace).filter_by(id=workspace_id).delete()
        session.commit()

        # Now check which hashes are orphaned (no remaining workspace references)
        orphaned = 0
        for h in hashes:
            remaining = session.query(WorkspaceFile).filter_by(file_hash=h).count()
            if remaining == 0:
                session.query(FileRecord).filter_by(hash=h).delete()
                orphaned += 1

        session.commit()
        return orphaned


# ---------------------------------------------------------------------------
# Workspace folder helpers
# ---------------------------------------------------------------------------

def add_folder_to_workspace(workspace_id: str, folder_path: str) -> WorkspaceFolder:
    with get_session() as session:
        existing = (
            session.query(WorkspaceFolder)
            .filter_by(workspace_id=workspace_id, folder_path=folder_path)
            .first()
        )
        if existing:
            session.expunge(existing)
            return existing
        wf = WorkspaceFolder(
            workspace_id=workspace_id,
            folder_path=folder_path,
            added_at=_utcnow(),
        )
        session.add(wf)
        session.commit()
        session.refresh(wf)
        session.expunge(wf)
        return wf


def remove_folder_from_workspace(workspace_id: str, folder_path: str) -> None:
    with get_session() as session:
        session.query(WorkspaceFolder).filter_by(
            workspace_id=workspace_id, folder_path=folder_path
        ).delete()
        session.commit()


def get_folders_for_workspace(workspace_id: str) -> list[str]:
    with get_session() as session:
        rows = session.query(WorkspaceFolder).filter_by(workspace_id=workspace_id).all()
        return [r.folder_path for r in rows]


# ---------------------------------------------------------------------------
# Workspace file helpers
# ---------------------------------------------------------------------------

def add_file_to_workspace(workspace_id: str, file_hash: str) -> WorkspaceFile:
    with get_session() as session:
        existing = (
            session.query(WorkspaceFile)
            .filter_by(workspace_id=workspace_id, file_hash=file_hash)
            .first()
        )
        if existing:
            session.expunge(existing)
            return existing
        wf = WorkspaceFile(
            workspace_id=workspace_id,
            file_hash=file_hash,
            added_at=_utcnow(),
        )
        session.add(wf)
        session.commit()
        session.refresh(wf)
        session.expunge(wf)
        return wf


def remove_file_from_workspace(workspace_id: str, file_hash: str) -> None:
    with get_session() as session:
        session.query(WorkspaceFile).filter_by(
            workspace_id=workspace_id, file_hash=file_hash
        ).delete()
        session.commit()


def get_workspace_file_count(workspace_id: str) -> int:
    with get_session() as session:
        return session.query(WorkspaceFile).filter_by(workspace_id=workspace_id).count()


# ---------------------------------------------------------------------------
# JSON helpers (kept for compatibility)
# ---------------------------------------------------------------------------

def parse_keywords(record: FileRecord) -> list[str]:
    try:
        return json.loads(record.keywords or "[]")
    except (json.JSONDecodeError, TypeError):
        return []


def parse_entities(record: FileRecord) -> dict:
    try:
        return json.loads(record.entities or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
