"""
NetworkX knowledge graph.

build_graph() loads all processed files from SQLite + ChromaDB and creates
a weighted undirected graph where:

  - Nodes: one per file (node ID = absolute path string)
    Attributes: path, summary, keywords, entities, doc_type, status

  - Edges: cosine similarity ≥ SIMILARITY_THRESHOLD
    Weight = cosine_similarity + ENTITY_BOOST per shared entity value

The graph is kept in memory and rebuilt from scratch on each app launch
(fast: <2s for 1 000 files; entity lookup is O(n²) but n is small).
"""
from __future__ import annotations

import numpy as np
import networkx as nx

import store
import vector_store
from config import ENTITY_BOOST, MAX_GRAPH_NEIGHBOURS, SIMILARITY_THRESHOLD


def _cosine(a: list[float], b: list[float]) -> float:
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    denom = np.linalg.norm(va) * np.linalg.norm(vb)
    if denom == 0:
        return 0.0
    return float(np.dot(va, vb) / denom)


def _shared_entity_count(entities_a: dict, entities_b: dict) -> int:
    """Count the number of identical entity values shared between two files."""
    count = 0
    for key in ("persons", "companies", "projects", "locations"):
        set_a = {v.lower().strip() for v in entities_a.get(key, [])}
        set_b = {v.lower().strip() for v in entities_b.get(key, [])}
        count += len(set_a & set_b)
    return count


def build_graph() -> nx.Graph:
    """Build and return the full knowledge graph from persisted data."""
    G = nx.Graph()

    records = store.get_all_files()
    embeddings = vector_store.get_all_embeddings()

    # Add nodes
    for rec in records:
        G.add_node(
            rec.path,
            path=rec.path,
            summary=rec.summary or "",
            keywords=store.parse_keywords(rec),
            entities=store.parse_entities(rec),
            doc_type=rec.doc_type or "Other",
            status=rec.status,
        )

    # Build edges only for files with embeddings
    paths_with_embeddings = [p for p in G.nodes if p in embeddings]

    # Pass 1: collect all (similarity, neighbour) pairs above threshold for every node.
    # Using a dict so each node accumulates its own candidate list independently.
    candidates: dict[str, list[tuple[float, str]]] = {p: [] for p in paths_with_embeddings}

    for i, path_a in enumerate(paths_with_embeddings):
        emb_a = embeddings[path_a]
        for path_b in paths_with_embeddings[i + 1:]:
            sim = _cosine(emb_a, embeddings[path_b])
            if sim >= SIMILARITY_THRESHOLD:
                candidates[path_a].append((sim, path_b))
                candidates[path_b].append((sim, path_a))

    # Pass 2: for each node keep only its top-MAX_GRAPH_NEIGHBOURS candidates
    # (ordered by similarity descending) then add those edges to the graph.
    # A set tracks already-added pairs so we don't add the same edge twice.
    seen: set[tuple[str, str]] = set()

    for path_a, nbrs in candidates.items():
        top = sorted(nbrs, reverse=True)[:MAX_GRAPH_NEIGHBOURS]  # sort by sim descending
        for sim, path_b in top:
            key = (min(path_a, path_b), max(path_a, path_b))
            if key in seen:
                continue
            seen.add(key)
            ent_a = G.nodes[path_a]["entities"]
            ent_b = G.nodes[path_b]["entities"]
            shared = _shared_entity_count(ent_a, ent_b)
            weight = sim + shared * ENTITY_BOOST
            G.add_edge(path_a, path_b, weight=weight, similarity=sim, shared_entities=shared)

    return G


def get_neighbours(G: nx.Graph, path: str, depth: int = 1) -> set[str]:
    """Return all nodes within `depth` hops of `path`."""
    if path not in G:
        return set()
    neighbours: set[str] = set()
    frontier = {path}
    for _ in range(depth):
        next_frontier: set[str] = set()
        for node in frontier:
            for nbr in G.neighbors(node):
                if nbr not in neighbours and nbr != path:
                    next_frontier.add(nbr)
        neighbours |= next_frontier
        frontier = next_frontier
    return neighbours


def subgraph_for_paths(G: nx.Graph, paths: list[str], expand_depth: int = 1) -> nx.Graph:
    """Return an induced subgraph of the seed paths plus their neighbours."""
    nodes: set[str] = set(paths)
    for p in paths:
        nodes |= get_neighbours(G, p, depth=expand_depth)
    return G.subgraph(nodes).copy()
