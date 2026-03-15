"""
Semantic search engine + interactive REPL.

Flow
----
1. Embed the query string (via inference.embed_text)
2. Vector store returns top-20 most similar documents
3. NetworkX expands each result to its 1st-degree neighbours
4. Results are de-duplicated and ranked by combined score
5. Rich table printed to terminal
6. REPL loop: type a query, `open <n>` to open in macOS, `q` to quit
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import networkx as nx
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import box

import store
import vector_store_router
from inference import embed_text
from config import MAX_GRAPH_NEIGHBOURS
from graph import get_neighbours

console = Console()


# ---------------------------------------------------------------------------
# Core search
# ---------------------------------------------------------------------------

def _embed_query(query: str, workspace=None) -> list[float]:
    return embed_text(query, workspace=workspace)


def _format_score(score: float) -> str:
    pct = int(score * 100)
    bar_width = 10
    filled = int(bar_width * score)
    bar = "█" * filled + "░" * (bar_width - filled)
    return f"{bar} {pct:3d}%"


def search(
    query: str,
    G: nx.Graph,
    n_results: int = 20,
    workspace_hashes: list[str] | None = None,
    workspace_id: str | None = None,
) -> list[dict]:
    """
    Perform semantic search and graph expansion.

    workspace_hashes: if provided, only documents with these hashes are
    considered (workspace-scoped search).
    workspace_id: used to select the right vector store and workspace config.

    Returns a ranked list of result dicts:
        rank, hash, path, filename, doc_type, summary, score, from_graph
    """
    workspace = store.get_workspace(workspace_id) if workspace_id else None
    embedding = _embed_query(query, workspace=workspace)
    vstore = vector_store_router.get_store(workspace_id)
    try:
        raw_results = vstore.query(
            embedding, n_results=n_results, hashes=workspace_hashes
        )
    except Exception as _qe:
        # Primary store query failed (e.g. Moorcheh auth error) — fall back to ChromaDB
        import logging as _log
        _log.getLogger(__name__).warning(f"Primary vector store query failed, using ChromaDB: {_qe}")
        import vector_store_local as _local_vs
        raw_results = _local_vs.query(
            embedding, n_results=n_results, hashes=workspace_hashes
        )

    if not raw_results:
        return []

    # Build a score map: hash → best score so far
    score_map: dict[str, dict] = {}
    for r in raw_results:
        score_map[r["hash"]] = {
            "hash": r["hash"],
            "path": r["path"],
            "score": r["score"],
            "from_graph": False,
        }

    # Graph expansion: add 1st-degree neighbours with a discounted score
    seed_hashes = list(score_map.keys())
    for h in seed_hashes:
        for nbr in get_neighbours(G, h, depth=MAX_GRAPH_NEIGHBOURS):
            if nbr not in score_map:
                edge_data = G.get_edge_data(h, nbr, default={})
                edge_weight = edge_data.get("weight", 0.0)
                neighbour_score = score_map[h]["score"] * edge_weight * 0.85
                # Resolve path for neighbour from graph node attributes
                nbr_path = G.nodes[nbr].get("path", "") if nbr in G.nodes else ""
                score_map[nbr] = {
                    "hash": nbr,
                    "path": nbr_path,
                    "score": neighbour_score,
                    "from_graph": True,
                }

    # Enrich with SQLite metadata
    results = []
    for h, entry in score_map.items():
        rec = store.get_file_by_hash(h)
        path = entry["path"] or (rec.path if rec else "")
        results.append(
            {
                "hash": h,
                "path": path,
                "filename": Path(path).name if path else "",
                "doc_type": (rec.doc_type if rec else "Unknown") or "Unknown",
                "summary": (rec.summary if rec else "") or "",
                "keywords": store.parse_keywords(rec) if rec else [],
                "score": entry["score"],
                "from_graph": entry["from_graph"],
                "status": (rec.status if rec else "unknown"),
            }
        )

    results.sort(key=lambda r: r["score"], reverse=True)
    for i, r in enumerate(results, start=1):
        r["rank"] = i

    return results


# ---------------------------------------------------------------------------
# Rich display
# ---------------------------------------------------------------------------

def print_results(results: list[dict], query: str) -> None:
    if not results:
        console.print(
            Panel(
                "[dim]No results found. Try a different query or index more files.[/dim]",
                title="[bold]Search Results[/bold]",
                border_style="dim",
            )
        )
        return

    table = Table(
        box=box.ROUNDED,
        show_header=True,
        header_style="bold cyan",
        title=f"[bold]Results for:[/bold] [italic]{query}[/italic]",
        title_justify="left",
        expand=True,
    )
    table.add_column("#", style="bold", width=3, justify="right")
    table.add_column("File", style="bold white", no_wrap=False, ratio=3)
    table.add_column("Type", style="cyan", width=20)
    table.add_column("Relevance", width=18)
    table.add_column("Summary", ratio=5)

    for r in results:
        score_display = _format_score(r["score"])
        graph_tag = " [dim](related)[/dim]" if r["from_graph"] else ""
        status_tag = " [yellow]⚠ not analysed[/yellow]" if r["status"] == "failed" else ""

        summary = r["summary"] or ""
        # Never surface raw exception strings — show a clean placeholder instead
        if summary.startswith("Unable to analyse:") or not summary.strip():
            summary_display = "[dim]Not yet summarised[/dim]"
        else:
            if len(summary) > 160:
                summary = summary[:157] + "…"
            summary_display = summary

        table.add_row(
            str(r["rank"]),
            f"{r['filename']}{graph_tag}{status_tag}",
            r["doc_type"],
            score_display,
            summary_display,
        )

    console.print(table)
    console.print(
        f"[dim]  {len(results)} result(s) · type [bold]open <n>[/bold] to open · [bold]q[/bold] to quit[/dim]\n"
    )


# ---------------------------------------------------------------------------
# Interactive REPL
# ---------------------------------------------------------------------------

def _open_file(path: str) -> None:
    subprocess.run(["open", path], check=False)


def repl() -> None:
    """Launch the interactive search REPL."""
    all_files = store.get_all_files()
    total = len(all_files)
    ok = sum(1 for f in all_files if f.status == "done")

    console.print()
    console.print(
        Panel(
            f"[bold cyan]Bina[/bold cyan] — semantic search\n"
            f"[dim]{ok} files analysed · {total - ok} pending/failed · "
            f"{vector_store_router.get_store().count()} vectors in index[/dim]\n\n"
            f"[dim]Type a question, [bold]open <n>[/bold] to open a result, "
            f"[bold]q[/bold] to quit.[/dim]",
            border_style="cyan",
        )
    )

    if total == 0:
        console.print(
            "[yellow]No files indexed yet. Run [bold]python main.py index <folder>[/bold] first.[/yellow]\n"
        )
        return

    # Build graph once per REPL session — use first available workspace
    from graph import get_graph as _get_graph
    workspaces = store.list_workspaces()
    with console.status("[dim]Building knowledge graph…[/dim]", spinner="dots"):
        if workspaces:
            G = _get_graph(workspaces[0].id)
        else:
            import networkx as _nx
            G = _nx.Graph()

    edge_count = G.number_of_edges()
    console.print(
        f"[dim]  Graph: {G.number_of_nodes()} nodes · {edge_count} edges[/dim]\n"
    )

    last_results: list[dict] = []

    while True:
        try:
            raw = console.input("[bold cyan]bina>[/bold cyan] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]Goodbye.[/dim]")
            break

        if not raw:
            continue

        if raw.lower() in {"q", "quit", "exit"}:
            console.print("[dim]Goodbye.[/dim]")
            break

        # `open <n>` command
        if raw.lower().startswith("open "):
            parts = raw.split(maxsplit=1)
            if len(parts) == 2 and parts[1].isdigit():
                n = int(parts[1])
                matching = [r for r in last_results if r["rank"] == n]
                if matching:
                    path = matching[0]["path"]
                    console.print(f"[dim]Opening: {path}[/dim]")
                    _open_file(path)
                else:
                    console.print(f"[red]No result #{n}[/red]")
            else:
                console.print("[red]Usage: open <number>[/red]")
            continue

        with console.status("[dim]Searching…[/dim]", spinner="dots"):
            last_results = search(raw, G)

        print_results(last_results, raw)
