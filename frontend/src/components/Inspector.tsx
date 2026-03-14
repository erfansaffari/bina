import { X, ExternalLink, Folder, Tag, User, Building, Calendar, FolderOpen } from 'lucide-react'
import { openFile, showInFinder } from '../api'
import type { GraphNode } from '../types'

const TYPE_COLORS: Record<string, string> = {
  'Research Paper':          'bg-bina-accent/20 text-bina-accent',
  'Lecture Notes':           'bg-cyan-500/20 text-cyan-400',
  'Course Syllabus':         'bg-bina-green/20 text-bina-green',
  'Assignment':              'bg-bina-yellow/20 text-bina-yellow',
  'Meeting Notes':           'bg-bina-purple/20 text-bina-purple',
  'Invoice':                 'bg-orange-400/20 text-orange-400',
  'Report':                  'bg-teal-400/20 text-teal-400',
  'Other':                   'bg-bina-muted/20 text-bina-muted',
}

interface Props {
  node: GraphNode | null
  open: boolean
  onClose: () => void
}

export default function Inspector({ node, open, onClose }: Props) {
  if (!open || !node) return null

  const docType  = node.doc_type ?? 'Unknown'
  const summary  = node.summary  ?? ''
  const keywords = (node.keywords ?? []).map(kw => String(kw)).filter(Boolean)
  const entities = node.entities ?? {}
  const path     = node.path     ?? node.id ?? ''

  const typeClass    = TYPE_COLORS[docType] ?? TYPE_COLORS['Other']
  const hasEntities  = Object.values(entities).some(arr => Array.isArray(arr) && arr.length > 0)

  return (
    <div
      className="w-80 flex-shrink-0 border-l border-bina-border bg-bina-surface/60 backdrop-blur-sm flex flex-col panel-transition animate-slide-up overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-14 pb-4 border-b border-bina-border">
        <h3 className="text-bina-text font-medium text-sm truncate flex-1 mr-2">
          {node.label}
        </h3>
        <button
          onClick={onClose}
          className="text-bina-muted hover:text-bina-text transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 selectable">

        {/* Type badge + score */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${typeClass}`}>
            {docType}
          </span>
          {node.score > 0 && (
            <span className="text-xs text-bina-muted">
              {Math.round(node.score * 100)}% match
            </span>
          )}
          {node.status === 'failed' && (
            <span className="text-xs bg-bina-red/20 text-bina-red px-2.5 py-1 rounded-full">
              Not analysed
            </span>
          )}
        </div>

        {/* Summary */}
        {summary ? (
          <div>
            <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2">Summary</p>
            <p className="text-bina-text/80 text-sm leading-relaxed">{summary}</p>
          </div>
        ) : (
          <p className="text-bina-muted text-sm italic">No summary available</p>
        )}

        {/* Keywords */}
        {keywords.length > 0 && (
          <div>
            <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2 flex items-center gap-1">
              <Tag className="w-3 h-3" /> Keywords
            </p>
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((kw) => (
                <span
                  key={kw}
                  className="text-xs bg-bina-border/60 text-bina-text/70 px-2.5 py-1 rounded-full"
                >
                  {kw}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Entities */}
        {hasEntities && (
          <div>
            <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2">
              Mentioned
            </p>
            <div className="space-y-2">
              {[
                { key: 'persons', icon: User, label: 'People' },
                { key: 'companies', icon: Building, label: 'Organisations' },
                { key: 'dates', icon: Calendar, label: 'Dates' },
                { key: 'projects', icon: FolderOpen, label: 'Projects' },
              ].map(({ key, icon: Icon, label }) => {
                const vals: string[] = entities[key] ?? []
                if (vals.length === 0) return null
                return (
                  <div key={key} className="flex items-start gap-2">
                    <Icon className="w-3.5 h-3.5 text-bina-muted mt-0.5 flex-shrink-0" />
                    <div>
                      <span className="text-xs text-bina-muted">{label}: </span>
                      <span className="text-xs text-bina-text/70">{vals.join(', ')}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* File path */}
        <div>
          <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2">Location</p>
          <p className="text-bina-muted text-xs font-mono break-all leading-relaxed">{path}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-bina-border space-y-2">
        <button
          onClick={() => openFile(node.path)}
          className="w-full flex items-center justify-center gap-2 bg-bina-accent hover:bg-bina-accent/80 text-white text-sm font-medium rounded-xl py-2.5 transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Open File
        </button>
        <button
          onClick={() => showInFinder(node.path)}
          className="w-full flex items-center justify-center gap-2 bg-bina-border/60 hover:bg-bina-border text-bina-text/80 text-sm font-medium rounded-xl py-2.5 transition-colors"
        >
          <Folder className="w-4 h-4" />
          Show in Finder
        </button>
      </div>
    </div>
  )
}
