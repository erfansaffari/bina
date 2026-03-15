"""
Vector store router — picks the right backend per workspace.

Usage:
    from vector_store_router import get_store
    vstore = get_store(workspace_id)   # returns Moorcheh or ChromaDB module
    vstore.upsert(file_hash, embedding, metadata)
    vstore.query(embedding, n_results=20, hashes=[...])

Both backends expose the same interface:
    upsert(file_hash, embedding, metadata)
    delete(file_hash)
    query(embedding, n_results, hashes) -> list[dict]
    get_embeddings_by_hashes(hashes) -> dict[str, list[float]]
    count() -> int
"""
from __future__ import annotations

import logging
from types import ModuleType

logger = logging.getLogger(__name__)


def get_store(workspace_id: str | None = None) -> ModuleType:
    """
    Return the correct vector store module for the given workspace.

    Default is local ChromaDB — no API key needed, fully offline.
    Moorcheh is opt-in: only used when the workspace has vector_backend='moorcheh'
    AND a valid MOORCHEH_API_KEY is set AND auth has not previously failed.

    Once Moorcheh auth fails (_auth_failed=True), it is skipped for all calls
    until reset_client() is called (i.e. the user saves a new key in Settings).
    """
    if workspace_id:
        try:
            import store as _store
            ws = _store.get_workspace(workspace_id)
            backend = getattr(ws, "vector_backend", "chromadb") if ws else "chromadb"
            if backend == "moorcheh":
                # Only use Moorcheh if key exists AND auth hasn't previously failed
                try:
                    import os as _os
                    from config import MOORCHEH_API_KEY
                    key = _os.environ.get("MOORCHEH_API_KEY") or MOORCHEH_API_KEY
                    if key:
                        import vector_store_moorcheh as _vm
                        if not _vm._auth_failed:
                            return _vm
                except Exception:
                    pass
            # Falls through to local ChromaDB for chromadb backend or Moorcheh failure
        except Exception:
            pass

    # Default: local ChromaDB (fast, offline, no key required)
    import vector_store_local
    return vector_store_local
