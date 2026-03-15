import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '../api'
import { useAppStore } from '../store/appStore'
import SearchBar from './SearchBar'
import GraphCanvas from './GraphCanvas'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import WorkspaceModal from './WorkspaceModal'
import SettingsModal from './SettingsModal'
import AskBinaPanel from './AskBinaPanel'
import type { GraphNode, GraphEdge, StatusData, ProgressData, Workspace } from '../types'

interface Props {
  initialStatus?: StatusData | null
  onNeedOnboarding?: () => void
}

export default function MainLayout({ initialStatus = null, onNeedOnboarding = () => {} }: Props) {
  const { activeWorkspaceId, loadWorkspaces, workspaces, globalSettingsOpen, setGlobalSettingsOpen } = useAppStore()

  const [fullNodes, setFullNodes] = useState<GraphNode[]>([])
  const [fullEdges, setFullEdges] = useState<GraphEdge[]>([])
  const [searchScores, setSearchScores] = useState<Map<string, number> | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [status, setStatus] = useState<StatusData | null>(initialStatus)
  const [progress, setProgress] = useState<ProgressData | null>(null)
  const [searchMs, setSearchMs] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [viewMode, setViewMode] = useState<'graph' | 'ask'>('graph')

  // Workspace modal state
  const [wsModalOpen, setWsModalOpen] = useState(false)
  const [wsToEdit, setWsToEdit] = useState<Workspace | null>(null)

  const loadingGraph = useRef(false)
  const prevGraphNodes = useRef<number | null>(null)
  const prevWorkspaceId = useRef<string | null>(null)

  // Load workspaces on mount
  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  // Show WorkspaceModal if no workspaces exist after loading
  useEffect(() => {
    if (workspaces !== undefined && workspaces.length === 0) {
      // Give loadWorkspaces time to complete before showing modal
      const t = setTimeout(() => setWsModalOpen(true), 300)
      return () => clearTimeout(t)
    }
  }, [workspaces])

  const loadFullGraph = useCallback(async (workspaceId?: string) => {
    const wsId = workspaceId ?? activeWorkspaceId
    if (!wsId || loadingGraph.current) return
    loadingGraph.current = true
    try {
      const g = await api.graph(wsId)
      setFullNodes(g.nodes)
      setFullEdges(g.edges)
      setSelectedNode(prev => {
        if (prev && !g.nodes.some(n => n.id === prev.id)) {
          setInspectorOpen(false)
          return null
        }
        return prev
      })
    } catch {}
    loadingGraph.current = false
  }, [activeWorkspaceId])

  // Reload graph when active workspace changes
  useEffect(() => {
    if (activeWorkspaceId && activeWorkspaceId !== prevWorkspaceId.current) {
      prevWorkspaceId.current = activeWorkspaceId
      prevGraphNodes.current = null
      setFullNodes([])
      setFullEdges([])
      setSearchScores(null)
      setSelectedNode(null)
      setInspectorOpen(false)
      loadFullGraph(activeWorkspaceId)
    }
  }, [activeWorkspaceId, loadFullGraph])

  // Poll status every 5s; reload graph if node count changed
  useEffect(() => {
    if (!activeWorkspaceId) return
    const id = setInterval(async () => {
      try {
        const s = await api.status(activeWorkspaceId)
        setStatus(s)
        if (
          prevGraphNodes.current !== null &&
          s.graph_nodes !== prevGraphNodes.current
        ) {
          await loadFullGraph()
        }
        prevGraphNodes.current = s.graph_nodes
      } catch {}
    }, 5000)
    return () => clearInterval(id)
  }, [activeWorkspaceId, loadFullGraph])

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
          if (activeWorkspaceId) {
            const s = await api.status(activeWorkspaceId)
            setStatus(s)
            await loadWorkspaces()
          }
        }
        if (!p.done) lastDoneRef.current = false
      } catch {}
    }
    poll()
    const id = setInterval(poll, 1500)
    return () => clearInterval(id)
  }, [activeWorkspaceId, loadFullGraph, loadWorkspaces])

  const handleSearch = useCallback(async (q: string) => {
    if (!q.trim() || !activeWorkspaceId) {
      setSearchScores(null)
      setSearchMs(null)
      return
    }
    try {
      const result = await api.search(q, activeWorkspaceId)
      setSearchMs(result.ms)

      const scoreMap = new Map<string, number>()
      result.nodes.forEach(n => scoreMap.set(n.id, n.score))
      setSearchScores(scoreMap)

      setFullNodes(prev => prev.map(n => {
        const updated = result.nodes.find(r => r.id === n.id)
        return updated ? { ...n, score: updated.score, summary: updated.summary } : { ...n, score: 0 }
      }))

      if (result.nodes.length > 0) {
        const top = [...result.nodes].sort((a, b) => b.score - a.score)[0]
        const fullNode = fullNodes.find(n => n.id === top.id) ?? top
        setSelectedNode({ ...fullNode, score: top.score })
        setInspectorOpen(true)
      }
    } catch (err) {
      console.error('[search] failed:', err)
    }
  }, [activeWorkspaceId, fullNodes])

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node)
    setInspectorOpen(true)
  }, [])

  function handleOpenEditWorkspace(ws: Workspace) {
    setWsToEdit(ws)
    setWsModalOpen(true)
  }

  function handleCloseWsModal() {
    setWsModalOpen(false)
    setWsToEdit(null)
  }

  return (
    <div className="flex h-full overflow-hidden relative">
      {/* Floating spring orbs — decorative background */}
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />

      {/* macOS traffic-light drag area — starts after workspace switcher column */}
      <div className="absolute top-0 left-16 right-0 h-12 drag-region z-10" />

      {/* Workspace switcher — leftmost column */}
      <WorkspaceSwitcher
        onCreateWorkspace={() => { setWsToEdit(null); setWsModalOpen(true) }}
        onEditWorkspace={handleOpenEditWorkspace}
      />

      {/* Sidebar */}
      <Sidebar
        status={status}
        progress={progress}
        onNeedOnboarding={onNeedOnboarding}
        onGraphReload={loadFullGraph}
      />

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 relative">
        <div className="relative z-20 px-6 pt-14 pb-3 no-drag flex items-center gap-3">
          {viewMode === 'graph' && (
            <div className="flex-1">
              <SearchBar onSearch={handleSearch} searchMs={searchMs} />
            </div>
          )}
          {viewMode === 'ask' && (
            <div className="flex-1">
              <h2 className="text-bina-text text-lg font-display font-semibold">Ask Bina</h2>
            </div>
          )}
          {/* Mode toggle */}
          <div className="flex bg-bina-surface border border-bina-border rounded-xl overflow-hidden shrink-0">
            <button
              onClick={() => setViewMode('graph')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'graph'
                  ? 'bg-bina-accent text-white'
                  : 'text-bina-muted hover:text-bina-text'
              }`}
            >
              Graph
            </button>
            <button
              onClick={() => setViewMode('ask')}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === 'ask'
                  ? 'bg-bina-accent text-white'
                  : 'text-bina-muted hover:text-bina-text'
              }`}
            >
              Ask
            </button>
          </div>
        </div>

        <div className="flex-1 relative no-drag">
          {viewMode === 'graph' ? (
            <>
              <GraphCanvas
                nodes={fullNodes}
                edges={fullEdges}
                selectedNodeId={selectedNode?.id ?? null}
                searchScores={searchScores}
                onNodeClick={handleNodeClick}
                onNodeDeleted={loadFullGraph}
              />

              {/* Empty state */}
              {fullNodes.length === 0 && !progress?.running && activeWorkspaceId && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center animate-fade-in">
                    <p className="text-bina-muted text-lg font-display">No files indexed yet</p>
                    <p className="text-bina-muted/60 text-sm mt-1">Add a folder to get started</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            activeWorkspaceId
              ? <AskBinaPanel workspaceId={activeWorkspaceId} />
              : (
                <div className="flex items-center justify-center h-full text-bina-muted text-sm">
                  Select a workspace to start asking questions
                </div>
              )
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

      {/* Workspace create/edit modal */}
      <WorkspaceModal
        open={wsModalOpen}
        editWorkspace={wsToEdit}
        onClose={handleCloseWsModal}
        onCreated={() => loadFullGraph()}
      />

      {/* Settings modal — opened from sidebar, gear icon, or error messages */}
      <SettingsModal
        open={globalSettingsOpen}
        onClose={() => setGlobalSettingsOpen(false)}
        onIndexCleared={() => { loadWorkspaces(); loadFullGraph() }}
      />
    </div>
  )
}
