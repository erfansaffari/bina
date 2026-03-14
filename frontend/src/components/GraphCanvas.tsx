import { useRef, useCallback, useEffect, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import type { GraphNode, GraphEdge } from '../types'

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

  // ── Stable graph data – only recreated when topology changes ────────────────
  // This is the KEY fix: we never pass a new graphData object unless
  // the set of node IDs or edges actually changes.
  const [graphData, setGraphData] = useState<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] })
  const stableDataRef = useRef<{ nodes: any[]; links: any[] }>({ nodes: [], links: [] })
  const prevNodeIdsRef = useRef(new Set<string>())
  const prevEdgeCountRef = useRef(0)

  useEffect(() => {
    const newIds = new Set(nodes.map(n => n.id))
    const topologyChanged =
      nodes.length !== prevNodeIdsRef.current.size ||
      nodes.some(n => !prevNodeIdsRef.current.has(n.id)) ||
      edges.length !== prevEdgeCountRef.current

    if (!topologyChanged) {
      // Just patch mutable properties in-place – simulation keeps running
      stableDataRef.current.nodes.forEach((n: any) => {
        const updated = nodes.find(u => u.id === n.id)
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
      nodes: nodes.map(n => {
        const p = posCache.get(n.id)
        return { ...n, x: p?.x, y: p?.y, vx: 0, vy: 0 }
      }),
      links: edges.map(e => ({
        source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
        target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
        weight: e.weight,
      })),
    }

    prevNodeIdsRef.current  = newIds
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

  // ── Camera: centre on best search result ──────────────────────────────────
  useEffect(() => {
    if (!fgRef.current || !searchScores || searchScores.size === 0) return
    // Wait a tick for d3 positions to settle
    setTimeout(() => {
      if (!fgRef.current) return
      let bestId = '', bestScore = -1
      searchScores.forEach((score, id) => { if (score > bestScore) { bestScore = score; bestId = id } })
      const topNode = stableDataRef.current.nodes.find((n: any) => n.id === bestId)
      if (topNode?.x != null && topNode?.y != null) {
        fgRef.current.centerAt(topNode.x, topNode.y, 700)
        fgRef.current.zoom(3, 700)
      }
    }, 600)
  }, [searchScores])

  // ── Draw: nodes ────────────────────────────────────────────────────────────
  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const gNode = node as GraphNode
    const color = nodeColor(gNode)
    const isSelected = gNode.id === selectedNodeId
    const isHovered  = gNode.id === hoveredNodeIdRef.current
    const hasQuery   = searchScores !== null
    const score      = searchScores?.get(gNode.id) ?? 0
    const isMatch    = hasQuery && score > 0
    const isTop      = hasQuery && score >= 0.65
    const inNeighbour = hoveredNodeIdRef.current && connectedNodeIdsRef.current.has(gNode.id)

    // Dimming logic
    let alpha = 1
    if (hasQuery && !isMatch && !isSelected) alpha = 0.12
    else if (hoveredNodeIdRef.current && !inNeighbour && !isSelected) alpha = 0.25

    // Node radius: base = degree-scaled, boosted by search score
    const degree  = degreeMapRef.current.get(gNode.id) ?? 0
    const degSize = Math.min(4 + Math.sqrt(degree) * 1.2, 10)
    let r = isTop ? degSize + 5 : isMatch ? degSize + 2 : degSize
    if (isSelected) r += 3
    if (isHovered)  r = Math.max(r, degSize + 2)

    ctx.save()
    ctx.globalAlpha = alpha

    // Outer glow (selected / top match / hovered)
    if (isSelected || isTop || isHovered) {
      const glowR = r + (isSelected ? 12 : 8)
      const grad = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, glowR)
      grad.addColorStop(0, hexAlpha(color, isSelected ? 0.55 : 0.35))
      grad.addColorStop(1, hexAlpha(color, 0))
      ctx.beginPath()
      ctx.arc(node.x, node.y, glowR, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
    }

    // Inner fill
    ctx.beginPath()
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
    if (isSelected) {
      // White core with colour ring
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth   = 2
      ctx.stroke()
    } else {
      ctx.fillStyle = color
      ctx.fill()
    }

    // Ring for top result
    if (isTop && !isSelected) {
      ctx.beginPath()
      ctx.arc(node.x, node.y, r + 2.5, 0, Math.PI * 2)
      ctx.strokeStyle = hexAlpha(color, 0.7)
      ctx.lineWidth   = 1.5
      ctx.stroke()
    }

    // Label rendering
    const showLabel =
      isSelected ||
      isHovered  ||
      (isTop && globalScale > 0.8) ||
      (isMatch && globalScale > 1.4) ||
      (!hasQuery && globalScale > 2)

    if (showLabel) {
      const rawLabel = gNode.label.replace(/\.[^.]+$/, '') // strip extension
      const label    = rawLabel.length > 26 ? rawLabel.slice(0, 23) + '…' : rawLabel
      const fontSize = Math.max(9, Math.min(13, 12 / Math.max(globalScale, 0.5)))

      ctx.font      = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'

      const labelY = node.y + r + 4 / Math.max(globalScale, 0.5)
      const tw     = ctx.measureText(label).width

      // Pill background
      const pad  = 3
      const bx   = node.x - tw / 2 - pad
      const by   = labelY - 1
      const bw   = tw + pad * 2
      const bh   = fontSize + 3
      ctx.fillStyle = 'rgba(15,15,18,0.82)'
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, 3)
      ctx.fill()

      ctx.fillStyle = isSelected ? '#ffffff' : (alpha < 0.5 ? hexAlpha(color, 0.6) : hexAlpha(color, 0.95))
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
        onNodeClick={(node: any) => onNodeClick(node as GraphNode)}
        onNodeHover={handleNodeHover}
        nodeLabel=""
        // Physics: settles quickly, doesn't restart on re-render
        warmupTicks={40}
        cooldownTicks={200}
        cooldownTime={4000}
        d3AlphaDecay={0.025}
        d3VelocityDecay={0.35}
        d3AlphaMin={0.001}
        // d3 force config via ref (see useEffect below)
        linkDirectionalParticles={0}
        enableZoomInteraction
        enablePanInteraction
        minZoom={0.15}
        maxZoom={10}
      />

      {/* Colour legend */}
      <Legend presentTypes={presentTypes} />
    </div>
  )
}
