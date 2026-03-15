"""
Moorcheh vector store wrapper.

Same interface as vector_store_local.py (ChromaDB) so the router can swap
them transparently. Uses the moorcheh-sdk Python package.

Namespace: "bina-vault" (vector type, 768 dimensions for nomic-embed-text).
"""
from __future__ import annotations

import logging
from typing import Any

from config import MOORCHEH_API_KEY, MOORCHEH_NAMESPACE

logger = logging.getLogger(__name__)

# Lazy-init to avoid import errors when API key isn't set
_client = None
_namespace_ready = False
_auth_failed = False   # set True on first 401/403 — stops log spam on every call


def _get_client():
    """Lazy-init the MoorchehClient singleton."""
    global _client
    if _client is None:
        import os as _os
        # Read at call time so a newly-saved key (written to os.environ by
        # save_app_settings) is picked up without a process restart.
        api_key = _os.environ.get("MOORCHEH_API_KEY") or MOORCHEH_API_KEY
        if not api_key:
            raise ValueError(
                "MOORCHEH_API_KEY not set. Add it to ~/.bina/.env or set the "
                "environment variable. Get a free key at https://console.moorcheh.ai"
            )
        from moorcheh_sdk import MoorchehClient
        _client = MoorchehClient(
            api_key=api_key,
            base_url="https://api.moorcheh.ai/v1",
        )
    return _client


def reset_client() -> None:
    """Discard cached client so the next call picks up a new API key."""
    global _client, _namespace_ready, _auth_failed
    _client = None
    _namespace_ready = False
    _auth_failed = False   # allow retrying after the user sets a new key


def ping() -> None:
    """
    Verify the API key is valid by making a lightweight authenticated request.
    Raises on auth failure or network error — does NOT catch exceptions.
    Tries several SDK methods to handle different SDK versions.
    """
    import os as _os
    key = _os.environ.get("MOORCHEH_API_KEY") or MOORCHEH_API_KEY
    if not key:
        raise ValueError("MOORCHEH_API_KEY not set")
    client = _get_client()

    # Try the lightest available call to verify auth; raise on 401/403/network errors.
    # Different SDK versions may expose different method names.
    for method in ("namespaces.list", "namespaces.list_all", "list_namespaces"):
        try:
            obj = client
            for part in method.split("."):
                obj = getattr(obj, part)
            obj()
            return
        except AttributeError:
            continue
        except Exception:
            raise  # real error (auth failure, network) — propagate

    # Last resort: attempt to get namespace info (non-existent namespace → 404 is OK,
    # auth error → exception propagates)
    try:
        client.namespaces.get(MOORCHEH_NAMESPACE)
    except Exception as e:
        if "not found" in str(e).lower() or "404" in str(e):
            return  # namespace doesn't exist yet, but auth succeeded
        raise


def _ensure_namespace() -> None:
    """Create the namespace if it doesn't exist yet.

    Raises on auth failures so callers know Moorcheh is unavailable.
    Does NOT raise if the namespace already exists (409 / "already exists").
    Auth failures are cached (_auth_failed=True) to avoid log-spam on every call.
    """
    global _namespace_ready, _auth_failed
    if _namespace_ready:
        return
    if _auth_failed:
        # Suppress repeated logging — just raise so callers fall back to ChromaDB.
        raise ValueError("Moorcheh API key is invalid. Update it in Settings → Vector Search.")
    try:
        client = _get_client()
        client.namespaces.create(
            namespace_name=MOORCHEH_NAMESPACE,
            type="vector",
            vector_dimension=768,  # nomic-embed-text output
        )
        _namespace_ready = True
    except Exception as e:
        err_str = str(e).lower()
        if "already exists" in err_str or "409" in str(e):
            # Namespace already exists — that's fine, mark ready
            _namespace_ready = True
        elif any(k in err_str for k in ("forbidden", "unauthorized", "401", "403")):
            # Auth failure: cache it so we don't hammer the API or spam logs.
            _auth_failed = True
            logger.warning(
                "Moorcheh API key is invalid or missing — falling back to ChromaDB. "
                "Fix it in Settings → Vector Search (Moorcheh)."
            )
            raise
        else:
            # Network / other transient error — log but don't crash indexing
            logger.warning(f"Moorcheh namespace create: {e}")
            _namespace_ready = True


# ── Public interface (matches vector_store_local.py) ─────────────────────────

def upsert(
    file_hash: str,
    embedding: list[float],
    metadata: dict,
) -> None:
    """Insert or update a document's embedding."""
    _ensure_namespace()
    client = _get_client()
    client.upload_vectors(
        namespace_name=MOORCHEH_NAMESPACE,
        vectors=[{
            "id": file_hash,
            "vector": embedding,
            "source": metadata.get("path", ""),
            "index": 0,
        }],
    )


def delete(file_hash: str) -> None:
    """Remove a document's embedding by its hash."""
    try:
        _ensure_namespace()
        client = _get_client()
        # Use the REST API directly if SDK doesn't expose delete
        client.delete_vectors(
            namespace_name=MOORCHEH_NAMESPACE,
            ids=[file_hash],
        )
    except Exception:
        pass


def query(
    embedding: list[float],
    n_results: int = 20,
    hashes: list[str] | None = None,
) -> list[dict]:
    """
    Return up to n_results most similar documents.
    Result format matches vector_store_local: {hash, path, score, ...}
    """
    _ensure_namespace()
    client = _get_client()
    results = client.search(
        namespaces=[MOORCHEH_NAMESPACE],
        query=embedding,
        top_k=n_results,
    )

    output = []
    matches = results.get("matches", results.get("results", []))
    for match in matches:
        doc_id = match.get("id", "")
        score = float(match.get("score", 0.0))
        source = match.get("source", match.get("metadata", {}).get("path", ""))
        output.append({
            "hash": doc_id,
            "path": source,
            "distance": max(0.0, 1.0 - score),
            "score": score,
            "doc_type": match.get("metadata", {}).get("doc_type", ""),
            "summary_snippet": match.get("text", "")[:200],
        })

    # Post-filter by workspace hashes if provided
    if hashes is not None:
        hash_set = set(hashes)
        output = [r for r in output if r["hash"] in hash_set]

    return output


def answer_query(query_text: str) -> str:
    """
    Use Moorcheh's built-in RAG /answer endpoint.
    Returns a natural language answer grounded in indexed documents.
    """
    _ensure_namespace()
    client = _get_client()
    result = client.answer.generate(
        namespace=MOORCHEH_NAMESPACE,
        query=query_text,
    )
    return result.get("answer", str(result))


def get_embeddings_by_hashes(hashes: list[str]) -> dict[str, list[float]]:
    """
    Fetch stored embeddings for graph building.
    Moorcheh may not support fetch-by-ID for vectors — return empty
    and let the graph module fall back to re-embedding.
    """
    if not hashes:
        return {}
    # Moorcheh SDK may not have a fetch-by-ID endpoint for raw vectors.
    # The graph module handles the empty-return case gracefully.
    logger.debug("get_embeddings_by_hashes called on Moorcheh — not supported, returning empty")
    return {}


def count() -> int:
    """Return count of vectors in the namespace."""
    try:
        _ensure_namespace()
        client = _get_client()
        info = client.namespaces.get(MOORCHEH_NAMESPACE)
        return info.get("vector_count", info.get("count", 0))
    except Exception:
        return 0


def clear_all() -> None:
    """Delete and recreate the Moorcheh namespace."""
    global _namespace_ready
    try:
        client = _get_client()
        client.namespaces.delete(MOORCHEH_NAMESPACE)
    except Exception:
        pass
    _namespace_ready = False
    _ensure_namespace()
