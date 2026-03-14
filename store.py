"""
SQLite metadata store via SQLAlchemy.

Schema
------
files:
    id           INTEGER PRIMARY KEY
    path         TEXT UNIQUE NOT NULL       -- absolute path
    hash         TEXT NOT NULL              -- MD5 of file bytes
    summary      TEXT                       -- 3-sentence AI summary
    keywords     TEXT                       -- JSON list[str]
    entities     TEXT                       -- JSON dict{persons,companies,dates,projects,locations}
    doc_type     TEXT                       -- AI-classified document type
    processed_at TEXT                       -- ISO-8601 timestamp
    status       TEXT                       -- "ok" | "failed"
    error        TEXT                       -- error message if status="failed"
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from config import DB_PATH


class Base(DeclarativeBase):
    pass


class FileRecord(Base):
    __tablename__ = "files"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(unique=True, nullable=False)
    hash: Mapped[str] = mapped_column(nullable=False)
    summary: Mapped[str | None]
    keywords: Mapped[str | None]   # JSON
    entities: Mapped[str | None]   # JSON
    doc_type: Mapped[str | None]
    processed_at: Mapped[str | None]
    status: Mapped[str] = mapped_column(default="ok")
    error: Mapped[str | None]


_engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)
Base.metadata.create_all(_engine)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def get_session() -> Session:
    return Session(_engine)


def get_file(path: str | Path) -> FileRecord | None:
    with get_session() as session:
        return session.query(FileRecord).filter_by(path=str(path)).first()


def upsert_file(
    path: str | Path,
    file_hash: str,
    summary: str | None = None,
    keywords: list[str] | None = None,
    entities: dict | None = None,
    doc_type: str | None = None,
    status: str = "ok",
    error: str | None = None,
) -> FileRecord:
    with get_session() as session:
        record = session.query(FileRecord).filter_by(path=str(path)).first()
        if record is None:
            record = FileRecord(path=str(path))
            session.add(record)
        record.hash = file_hash
        record.summary = summary
        record.keywords = json.dumps(keywords or [])
        record.entities = json.dumps(entities or {})
        record.doc_type = doc_type
        record.processed_at = datetime.now(timezone.utc).isoformat()
        record.status = status
        record.error = error
        session.commit()
        session.refresh(record)
        return record


def delete_file(path: str | Path) -> bool:
    """Delete the record for *path*. Returns True if a row was removed."""
    with get_session() as session:
        deleted = session.query(FileRecord).filter_by(path=str(path)).delete()
        session.commit()
        return deleted > 0


def get_all_files() -> list[FileRecord]:
    with get_session() as session:
        rows = session.query(FileRecord).all()
        # Detach from session so they can be used after close
        for row in rows:
            session.expunge(row)
        return rows


def get_file_count() -> int:
    with get_session() as session:
        return session.query(FileRecord).count()


def get_ok_count() -> int:
    with get_session() as session:
        return session.query(FileRecord).filter_by(status="ok").count()


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
