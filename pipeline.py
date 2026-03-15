"""
Local AI pipeline.

process_file(path, workspace_id, force=False)
    1. MD5 hash → register in workspace; skip AI if already indexed globally
    2. Extract text (or image bytes for images) → smart sample
    3. Call inference (hosted GPT-OSS, local Ollama, or user API) for structured JSON
    4. Embed via nomic-embed-text (local) or OpenAI fallback
    5. Write to SQLite (store.py) + vector store (Moorcheh or ChromaDB)
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

import store
import vector_store_router
from inference import call_inference, embed_text
from config import LLM_CHAR_BUDGET
from extractor import extract
from sampler import sample
import graph as _graph


def _md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _repair_json(text: str) -> str:
    """Best-effort repair of common LLM JSON output quirks."""
    # Strip <think>...</think> blocks (qwen3.5 thinking mode)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
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


def unload_models() -> None:
    """Explicitly unload local Ollama models from RAM when indexing is complete."""
    try:
        import ollama
        from config import LOCAL_MODEL, LOCAL_EMBED_MODEL
        ollama.chat(model=LOCAL_MODEL, messages=[], keep_alive=0)
    except Exception:
        pass
    try:
        import ollama
        from config import LOCAL_EMBED_MODEL
        ollama.embeddings(model=LOCAL_EMBED_MODEL, prompt="", keep_alive=0)
    except Exception:
        pass


def process_file(
    path: str | Path,
    workspace_id: str,
    force: bool = False,
) -> dict[str, Any]:
    """
    Process a single file for a specific workspace.

    Uses the workspace's configured processing path (hosted/local/user_api)
    for inference, and the workspace's vector backend for storage.

    Returns a dict with keys: path, hash, summary, keywords, entities,
    doc_type, status, error.
    """
    path = Path(path).resolve()
    result: dict[str, Any] = {"path": str(path), "status": "ok", "error": None}

    try:
        file_hash = _md5(path)

        # Load workspace config for inference + vector store selection
        workspace = store.get_workspace(workspace_id)
        vstore = vector_store_router.get_store(workspace_id)

        # Deduplication: skip AI if this hash is already fully indexed globally.
        if not force and store.file_already_indexed(file_hash):
            store.add_file_to_workspace(workspace_id, file_hash)
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

        # Text / image extraction
        extraction = extract(path)

        if extraction.is_image:
            # Image path: send bytes directly to inference
            img_size_mb = len(extraction.image_bytes) / 1_048_576
            if img_size_mb > 20:
                raise ValueError(
                    f"Image too large to process ({img_size_mb:.1f} MB > 20 MB limit)."
                )

            raw_response = call_inference(
                text="", workspace=workspace,
                image_bytes=extraction.image_bytes,
            )
            llm_data = _parse_llm_response(raw_response)
            summary = llm_data.get("summary", "")
            keywords = llm_data.get("keywords", [])
            sampled_text = f"{summary} {' '.join(keywords)}"

        else:
            # Text path: extract, sample, analyse
            sampled_text = sample(extraction.pages)
            if not sampled_text.strip():
                raise ValueError("No text could be extracted from this file.")

            raw_response = call_inference(
                text=sampled_text[:LLM_CHAR_BUDGET],
                workspace=workspace,
            )
            llm_data = _parse_llm_response(raw_response)
            summary = llm_data.get("summary", "")
            keywords = llm_data.get("keywords", [])

        entities = llm_data.get("entities", {})
        doc_type = llm_data.get("doc_type", "Other")

        # Handle empty summary
        llm_error: str | None = None
        if not summary:
            llm_error = "Model returned empty summary"

        # Determine which embed model was used
        embed_model_name = getattr(workspace, "embed_model", "nomic-embed-text") if workspace else "nomic-embed-text"

        # Embedding
        embed_text_str = f"{summary}\n{' '.join(keywords)}\n{sampled_text[:6000]}"
        embedding = embed_text(embed_text_str, workspace=workspace)

        # Persist to SQLite
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
            embedding_model=embed_model_name,
        )

        store.add_file_to_workspace(workspace_id, file_hash)

        # Persist to vector store (Moorcheh or ChromaDB)
        _meta = {
            "path": str(path),
            "doc_type": doc_type or "",
            "summary_snippet": (summary or "")[:200],
            "embedding_model": embed_model_name,
        }
        import vector_store_local as _local_vs
        try:
            vstore.upsert(file_hash=file_hash, embedding=embedding, metadata=_meta)
        except Exception as _ve:
            # Primary store failed (e.g. Moorcheh auth error). Fall back to local
            # ChromaDB so the file is still searchable — user can fix their API key
            # in Settings and re-index later.
            import logging as _log
            _log.getLogger(__name__).warning(
                f"Primary vector store failed, falling back to ChromaDB: {_ve}"
            )
            vstore = _local_vs
            _local_vs.upsert(file_hash=file_hash, embedding=embedding, metadata=_meta)

        # Always cache embedding in local ChromaDB so graph.py can always
        # retrieve raw vectors for cosine-similarity edge building.
        # Moorcheh does not support get_embeddings_by_hashes(), so without this
        # local cache the graph would silently re-embed every file on each build.
        if vstore is not _local_vs:
            try:
                _local_vs.upsert(
                    file_hash=file_hash,
                    embedding=embedding,
                    metadata=_meta,
                )
            except Exception:
                pass

        _graph.mark_dirty(workspace_id)

        result.update({
            "hash": file_hash,
            "summary": summary,
            "keywords": keywords,
            "entities": entities,
            "doc_type": doc_type,
        })

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
        vstore = vector_store_router.get_store(workspace_id)
        vstore.delete(record.hash)
        store.delete_file(record.hash)
