#!/usr/bin/env python3
"""
Bina CLI — Phase 0 entry point.

Commands
--------
  index <folder>   Scan a folder, index all supported files, then watch for changes.
  search           Launch the interactive semantic search REPL.
  status           Print index statistics.
  reindex          Force re-process all files ignoring the hash cache.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table
from rich import box

import store
import vector_store
from config import BINA_HOME, SUPPORTED_EXTENSIONS, WATCHED_FOLDER_FILE

console = Console()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _collect_files(folder: Path) -> list[Path]:
    """Recursively collect all supported files under folder."""
    return [
        p
        for p in folder.rglob("*")
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
    ]


def _save_watched_folder(folder: Path) -> None:
    WATCHED_FOLDER_FILE.write_text(str(folder))


def _load_watched_folder() -> Path | None:
    if WATCHED_FOLDER_FILE.exists():
        p = Path(WATCHED_FOLDER_FILE.read_text().strip())
        if p.is_dir():
            return p
    return None


def _status_table() -> Table:
    all_files = store.get_all_files()
    total = len(all_files)
    ok = sum(1 for f in all_files if f.status == "done")
    vectors = vector_store.count()
    workspaces = store.list_workspaces()

    watched = _load_watched_folder()

    table = Table(box=box.SIMPLE, show_header=False, padding=(0, 2))
    table.add_column("Key", style="bold cyan")
    table.add_column("Value", style="white")

    table.add_row("Workspaces", str(len(workspaces)))
    table.add_row("Watched folder", str(watched) if watched else "[dim]not set[/dim]")
    table.add_row("Files indexed", str(ok))
    table.add_row("Files failed", str(total - ok))
    table.add_row("Vectors in index", str(vectors))
    table.add_row("Data directory", str(BINA_HOME))

    return table


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

@click.group()
def cli() -> None:
    """Bina — AI semantic file manager (Phase 0 CLI)."""


@cli.command()
@click.argument("folder", type=click.Path(exists=True, file_okay=False, path_type=Path))
def index(folder: Path) -> None:
    """Scan FOLDER, index all supported files, then watch for changes."""
    import pipeline as _pipeline
    from watcher import FolderWatcher

    folder = folder.resolve()
    _save_watched_folder(folder)

    # Get or create a workspace for this folder
    workspaces = store.list_workspaces()
    if workspaces:
        workspace_id = workspaces[0].id
    else:
        ws = store.create_workspace(name=folder.name, emoji="📁")
        workspace_id = ws.id
    store.add_folder_to_workspace(workspace_id, str(folder))

    files = _collect_files(folder)
    ext_list = ", ".join(sorted(SUPPORTED_EXTENSIONS))

    console.print()
    console.print(
        Panel(
            f"[bold cyan]Bina[/bold cyan] — indexing [bold]{folder}[/bold]\n"
            f"[dim]Found [bold]{len(files)}[/bold] supported files ({ext_list})[/dim]",
            border_style="cyan",
        )
    )

    if not files:
        console.print("[yellow]No supported files found. Nothing to index.[/yellow]")
        return

    processed = skipped = failed = 0

    def _on_event(result: dict) -> None:
        s = result.get("status", "")
        filename = Path(result["path"]).name
        if s == "ok":
            console.print(f"  [green]✓[/green] [dim]{filename}[/dim]")
        elif s == "failed":
            console.print(f"  [red]✗[/red] [dim]{filename}[/dim] — {result.get('error', '')}")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Analysing files…", total=len(files))

        for file_path in files:
            progress.update(task, description=f"[cyan]{file_path.name[:40]}")
            result = _pipeline.process_file(str(file_path), workspace_id)
            s = result.get("status", "")
            if s == "ok":
                processed += 1
            elif s == "skipped":
                skipped += 1
            else:
                failed += 1
            progress.advance(task)

    with console.status("[dim]Freeing AI memory…[/dim]", spinner="dots"):
        _pipeline.unload_models()

    console.print()
    console.print(
        f"[bold green]Done.[/bold green] "
        f"{processed} analysed · {skipped} unchanged · {failed} failed"
    )
    console.print()

    # Start FSEvents watcher
    console.print(
        f"[bold]Watching[/bold] [dim]{folder}[/dim] for changes. "
        f"Press [bold]Ctrl+C[/bold] to stop.\n"
    )

    watcher = FolderWatcher(
        workspace_id=workspace_id,
        folder_path=folder,
        pipeline_fn=_pipeline.process_file,
        remove_fn=_pipeline.remove_file,
        on_processed=_on_event,
    )
    watcher.start()

    try:
        while watcher.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        console.print("\n[dim]Stopping watcher…[/dim]")
    finally:
        watcher.stop()
        console.print("[dim]Done.[/dim]")


@cli.command()
def search() -> None:
    """Launch the interactive semantic search REPL."""
    from search import repl
    repl()


@cli.command()
def status() -> None:
    """Print index statistics."""
    console.print()
    console.print(
        Panel(
            _status_table(),
            title="[bold cyan]Bina Status[/bold cyan]",
            border_style="cyan",
        )
    )
    console.print()


@cli.command()
@click.confirmation_option(
    prompt="This will delete ALL indexed data in ~/.bina/. Are you sure?"
)
def reset() -> None:
    """Wipe all indexed data and start fresh."""
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).parent / "backend"))
    from reset import reset as do_reset
    do_reset()


@cli.command()
def reindex() -> None:
    """Force re-process all files in the watched folder, ignoring hash cache."""
    import pipeline as _pipeline

    watched = _load_watched_folder()
    if watched is None:
        console.print("[red]No watched folder set. Run [bold]bina index <folder>[/bold] first.[/red]")
        sys.exit(1)

    workspaces = store.list_workspaces()
    workspace_id = workspaces[0].id if workspaces else None
    if not workspace_id:
        console.print("[red]No workspace found. Run [bold]bina index <folder>[/bold] first.[/red]")
        sys.exit(1)

    files = _collect_files(watched)
    console.print()
    console.print(
        Panel(
            f"[bold cyan]Bina[/bold cyan] — reindexing [bold]{watched}[/bold]\n"
            f"[dim]{len(files)} files will be force-reprocessed[/dim]",
            border_style="yellow",
        )
    )

    if not files:
        console.print("[yellow]No supported files found.[/yellow]")
        return

    processed = failed = 0

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[yellow]Reanalysing…", total=len(files))

        for file_path in files:
            progress.update(task, description=f"[yellow]{file_path.name[:40]}")
            result = _pipeline.process_file(str(file_path), workspace_id, force=True)
            if result.get("status") == "ok":
                processed += 1
            else:
                failed += 1
            progress.advance(task)

    with console.status("[dim]Freeing AI memory…[/dim]", spinner="dots"):
        _pipeline.unload_models()

    console.print()
    console.print(
        f"[bold green]Done.[/bold green] {processed} reprocessed · {failed} failed"
    )
    console.print()


if __name__ == "__main__":
    cli()
