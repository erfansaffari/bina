"""
inference.py — unified inference client for all three processing paths.

Path A: Hosted GPT-OSS (default) — free, fast, requires internet
Path B: Local Ollama (qwen3.5:2b) — private, slower
Path C: User's own OpenAI API key — user's billing
"""
from __future__ import annotations

import base64
import logging
from typing import Any

from openai import OpenAI
import ollama

from config import (
    HOSTED_API_BASE, HOSTED_API_KEY, HOSTED_MODEL,
    LOCAL_MODEL, LOCAL_EMBED_MODEL, LLM_CHAR_BUDGET,
)

logger = logging.getLogger(__name__)

# ── Analysis prompts (moved here from pipeline.py) ──────────────────────────

_SYSTEM_PROMPT = """\
You are a document analyser. Extract structured metadata from the provided \
document text. Respond with ONLY a valid JSON object — no markdown, no \
explanation, no preamble, no <think> blocks.

Required format:
{
  "summary": "<3-sentence plain-language summary of what this document is>",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "entities": {
    "persons": ["person names found"],
    "companies": ["company/org names found"],
    "dates": ["dates found"],
    "projects": ["project names found"],
    "locations": ["locations found"]
  },
  "doc_type": "<one of: Invoice, Research Paper, Meeting Notes, Contract, \
Book Chapter, Lecture Notes, Assignment, README, Report, Email, \
Presentation, Spreadsheet, Image, CSV Data, Other>"
}"""

_IMAGE_PROMPT = """\
You are a document archivist analysing an image. Describe what you see \
(objects, text, context), then respond with ONLY a valid JSON object — \
no markdown, no explanation, no <think> blocks.

Required format:
{
  "summary": "<2-3 sentences describing what this image shows>",
  "keywords": ["keyword1", "keyword2", "up to 10"],
  "entities": {
    "persons": [], "companies": [], "dates": [],
    "projects": [], "locations": []
  },
  "doc_type": "Image"
}"""


# ── Client helpers ───────────────────────────────────────────────────────────

def _get_client_for_workspace(workspace: Any) -> tuple[str, OpenAI | None]:
    """
    Returns (model_name, client) based on the workspace's processing_path.
    client is None when using local Ollama.
    """
    path = getattr(workspace, "processing_path", "hosted") if workspace else "hosted"

    if path == "hosted":
        client = OpenAI(api_key=HOSTED_API_KEY, base_url=HOSTED_API_BASE)
        return HOSTED_MODEL, client

    elif path == "user_api":
        api_key = getattr(workspace, "user_api_key", None)
        base_url = getattr(workspace, "user_api_base", None)
        if not api_key:
            raise ValueError("Workspace has user_api path but no api_key set")
        client = OpenAI(
            api_key=api_key,
            base_url=base_url or "https://api.openai.com/v1",
        )
        model = getattr(workspace, "model_name", None) or "gpt-4o-mini"
        return model, client

    else:  # "local"
        return LOCAL_MODEL, None


# ── Main inference call ──────────────────────────────────────────────────────

def call_inference(
    text: str,
    workspace: Any,
    image_bytes: bytes | None = None,
    max_tokens: int = 1024,
) -> str:
    """
    Call the LLM for the given workspace's processing path.
    Returns raw text response (JSON parsing/repair is the caller's job).

    For images: pass image_bytes; text is ignored.
    For text: pass text (document content to analyse).
    """
    model_name, client = _get_client_for_workspace(workspace)

    if client is None:
        # Local Ollama path
        return _call_ollama(model_name, text, image_bytes)
    else:
        # OpenAI-compatible path (hosted GPT-OSS or user API)
        return _call_openai(client, model_name, text, image_bytes, max_tokens)


def _call_openai(
    client: OpenAI,
    model: str,
    text: str,
    image_bytes: bytes | None,
    max_tokens: int,
) -> str:
    """Call an OpenAI-compatible API (hosted GPT-OSS or user's own key)."""
    if image_bytes:
        b64 = base64.b64encode(image_bytes).decode()
        messages = [
            {"role": "system", "content": _IMAGE_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "Analyse this image for a file archive."},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/jpeg;base64,{b64}",
                }},
            ]},
        ]
    else:
        truncated = text[:LLM_CHAR_BUDGET]
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": truncated},
        ]

    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
    )
    return resp.choices[0].message.content or ""


def _call_ollama(
    model: str,
    text: str,
    image_bytes: bytes | None,
) -> str:
    """Call local Ollama for inference."""
    if image_bytes:
        b64 = base64.b64encode(image_bytes).decode()
        response = ollama.chat(
            model=model,
            messages=[{
                "role": "user",
                "content": _IMAGE_PROMPT,
                "images": [b64],
            }],
            options={"temperature": 0.1},
        )
    else:
        truncated = text[:LLM_CHAR_BUDGET]
        input_tokens = len(truncated) // 4
        num_ctx = max(1024, min(input_tokens + 512, 8192))
        response = ollama.chat(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": truncated},
            ],
            options={"temperature": 0.1, "num_ctx": num_ctx},
        )
    return response["message"]["content"]


# ── Chat / Q&A inference (separate from document analysis) ──────────────────

_CHAT_SYSTEM_PROMPT = """\
You are Bina, a helpful AI assistant for a personal file vault. \
The user is asking questions about their indexed documents. \
Answer clearly and concisely in plain language. \
Cite specific file names where your answer is drawn from. \
Do NOT output JSON. Do NOT output code blocks unless the user asks for code."""


def call_chat(
    prompt: str,
    workspace: Any,
    max_tokens: int = 600,
) -> str:
    """
    Call the LLM for conversational Q&A using the workspace's processing path.

    This is DIFFERENT from call_inference() — it uses a plain-language system
    prompt so the model answers in natural language, not JSON.
    """
    model_name, client = _get_client_for_workspace(workspace)

    if client is None:
        # Local Ollama path
        input_tokens = len(prompt) // 4
        num_ctx = max(1024, min(input_tokens + 512, 8192))
        response = ollama.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": _CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            options={"temperature": 0.3, "num_ctx": num_ctx},
        )
        return response["message"]["content"]
    else:
        # OpenAI-compatible (hosted GPT-OSS or user API)
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": _CHAT_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""


# ── Embedding ────────────────────────────────────────────────────────────────

def embed_text(text: str, workspace: Any = None) -> list[float]:
    """
    Embed text. Always tries local nomic-embed-text first (fast, ~274 MB).
    Falls back to OpenAI text-embedding-3-small if Ollama is unavailable
    and workspace uses a hosted/user_api path.
    """
    try:
        response = ollama.embeddings(
            model=LOCAL_EMBED_MODEL,
            prompt=text[:6000],
        )
        return response["embedding"]
    except Exception as e:
        logger.warning(f"Ollama embedding failed: {e}")
        if workspace and getattr(workspace, "processing_path", "hosted") != "local":
            return _embed_openai(text, workspace)
        raise


def _embed_openai(text: str, workspace: Any) -> list[float]:
    """Fallback: use OpenAI embeddings API if Ollama is unavailable."""
    _, client = _get_client_for_workspace(workspace)
    if client is None:
        raise RuntimeError("Cannot embed: Ollama unavailable and no API client")
    response = client.embeddings.create(
        model="text-embedding-3-small",
        input=text[:6000],
    )
    return response.data[0].embedding
