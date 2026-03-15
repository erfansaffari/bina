# Bina — Developer Log

---

## Session · 2026-03-14

### Overview
This session focused on upgrading the AI model stack, expanding file-type support, fixing indexing bugs, and improving workspace management UX.

---

### 1 · Model Stack Overhaul

#### Problem
The original setup used `llama3.2:3b` for text inference and `nomic-embed-text` for embeddings. The user requested a smarter, multimodal model that could handle both text documents and images without needing two separate models.

#### Journey
| Attempt | Model | Outcome |
|---|---|---|
| 1st | `qwen3:4b` (text) + `qwen2.5vl:3b` (vision) | Worked but required 2 models |
| 2nd | `qwen2.5vl:3b` alone for text + images | ❌ GGML_ASSERT crashes on pure text (VL model requires image tokens) |
| 3rd ✅ | `qwen3.5:2b` for text + images | ✅ Verified multimodal: `completion + vision + thinking` |

#### Final Stack
```
MODEL        = qwen3.5:2b       # text analysis + image understanding (single model)
EMBED_MODEL  = nomic-embed-text # 768-dim semantic vectors
```

#### Files Changed
- `config.py` — added `MODEL`, `LLM_MODEL`, `VISION_MODEL` (all pointing to `qwen3.5:2b`), updated `_DEFAULTS` and `load_settings()` / `save_settings()`
- `~/.bina/settings.json` — updated persisted model name on disk
- `backend/api.py` — `_REQUIRED_MODELS` reduced from 3 → 2 entries (`qwen3.5:2b` + `nomic-embed-text`)

---

### 2 · Pipeline Rewrite (`pipeline.py`)

#### What Changed
- Removed separate `_call_llm()` and `_call_vision()` functions
- Replaced with unified `_call_model(text, image_bytes=None)`:
  - **Text files** → sends document text with structured JSON analysis prompt
  - **Image files** → sends image bytes directly via Ollama's `images` field with an archiving-focused prompt
- `_IMAGE_PROMPT` added: produces `summary`, `keywords`, `entities`, `doc_type: "Image"` directly from the model — no intermediate description step
- `unload_models()` simplified to unload one model instead of two
- `LLM_CHAR_BUDGET` increased from 4 000 → 8 000 chars (qwen3.5 handles longer context)
- Added **20 MB image size guard** — rejects oversized images before calling the model

#### Bug Fixed: Vision failure producing garbage summary
Previously, when the vision model failed (e.g. not installed), the error string `"[Image description unavailable: ...]"` was silently passed into the LLM → the LLM summarised the error text and stored it as the file's summary. Fixed: vision failure now raises immediately → file stored as `status='failed'` with a clear error message.

---

### 3 · File Type Support Expansion

#### Newly Supported
| Extension | How Processed |
|---|---|
| `.png`, `.jpg`, `.jpeg`, `.webp` | Passed as base64 image bytes to `qwen3.5:2b` |
| `.csv` | Parsed into text table (headers + first 200 rows) → standard LLM path |

#### Files Changed
- `config.py` — added `.png .jpg .jpeg .webp .csv` to `SUPPORTED_EXTENSIONS`; added `IMAGE_EXTENSIONS` set
- `extractor.py` — added `_extract_csv()` and `_extract_image()`; `ExtractionResult` now has `is_image` and `image_bytes` fields
- `requirements.txt` — added `Pillow` for image validation

---

### 4 · Image Extension Case Sensitivity Fix

#### Problem
`IMG_6774.JPG` (uppercase `.JPG`) wasn't being watched/processed.

#### Fix
`watcher.py` already used `Path(path).suffix.lower()` — the real issue was the vision model not being installed, causing a 500 error from Ollama that was silently swallowed and stored as the summary text.

---

### 5 · App Startup Fix — Workspace Not Persisting

#### Problem
`App.tsx` was calling `modelsApi.status()` on startup and routing to Onboarding if any model was missing, even if the user already had workspaces. This caused users to lose access to existing workspaces every time a model wasn't installed.

#### Fix
Removed the `modelsReady` blocking gate from `App.tsx`. Now:
- App loads workspaces immediately on startup
- Onboarding only shown if `workspaces.length === 0` (true first-time users)
- Model setup is accessible via **Settings → AI Models** for existing users

---

### 6 · Settings Modal — AI Models Section

#### What Changed
Replaced the old static `llama3.2:3b` / `llama3.1:8b` model picker with a live **AI Models** panel:
- Shows each required model with its role, size, and install status
- Individual **Install** buttons that trigger Ollama pull via backend
- Live progress bar polling (`/models/pull-progress/{model}`)
- `✓ All ready` badge when all models are present

#### Files Changed
- `frontend/src/components/SettingsModal.tsx` — full rewrite

---

### 7 · Model Onboarding Screen (`ModelSetupScreen.tsx`)

#### What Was Added
- New component for first-time users who don't have required models installed
- Shows model list with roles, sizes, and download buttons
- Real-time progress bars during pulls
- Auto-advances when all models are ready

#### Backend API Endpoints Added (`backend/api.py`)
```
GET  /models/status                  → check which models are installed
POST /models/pull/{model_name}       → start background pull
GET  /models/pull-progress/{model}   → poll pull progress (percent, status)
```

---

### 8 · Inspector — Image Thumbnail Preview

#### What Was Added (`Inspector.tsx`)
- Inline `<img>` thumbnail rendered for `.png/.jpg/.jpeg/.webp` files using `file://` path
- `Image` and `Photograph` doc_type badge colors added (pink)
- Error handler hides thumbnail gracefully if image can't be loaded

---

### 9 · Workspace Delete

#### What Was Added (`WorkspaceSwitcher.tsx`)
- **🗑 Delete button** appears on hover over each workspace icon (top-right corner)
- Confirmation dialog: warns the user that indexed data (not actual files) will be removed
- Spinner shown on the workspace icon while deleting
- If the active workspace is deleted, auto-switches to the next available one
- Backend `DELETE /workspaces/:id` endpoint was already implemented — only frontend wiring was needed

---

### 10 · Cleanup

- Removed all references to `llama3.2:3b` and `llama3.1:8b` from the codebase and persisted settings
- `qwen3:4b` and `llama3.2:3b` remain installed in Ollama but are no longer used (can be freed with `ollama rm`)
- `DeprecationWarning: datetime.utcnow()` noted in `api.py` (pre-existing, not blocking)

---

### Models Currently Installed

```
qwen3.5:2b          2.7 GB   ← active (text + vision)
qwen2.5vl:3b        3.2 GB   ← unused (can remove)
qwen3:4b            2.5 GB   ← unused (can remove)
llama3.2:3b         2.0 GB   ← unused (can remove)
nomic-embed-text    274 MB   ← active (embeddings)
```

Free up ~8 GB with:
```bash
ollama rm qwen2.5vl:3b
ollama rm qwen3:4b
ollama rm llama3.2:3b
```

---

### Known Issues / Next Steps

- `DeprecationWarning` for `datetime.utcnow()` in `backend/api.py:562` — minor, not blocking
- Pyre2 lint false-positives for venv imports (`fastapi`, `chromadb`, etc.) — tool config issue, not real errors
- `qwen3.5:2b` `thinking` capability is enabled by default — monitor if `<think>` tags leak into JSON responses (the `_repair_json` stripper handles markdown fences but not thinking tags; add stripper if needed)
