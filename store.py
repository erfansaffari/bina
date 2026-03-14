"""
SQLite metadata store via SQLAlchemy.

Schema
------
file_records:
    hash         TEXT PRIMARY KEY          -- MD5 of file bytes
    path         TEXT NOT NULL, indexed    -- last known absolute path
    summary      TEXT
    keywords     TEXT  -- JSON list[str]
    entities     TEXT  -- JSON dict{persons,companies,dates,projects,locations}
    doc_type     TEXT
    status       TEXT  -- "pending" | "done" | "failed"
    error        TEXT
    processed_at TEXT  -- ISO-8601 timestamp

workspaces:
    id           TEXT PRIMARY KEY  -- UUID
    name         TEXT NOT NULL
    emoji        TEXT
    colour       TEXT
    created_at   TEXT
    last_opened  TEXT

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
    create_engine, event,
)
from sqlalchemy.orm import DeclarativeBase, Session

from config import DB_PATH


class Base(DeclarativeBase):
    pass


class FileRecord(Base):
    __tablename__ = "file_records"

    hash         = Column(String, primary_key=True)
    path         = Column(String, nullable=False, index=True)
    summary      = Column(Text)
    keywords     = Column(Text)     # JSON list[str]
    entities     = Column(Text)     # JSON dict
    doc_type     = Column(String)
    status       = Column(String, default="pending")
    error        = Column(Text)
    processed_at = Column(DateTime)


class Workspace(Base):
    __tablename__ = "workspaces"

    id          = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name        = Column(String, nullable=False)
    emoji       = Column(String, default="📁")
    colour      = Column(String, default="#4F46E5")
    created_at  = Column(DateTime, default=datetime.utcnow)
    last_opened = Column(DateTime, default=datetime.utcnow)


class WorkspaceFolder(Base):
    __tablename__ = "workspace_folders"

    workspace_id = Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    folder_path  = Column(String, primary_key=True)
    added_at     = Column(DateTime, default=datetime.utcnow)


class WorkspaceFile(Base):
    __tablename__ = "workspace_files"

    workspace_id = Column(String, ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True)
    file_hash    = Column(String, ForeignKey("file_records.hash", ondelete="CASCADE"), primary_key=True)
    added_at     = Column(DateTime, default=datetime.utcnow)


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


# Create tables immediately on import (safe to call multiple times)
init_db()


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
) -> Workspace:
    with get_session() as session:
        ws = Workspace(
            id=str(uuid.uuid4()),
            name=name,
            emoji=emoji,
            colour=colour,
            created_at=datetime.utcnow(),
            last_opened=datetime.utcnow(),
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
            added_at=datetime.utcnow(),
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
            added_at=datetime.utcnow(),
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
