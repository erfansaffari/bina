"""
Semantic search engine + interactive REPL.

Flow
----
1. Embed the query string with nomic-embed-text  (<100ms)
2. ChromaDB returns top-20 most similar document chunks
3. NetworkX expands each result to its 1st-degree neighbours
4. Results are de-duplicated and ranked by combined score
5. Rich table printed to terminal
6. REPL loop: type a query, `open <n>` to open in macOS, `q` to quit
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import networkx as nx
import ollama
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import box

import store
import vector_store
from config import EMBED_MODEL, MAX_GRAPH_NEIGHBOURS
from graph import build_graph, get_neighbours

console = Console()


# ---------------------------------------------------------------------------
# Core search
# ---------------------------------------------------------------------------

def _embed_query(query: str) -> list[float]:
    response = ollama.embeddings(model=EMBED_MODEL, prompt=query)
    return response["embedding"]


def _format_score(score: float) -> str:
    pct = int(score * 100)
    bar_width = 10
    filled = int(bar_width * score)
    bar = "█" * filled + "░" * (bar_width - filled)
    return f"{bar} {pct:3d}%"


def search(query: str, G: nx.Graph, n_results: int = 20) -> list[dict]:
    """
    Perform semantic search and graph expansion.

    Returns a ranked list of result dicts:
        rank, path, filename, doc_type, summary, score, from_graph
    """
    embedding = _embed_query(query)
    raw_results = vector_store.query(embedding, n_results=n_results)

    if not raw_results:
        return []

    # Build a score map: path → best score so far
    score_map: dict[str, dict] = {}
    for r in raw_results:
        score_map[r["path"]] = {
            "path": r["path"],
            "score": r["score"],
            "from_graph": False,
        }

    # Graph expansion: add 1st-degree neighbours with a discounted score
    seed_paths = list(score_map.keys())
    for path in seed_paths:
        for nbr in get_neighbours(G, path, depth=MAX_GRAPH_NEIGHBOURS):
            if nbr not in score_map:
                edge_data = G.get_edge_data(path, nbr, default={})
                edge_weight = edge_data.get("weight", 0.0)
                # Neighbour score: seed score × edge weight (capped at seed score)
                neighbour_score = score_map[path]["score"] * edge_weight * 0.85
                score_map[nbr] = {
                    "path": nbr,
                    "score": neighbour_score,
                    "from_graph": True,
                }

    # Enrich with SQLite metadata
    results = []
    for path, entry in score_map.items():
        rec = store.get_file(path)
        results.append(
            {
                "path": path,
                "filename": Path(path).name,
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
    total = store.get_file_count()
    ok = store.get_ok_count()

    console.print()
    console.print(
        Panel(
            f"[bold cyan]Bina[/bold cyan] — semantic search\n"
            f"[dim]{ok} files analysed · {total - ok} pending/failed · "
            f"{vector_store.count()} vectors in index[/dim]\n\n"
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

    # Build graph once per REPL session
    with console.status("[dim]Building knowledge graph…[/dim]", spinner="dots"):
        G = build_graph()

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
