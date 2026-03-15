import { create } from 'zustand'
import { apiGet } from '../api'
import type { Workspace } from '../types'

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

interface AppStore {
  activeWorkspaceId: string | null
  workspaces: Workspace[]
  globalSettingsOpen: boolean
  setActiveWorkspace: (id: string) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  loadWorkspaces: () => Promise<void>
  setGlobalSettingsOpen: (open: boolean) => void
}

export const useAppStore = create<AppStore>((set, get) => ({
  activeWorkspaceId: null,
  workspaces: [],
  globalSettingsOpen: false,

  setActiveWorkspace: (id: string) => {
    set({ activeWorkspaceId: id })
    // Persist to localStorage so it survives page refreshes
    try {
      localStorage.setItem('bina_active_workspace', id)
    } catch {}
  },

  setWorkspaces: (workspaces: Workspace[]) => {
    set({ workspaces })
  },

  setGlobalSettingsOpen: (open: boolean) => {
    set({ globalSettingsOpen: open })
  },

  loadWorkspaces: async () => {
    try {
      const list = await apiGet<Workspace[]>('/workspaces')
      set({ workspaces: list })

      // Restore active workspace from localStorage or pick most-recently-opened
      const stored = (() => {
        try { return localStorage.getItem('bina_active_workspace') } catch { return null }
      })()

      const { activeWorkspaceId } = get()
      if (!activeWorkspaceId) {
        if (stored && list.some(w => w.id === stored)) {
          set({ activeWorkspaceId: stored })
        } else if (list.length > 0) {
          // Sort by last_opened descending, pick first
          const sorted = [...list].sort(
            (a, b) => new Date(b.last_opened).getTime() - new Date(a.last_opened).getTime()
          )
          set({ activeWorkspaceId: sorted[0].id })
        }
      } else if (!list.some(w => w.id === activeWorkspaceId)) {
        // Previously active workspace was deleted
        set({ activeWorkspaceId: list.length > 0 ? list[0].id : null })
      }
    } catch (err) {
      console.error('Failed to load workspaces', err)
    }
  },
}))

// ---------------------------------------------------------------------------
// Workspace-scoped API hook
// ---------------------------------------------------------------------------

export function useWorkspaceId(): string | null {
  return useAppStore(s => s.activeWorkspaceId)
}
