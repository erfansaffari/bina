"""
Smart sampling engine.

Extracts a statistically representative slice of a document
within a fixed token/character budget so the LLM always receives
a manageable context window.

    Short  (<10 pages):  full text
    Medium (10–50 pages): first 5 + last 5 + 5 random middle
    Long   (50+ pages):  first 10 + last 10 + 10 random middle
"""
from __future__ import annotations

import random
from config import CHAR_BUDGET


def sample(pages: list[str], seed: int | None = None) -> str:
    """Return a single sampled string from the page list, within CHAR_BUDGET chars."""
    n = len(pages)

    if n == 0:
        return ""

    rng = random.Random(seed)

    if n < 10:
        selected = pages[:]
    elif n < 50:
        head = pages[:5]
        tail = pages[-5:]
        middle_indices = list(range(5, n - 5))
        middle = [pages[i] for i in rng.sample(middle_indices, min(5, len(middle_indices)))]
        selected = head + middle + tail
    else:
        head = pages[:10]
        tail = pages[-10:]
        middle_indices = list(range(10, n - 10))
        middle = [pages[i] for i in rng.sample(middle_indices, min(10, len(middle_indices)))]
        selected = head + middle + tail

    text = "\n\n".join(page for page in selected if page.strip())
    return text[:CHAR_BUDGET]
