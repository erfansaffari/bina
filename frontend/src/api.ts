/**
 * API client — calls Electron IPC in the app, falls back to direct fetch
 * in browser dev mode (e.g. running `vite` without Electron).
 */
import type { StatusData, ProgressData, SearchResult, GraphData } from './types'

const BASE = 'http://127.0.0.1:8765'

function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof (window as any).bina !== 'undefined'
}

async function get<T>(endpoint: string): Promise<T> {
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

export const api = {
  status: () => get<StatusData>('/status'),
  progress: () => get<ProgressData>('/progress'),
  graph: () => get<GraphData>('/graph'),
  search: (query: string, n_results = 20) =>
    post<SearchResult>('/search', { query, n_results }),
  index: (folder: string) => post<{ status: string }>('/index', { folder }),
  watch: (folder: string) => post<{ status: string }>('/watch', { folder }),
  stopWatch: () => del<{ status: string }>('/watch'),
  deleteFile: (path: string) => del<{ status: string }>('/file', { path }),
}

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
