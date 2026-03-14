"""
Local AI pipeline.

process_file(path, workspace_id, force=False)
    1. MD5 hash → register in workspace; skip AI if already indexed globally
    2. Extract text → smart sample
    3. Ollama LLM → structured JSON (summary, keywords, entities, doc_type)
    4. Ollama embed → 384-dim vector
    5. Write to SQLite (store.py) + ChromaDB (vector_store.py)
    6. Return metadata dict

remove_file(path, workspace_id)
    Remove a file from a specific workspace.
    If no other workspace references the file, purge it globally.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import ollama

import store
import vector_store
import graph as _graph
from config import EMBED_MODEL, LLM_MODEL, LLM_CHAR_BUDGET
from extractor import extract
from sampler import sample

_LLM_PROMPT = """\
You are a document analysis assistant. Analyse the document text below and respond with ONLY a valid JSON object — no markdown, no explanation.

Required JSON structure:
{{
  "summary": "<exactly 3 sentences describing what this document is about>",
  "keywords": ["<keyword1>", "<keyword2>", "...", "<up to 10 keywords>"],
  "entities": {{
    "persons": ["<name>", ...],
    "companies": ["<name>", ...],
    "dates": ["<date string>", ...],
    "projects": ["<project name>", ...],
    "locations": ["<location>", ...]
  }},
  "doc_type": "<one of: Invoice, Research Paper, Meeting Notes, Contract, Book Chapter, Report, Presentation, Email, Legal Document, Technical Documentation, Personal Notes, Assignment, Course Syllabus, Lecture Notes, README, Other>"
}}

Document text:
---
{text}
---

Respond with ONLY the JSON object."""


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _repair_json(text: str) -> str:
    """Best-effort repair of common LLM JSON output quirks."""
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r",\s*([}\]])", r"\1", text)
    text = re.sub(r"\bNone\b", "null", text)
    text = re.sub(r"\bTrue\b", "true", text)
    text = re.sub(r"\bFalse\b", "false", text)
    return text


def _parse_llm_response(response_text: str) -> dict[str, Any]:
    """Robustly parse the LLM's JSON response with multi-stage repair."""
    text = _repair_json(response_text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(_repair_json(match.group(0)))
            except json.JSONDecodeError:
                pass
        raise


def _call_llm(text: str) -> dict[str, Any]:
    prompt = _LLM_PROMPT.format(text=text)
    input_tokens = len(prompt) // 4
    num_ctx = max(1024, min(input_tokens + 512, 4096))
    response = ollama.chat(
        model=LLM_MODEL,
        messages=[{"role": "user", "content": prompt}],
        options={"temperature": 0.1, "num_ctx": num_ctx},
    )
    raw = response["message"]["content"]
    return _parse_llm_response(raw)


def _call_embed(text: str) -> list[float]:
    response = ollama.embeddings(model=EMBED_MODEL, prompt=text)
    return response["embedding"]


def unload_models() -> None:
    """Explicitly unload both models from RAM when indexing is complete."""
    try:
        ollama.chat(model=LLM_MODEL, messages=[], keep_alive=0)
    except Exception:
        pass
    try:
        ollama.embeddings(model=EMBED_MODEL, prompt="", keep_alive=0)
    except Exception:
        pass


def process_file(
    path: str | Path,
    workspace_id: str,
    force: bool = False,
) -> dict[str, Any]:
    """
    Process a single file for a specific workspace.

    If the file has already been indexed globally (same hash, status='done'),
    AI processing is skipped — only the workspace association is registered.

    Returns a dict with keys: path, hash, summary, keywords, entities,
    doc_type, status, error.
    Raises nothing — all errors are caught and stored as status='failed'.
    """
    path = Path(path).resolve()
    result: dict[str, Any] = {"path": str(path), "status": "ok", "error": None}

    try:
        file_hash = _md5(path)

        # Always register file in this workspace
        store.add_file_to_workspace(workspace_id, file_hash)

        # Deduplication: skip AI if this hash is already fully indexed globally
        if not force and store.file_already_indexed(file_hash):
            existing = store.get_file_by_hash(file_hash)
            _graph.mark_dirty(workspace_id)
            return {
                "path": str(path),
                "hash": file_hash,
                "summary": existing.summary if existing else "",
                "keywords": store.parse_keywords(existing) if existing else [],
                "entities": store.parse_entities(existing) if existing else {},
                "doc_type": existing.doc_type if existing else "Other",
                "status": "skipped",
                "error": None,
            }

        # Text extraction + sampling
        extraction = extract(path)
        sampled_text = sample(extraction.pages)

        if not sampled_text.strip():
            raise ValueError("No text could be extracted from this file.")

        # LLM analysis
        llm_text = sampled_text[:LLM_CHAR_BUDGET]
        llm_error: str | None = None
        try:
            llm_data = _call_llm(llm_text)
        except Exception as llm_err:
            llm_error = str(llm_err)
            llm_data = {
                "summary": None,
                "keywords": [],
                "entities": {},
                "doc_type": "Other",
            }

        summary = llm_data.get("summary", "")
        keywords = llm_data.get("keywords", [])
        entities = llm_data.get("entities", {})
        doc_type = llm_data.get("doc_type", "Other")

        # Embedding
        embed_text = f"{summary}\n{' '.join(keywords)}\n{sampled_text[:6000]}"
        embedding = _call_embed(embed_text)

        # Persist to SQLite — hash is the primary key
        store.upsert_file(
            hash=file_hash,
            path=str(path),
            summary=summary,
            keywords=json.dumps(keywords or []),
            entities=json.dumps(entities or {}),
            doc_type=doc_type,
            status="done",
            error=llm_error,
            processed_at=datetime.now(timezone.utc),
        )

        # Persist to ChromaDB — ID is the hash
        vector_store.upsert(
            file_hash=file_hash,
            embedding=embedding,
            metadata={
                "path": str(path),
                "doc_type": doc_type or "",
                "summary_snippet": (summary or "")[:200],
            },
        )

        _graph.mark_dirty(workspace_id)

        result.update(
            {
                "hash": file_hash,
                "summary": summary,
                "keywords": keywords,
                "entities": entities,
                "doc_type": doc_type,
            }
        )

    except Exception as exc:
        error_msg = str(exc)
        result["status"] = "failed"
        result["error"] = error_msg
        try:
            fh = _md5(path) if path.exists() else ""
            store.upsert_file(
                hash=fh,
                path=str(path),
                status="failed",
                error=error_msg,
            )
        except Exception:
            pass

    return result


def remove_file(path: str | Path, workspace_id: str) -> None:
    """
    Remove a file from a specific workspace.
    Only purge from global stores if no other workspace references it.
    """
    path_str = str(Path(path).resolve())
    record = store.get_file_by_path(path_str)
    if not record:
        return

    store.remove_file_from_workspace(workspace_id, record.hash)
    _graph.mark_dirty(workspace_id)

    remaining_refs = store.count_workspace_refs(record.hash)
    if remaining_refs == 0:
        vector_store.delete(record.hash)
        store.delete_file(record.hash)
