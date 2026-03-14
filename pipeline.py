"""
Local AI pipeline.

process_file(path, force=False)
    1. MD5 hash → skip if unchanged and force=False
    2. Extract text → smart sample
    3. Ollama LLM → structured JSON (summary, keywords, entities, doc_type)
    4. Ollama embed → 384-dim vector
    5. Write to SQLite (store.py) + ChromaDB (vector_store.py)
    6. Return metadata dict
"""
from __future__ import annotations

import hashlib
import json
import re
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
    # Strip markdown code fences
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    text = re.sub(r"\s*```$", "", text).strip()
    # Remove // line comments (not valid JSON)
    text = re.sub(r"//[^\n]*", "", text)
    # Remove trailing commas before ] or }
    text = re.sub(r",\s*([}\]])", r"\1", text)
    # Replace Python-style None/True/False with JSON equivalents
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
        # Try to extract the first complete JSON object from the string
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(_repair_json(match.group(0)))
            except json.JSONDecodeError:
                pass
        raise


def _call_llm(text: str) -> dict[str, Any]:
    prompt = _LLM_PROMPT.format(text=text)
    # num_ctx must cover input + output tokens.
    # Input estimate: chars / 4.  Output budget: 512 tokens for the JSON.
    # Floor at 1024, cap at 4096.  This trims the KV-cache allocation vs
    # Ollama's default, reducing peak RAM by ~30–40% during indexing.
    # No format="json": constrained grammar sampling hangs on some documents.
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
    """Explicitly unload both models from RAM when indexing is complete.

    Called by main.py after a reindex/index run so the LLM (~2 GB) is freed
    immediately rather than lingering for Ollama's 5-minute keep_alive window.
    """
    try:
        ollama.chat(model=LLM_MODEL, messages=[], keep_alive=0)
    except Exception:
        pass
    try:
        ollama.embeddings(model=EMBED_MODEL, prompt="", keep_alive=0)
    except Exception:
        pass


def process_file(path: str | Path, force: bool = False) -> dict[str, Any]:
    """
    Process a single file through the full AI pipeline.

    Returns a dict with keys: path, hash, summary, keywords, entities,
    doc_type, status, error.
    Raises nothing — all errors are caught and stored as status="failed".
    """
    path = Path(path).resolve()
    result: dict[str, Any] = {"path": str(path), "status": "ok", "error": None}

    try:
        file_hash = _md5(path)

        # Deduplication: skip if file unchanged
        if not force:
            existing = store.get_file(str(path))
            if existing and existing.hash == file_hash and existing.status == "ok":
                return {
                    "path": str(path),
                    "hash": file_hash,
                    "summary": existing.summary,
                    "keywords": store.parse_keywords(existing),
                    "entities": store.parse_entities(existing),
                    "doc_type": existing.doc_type,
                    "status": "skipped",
                    "error": None,
                }

        # Text extraction + sampling
        extraction = extract(path)
        sampled_text = sample(extraction.pages)

        if not sampled_text.strip():
            raise ValueError("No text could be extracted from this file.")

        # LLM analysis — cap text to LLM_CHAR_BUDGET so the 3b model
        # doesn't get overwhelmed and return empty fields.
        llm_text = sampled_text[:LLM_CHAR_BUDGET]
        llm_error: str | None = None
        try:
            llm_data = _call_llm(llm_text)
        except Exception as llm_err:
            llm_error = str(llm_err)
            llm_data = {
                "summary": None,   # kept blank — never show raw exception in UI
                "keywords": [],
                "entities": {},
                "doc_type": "Other",
            }

        summary = llm_data.get("summary", "")
        keywords = llm_data.get("keywords", [])
        entities = llm_data.get("entities", {})
        doc_type = llm_data.get("doc_type", "Other")

        # Embedding — nomic-embed-text has an 8192-token context window;
        # cap the raw text portion to avoid exceeding it (~6000 chars safe).
        embed_text = f"{summary}\n{' '.join(keywords)}\n{sampled_text[:6000]}"
        embedding = _call_embed(embed_text)

        # Persist — status="ok" even when LLM failed so the file stays
        # searchable via its embedding; the raw error goes in the error column.
        store.upsert_file(
            path=str(path),
            file_hash=file_hash,
            summary=summary,
            keywords=keywords,
            entities=entities,
            doc_type=doc_type,
            status="ok",
            error=llm_error,
        )
        vector_store.upsert(
            path=str(path),
            embedding=embedding,
            doc_type=doc_type,
            summary=summary,
        )

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
        store.upsert_file(
            path=str(path),
            file_hash=_md5(path) if path.exists() else "",
            status="failed",
            error=error_msg,
        )

    return result


def remove_file(path: str | Path) -> None:
    """Remove a deleted file from all three stores (SQLite, ChromaDB, graph)."""
    path = str(Path(path).resolve())
    store.delete_file(path)
    vector_store.delete(path)
    _graph.mark_dirty()   # force graph rebuild from updated stores on next request
