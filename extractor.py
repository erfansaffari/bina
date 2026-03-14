"""
Text extraction for PDF, DOCX, TXT, MD, CSV, and image files.
Returns a list of page strings and the total page count.

For images, returns a special sentinel so pipeline.py can route to
the vision model instead of the text LLM.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import NamedTuple

IMAGE_SENTINEL = "__IMAGE__"  # pipeline.py checks for this


class ExtractionResult(NamedTuple):
    pages: list[str]
    page_count: int
    is_image: bool = False      # True → use vision model, not text LLM
    image_bytes: bytes = b""    # raw image bytes for base64 encoding


def extract(path: str | Path) -> ExtractionResult:
    """Extract text from a supported file. Returns (pages, page_count, is_image, image_bytes)."""
    path = Path(path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return _extract_pdf(path)
    elif suffix == ".docx":
        return _extract_docx(path)
    elif suffix in {".txt", ".md"}:
        return _extract_plaintext(path)
    elif suffix == ".csv":
        return _extract_csv(path)
    elif suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        return _extract_image(path)
    else:
        raise ValueError(f"Unsupported file type: {suffix}")


def _extract_pdf(path: Path) -> ExtractionResult:
    import fitz  # pymupdf

    pages: list[str] = []
    with fitz.open(str(path)) as doc:
        for page in doc:
            text = page.get_text("text")
            pages.append(text)
    return ExtractionResult(pages=pages, page_count=len(pages))


def _extract_docx(path: Path) -> ExtractionResult:
    from docx import Document

    doc = Document(str(path))
    # Treat every 30 paragraphs as a logical "page" so sampling logic applies
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    chunk_size = 30
    pages: list[str] = []
    for i in range(0, max(len(paragraphs), 1), chunk_size):
        chunk = "\n".join(paragraphs[i : i + chunk_size])
        if chunk.strip():
            pages.append(chunk)
    if not pages:
        pages = [""]
    return ExtractionResult(pages=pages, page_count=len(pages))


def _extract_plaintext(path: Path) -> ExtractionResult:
    text = path.read_text(encoding="utf-8", errors="replace")
    # Split into ~500-char logical pages so sampler can work uniformly
    lines = text.splitlines(keepends=True)
    chunk_size = 50  # lines per logical page
    pages: list[str] = []
    for i in range(0, max(len(lines), 1), chunk_size):
        chunk = "".join(lines[i : i + chunk_size])
        if chunk.strip():
            pages.append(chunk)
    if not pages:
        pages = [text or ""]
    return ExtractionResult(pages=pages, page_count=len(pages))


def _extract_csv(path: Path) -> ExtractionResult:
    """Parse a CSV file into a readable text representation."""
    import csv

    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            reader = csv.reader(f)
            rows = list(reader)
    except Exception:
        return ExtractionResult(pages=["[CSV unreadable]"], page_count=1)

    if not rows:
        return ExtractionResult(pages=["[Empty CSV]"], page_count=1)

    headers = rows[0]
    data_rows = rows[1:201]  # max 200 sample rows

    # Format as a compact text table
    lines = ["CSV File — Column Summary", f"Columns ({len(headers)}): {', '.join(headers)}", ""]
    lines.append(f"Sample data ({len(data_rows)} rows):")
    for row in data_rows[:20]:  # first 20 rows in detail
        lines.append("  " + " | ".join(str(c)[:50] for c in row))
    if len(data_rows) > 20:
        lines.append(f"  ... and {len(data_rows) - 20} more rows")
    lines.append(f"\nTotal rows sampled: {len(data_rows)}")

    text = "\n".join(lines)
    return ExtractionResult(pages=[text], page_count=1)


def _extract_image(path: Path) -> ExtractionResult:
    """Read image bytes for vision model processing."""
    raw = path.read_bytes()
    # Validate it's a real, readable image using Pillow
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(raw))
        img.verify()        # raises on corrupt images
    except Exception as e:
        raise ValueError(f"Image unreadable: {e}") from e

    return ExtractionResult(
        pages=[IMAGE_SENTINEL],
        page_count=1,
        is_image=True,
        image_bytes=raw,
    )


