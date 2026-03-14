import { useRef, useCallback, useEffect, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import * as d3 from 'd3-force-3d'
import type { GraphNode, GraphEdge } from '../types'
import { openFile } from '../api'

// ── Colour palette – one per doc_type ─────────────────────────────────────────
export const TYPE_COLORS: Record<string, string> = {
  'Research Paper':          '#5e7ce6',
  'Lecture Notes':           '#00bcd4',
  'Course Syllabus':         '#4caf50',
  'Assignment':              '#ffd740',
  'Meeting Notes':           '#e040fb',
  'Invoice':                 '#ff9800',
  'Contract':                '#f44336',
  'Report':                  '#26c6da',
  'Technical Documentation': '#80deea',
  'Personal Notes':          '#ce93d8',
  'README':                  '#a5d6a7',
  'Book Chapter':            '#ffca28',
  'Email':                   '#ffa726',
  'Presentation':            '#ff7043',
  'Legal Document':          '#ef9a9a',
  'Other':                   '#78909c',
}

function nodeColor(node: GraphNode): string {
  if (node.status === 'failed') return '#3a3a40'
  return TYPE_COLORS[node.doc_type] ?? '#78909c'
}

// Hex → rgba helper
function hexAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

interface Props {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedNodeId: string | null
  searchScores: Map<string, number> | null   // id → score, null = no active query
  onNodeClick: (node: GraphNode) => void
}

// ── Legend ──────────────────────────────────────────────────────────────────
function Legend({ presentTypes }: { presentTypes: string[] }) {
  const [collapsed, setCollapsed] = useState(false)
  if (presentTypes.length === 0) return null
  return (
    <div className="absolute bottom-4 left-4 z-20 select-none">
      <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-2xl">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/60 hover:text-white/90 transition-colors"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="font-semibold tracking-wide uppercase text-[10px]">Document types</span>
          <svg className={`ml-auto w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-180'}`} viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        {!collapsed && (
          <div className="px-3 pb-3 grid grid-cols-1 gap-1 max-h-64 overflow-y-auto">
            {presentTypes.map(type => (
              <div key={type} className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: TYPE_COLORS[type] ?? '#78909c', boxShadow: `0 0 4px ${TYPE_COLORS[type] ?? '#78909c'}` }}
                />
                <span className="text-[11px] text-white/70 whitespace-nowrap">{type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function GraphCanvas({ nodes, edges, selectedNodeId, searchScores, onNodeClick }: Props) {
  const fgRef = useRef<any>(null)

  // ── Double-click detection ────────────────────────────────────────────────
  // react-force-graph-2d's onNodeDoubleClick is unreliable because onNodeClick
  // fires first on each click and zooms the camera, shifting the node before
  // the second click arrives. We detect the double-click manually instead.
  const clickTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastClickNodeId = useRef<string | null>(null)

  // ── Stable graph data – only recreated when topology changes ────────────────
  // This is the KEY fix: we never pass a new graphData object unless
  // the set of node IDs or edges actually changes.
  const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] })
  const stableDataRef = useRef<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] })
  const prevNodeIdsRef = useRef(new Set<string>())
  const prevEdgeCountRef = useRef(0)

  useEffect(() => {
    // Resolve all edge endpoint IDs up front so we can filter isolated nodes.
    const resolvedLinks = edges.map(e => ({
      source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      weight: e.weight,
    }))

    // Isolated nodes (zero edges) pile at the canvas origin in d3-force.
    // Keep them in state for the Inspector but never hand them to ForceGraph.
    const connectedIds = new Set(resolvedLinks.flatMap(l => [l.source, l.target]))
    const visibleNodes = nodes.filter(n => connectedIds.has(n.id))

    const topologyChanged =
      visibleNodes.length !== prevNodeIdsRef.current.size ||
      visibleNodes.some(n => !prevNodeIdsRef.current.has(n.id)) ||
      edges.length !== prevEdgeCountRef.current

    if (!topologyChanged) {
      // Just patch mutable properties in-place – simulation keeps running
      stableDataRef.current.nodes.forEach((n: any) => {
        const updated = visibleNodes.find(u => u.id === n.id)
        if (updated) {
          n.doc_type = updated.doc_type
          n.status   = updated.status
          n.score    = updated.score
          n.summary  = updated.summary
          n.keywords = updated.keywords
          n.label    = updated.label
        }
      })
      return
    }

    // Capture live positions before rebuilding
    const posCache = new Map<string, { x: number; y: number }>()
    stableDataRef.current.nodes.forEach((n: any) => {
      if (n.x != null && n.y != null) posCache.set(n.id, { x: n.x, y: n.y })
    })

    const newData = {
      nodes: visibleNodes.map(n => {
        const p = posCache.get(n.id)
        return { ...n, x: p?.x, y: p?.y, vx: 0, vy: 0 }
      }),
      links: resolvedLinks,
    }

    prevNodeIdsRef.current  = new Set(visibleNodes.map(n => n.id))
    prevEdgeCountRef.current = edges.length
    stableDataRef.current   = newData
    setGraphData(newData)
  }, [nodes, edges])

  // ── Hover state (stored in refs so draw functions don't cause re-renders) ───
  const hoveredNodeIdRef    = useRef<string | null>(null)
  const connectedNodeIdsRef = useRef<Set<string>>(new Set())
  const connectedLinkIdsRef = useRef<Set<string>>(new Set())

  // Build edge adjacency index
  const edgeIndexRef = useRef<Map<string, string[]>>(new Map())
  useEffect(() => {
    const idx = new Map<string, string[]>()
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      if (!idx.has(s)) idx.set(s, [])
      if (!idx.has(t)) idx.set(t, [])
      idx.get(s)!.push(t)
      idx.get(t)!.push(s)
    })
    edgeIndexRef.current = idx
  }, [edges])

  const handleNodeHover = useCallback((node: any) => {
    hoveredNodeIdRef.current = node?.id ?? null
    if (node) {
      const neighbours = edgeIndexRef.current.get(node.id) ?? []
      connectedNodeIdsRef.current = new Set([node.id, ...neighbours])
      const linkSet = new Set<string>()
      stableDataRef.current.links.forEach((l: any) => {
        const s = typeof l.source === 'object' ? l.source.id : l.source
        const t = typeof l.target === 'object' ? l.target.id : l.target
        if (s === node.id || t === node.id) linkSet.add(`${s}__${t}`)
      })
      connectedLinkIdsRef.current = linkSet
    } else {
      connectedNodeIdsRef.current = new Set()
      connectedLinkIdsRef.current = new Set()
    }
  }, [])

  // ── Node degree cache (for Obsidian-style sizing) ─────────────────────────
  const degreeMapRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    const deg = new Map<string, number>()
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      deg.set(s, (deg.get(s) ?? 0) + 1)
      deg.set(t, (deg.get(t) ?? 0) + 1)
    })
    degreeMapRef.current = deg
  }, [edges])

  // ── Apply d3 forces whenever topology changes ─────────────────────────────
  // This is what spreads nodes out; without this they pile up in the center.
  // We depend on nodes.length (primitive) so React doesn't re-fire on every
  // object-reference change, and we defer 100 ms so ForceGraph's canvas has
  // time to mount before we configure forces on it.
  useEffect(() => {
    if (graphData.nodes.length === 0) return
    const snapshot = graphData  // capture for the closure
    const t = setTimeout(() => {
      const fg = fgRef.current
      if (!fg) return

      // Repulsion: stronger formula handles denser graphs (avg degree 6 now)
      const nodeCount = snapshot.nodes.length
      const chargeStr = Math.max(-800, -200 - nodeCount * 10)
      fg.d3Force('charge')?.strength(chargeStr)

      // Link distance: how far connected nodes sit from each other
      fg.d3Force('link')?.distance(60).strength(0.4)

      // Weak center pull so the graph doesn't drift off canvas
      fg.d3Force('center')?.strength(0.08)

      // Collision force: prevents nodes from visually overlapping.
      // Radius matches the drawn node size (baseR + padding).
      fg.d3Force('collide', d3.forceCollide().radius((node: any) => {
        const degree = snapshot.links.filter(
          (l: any) => l.source === node.id || l.target === node.id
        ).length
        return 6 + Math.sqrt(degree) * 1.5 + 4  // node visual radius + padding
      }).strength(0.8))

      // Restart simulation from warm state
      fg.d3ReheatSimulation()
    }, 100)
    return () => clearTimeout(t)
  }, [graphData.nodes.length])

  // ── Camera: centre on best search result ──────────────────────────────────
  useEffect(() => {
    if (!fgRef.current || !searchScores || searchScores.size === 0) return
    setTimeout(() => {
      if (!fgRef.current) return
      let bestId = '', bestScore = -1
      searchScores.forEach((score, id) => { if (score > bestScore) { bestScore = score; bestId = id } })
      const topNode = stableDataRef.current.nodes.find((n: any) => n.id === bestId)
      if (topNode?.x != null && topNode?.y != null) {
        fgRef.current.centerAt(topNode.x, topNode.y, 700)
        fgRef.current.zoom(2.5, 700)
      }
    }, 800)
  }, [searchScores])

  // ── Draw: nodes ────────────────────────────────────────────────────────────
  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const gNode = node as GraphNode
    const color      = nodeColor(gNode)
    const isSelected = gNode.id === selectedNodeId
    const isHovered  = gNode.id === hoveredNodeIdRef.current
    const hasQuery   = searchScores !== null
    const score      = searchScores?.get(gNode.id) ?? 0
    const isMatch    = hasQuery && score > 0
    const isTop      = hasQuery && score >= 0.6
    const inNeighbour = hoveredNodeIdRef.current
      ? connectedNodeIdsRef.current.has(gNode.id)
      : false

    // ── Alpha / dimming ───────────────────────────────────────────────────
    let alpha = 1
    if (hasQuery && !isMatch && !isSelected)       alpha = 0.15
    else if (hoveredNodeIdRef.current && !inNeighbour && !isSelected) alpha = 0.20

    // ── Node radius (keep small – Obsidian dots, not planets) ────────────
    const degree  = degreeMapRef.current.get(gNode.id) ?? 0
    // sqrt scaling so highly-connected nodes are only slightly larger
    const baseR   = 3 + Math.sqrt(degree) * 0.5        // 3–8 px range
    let r = baseR
    if (isTop)     r = baseR + 3
    if (isMatch && !isTop) r = baseR + 1.5
    if (isSelected) r = baseR + 4
    if (isHovered && !isSelected) r = baseR + 2

    ctx.save()
    ctx.globalAlpha = alpha

    // ── Glow halo (only selected / hovered / top-match) ──────────────────
    if (isSelected || isHovered || isTop) {
      const haloR = r + (isSelected ? 10 : 6)
      const g = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, haloR)
      g.addColorStop(0, hexAlpha(color, isSelected ? 0.5 : 0.28))
      g.addColorStop(1, hexAlpha(color, 0))
      ctx.beginPath()
      ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
    }

    // ── Core dot ─────────────────────────────────────────────────────────
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
    if (isSelected) {
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.fill()
    }

    // Outer ring for top search result
    if (isTop && !isSelected) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 2.5, 0, Math.PI * 2)
      ctx.strokeStyle = hexAlpha(color, 0.65)
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // ── Label — ONLY for hovered or selected node ─────────────────────────
    // Also show for top-3 search matches when zoomed in
    const topIds = hasQuery
      ? Array.from(searchScores!.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0])
      : []
    const isTopThree = topIds.includes(gNode.id)

    const showLabel =
      isSelected ||
      isHovered  ||
      (isTopThree && globalScale >= 0.6)

    if (showLabel) {
      const rawLabel = gNode.label.replace(/\.[^.]+$/, '')
      const label    = rawLabel.length > 28 ? rawLabel.slice(0, 25) + '…' : rawLabel

      // Font size stays readable at any zoom: fixed 12px in screen space
      const fontSize = Math.max(10, Math.min(14, 12 / Math.max(globalScale * 0.6, 0.4)))
      ctx.font         = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'top'

      const labelY = node.y + r + 5 / Math.max(globalScale, 0.5)
      const tw = ctx.measureText(label).width
      const pad = 4, bh = fontSize + 4

      // Dark pill so text is always legible
      ctx.fillStyle = 'rgba(10,10,14,0.88)'
      ctx.beginPath()
      ctx.roundRect(node.x - tw / 2 - pad, labelY - 1, tw + pad * 2, bh, 4)
      ctx.fill()

      ctx.fillStyle = isSelected ? '#ffffff' : hexAlpha(color, 0.95)
      ctx.fillText(label, node.x, labelY)
    }

    ctx.restore()
  }, [selectedNodeId, searchScores])

  // ── Draw: links ────────────────────────────────────────────────────────────
  const drawLink = useCallback((link: any, ctx: CanvasRenderingContext2D) => {
    const s = typeof link.source === 'object' ? link.source : { x: 0, y: 0 }
    const t = typeof link.target === 'object' ? link.target : { x: 0, y: 0 }
    if (s.x == null || t.x == null) return

    const sId = typeof link.source === 'object' ? link.source.id : link.source
    const tId = typeof link.target === 'object' ? link.target.id : link.target
    const linkKey = `${sId}__${tId}`

    const weight     = link.weight ?? 0.5
    const isActive   = connectedLinkIdsRef.current.has(linkKey) || connectedLinkIdsRef.current.has(`${tId}__${sId}`)
    const hasQuery   = searchScores !== null
    const sMatch     = searchScores?.has(sId)
    const tMatch     = searchScores?.has(tId)
    const bothMatch  = sMatch && tMatch

    let alpha: number
    let width: number
    let strokeColor: string

    if (isActive) {
      alpha       = 0.7
      width       = 1.2 + weight
      strokeColor = '#ffffff'
    } else if (hasQuery && bothMatch) {
      alpha       = 0.5 + weight * 0.3
      width       = 0.8 + weight * 1.2
      strokeColor = '#5e7ce6'
    } else if (hasQuery && !sMatch && !tMatch) {
      alpha       = 0.04
      width       = 0.4
      strokeColor = '#ffffff'
    } else {
      alpha       = 0.12 + weight * 0.08
      width       = 0.5 + weight * 0.6
      strokeColor = '#ffffff'
    }

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = strokeColor
    ctx.lineWidth   = width
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(t.x, t.y)
    ctx.stroke()
    ctx.restore()
  }, [searchScores])

  // ── Present doc types for legend ───────────────────────────────────────────
  const presentTypes = Array.from(new Set(nodes.map(n => n.doc_type).filter(Boolean)))

  return (
    <div className="w-full h-full relative" style={{ background: '#0c0c0f' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        nodeId="id"
        linkSource="source"
        linkTarget="target"
        backgroundColor="#0c0c0f"
        nodeCanvasObject={drawNode}
        nodeCanvasObjectMode={() => 'replace'}
        linkCanvasObject={drawLink}
        linkCanvasObjectMode={() => 'replace'}
        onNodeClick={(node: any) => {
          const id = (node as GraphNode).id

          if (lastClickNodeId.current === id && clickTimerRef.current !== null) {
            // ── Second click within 300 ms on the same node → double-click ──
            clearTimeout(clickTimerRef.current)
            clickTimerRef.current = null
            lastClickNodeId.current = null
            if (id) openFile(id)
            return
          }

          // ── First click: start timer; act as single-click if no second arrives ──
          lastClickNodeId.current = id
          clickTimerRef.current = setTimeout(() => {
            clickTimerRef.current = null
            lastClickNodeId.current = null
            onNodeClick(node as GraphNode)
            fgRef.current?.centerAt(node.x, node.y, 600)
            fgRef.current?.zoom(2.5, 600)
          }, 300)
        }}
        onNodeHover={handleNodeHover}
        nodeLabel=""
        nodeRelSize={4}
        cooldownTicks={300}
        cooldownTime={6000}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.4}
        d3AlphaMin={0.001}
        linkDirectionalParticles={0}
        enableZoomInteraction
        enablePanInteraction
        minZoom={0.1}
        maxZoom={12}
      />

      {/* Colour legend */}
      <Legend presentTypes={presentTypes} />
    </div>
  )
}
