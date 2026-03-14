import { Lock, Database, GitBranch, FolderOpen, AlertCircle } from 'lucide-react'
import type { StatusData, ProgressData } from '../types'

interface Props {
  status: StatusData | null
  progress: ProgressData | null
  onNeedOnboarding: () => void
}

export default function Sidebar({ status, progress, onNeedOnboarding }: Props) {
  const isIndexing = progress?.running ?? false

  return (
    <div className="w-56 flex-shrink-0 border-r border-bina-border bg-bina-surface/40 backdrop-blur-sm flex flex-col">
      {/* App name — sits under traffic lights */}
      <div className="h-14 flex items-end px-5 pb-3 drag-region">
        <span className="text-bina-text font-display font-semibold text-lg tracking-tight no-drag">
          Bina
        </span>
        <span className="text-bina-muted text-xs ml-2 mb-0.5 no-drag">بینا</span>
      </div>

      {/* Stats */}
      <div className="flex-1 px-4 py-4 space-y-1 overflow-y-auto">

        {/* Indexing indicator */}
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
                style={{
                  width: `${progress?.total ? (progress.current / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            <div className="text-bina-muted text-xs mt-1">
              {progress?.current} / {progress?.total}
            </div>
          </div>
        )}

        <p className="text-bina-muted text-xs font-medium uppercase tracking-wider px-2 pb-2">
          Index
        </p>

        {[
          {
            icon: Database,
            label: 'Files understood',
            value: status?.indexed ?? 0,
            color: 'text-bina-accent',
          },
          {
            icon: GitBranch,
            label: 'Connections',
            value: status?.graph_edges ?? 0,
            color: 'text-bina-purple',
          },
          {
            icon: AlertCircle,
            label: 'Unreadable',
            value: status?.failed ?? 0,
            color: 'text-bina-muted',
            hide: !status?.failed,
          },
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

        {/* Watched folder */}
        {status?.watched_folder && (
          <div className="mt-4">
            <p className="text-bina-muted text-xs font-medium uppercase tracking-wider px-2 pb-2">
              Watching
            </p>
            <div className="flex items-start gap-2 px-2 py-2">
              <FolderOpen className="w-4 h-4 text-bina-yellow flex-shrink-0 mt-0.5" />
              <p className="text-bina-muted text-xs font-mono break-all leading-relaxed">
                {status.watched_folder.split('/').pop()}
              </p>
            </div>
          </div>
        )}
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
