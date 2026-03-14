"""
FSEvents folder watcher via watchdog — workspace-aware.

Each FolderWatcher is bound to one (workspace_id, folder_path) pair.
It accepts pipeline_fn and remove_fn callbacks so the API layer controls
how files are processed and removed.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Callable

from watchdog.events import (
    FileCreatedEvent,
    FileDeletedEvent,
    FileModifiedEvent,
    FileMovedEvent,
    FileSystemEventHandler,
)
from watchdog.observers import Observer

from config import SUPPORTED_EXTENSIONS

logger = logging.getLogger(__name__)


class _BinaHandler(FileSystemEventHandler):
    """Watchdog handler for a single (workspace, folder) pair."""

    def __init__(
        self,
        workspace_id: str,
        pipeline_fn: Callable[[str, str], None],
        remove_fn: Callable[[str, str], None],
        on_processed: Callable[[dict], None] | None = None,
    ) -> None:
        super().__init__()
        self.workspace_id = workspace_id
        self._process = pipeline_fn    # process_file(path, workspace_id)
        self._remove = remove_fn       # remove_file(path, workspace_id)
        self._on_processed = on_processed
        self._pending: dict[str, float] = {}
        self._lock = threading.Lock()

    def _is_supported(self, path: str) -> bool:
        return Path(path).suffix.lower() in SUPPORTED_EXTENSIONS

    def _process_async(self, path: str) -> None:
        def _run() -> None:
            result = self._process(path, self.workspace_id)
            if self._on_processed and isinstance(result, dict):
                self._on_processed(result)

        threading.Thread(target=_run, daemon=True).start()

    def _remove_async(self, path: str) -> None:
        def _run() -> None:
            self._remove(path, self.workspace_id)

        threading.Thread(target=_run, daemon=True).start()

    def on_created(self, event: FileCreatedEvent) -> None:  # type: ignore[override]
        if not event.is_directory and self._is_supported(event.src_path):
            path = str(Path(event.src_path).resolve())
            self._process_async(path)

    def on_modified(self, event: FileModifiedEvent) -> None:  # type: ignore[override]
        if not event.is_directory and self._is_supported(event.src_path):
            path = str(Path(event.src_path).resolve())
            with self._lock:
                last = self._pending.get(path, 0)
                now = time.monotonic()
                if now - last < 2.0:
                    return
                self._pending[path] = now
            self._process_async(path)

    def on_deleted(self, event: FileDeletedEvent) -> None:  # type: ignore[override]
        if event.is_directory:
            return
        path = str(Path(event.src_path).resolve())
        self._remove_async(path)
        logger.info("Queued removal for deleted file: %s (workspace: %s)", path, self.workspace_id)

    def on_moved(self, event: FileMovedEvent) -> None:  # type: ignore[override]
        if not event.is_directory:
            if self._is_supported(event.src_path):
                old_path = str(Path(event.src_path).resolve())
                self._remove_async(old_path)
            if self._is_supported(event.dest_path):
                new_path = str(Path(event.dest_path).resolve())
                self._process_async(new_path)


class FolderWatcher:
    """Watches one folder for one workspace using macOS FSEvents (watchdog)."""

    def __init__(
        self,
        workspace_id: str,
        folder_path: str | Path,
        pipeline_fn: Callable[[str, str], None],
        remove_fn: Callable[[str, str], None],
        on_processed: Callable[[dict], None] | None = None,
    ) -> None:
        self.workspace_id = workspace_id
        self._folder = str(folder_path)
        self._handler = _BinaHandler(
            workspace_id=workspace_id,
            pipeline_fn=pipeline_fn,
            remove_fn=remove_fn,
            on_processed=on_processed,
        )
        self._observer = Observer()

    def start(self) -> None:
        self._observer.schedule(self._handler, self._folder, recursive=True)
        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join()

    def is_alive(self) -> bool:
        return self._observer.is_alive()
