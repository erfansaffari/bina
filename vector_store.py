"""
ChromaDB vector store wrapper.

Collection: "bina_docs"
Each document is stored with:
    id        = absolute file path (used as the stable document ID)
    embedding = 384-dim float list from nomic-embed-text
    metadata  = {path, doc_type, summary_snippet}
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
    path: str,
    embedding: list[float],
    doc_type: str | None = None,
    summary: str | None = None,
) -> None:
    """Insert or update a document's embedding."""
    col = _get_collection()
    col.upsert(
        ids=[path],
        embeddings=[embedding],
        metadatas=[
            {
                "path": path,
                "doc_type": doc_type or "",
                "summary_snippet": (summary or "")[:200],
            }
        ],
    )


def delete(path: str) -> None:
    """Remove a document's embedding."""
    col = _get_collection()
    try:
        col.delete(ids=[path])
    except Exception:
        pass


def query(
    embedding: list[float],
    n_results: int = 20,
) -> list[dict]:
    """
    Return up to n_results most similar documents.

    Each result dict:
        path      : str
        distance  : float  (0 = identical, 2 = maximally dissimilar in cosine space)
        score     : float  (1 - distance, so higher = more similar)
        doc_type  : str
        summary_snippet : str
    """
    col = _get_collection()
    total = col.count()
    if total == 0:
        return []

    n = min(n_results, total)
    results = col.query(
        query_embeddings=[embedding],
        n_results=n,
        include=["distances", "metadatas"],
    )

    output = []
    for path, distance, meta in zip(
        results["ids"][0],
        results["distances"][0],
        results["metadatas"][0],
    ):
        output.append(
            {
                "path": path,
                "distance": distance,
                "score": max(0.0, 1.0 - distance),
                "doc_type": meta.get("doc_type", ""),
                "summary_snippet": meta.get("summary_snippet", ""),
            }
        )
    return output


def get_all_embeddings() -> dict[str, list[float]]:
    """
    Return {path: embedding} for all stored documents.
    Used by graph.py to build pairwise similarity edges.
    """
    col = _get_collection()
    total = col.count()
    if total == 0:
        return {}

    results = col.get(include=["embeddings"])
    return dict(zip(results["ids"], results["embeddings"]))


def count() -> int:
    return _get_collection().count()
