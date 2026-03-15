"""
vector_store.py — compatibility shim.

This module re-exports from vector_store_local (ChromaDB) so that existing
code that does `import vector_store` or `from vector_store import ...` still
works unchanged.

New code should use vector_store_router.get_store(workspace_id) to get the
correct backend per workspace.
"""
from vector_store_local import (  # noqa: F401
    upsert,
    delete,
    query,
    get_embeddings_by_hashes,
    get_all_embeddings,
    count,
    clear_all,
)
