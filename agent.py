"""
agent.py — Railtracks agent wrapping Bina's core functions.

The agent lets users ask natural language questions about their files.
It reasons over the knowledge graph, fetches summaries, and gives
grounded answers using actual document content.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ── Railtracks availability check ─────────────────────────────────────────────
try:
    import railtracks as rt
    _RT_AVAILABLE = True
except ImportError:
    _RT_AVAILABLE = False
    logger.warning("railtracks not installed — agent mode unavailable")


# ── Tool functions (callable directly or via Railtracks) ──────────────────────

def semantic_search(query: str, workspace_id: str, top_k: int = 20) -> list:
    """
    Search the knowledge graph for files semantically related to the query.
    Returns a list of {id, name, path, summary, score} dicts.
    """
    from search import search as _search
    from graph import get_graph
    import store

    G = get_graph(workspace_id)
    ws_files = store.get_files_for_workspace(workspace_id)
    ws_hashes = [f.hash for f in ws_files]

    results = _search(
        query, G,
        n_results=top_k,
        workspace_hashes=ws_hashes,
        workspace_id=workspace_id,
    )
    return [
        {
            "hash": r["hash"],
            "name": r.get("filename", ""),
            "path": r.get("path", ""),
            "summary": r.get("summary", ""),
            "score": r.get("score", 0.0),
        }
        for r in results
    ]


def answer_query(query: str, workspace_id: str) -> str:
    """
    Answer a question using the workspace's configured LLM.
    Retrieves top file summaries via semantic search, then calls the LLM
    to synthesise a grounded answer.
    """
    import store as _store
    from inference import call_chat

    results = semantic_search(query=query, workspace_id=workspace_id, top_k=5)

    if not results:
        return "I couldn't find any relevant files in this workspace. Try indexing a folder first."

    ws = _store.get_workspace(workspace_id)
    context = "\n\n".join(
        f"[{r['name']}]: {r['summary']}" for r in results if r.get("summary")
    )
    prompt = (
        f"The user is asking about their indexed files. "
        f"Answer based on the document summaries below. "
        f"Be specific and cite the file names.\n\n"
        f"Question: {query}\n\n"
        f"Relevant document summaries:\n{context}"
    )
    try:
        return call_chat(prompt, ws, max_tokens=600)
    except Exception as e:
        logger.warning(f"LLM answer failed: {e}")
        # Fallback: summarise the top results in plain text
        lines = [f"• {r['name']}: {r['summary'][:120]}…" for r in results if r.get("summary")]
        return "Based on your files:\n\n" + "\n".join(lines)


def summarize_node(node_id: str, workspace_id: str) -> str:
    """Return the stored AI summary for a specific file node."""
    import store as _store
    record = _store.get_file_by_hash(node_id)
    if not record:
        return f"No record found for node {node_id}"
    return record.summary or "No summary available for this file."


def get_node_neighbors(node_id: str, workspace_id: str, depth: int = 1) -> list:
    """
    Return neighboring file nodes in the knowledge graph.
    Useful for exploring related documents.
    """
    from graph import get_graph
    import store as _store

    G = get_graph(workspace_id)
    if not G.has_node(node_id):
        return []
    neighbors = []
    for neighbor_id, edge_data in G[node_id].items():
        record = _store.get_file_by_hash(neighbor_id)
        if record:
            neighbors.append({
                "id": neighbor_id,
                "name": record.path.split("/")[-1] if record.path else "",
                "path": record.path or "",
                "summary": record.summary or "",
                "weight": edge_data.get("weight", 0.0),
            })
    neighbors.sort(key=lambda x: x["weight"], reverse=True)
    return neighbors[:10 * depth]


# ── Agent definition ──────────────────────────────────────────────────────────

def build_agent(workspace_id: str, workspace_config=None):
    """
    Build a Bina agent for a specific workspace.
    Returns None if railtracks is not available or agent construction fails.
    """
    if not _RT_AVAILABLE:
        return None

    try:
        import store as _store
        from config import HOSTED_MODEL, HOSTED_API_BASE, HOSTED_API_KEY, LOCAL_MODEL

        ws = workspace_config or _store.get_workspace(workspace_id)

        # Wrap tool functions as railtracks function nodes
        search_node = rt.function_node(semantic_search)
        answer_node = rt.function_node(answer_query)
        summary_node = rt.function_node(summarize_node)
        neighbor_node = rt.function_node(get_node_neighbors)

        processing_path = getattr(ws, "processing_path", "hosted") if ws else "hosted"
        llm = None

        if processing_path == "local":
            try:
                llm = rt.llm.OllamaLLM(LOCAL_MODEL)
            except AttributeError:
                pass
        else:
            api_key = getattr(ws, "user_api_key", None) or HOSTED_API_KEY
            base_url = getattr(ws, "user_api_base", None) or HOSTED_API_BASE
            model = getattr(ws, "model_name", None) or HOSTED_MODEL
            try:
                llm = rt.llm.OpenAILLM(model=model, api_key=api_key, base_url=base_url)
            except AttributeError:
                try:
                    llm = rt.llm.LiteLLM(model=model)
                except (AttributeError, Exception):
                    pass

        if llm is None:
            logger.warning("Could not create railtracks LLM — agent disabled")
            return None

        agent = rt.agent_node(
            f"Bina-{workspace_id[:8]}",
            tool_nodes=(search_node, answer_node, summary_node, neighbor_node),
            llm=llm,
            system_message=f"""You are Bina, a semantic file vault assistant.
The user's files are indexed in a knowledge graph (workspace: {workspace_id}).

Always pass workspace_id="{workspace_id}" to every tool call.

Your capabilities:
- semantic_search: find files related to any topic or question
- answer_query: get a direct answer from indexed document content
- summarize_node: read the AI summary of a specific file
- get_node_neighbors: explore documents related to a specific file

How to answer questions:
1. For factual questions → use answer_query first
2. For "find me files about X" → use semantic_search
3. For "what's related to this file" → use get_node_neighbors
4. For "what does this file say" → use summarize_node
5. Chain tools when needed: search → get neighbors → summarize

Always cite which files your answer comes from.
Always be honest if you cannot find relevant files.""",
        )
        return agent
    except Exception as e:
        logger.error(f"Failed to build railtracks agent: {e}")
        return None


# ── Agent cache (one per workspace) ──────────────────────────────────────────
_agents: dict[str, Any] = {}


def get_agent(workspace_id: str):
    if workspace_id not in _agents:
        try:
            _agents[workspace_id] = build_agent(workspace_id)
        except Exception as e:
            logger.warning(f"get_agent failed for {workspace_id}: {e}")
            _agents[workspace_id] = None
    return _agents[workspace_id]


def invalidate_agent(workspace_id: str):
    """Call when workspace config changes (model switch, etc.)."""
    _agents.pop(workspace_id, None)


# ── Fallback query (no railtracks) ───────────────────────────────────────────

def fallback_query(query: str, workspace_id: str) -> str:
    """
    Simple query without railtracks — search + concatenate summaries.
    Used when railtracks is not available or agent fails.
    """
    return answer_query(query, workspace_id)
