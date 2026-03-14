import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import SearchBar from './SearchBar'
import GraphCanvas from './GraphCanvas'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import type { GraphNode, GraphEdge, StatusData, ProgressData } from '../types'

interface Props {
  initialStatus: StatusData | null
  onNeedOnboarding: () => void
}

export default function MainLayout({ initialStatus, onNeedOnboarding }: Props) {
  // Full graph – never replaced during a search (prevents flicker)
  const [fullNodes, setFullNodes] = useState<GraphNode[]>([])
  const [fullEdges, setFullEdges] = useState<GraphEdge[]>([])

  // Search overlay: only scores change, topology stays the same
  const [searchScores, setSearchScores] = useState<Map<string, number> | null>(null)

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [status,   setStatus]   = useState<StatusData | null>(initialStatus)
  const [progress, setProgress] = useState<ProgressData | null>(null)
  const [searchMs, setSearchMs] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  // Track whether a graph load is in flight to avoid double-loads
  const loadingGraph = useRef(false)

  const loadFullGraph = useCallback(async () => {
    if (loadingGraph.current) return
    loadingGraph.current = true
    try {
      const g = await api.graph()
      setFullNodes(g.nodes)
      setFullEdges(g.edges)
    } catch {}
    loadingGraph.current = false
  }, [])

  // Load full graph on mount
  useEffect(() => { loadFullGraph() }, [loadFullGraph])

  // Poll status every 5 s
  useEffect(() => {
    const id = setInterval(() => { api.status().then(setStatus).catch(() => {}) }, 5000)
    return () => clearInterval(id)
  }, [])

  // Poll progress while indexing; reload graph when done
  const lastDoneRef = useRef(false)
  useEffect(() => {
    const poll = async () => {
      try {
        const p = await api.progress()
        setProgress(p)
        if (p.done && !lastDoneRef.current) {
          lastDoneRef.current = true
          await loadFullGraph()
          const s = await api.status()
          setStatus(s)
        }
        if (!p.done) lastDoneRef.current = false
      } catch {}
    }
    poll()
    const id = setInterval(poll, 1500)
    return () => clearInterval(id)
  }, [loadFullGraph])

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchScores(null)
      setSearchMs(null)
      return
    }
    try {
      const result = await api.search(q)
      setSearchMs(result.ms)

      // Build score map from search result nodes
      const scoreMap = new Map<string, number>()
      result.nodes.forEach(n => scoreMap.set(n.id, n.score))
      setSearchScores(scoreMap)

      // Also update full graph nodes with refreshed scores/summaries
      // (backend may have enriched data)
      setFullNodes(prev => prev.map(n => {
        const updated = result.nodes.find(r => r.id === n.id)
        return updated ? { ...n, score: updated.score, summary: updated.summary } : { ...n, score: 0 }
      }))

      // Auto-select the top-scoring node
      if (result.nodes.length > 0) {
        const top = [...result.nodes].sort((a, b) => b.score - a.score)[0]
        // Find in fullNodes to get complete data
        const fullNode = fullNodes.find(n => n.id === top.id) ?? top
        setSelectedNode({ ...fullNode, score: top.score })
        setInspectorOpen(true)
      }
    } catch {}
  }, [fullNodes])

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node)
    setInspectorOpen(true)
  }, [])

  return (
    <div className="flex h-full bg-bina-bg overflow-hidden">
      {/* macOS traffic-light drag area */}
      <div className="absolute top-0 left-0 right-0 h-12 drag-region z-10" />

      {/* Sidebar */}
      <Sidebar
        status={status}
        progress={progress}
        onNeedOnboarding={onNeedOnboarding}
      />

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 relative">
        {/* Search bar */}
        <div className="relative z-20 px-6 pt-14 pb-3 no-drag">
          <SearchBar onSearch={handleSearch} searchMs={searchMs} />
        </div>

        {/* Graph canvas */}
        <div className="flex-1 relative no-drag">
          <GraphCanvas
            nodes={fullNodes}
            edges={fullEdges}
            selectedNodeId={selectedNode?.id ?? null}
            searchScores={searchScores}
            onNodeClick={handleNodeClick}
          />

          {/* Empty state */}
          {fullNodes.length === 0 && !progress?.running && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center animate-fade-in">
                <p className="text-bina-muted text-lg font-display">No files indexed yet</p>
                <p className="text-bina-muted/60 text-sm mt-1">Add a folder to get started</p>
              </div>
            </div>
          )}

          {/* Indexing overlay */}
          {progress?.running && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
              <div className="bg-bina-surface/90 backdrop-blur border border-bina-border rounded-2xl px-5 py-3 flex items-center gap-3 shadow-xl animate-slide-up">
                <div className="w-3 h-3 rounded-full bg-bina-accent animate-pulse" />
                <div>
                  <p className="text-bina-text text-sm font-medium">
                    Understanding your files…
                  </p>
                  <p className="text-bina-muted text-xs mt-0.5">
                    {progress.current} of {progress.total} · {progress.current_file}
                  </p>
                </div>
                <div className="w-24 h-1 bg-bina-border rounded-full overflow-hidden ml-2">
                  <div
                    className="h-full bg-bina-accent rounded-full transition-all duration-500"
                    style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Inspector panel */}
      <Inspector
        node={selectedNode}
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
      />
    </div>
  )
}
