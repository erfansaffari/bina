"""
Text extraction for PDF, DOCX, TXT, and MD files.
Returns a list of page strings and the total page count.
"""
from __future__ import annotations

from pathlib import Path
from typing import NamedTuple


class ExtractionResult(NamedTuple):
    pages: list[str]
    page_count: int


def extract(path: str | Path) -> ExtractionResult:
    """Extract text from a supported file. Returns (pages, page_count)."""
    path = Path(path)
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return _extract_pdf(path)
    elif suffix == ".docx":
        return _extract_docx(path)
    elif suffix in {".txt", ".md"}:
        return _extract_plaintext(path)
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
