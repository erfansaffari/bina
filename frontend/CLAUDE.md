# Frontend Rules

## Stack
Electron 32 · React 18 · TypeScript · Vite · Tailwind CSS · react-force-graph-2d

## IPC Pattern
Renderer → window.bina.method() → preload.js contextBridge →
ipcRenderer.invoke() → main.js ipcMain.handle() → fetch to localhost:8765

## State Management
Zustand in src/store/appStore.ts
- activeWorkspaceId drives ALL API calls
- useWorkspaceApi() hook wraps every endpoint with workspace_id

## Component Rules
- GraphCanvas.tsx — DO NOT touch lines 210–215 (collision force)
- All API calls must include activeWorkspaceId
- Native macOS dialogs via window.bina.confirm() not browser confirm()
- Folder picker via window.bina.pickFolder() not HTML input

## Styling
- SF Pro font stack (system-ui on non-Mac)
- NSVisualEffectView vibrancy: backdrop-filter: blur(20px) on sidebar/inspector
- Never hardcode colours — use Tailwind custom tokens from tailwind.config.js
- No AI jargon in user-facing text: "Analysing..." not "embedding" or "LLM"