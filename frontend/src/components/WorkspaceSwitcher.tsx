import { useState } from 'react'
import { Plus, Trash2, Settings } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import type { Workspace } from '../types'
import { workspacesApi, confirmDialog } from '../api'

interface Props {
  onCreateWorkspace: () => void
  onEditWorkspace: (ws: Workspace) => void
}

export default function WorkspaceSwitcher({ onCreateWorkspace, onEditWorkspace }: Props) {
  const { workspaces, activeWorkspaceId, setActiveWorkspace, loadWorkspaces, setGlobalSettingsOpen } = useAppStore()
  const [deleting, setDeleting] = useState<string | null>(null)

  async function handleSelectWorkspace(ws: Workspace) {
    setActiveWorkspace(ws.id)
    try {
      await workspacesApi.update(ws.id, {})
      await loadWorkspaces()
    } catch {}
  }

  async function handleDelete(e: React.MouseEvent, ws: Workspace) {
    e.stopPropagation()
    const confirmed = await confirmDialog(
      `Delete "${ws.name}"?`,
      'This will remove the workspace and all its indexed files. Your actual files on disk are untouched.',
    )
    if (!confirmed) return

    setDeleting(ws.id)
    try {
      await workspacesApi.delete(ws.id)
      await loadWorkspaces()
      // If we deleted the active workspace, switch to another one
      if (ws.id === activeWorkspaceId) {
        const remaining = workspaces.filter(w => w.id !== ws.id)
        if (remaining.length > 0) setActiveWorkspace(remaining[0].id)
      }
    } catch {}
    setDeleting(null)
  }

  return (
    <div className="w-16 flex-shrink-0 flex flex-col items-center py-3 gap-2 border-r border-bina-border bg-bina-surface/60 backdrop-blur-sm">
      {/* Workspaces list */}
      <div className="flex flex-col items-center gap-2 flex-1 overflow-y-auto w-full px-2 scrollbar-hide">
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId
          const isDeleting = deleting === ws.id
          return (
            <div key={ws.id} className="relative w-full group/ws">
              <button
                onClick={() => handleSelectWorkspace(ws)}
                onDoubleClick={() => onEditWorkspace(ws)}
                title={`${ws.name} — ${ws.file_count} files\nDouble-click to edit`}
                disabled={isDeleting}
                className={`relative w-full aspect-square rounded-xl flex items-center justify-center transition-all duration-200 ${
                  isActive
                    ? 'shadow-lg scale-105'
                    : 'hover:scale-105 opacity-70 hover:opacity-100'
                } ${isDeleting ? 'opacity-30' : ''}`}
                style={{
                  backgroundColor: `${ws.colour}22`,
                  border: isActive ? `2px solid ${ws.colour}` : '2px solid transparent',
                }}
              >
                {/* Active indicator */}
                {isActive && (
                  <div
                    className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full -translate-x-2"
                    style={{ backgroundColor: ws.colour }}
                  />
                )}

                {/* Emoji or spinner */}
                {isDeleting ? (
                  <div className="w-4 h-4 border-2 border-bina-muted border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="text-xl leading-none select-none">{ws.emoji}</span>
                )}

                {/* File count badge */}
                {ws.file_count > 0 && !isDeleting && (
                  <div
                    className="absolute -bottom-1 -right-1 min-w-[16px] h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white px-1"
                    style={{ backgroundColor: ws.colour }}
                  >
                    {ws.file_count > 99 ? '99+' : ws.file_count}
                  </div>
                )}

                {/* Tooltip */}
                <div className="absolute left-full ml-2 z-50 pointer-events-none opacity-0 group-hover/ws:opacity-100 transition-opacity duration-150 whitespace-nowrap">
                  <div className="bg-bina-surface border border-bina-border rounded-lg px-3 py-1.5 shadow-xl">
                    <p className="text-bina-text text-xs font-medium">{ws.name}</p>
                    <p className="text-bina-muted text-[10px]">{ws.file_count} files</p>
                    <p className="text-bina-muted/60 text-[10px]">Double-click to edit</p>
                  </div>
                </div>
              </button>

              {/* Delete button — shows on hover */}
              {!isDeleting && (
                <button
                  onClick={(e) => handleDelete(e, ws)}
                  title={`Delete "${ws.name}"`}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 border border-bina-bg flex items-center justify-center opacity-0 group-hover/ws:opacity-100 transition-opacity duration-150 hover:bg-red-400 z-10"
                >
                  <Trash2 className="w-2.5 h-2.5 text-white" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Divider */}
      {workspaces.length > 0 && (
        <div className="w-8 h-px bg-bina-border flex-shrink-0" />
      )}

      {/* Add workspace button */}
      <button
        onClick={onCreateWorkspace}
        title="New workspace"
        className="w-10 h-10 rounded-xl border-2 border-dashed border-bina-border hover:border-bina-accent/50 hover:bg-bina-accent/5 flex items-center justify-center transition-all duration-200 flex-shrink-0 group"
      >
        <Plus className="w-4 h-4 text-bina-muted group-hover:text-bina-accent transition-colors" />
      </button>

      {/* Global settings button */}
      <button
        onClick={() => setGlobalSettingsOpen(true)}
        title="Global settings"
        className="w-10 h-10 rounded-xl flex items-center justify-center text-bina-muted hover:text-bina-text hover:bg-bina-border/50 transition-all duration-200 flex-shrink-0"
      >
        <Settings className="w-4 h-4" />
      </button>
    </div>
  )
}
