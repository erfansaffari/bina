"""
ChromaDB vector store wrapper.

Collection: "bina_docs"
Each document is stored with:
    id        = file MD5 hash (stable even if file is moved/renamed)
    embedding = 384-dim float list from nomic-embed-text
    metadata  = {path, doc_type, hash, summary_snippet}
"""
from __future__ import annotations

import chromadb
from chromadb.config import Settings

from config import CHROMA_PATH

_client: chromadb.PersistentClient | None = None
_collection = None

COLLECTION_NAME = "bina_docs"


def _get_collection():
    global _client, _collection
    if _collection is None:
        _client = chromadb.PersistentClient(
            path=str(CHROMA_PATH),
            settings=Settings(anonymized_telemetry=False),
        )
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
    return _collection


def upsert(
    file_hash: str,
    embedding: list[float],
    metadata: dict,
) -> None:
    """Insert or update a document's embedding. ID is the file MD5 hash.

    metadata should include at minimum: path, doc_type.
    hash is automatically added to metadata for filtering.
    """
    col = _get_collection()
    meta = dict(metadata)
    meta["hash"] = file_hash  # stored in metadata for where-filter scoping
    col.upsert(
        ids=[file_hash],
        embeddings=[embedding],
        metadatas=[meta],
    )


def delete(file_hash: str) -> None:
    """Remove a document's embedding by its hash."""
    col = _get_collection()
    try:
        col.delete(ids=[file_hash])
    except Exception:
        pass


def query(
    embedding: list[float],
    n_results: int = 20,
    hashes: list[str] | None = None,
) -> list[dict]:
    """
    Return up to n_results most similar documents.

    If hashes is provided, only documents whose IDs are in that list are
    considered (used for workspace-scoped search).

    Each result dict:
        hash            : str
        path            : str
        distance        : float  (0 = identical, 2 = maximally dissimilar)
        score           : float  (1 - distance; higher = more similar)
        doc_type        : str
        summary_snippet : str
    """
    col = _get_collection()
    total = col.count()
    if total == 0:
        return []

    where = None
    if hashes:
        if len(hashes) == 0:
            return []
        where = {"hash": {"$in": hashes}}

    n = min(n_results, total)
    try:
        results = col.query(
            query_embeddings=[embedding],
            n_results=n,
            where=where,
            include=["distances", "metadatas"],
        )
    except Exception:
        # Fallback without where filter if ChromaDB rejects it
        results = col.query(
            query_embeddings=[embedding],
            n_results=n,
            include=["distances", "metadatas"],
        )

    output = []
    for doc_hash, distance, meta in zip(
        results["ids"][0],
        results["distances"][0],
        results["metadatas"][0],
    ):
        output.append(
            {
                "hash": doc_hash,
                "path": meta.get("path", ""),
                "distance": distance,
                "score": max(0.0, 1.0 - distance),
                "doc_type": meta.get("doc_type", ""),
                "summary_snippet": meta.get("summary_snippet", ""),
            }
        )

    # Post-filter if where clause was bypassed (fallback case)
    if hashes is not None:
        hash_set = set(hashes)
        output = [r for r in output if r["hash"] in hash_set]

    return output


def get_embeddings_by_hashes(hashes: list[str]) -> dict[str, list[float]]:
    """Return {hash: embedding_vector} for building workspace graphs."""
    if not hashes:
        return {}
    col = _get_collection()
    result = col.get(ids=hashes, include=["embeddings"])
    return dict(zip(result["ids"], result["embeddings"]))


def get_all_embeddings() -> dict[str, list[float]]:
    """Return {hash: embedding} for all stored documents."""
    col = _get_collection()
    total = col.count()
    if total == 0:
        return {}
    results = col.get(include=["embeddings"])
    return dict(zip(results["ids"], results["embeddings"]))


def count() -> int:
    return _get_collection().count()
