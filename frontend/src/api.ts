/**
 * API client — calls Electron IPC in the app, falls back to direct fetch
 * in browser dev mode (e.g. running `vite` without Electron).
 */
import type {
  StatusData,
  ProgressData,
  SearchResult,
  GraphData,
  Workspace,
  WorkspaceFolder,
} from './types'

const BASE = 'http://127.0.0.1:8765'

function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).bina !== 'undefined'
}

export async function apiGet<T>(endpoint: string): Promise<T> {
  if (isElectron()) {
    return (window as any).bina.api.get(endpoint) as T
  }
  const r = await fetch(`${BASE}${endpoint}`)
  return r.json()
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  if (isElectron()) {
    return (window as any).bina.api.post(endpoint, body) as T
  }
  const r = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function patch<T>(endpoint: string, body: unknown): Promise<T> {
  if (isElectron()) {
    return (window as any).bina.api.patch(endpoint, body) as T
  }
  const r = await fetch(`${BASE}${endpoint}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return r.json()
}

async function del<T>(endpoint: string, body?: unknown): Promise<T> {
  if (isElectron()) {
    return (window as any).bina.api.delete(endpoint, body) as T
  }
  const r = await fetch(`${BASE}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return r.json()
}

// ---------------------------------------------------------------------------
// Core API (workspace-scoped)
// ---------------------------------------------------------------------------

export const api = {
  status: (workspaceId?: string) =>
    apiGet<StatusData>(workspaceId ? `/status?workspace_id=${workspaceId}` : '/status'),

  progress: () => apiGet<ProgressData>('/progress'),

  graph: (workspaceId: string) =>
    apiGet<GraphData>(`/graph?workspace_id=${workspaceId}`),

  search: (query: string, workspaceId: string, limit = 20) =>
    post<SearchResult>('/search', { query, workspace_id: workspaceId, limit }),

  index: (folder: string, workspaceId?: string) =>
    post<{ status: string; workspace_id: string }>('/index', {
      folder,
      workspace_id: workspaceId,
    }),

  watch: (folder: string, workspaceId: string) =>
    post<{ status: string }>('/watch', { path: folder, workspace_id: workspaceId }),

  stopWatch: (folder: string, workspaceId: string) =>
    del<{ status: string }>('/watch', { path: folder, workspace_id: workspaceId }),

  deleteFile: (path: string, workspaceId: string) =>
    del<{ removed: boolean; path: string }>('/file', { path, workspace_id: workspaceId }),

  globalStatus: () =>
    apiGet<{
      total_files_indexed: number
      total_workspaces: number
      chroma_count: number
      dedup_savings: number
    }>('/global/status'),
}

// ---------------------------------------------------------------------------
// Workspace API
// ---------------------------------------------------------------------------

export const workspacesApi = {
  list: () => apiGet<Workspace[]>('/workspaces'),

  create: (name: string, emoji = '📁', colour = '#4F46E5') =>
    post<Workspace>('/workspaces', { name, emoji, colour }),

  update: (id: string, fields: Partial<Pick<Workspace, 'name' | 'emoji' | 'colour'>>) =>
    patch<Workspace>(`/workspaces/${id}`, fields),

  delete: (id: string) =>
    del<{ deleted: boolean; files_purged: number }>(`/workspaces/${id}`),

  getFolders: (id: string) =>
    apiGet<WorkspaceFolder[]>(`/workspaces/${id}/folders`),

  addFolder: (id: string, path: string) =>
    post<{ watching: boolean; file_count: number }>(`/workspaces/${id}/folders`, { path }),

  removeFolder: (id: string, path: string) =>
    del<{ stopped: boolean; files_purged: number }>(`/workspaces/${id}/folders`, { path }),
}

// ---------------------------------------------------------------------------
// Electron native helpers
// ---------------------------------------------------------------------------

export function openFolder(): Promise<string | null> {
  if (isElectron()) return (window as any).bina.openFolder()
  return Promise.resolve(null)
}

export function openFile(filePath: string): void {
  if (isElectron()) (window as any).bina.openFile(filePath)
  else window.alert(`Would open: ${filePath}`)
}

export function showInFinder(filePath: string): void {
  if (isElectron()) (window as any).bina.showInFinder(filePath)
}

export async function confirmDialog(message: string, detail: string): Promise<boolean> {
  if (isElectron()) return (window as any).bina.confirm(message, detail)
  return window.confirm(`${message}\n${detail}`)
}
