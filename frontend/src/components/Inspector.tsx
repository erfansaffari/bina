import { useState, useEffect } from 'react'
import { X, ExternalLink, Folder, Tag, User, Building, Calendar, FolderOpen, ChevronDown, ChevronUp } from 'lucide-react'
import { openFile, showInFinder } from '../api'
import type { GraphNode } from '../types'
import { communityColor, hexAlpha } from '../utils/colorUtils'

interface Props {
  node: GraphNode | null
  open: boolean
  onClose: () => void
}

export default function Inspector({ node, open, onClose }: Props) {
  const isVisible = open && !!node
  const [summaryExpanded, setSummaryExpanded] = useState(false)

  // Collapse summary whenever the selected node changes
  useEffect(() => { setSummaryExpanded(false) }, [node?.id])

  const docType  = node?.doc_type ?? 'Unknown'
  const summary  = node?.summary  ?? ''
  const keywords = (node?.keywords ?? []).map(kw => String(kw)).filter(Boolean)
  const entities = node?.entities ?? {}
  const path     = node?.path     ?? node?.id ?? ''

  // Badge color derived from the node's community color — matches graph node color
  const nodeColor = communityColor(node?.community_id ?? 0, node?.community_label)
  const hasEntities = Object.values(entities).some(arr => Array.isArray(arr) && arr.length > 0)

  return (
    <div
      className={`flex-shrink-0 flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${
        isVisible ? 'w-80 opacity-100' : 'w-0 opacity-0 pointer-events-none'
      }`}
      style={{
        background: 'linear-gradient(160deg, rgba(255,255,255,0.92) 0%, rgba(244,252,252,0.84) 50%, rgba(255,255,255,0.88) 100%)',
        backdropFilter: 'blur(32px) saturate(2.0)',
        WebkitBackdropFilter: 'blur(32px) saturate(2.0)',
        borderLeft: '1px solid rgba(10,147,150,0.20)',
        boxShadow: '-10px 0 48px rgba(0,95,115,0.10), -2px 0 8px rgba(0,18,25,0.05)',
      }}
    >
      {/* Minimum width wrapper prevents reflow of inner content during animation */}
      <div className="w-80 flex flex-col flex-1 overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-14 pb-4 border-b border-bina-border">
        <h3 className="text-bina-text font-medium text-sm truncate flex-1 mr-2">
          {node?.label}
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

        {/* Type badge + score — color matches graph node color */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className="text-xs px-2.5 py-1 rounded-full font-medium"
            style={{
              backgroundColor: hexAlpha(nodeColor, 0.15),
              color: nodeColor,
              border: `1px solid ${hexAlpha(nodeColor, 0.30)}`,
            }}
          >
            {docType}
          </span>
          {(node?.score ?? 0) > 0 && (
            <span className="text-xs text-bina-muted">
              {Math.round((node?.score ?? 0) * 100)}% match
            </span>
          )}
          {node?.status === 'failed' && (
            <span className="text-xs bg-bina-red/20 text-bina-red px-2.5 py-1 rounded-full">
              Not analysed
            </span>
          )}
        </div>

        {/* Image thumbnail (for image files) */}
        {path && /\.(png|jpg|jpeg|webp|gif)$/i.test(path) && (
          <div>
            <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2">Preview</p>
            <img
              src={`file://${path}`}
              alt={node?.label}
              className="w-full rounded-xl object-cover max-h-48 border border-bina-border"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Summary */}
        {summary ? (
          <div>
            <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-2">Summary</p>
            <p className="text-bina-text/80 text-sm leading-relaxed">
              {summaryExpanded || summary.length <= 200
                ? summary
                : summary.slice(0, 200).trimEnd() + '…'}
            </p>
            {summary.length > 200 && (
              <button
                onClick={() => setSummaryExpanded(v => !v)}
                className="mt-1.5 flex items-center gap-1 text-xs text-bina-accent hover:text-bina-muted transition-colors"
              >
                {summaryExpanded ? (
                  <><ChevronUp className="w-3 h-3" /> Show less</>
                ) : (
                  <><ChevronDown className="w-3 h-3" /> Read more</>
                )}
              </button>
            )}
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
          onClick={() => node && openFile(node.path)}
          className="w-full flex items-center justify-center gap-2 bg-bina-accent hover:bg-bina-accent/80 text-white text-sm font-medium rounded-xl py-2.5 transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Open File
        </button>
        <button
          onClick={() => node && showInFinder(node.path)}
          className="w-full flex items-center justify-center gap-2 bg-bina-border/60 hover:bg-bina-border text-bina-text/80 text-sm font-medium rounded-xl py-2.5 transition-colors"
        >
          <Folder className="w-4 h-4" />
          Show in Finder
        </button>
      </div>

      </div>{/* end w-80 wrapper */}
    </div>
  )
}
