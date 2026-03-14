import { useState, useEffect, useCallback } from 'react'
import { Lock, Database, GitBranch, FolderOpen, AlertCircle, Plus, X } from 'lucide-react'
import { workspacesApi, openFolder } from '../api'
import { useAppStore } from '../store/appStore'
import type { StatusData, ProgressData, WorkspaceFolder } from '../types'

interface Props {
  status: StatusData | null
  progress: ProgressData | null
  onNeedOnboarding: () => void
  onGraphReload: () => void
}

export default function Sidebar({ status, progress, onNeedOnboarding, onGraphReload }: Props) {
  const { activeWorkspaceId, workspaces, loadWorkspaces } = useAppStore()
  const isIndexing = progress?.running ?? false

  const [folders, setFolders] = useState<WorkspaceFolder[]>([])
  const [addingFolder, setAddingFolder] = useState(false)

  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

  const loadFolders = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const f = await workspacesApi.getFolders(activeWorkspaceId)
      setFolders(f)
    } catch {}
  }, [activeWorkspaceId])

  useEffect(() => {
    loadFolders()
  }, [loadFolders])

  async function handleAddFolder() {
    if (!activeWorkspaceId || addingFolder) return
    const picked = await openFolder()
    if (!picked) return
    setAddingFolder(true)
    try {
      await workspacesApi.addFolder(activeWorkspaceId, picked)
      await loadFolders()
      await loadWorkspaces()
      onGraphReload()
    } catch (err) {
      console.error('Failed to add folder', err)
    } finally {
      setAddingFolder(false)
    }
  }

  async function handleRemoveFolder(folderPath: string) {
    if (!activeWorkspaceId) return
    try {
      await workspacesApi.removeFolder(activeWorkspaceId, folderPath)
      await loadFolders()
      await loadWorkspaces()
      onGraphReload()
    } catch (err) {
      console.error('Failed to remove folder', err)
    }
  }

  return (
    <div className="w-56 flex-shrink-0 border-r border-bina-border bg-bina-surface/40 backdrop-blur-sm flex flex-col">
      {/* Header — workspace name */}
      <div className="h-14 flex items-end px-5 pb-3 drag-region">
        {activeWorkspace ? (
          <div className="flex items-center gap-2 no-drag">
            <span className="text-lg leading-none">{activeWorkspace.emoji}</span>
            <span className="text-bina-text font-display font-semibold text-base tracking-tight truncate">
              {activeWorkspace.name}
            </span>
          </div>
        ) : (
          <span className="text-bina-text font-display font-semibold text-lg tracking-tight no-drag">
            Bina
          </span>
        )}
      </div>

      <div className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">
        {/* Indexing progress */}
        {isIndexing && (
          <div className="bg-bina-accent/10 border border-bina-accent/20 rounded-xl p-3 mb-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-bina-accent animate-pulse" />
              <span className="text-bina-accent text-xs font-medium">Understanding files…</span>
            </div>
            <div className="text-bina-muted text-xs truncate">{progress?.current_file}</div>
            <div className="mt-2 h-1 bg-bina-border rounded-full overflow-hidden">
              <div
                className="h-full bg-bina-accent rounded-full transition-all duration-300"
                style={{ width: `${progress?.total ? (progress.current / progress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="text-bina-muted text-xs mt-1">
              {progress?.current} / {progress?.total}
            </div>
          </div>
        )}

        {/* Stats */}
        <p className="text-bina-muted text-xs font-medium uppercase tracking-wider px-2 pb-2">Index</p>

        {[
          { icon: Database,    label: 'Files understood', value: status?.indexed ?? 0,    color: 'text-bina-accent'  },
          { icon: GitBranch,   label: 'Connections',      value: status?.graph_edges ?? 0, color: 'text-bina-purple'  },
          { icon: AlertCircle, label: 'Unreadable',        value: status?.failed ?? 0,      color: 'text-bina-muted', hide: !status?.failed },
        ].map(({ icon: Icon, label, value, color, hide }) =>
          hide ? null : (
            <div key={label} className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-bina-border/30 transition-colors">
              <Icon className={`w-4 h-4 ${color} flex-shrink-0`} />
              <div className="flex-1 min-w-0">
                <p className="text-bina-muted text-xs">{label}</p>
                <p className="text-bina-text font-mono text-sm font-medium">{value.toLocaleString()}</p>
              </div>
            </div>
          )
        )}

        {/* Folders section */}
        <div className="mt-4">
          <div className="flex items-center justify-between px-2 pb-2">
            <p className="text-bina-muted text-xs font-medium uppercase tracking-wider">Folders</p>
            <button
              onClick={handleAddFolder}
              disabled={addingFolder || !activeWorkspaceId}
              title="Add folder"
              className="w-5 h-5 rounded flex items-center justify-center text-bina-muted hover:text-bina-accent hover:bg-bina-accent/10 transition-colors disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {folders.length === 0 && (
            <div className="px-2 py-2">
              <p className="text-bina-muted/60 text-xs">No folders added yet.</p>
            </div>
          )}

          {folders.map((f) => (
            <div
              key={f.folder_path}
              className="flex items-start gap-2 px-2 py-2 rounded-xl hover:bg-bina-border/30 transition-colors group"
            >
              <FolderOpen className="w-4 h-4 text-bina-yellow flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-bina-muted text-xs font-mono break-all leading-relaxed">
                  {f.folder_path.split('/').pop() || f.folder_path}
                </p>
                {f.file_count > 0 && (
                  <p className="text-bina-muted/60 text-[10px]">{f.file_count} files</p>
                )}
              </div>
              <button
                onClick={() => handleRemoveFolder(f.folder_path)}
                title="Remove folder"
                className="w-5 h-5 rounded flex items-center justify-center text-bina-muted/40 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Privacy badge */}
      <div className="px-4 py-4 border-t border-bina-border">
        <div className="flex items-center gap-2.5 px-3 py-2.5 bg-bina-green/5 border border-bina-green/15 rounded-xl">
          <Lock className="w-3.5 h-3.5 text-bina-green flex-shrink-0" />
          <p className="text-bina-green/80 text-xs leading-tight">
            All AI runs on your Mac. Nothing is sent anywhere.
          </p>
        </div>
      </div>
    </div>
  )
}
