# Bina v3 — Continuation Prompt (Second Half)
## Remaining Frontend Tasks + Error Handling + Cleanup

---

## CONTEXT — READ BEFORE TOUCHING ANYTHING

This is a continuation of the Bina v3 upgrade. The following is FULLY
IMPLEMENTED and working. Do not rewrite or re-examine any of it:

### Backend (100% complete — do not touch):
- `inference.py` — unified LLM + embedding abstraction (hosted/local/user_api)
- `vector_store_moorcheh.py` — Moorcheh SDK wrapper
- `vector_store_local.py` — ChromaDB (local privacy mode)
- `vector_store_router.py` — dynamic store selection per workspace
- `vector_store.py` — legacy shim (do not modify)
- `pipeline.py` — uses inference.py, workspace-aware
- `search.py` — uses vector_store_router
- `graph.py` — per-workspace NetworkX, uses router
- `agent.py` — Railtracks tool nodes + agent builder with graceful fallback
- `store.py` — dynamic migration, _utcnow() helper, all workspace CRUD
- `api.py` — all endpoints including POST /query, PATCH /workspaces/:id/model

### Frontend (partially complete — do not rewrite what exists):
- `types.ts` — Workspace interface updated, QueryResult type added
- `api.ts` — workspacesApi.getModel() and query() implemented
- `AskBinaPanel.tsx` — ChatGPT-style conversational UI with cited sources
- `MainLayout.tsx` — graph/ask toggle in top nav, AskBinaPanel wired in
- `Onboarding.tsx` — model_choice step (hosted/local/user_api), Ollama
  installer only shown for local path, API key input for user_api path

### What the PATCH /workspaces/:id/model endpoint accepts:
```json
{
  "processing_path": "hosted" | "local" | "user_api",
  "model_name": "openai/gpt-oss-120b",
  "user_api_key": "sk-...",
  "user_api_base": "https://...",
  "vector_backend": "moorcheh" | "chromadb"
}
```

### Where Moorcheh API key is stored:
`~/.bina/.env` — read by the backend on startup via python-dotenv.
`MOORCHEH_API_KEY=<value>` is the key name.

### Hosted GPT-OSS config (already in config.py):
```
HOSTED_API_BASE = "https://vjioo4r1vyvcozuj.us-east-2.aws.endpoints.huggingface.cloud/v1"
HOSTED_API_KEY  = "test"
HOSTED_MODEL    = "openai/gpt-oss-120b"
```

---

## TASK 1 — Workspace Settings UI in WorkspaceModal.tsx

### What to build
Add an "AI Settings" section to `WorkspaceModal.tsx` when it is in
**edit mode** (not create mode — onboarding already handles create).
This lets users migrate an existing workspace from local → hosted,
swap their API key, or switch vector backends.

### Exact UI spec

Inside the WorkspaceModal edit view, after the emoji/name/colour section,
add a collapsible section titled "AI Settings":

```
AI Settings  [chevron toggle]
─────────────────────────────────────────
Processing path
  ○ Hosted AI (recommended)
    "Uses the free hosted server. Fast. Requires internet."
  ○ Local AI (private)
    "All AI runs on your Mac. Slower. Nothing leaves your device."
  ○ Your API Key
    [text input: "Paste your OpenAI-compatible API key"]
    [text input: "Base URL (optional — leave blank for OpenAI)"]
    [text input: "Model name (e.g. gpt-4o-mini)"]

Vector store  [only show if processing_path === "local"]
  ○ Moorcheh (default)
    "Hosted vector search. Vectors leave your device."
  ○ Local ChromaDB
    "Fully offline. Vectors stay on your Mac."

[Save AI Settings]  ← calls PATCH /workspaces/:id/model
```

### Warning banner for path switches

If the user changes `processing_path` from the current saved value,
show a yellow warning banner ABOVE the Save button:

```
⚠ Changing the AI path will re-embed all files in this workspace
on next index. This may take a few minutes.
```

Only show if the new path !== the existing saved path. Do not show
on first open (before user has changed anything).

### Implementation

```typescript
// In WorkspaceModal.tsx

// 1. Fetch current model config on mount (edit mode only)
useEffect(() => {
  if (!isEditMode || !workspace?.id) return
  api.workspacesApi.getModel(workspace.id).then(config => {
    setProcessingPath(config.processing_path)
    setModelName(config.model_name || '')
    setUserApiKey(config.has_user_api_key ? '••••••••' : '')
    setUserApiBase(config.user_api_base || '')
    setVectorBackend(config.vector_backend || 'moorcheh')
    setOriginalPath(config.processing_path)  // track for change warning
  })
}, [isEditMode, workspace?.id])

// 2. Save handler
const saveModelConfig = async () => {
  if (!workspace?.id) return
  setSaving(true)
  try {
    await api.workspacesApi.updateModel(workspace.id, {
      processing_path: processingPath,
      model_name: modelName || undefined,
      user_api_key: userApiKey && !userApiKey.includes('•')
                    ? userApiKey : undefined,
      user_api_base: userApiBase || undefined,
      vector_backend: vectorBackend,
    })
    setOriginalPath(processingPath)
    showSuccessToast('AI settings saved')
  } catch (e) {
    showErrorToast('Failed to save AI settings')
  } finally {
    setSaving(false)
  }
}
```

Add `workspacesApi.updateModel` to `api.ts` if not already present:
```typescript
updateModel: async (workspaceId: string, config: Partial<WorkspaceModelConfig>) => {
  return apiRequest(`/workspaces/${workspaceId}/model`, {
    method: 'PATCH',
    body: JSON.stringify(config),
  })
}
```

---

## TASK 2 — Global App Settings Screen (Moorcheh API Key UI)

### What to build
A global settings screen (not workspace-specific) where the user can
paste their Moorcheh API key. This writes to `~/.bina/.env` via a
new backend endpoint.

### Backend endpoint (add to api.py)

```python
class AppSettingsRequest(BaseModel):
    moorcheh_api_key: str | None = None

class AppSettingsResponse(BaseModel):
    moorcheh_api_key_set: bool
    moorcheh_connected: bool

@app.get("/settings/app")
async def get_app_settings():
    """Check current global app settings status."""
    key_set = bool(os.environ.get("MOORCHEH_API_KEY"))
    connected = False
    if key_set:
        try:
            from vector_store_moorcheh import MoorchehVectorStore
            count = MoorchehVectorStore().count()
            connected = True
        except Exception:
            connected = False
    return AppSettingsResponse(
        moorcheh_api_key_set=key_set,
        moorcheh_connected=connected
    )

@app.post("/settings/app")
async def save_app_settings(request: AppSettingsRequest):
    """
    Save global app settings to ~/.bina/.env
    Rewrites the key in the .env file and reloads into os.environ.
    """
    env_path = Path.home() / ".bina" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)

    # Read existing .env lines
    lines = []
    if env_path.exists():
        lines = env_path.read_text().splitlines()

    # Update or insert MOORCHEH_API_KEY
    if request.moorcheh_api_key is not None:
        key_line = f"MOORCHEH_API_KEY={request.moorcheh_api_key}"
        updated = False
        for i, line in enumerate(lines):
            if line.startswith("MOORCHEH_API_KEY="):
                lines[i] = key_line
                updated = True
                break
        if not updated:
            lines.append(key_line)
        # Hot-reload into running process
        os.environ["MOORCHEH_API_KEY"] = request.moorcheh_api_key

    env_path.write_text("\n".join(lines) + "\n")
    return {"saved": True}
```

### Frontend — Settings screen / modal

Add a "Global Settings" option accessible from:
1. The WorkspaceSwitcher bottom area (gear icon)
2. The Electron app menu (Help → Settings or Bina → Preferences)

The settings screen is a simple modal (same style as WorkspaceModal):

```
Global Settings
────────────────────────────────────────────────
Moorcheh API Key
  [password input: "Paste your Moorcheh API key"]
  Status indicator:
    ● Connected     (green dot — key works)
    ○ Not connected (red dot — key missing or invalid)
  [Test connection]  ← calls GET /settings/app
  [Save]             ← calls POST /settings/app

────────────────────────────────────────────────
About
  Bina v3 · All AI runs locally or via your chosen provider
```

On mount: call `GET /settings/app` to check if key is set.
Show `••••••••` if key is already set (don't expose the actual key).
Only send to backend if user types a new value (not the masked value).

Add to `api.ts`:
```typescript
export const appSettingsApi = {
  get: () => apiRequest('/settings/app'),
  save: (settings: { moorcheh_api_key?: string }) =>
    apiRequest('/settings/app', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
}
```

---

## TASK 3 — Graceful Error Handling in AskBinaPanel.tsx

### Current problem
`AskBinaPanel.tsx` renders raw error strings from the backend if the
query fails — users see Python tracebacks or "401 Unauthorized" text.

### What to build
Intercept specific error types and show friendly UI instead.

```typescript
// In AskBinaPanel.tsx — replace the raw error display

interface BinaChatError {
  type: 'moorcheh_missing_key' | 'moorcheh_unauthorized' |
        'ollama_unavailable' | 'hosted_unreachable' | 'unknown'
  message: string
  action?: string
}

function classifyError(errorText: string): BinaChatError {
  const lower = errorText.toLowerCase()

  if (lower.includes('moorcheh') && (
      lower.includes('api_key') || lower.includes('not set') ||
      lower.includes('missing'))) {
    return {
      type: 'moorcheh_missing_key',
      message: 'Moorcheh API key is not configured.',
      action: 'open_settings'
    }
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return {
      type: 'moorcheh_unauthorized',
      message: 'Moorcheh API key is invalid or expired.',
      action: 'open_settings'
    }
  }
  if (lower.includes('ollama') || lower.includes('connection refused') ||
      lower.includes('11434')) {
    return {
      type: 'ollama_unavailable',
      message: 'Ollama is not running. Start it with: ollama serve',
      action: 'copy_command'
    }
  }
  if (lower.includes('huggingface') || lower.includes('hosted') ||
      lower.includes('econnrefused')) {
    return {
      type: 'hosted_unreachable',
      message: 'The hosted AI server is unreachable. Check your internet connection.',
      action: null
    }
  }
  return {
    type: 'unknown',
    message: 'Something went wrong. Check the backend logs.',
    action: null
  }
}

// Error UI component
function ErrorMessage({ error, onOpenSettings, onCopyCommand }: {
  error: BinaChatError
  onOpenSettings: () => void
  onCopyCommand: (cmd: string) => void
}) {
  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: 10,
      background: 'rgba(220, 38, 38, 0.08)',
      border: '1px solid rgba(220, 38, 38, 0.2)',
      color: 'var(--color-text-primary)',
      fontSize: 13,
      lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 500, marginBottom: 6 }}>
        {error.message}
      </div>
      {error.action === 'open_settings' && (
        <button
          onClick={onOpenSettings}
          style={{
            fontSize: 12, color: '#4F46E5',
            background: 'none', border: 'none',
            cursor: 'pointer', padding: 0,
            textDecoration: 'underline'
          }}
        >
          Open Settings to fix this →
        </button>
      )}
      {error.action === 'copy_command' && (
        <button
          onClick={() => onCopyCommand('ollama serve')}
          style={{
            fontSize: 12, color: '#4F46E5',
            background: 'none', border: 'none',
            cursor: 'pointer', padding: 0,
            textDecoration: 'underline'
          }}
        >
          Copy command
        </button>
      )}
    </div>
  )
}
```

In the message rendering in AskBinaPanel.tsx, replace the current
error display:

```typescript
// Replace:
{message.isError && <div className="error">{message.content}</div>}

// With:
{message.isError && (() => {
  const classified = classifyError(message.content)
  return (
    <ErrorMessage
      error={classified}
      onOpenSettings={() => setGlobalSettingsOpen(true)}
      onCopyCommand={(cmd) => navigator.clipboard.writeText(cmd)}
    />
  )
})()}
```

Also add: if the ENTIRE ask panel fails to load (no workspaces, no
Moorcheh key), show a full-panel empty state instead of a blank div:

```typescript
// At top of AskBinaPanel render, before chat history:
if (!activeWorkspaceId) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  height: '100%', gap: 12,
                  color: 'var(--color-text-tertiary)' }}>
      <div style={{ fontSize: 15 }}>No workspace selected</div>
      <div style={{ fontSize: 13 }}>
        Select a workspace from the left panel to start asking questions.
      </div>
    </div>
  )
}
```

---

## TASK 4 — Wire Global Settings into App Navigation

### What to build
Connect the GlobalSettingsModal to the rest of the app so it can be
opened from multiple places.

In `appStore.ts` (Zustand), add:
```typescript
globalSettingsOpen: boolean
setGlobalSettingsOpen: (open: boolean) => void
```

In `MainLayout.tsx`, render `<GlobalSettingsModal>` at the root level
(same pattern as WorkspaceModal):
```typescript
const { globalSettingsOpen, setGlobalSettingsOpen } = useAppStore()

// In JSX:
{globalSettingsOpen && (
  <GlobalSettingsModal onClose={() => setGlobalSettingsOpen(false)} />
)}
```

In `WorkspaceSwitcher.tsx`, add a gear icon at the bottom:
```typescript
<button
  onClick={() => setGlobalSettingsOpen(true)}
  title="Global settings"
  style={{
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--color-text-tertiary)',
    padding: '8px', borderRadius: 8,
    fontSize: 16,
  }}
>
  ⚙
</button>
```

In `AskBinaPanel.tsx`, pass the setGlobalSettingsOpen through to the
ErrorMessage component so clicking "Open Settings to fix this" actually
opens the modal.

---

## TASK 5 — Fix Pyre Linter Import Warnings

### Problem
Pyre2 can't resolve `from fastapi import ...` and other venv imports in
`backend/api.py` because `sys.path.insert(0, ...)` is done at runtime.

### Solution — add pyrightconfig.json (easier than moving files)

Create `backend/pyrightconfig.json`:
```json
{
  "venvPath": "..",
  "venv": ".venv",
  "pythonVersion": "3.11",
  "include": ["."],
  "exclude": ["__pycache__"]
}
```

Create `backend/.pyre_configuration` (if using Pyre2):
```json
{
  "source_directories": ["."],
  "search_path": ["../.venv/lib/python3.11/site-packages"],
  "strict": false
}
```

If the project uses VS Code, add to `.vscode/settings.json`:
```json
{
  "python.analysis.extraPaths": [
    "${workspaceFolder}/backend",
    "${workspaceFolder}/.venv/lib/python3.11/site-packages"
  ],
  "python.defaultInterpreterPath": "${workspaceFolder}/.venv/bin/python3"
}
```

---

## TASK 6 — End-to-End Visual Verification

After all tasks above are implemented, run this checklist manually:

```
Frontend smoke test:
[ ] npm run dev starts without TypeScript errors
[ ] No React warnings in browser console (check for key props, hook deps)
[ ] Graph view loads with nodes visible after indexing a folder
[ ] Ask view shows empty state when no query has been made
[ ] Typing a question in Ask view shows thinking indicator
[ ] Agent answer renders with source file citations as clickable chips
[ ] Clicking a citation chip highlights that node in the graph view
[ ] Moorcheh error in Ask view shows friendly message + settings link
[ ] Ollama error in Ask view shows friendly message + copy command button

WorkspaceModal edit mode:
[ ] AI Settings section renders with correct current values
[ ] Switching processing_path shows the yellow re-embed warning
[ ] Save AI Settings calls PATCH and shows success toast
[ ] user_api_key shows masked value (••••••••) if already set
[ ] Switching to local + chromadb shows vector store options

Global Settings modal:
[ ] Gear icon in WorkspaceSwitcher opens GlobalSettingsModal
[ ] GET /settings/app correctly reports key set / not set
[ ] Pasting a new key and clicking Save calls POST /settings/app
[ ] "Test connection" button updates the status indicator in real time
[ ] Modal closes cleanly with no state leaks

Tailwind classes:
[ ] All new components use only Tailwind utility classes
[ ] No hardcoded colour hex values in new components
[ ] Dark mode renders correctly for all new UI elements
  (mental test: if background were near-black, is all text visible?)
```

---

## EXECUTION ORDER

Do these in order. Each task is independent except Task 4 which
depends on Tasks 2 and 3 (it wires them together).

```
1. backend/api.py      — add GET /settings/app and POST /settings/app
2. frontend/api.ts     — add appSettingsApi.get() and appSettingsApi.save()
3. GlobalSettingsModal.tsx  — new component
4. WorkspaceModal.tsx  — add AI Settings section (edit mode only)
5. AskBinaPanel.tsx    — add classifyError() + ErrorMessage component
6. appStore.ts         — add globalSettingsOpen state
7. MainLayout.tsx      — render GlobalSettingsModal at root level
8. WorkspaceSwitcher.tsx — add gear icon at bottom
9. pyrightconfig.json  — fix linter warnings
10. Manual e2e walkthrough using Task 6 checklist
```

---

## DO NOT TOUCH

```
inference.py          — working correctly
vector_store_router.py — working correctly
vector_store_moorcheh.py — working correctly
vector_store_local.py — working correctly
pipeline.py           — working correctly
graph.py              — working correctly
agent.py              — working correctly
store.py              — working correctly, migration in place
GraphCanvas.tsx       — DO NOT TOUCH (lines 210–215 especially)
Inspector.tsx         — working correctly
SearchBar.tsx         — working correctly
Onboarding.tsx        — model_choice step already implemented
AskBinaPanel.tsx      — only add error handling, do not rewrite
MainLayout.tsx        — only add GlobalSettingsModal render + wiring
```