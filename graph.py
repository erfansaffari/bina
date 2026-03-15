"""
NetworkX knowledge graph — per-workspace singletons.

build_graph(workspace_id) loads files for that workspace from SQLite +
ChromaDB and creates a weighted undirected graph where:

  - Nodes: one per file (node ID = MD5 hash)
    Attributes: path, summary, keywords, entities, doc_type, status,
                community_id (structural group integer),
                community_label (human-readable group name)

  - Edges: cosine similarity ≥ SIMILARITY_THRESHOLD
    Weight = cosine_similarity + ENTITY_BOOST per shared entity value
    Isolated nodes (degree 0) receive one forced edge to their nearest
    neighbour; these edges carry forced=True.

Graphs are kept in memory per workspace and rebuilt on demand when
mark_dirty(workspace_id) is called.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Dict, Set

import numpy as np
import networkx as nx

import store
import vector_store_router
from config import ENTITY_BOOST, MAX_GRAPH_NEIGHBOURS, SIMILARITY_THRESHOLD

# ---------------------------------------------------------------------------
# Per-workspace graph cache
# ---------------------------------------------------------------------------

_graphs: Dict[str, nx.Graph] = {}
_dirty: Set[str] = set()
_lock = threading.Lock()


def get_graph(workspace_id: str) -> nx.Graph:
    """Return the cached graph for workspace_id, rebuilding if dirty."""
    with _lock:
        if workspace_id in _dirty or workspace_id not in _graphs:
            _graphs[workspace_id] = _build_graph_locked(workspace_id)
            _dirty.discard(workspace_id)
        return _graphs[workspace_id]


def mark_dirty(workspace_id: str) -> None:
    """Invalidate the cached graph for workspace_id so it rebuilds on next access."""
    with _lock:
        _dirty.add(workspace_id)


def mark_all_dirty() -> None:
    """Invalidate all cached workspace graphs."""
    with _lock:
        _dirty.update(_graphs.keys())


def remove_node_from_graph(workspace_id: str, file_hash: str) -> None:
    """Surgically remove one node without a full rebuild.

    Removes the node and all its edges in-place, then re-runs structural
    group assignment on the surviving graph so community_id/community_label
    values stay accurate.  Does NOT mark the workspace dirty — callers that
    need a full rebuild should call mark_dirty() explicitly.
    """
    with _lock:
        if workspace_id not in _graphs:
            return
        G = _graphs[workspace_id]
        if not G.has_node(file_hash):
            return
        G.remove_node(file_hash)  # also removes all incident edges

        # Re-run structural group assignment on the trimmed graph
        group_labels: dict[str, str] = {}
        for h in G.nodes:
            group_labels[h] = _assign_structural_group(
                G.nodes[h].get("path", ""), G.nodes[h].get("doc_type", "Other"),
            )
        unique_groups = sorted(set(group_labels.values())) if group_labels else []
        group_to_id = {g: i for i, g in enumerate(unique_groups)}
        for h in G.nodes:
            G.nodes[h]["community_id"] = group_to_id.get(group_labels[h], 0)
            G.nodes[h]["community_label"] = group_labels[h]


# ---------------------------------------------------------------------------
# Graph construction helpers
# ---------------------------------------------------------------------------

def _cosine(a: list[float], b: list[float]) -> float:
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


def _shared_entity_count(entities_a: dict, entities_b: dict) -> int:
    """Count identical entity values shared between two files."""
    count = 0
    for key in ("persons", "companies", "projects", "locations"):
        set_a = {v.lower().strip() for v in entities_a.get(key, [])}
        set_b = {v.lower().strip() for v in entities_b.get(key, [])}
        count += len(set_a & set_b)
    return count


def _assign_structural_group(path: str, doc_type: str) -> str:
    """Assign a human-readable structural group label from folder name + doc_type."""
    folder = Path(path).parent.name.lower() if path else ""
    dt = (doc_type or "").lower()

    # Folder-based patterns (strongest signal)
    if re.match(r'^a\d+$', folder):                       return "Assignments"
    if folder in ("lectures", "lecture"):                  return "Lectures"
    if folder in ("labs", "lab"):                          return "Labs"
    if folder in ("exams", "exam", "tests", "test"):       return "Exams"
    if folder in ("tutorials", "tutorial"):                return "Tutorials"
    if folder in ("notes", "note"):                        return "Notes"
    if re.match(r'^(problem.?set|ps|hw)\d*$', folder):    return "Problem Sets"

    # doc_type fallback
    if "assignment" in dt:                                  return "Assignments"
    if "lecture" in dt:                                     return "Lectures"
    if any(k in dt for k in ("exam", "review", "midterm", "final")): return "Exams"
    if "lab" in dt:                                         return "Labs"
    if "tutorial" in dt:                                    return "Tutorials"

    # Use doc_type directly if it's meaningful
    if doc_type and doc_type not in ("Other", "other"):    return doc_type
    # Use folder name
    if folder and folder not in (".", ""):                  return folder.title()
    return "Other"


def _build_graph_locked(workspace_id: str) -> nx.Graph:
    """Build and return the graph for workspace_id. Must be called inside _lock."""
    G = nx.Graph()

    records = store.get_files_for_workspace(workspace_id)
    if not records:
        return G

    hashes = [r.hash for r in records]

    # Always fetch from local ChromaDB — it's the reliable embedding cache.
    # Moorcheh does not support get_embeddings_by_hashes(), so using the router
    # here would return {} and force every file to be re-embedded on each build.
    import vector_store_local as _local_vs
    embeddings = _local_vs.get_embeddings_by_hashes(hashes)

    # Re-embed any files genuinely missing from the local cache
    # (e.g. indexed before the dual-write was added), using their stored summary+keywords.
    # Also back-fills the ChromaDB cache so subsequent builds skip this step.
    missing = [h for h in hashes if h not in embeddings]
    if missing:
        ws = store.get_workspace(workspace_id)
        for h in missing:
            rec = store.get_file_by_hash(h)
            if rec and rec.status == "done":
                text = (
                    f"{rec.summary or ''} {' '.join(store.parse_keywords(rec))}"
                )[:2000].strip()
                if text:
                    try:
                        from inference import embed_text
                        emb = embed_text(text, workspace=ws)
                        embeddings[h] = emb
                        # Back-fill local ChromaDB cache to avoid re-embedding next time
                        try:
                            _local_vs.upsert(
                                file_hash=h,
                                embedding=emb,
                                metadata={
                                    "path": rec.path or "",
                                    "doc_type": rec.doc_type or "",
                                    "summary_snippet": (rec.summary or "")[:200],
                                },
                            )
                        except Exception:
                            pass
                    except Exception:
                        pass

    # Add nodes (ID = hash)
    for rec in records:
        G.add_node(
            rec.hash,
            path=rec.path,
            summary=rec.summary or "",
            keywords=store.parse_keywords(rec),
            entities=store.parse_entities(rec),
            doc_type=rec.doc_type or "Other",
            status=rec.status,
        )

    # Build edges only for files with embeddings
    hashes_with_emb = [h for h in hashes if h in embeddings]

    candidates: dict[str, list[tuple[float, str]]] = {h: [] for h in hashes_with_emb}

    for i, hash_a in enumerate(hashes_with_emb):
        emb_a = embeddings[hash_a]
        for hash_b in hashes_with_emb[i + 1:]:
            sim = _cosine(emb_a, embeddings[hash_b])
            if sim >= SIMILARITY_THRESHOLD:
                candidates[hash_a].append((sim, hash_b))
                candidates[hash_b].append((sim, hash_a))

    seen: set[tuple[str, str]] = set()

    for hash_a, nbrs in candidates.items():
        top = sorted(nbrs, reverse=True)[:MAX_GRAPH_NEIGHBOURS]
        for sim, hash_b in top:
            key = (min(hash_a, hash_b), max(hash_a, hash_b))
            if key in seen:
                continue
            seen.add(key)
            ent_a = G.nodes[hash_a]["entities"]
            ent_b = G.nodes[hash_b]["entities"]
            shared = _shared_entity_count(ent_a, ent_b)
            weight = sim + shared * ENTITY_BOOST
            G.add_edge(hash_a, hash_b, weight=weight, similarity=sim,
                       shared_entities=shared, forced=False)

    # ── Forced edges for isolated nodes (degree 0 → nearest neighbour) ────────
    # These render as dotted lines and prevent isolated nodes piling at origin.
    isolated = [h for h in hashes_with_emb if G.degree(h) == 0]
    for iso_hash in isolated:
        best_sim, best_hash = -1.0, None
        for other_hash in hashes_with_emb:
            if other_hash == iso_hash:
                continue
            sim = _cosine(embeddings[iso_hash], embeddings[other_hash])
            if sim > best_sim:
                best_sim = sim
                best_hash = other_hash
        if best_hash and best_sim > 0:
            G.add_edge(iso_hash, best_hash,
                       weight=float(best_sim), similarity=float(best_sim),
                       shared_entities=0, forced=True)

    # ── Structural group assignment ──────────────────────────────────────────
    group_labels: dict[str, str] = {}
    for h in G.nodes:
        group_labels[h] = _assign_structural_group(
            G.nodes[h].get("path", ""), G.nodes[h].get("doc_type", "Other"),
        )

    unique_groups = sorted(set(group_labels.values()))
    group_to_id = {g: i for i, g in enumerate(unique_groups)}

    for h in G.nodes:
        G.nodes[h]["community_id"] = group_to_id[group_labels[h]]
        G.nodes[h]["community_label"] = group_labels[h]

    return G


def build_graph(workspace_id: str) -> nx.Graph:
    """Public alias — build (or return cached) graph for workspace_id."""
    return get_graph(workspace_id)


# ---------------------------------------------------------------------------
# Graph traversal utilities
# ---------------------------------------------------------------------------

def get_neighbours(G: nx.Graph, node_id: str, depth: int = 1) -> set[str]:
    """Return all nodes within `depth` hops of node_id."""
    if node_id not in G:
        return set()
    neighbours: set[str] = set()
    frontier = {node_id}
    for _ in range(depth):
        next_frontier: set[str] = set()
        for node in frontier:
            for nbr in G.neighbors(node):
                if nbr not in neighbours and nbr != node_id:
                    next_frontier.add(nbr)
        neighbours |= next_frontier
        frontier = next_frontier
    return neighbours


def subgraph_for_paths(G: nx.Graph, node_ids: list[str], expand_depth: int = 1) -> nx.Graph:
    """Return an induced subgraph of seed nodes plus their neighbours."""
    nodes: set[str] = set(node_ids)
    for nid in node_ids:
        nodes |= get_neighbours(G, nid, depth=expand_depth)
    return G.subgraph(nodes).copy()
