"""
FSEvents folder watcher via watchdog.

Watches a folder recursively for file creation, modification, and deletion.
On each event the appropriate pipeline function is called in a background
thread so the watcher loop is never blocked by AI processing.
"""
from __future__ import annotations

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
import pipeline


class _BinaHandler(FileSystemEventHandler):
    def __init__(self, on_processed: Callable[[dict], None] | None = None) -> None:
        super().__init__()
        self._on_processed = on_processed
        self._pending: dict[str, float] = {}  # path → last-seen mtime
        self._lock = threading.Lock()

    def _is_supported(self, path: str) -> bool:
        return Path(path).suffix.lower() in SUPPORTED_EXTENSIONS

    def _process_async(self, path: str) -> None:
        def _run():
            result = pipeline.process_file(path)
            if self._on_processed:
                self._on_processed(result)

        threading.Thread(target=_run, daemon=True).start()

    def _remove_async(self, path: str) -> None:
        def _run():
            pipeline.remove_file(path)

        threading.Thread(target=_run, daemon=True).start()

    def on_created(self, event: FileCreatedEvent) -> None:  # type: ignore[override]
        if not event.is_directory and self._is_supported(event.src_path):
            self._process_async(event.src_path)

    def on_modified(self, event: FileModifiedEvent) -> None:  # type: ignore[override]
        if not event.is_directory and self._is_supported(event.src_path):
            # Debounce: some editors write multiple modify events per save
            with self._lock:
                last = self._pending.get(event.src_path, 0)
                now = time.monotonic()
                if now - last < 2.0:
                    return
                self._pending[event.src_path] = now
            self._process_async(event.src_path)

    def on_deleted(self, event: FileDeletedEvent) -> None:  # type: ignore[override]
        if not event.is_directory and self._is_supported(event.src_path):
            self._remove_async(event.src_path)

    def on_moved(self, event: FileMovedEvent) -> None:  # type: ignore[override]
        if not event.is_directory:
            if self._is_supported(event.src_path):
                self._remove_async(event.src_path)
            if self._is_supported(event.dest_path):
                self._process_async(event.dest_path)


class FolderWatcher:
    """Watches a folder using macOS FSEvents (via watchdog) in a background thread."""

    def __init__(
        self,
        folder: str | Path,
        on_processed: Callable[[dict], None] | None = None,
    ) -> None:
        self._folder = str(folder)
        self._handler = _BinaHandler(on_processed=on_processed)
        self._observer = Observer()

    def start(self) -> None:
        self._observer.schedule(self._handler, self._folder, recursive=True)
        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join()

    def is_alive(self) -> bool:
        return self._observer.is_alive()
