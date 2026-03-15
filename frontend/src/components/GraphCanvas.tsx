/**
 * Knowledge graph — D3 v7 simulation + Canvas.
 *
 * All nodes always visible. Structural groups kept apart by cluster forces
 * (forceX/Y targeting each group's centre). Group rings drawn behind nodes.
 * Click a node → focus its whole group. Click legend row → same.
 *
 * Pan/zoom is MANUAL (no d3-zoom) to keep click events clean.
 */
import {
  useRef, useCallback, useEffect, useState, useMemo,
} from 'react'
import * as d3 from 'd3'
import type { GraphNode, GraphEdge } from '../types'
import { openFile, showInFinder, api } from '../api'
import { useAppStore } from '../store/appStore'

// ── Community palette ─────────────────────────────────────────────────────────
const COMMUNITY_PALETTE = [
  '#5e7ce6', '#0d9488', '#d97706', '#dc2626',
  '#7c3aed', '#db2777', '#16a34a', '#0891b2',
]
function communityColor(id: number): string {
  return COMMUNITY_PALETTE[(id ?? 0) % COMMUNITY_PALETTE.length]
}
function hexAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

type SimNode = GraphNode & {
  x: number; y: number; vx: number; vy: number
  fx?: number | null; fy?: number | null
}
type SimLink = {
  source: SimNode | string
  target: SimNode | string
  weight: number
  forced?: boolean
}

interface Transform { x: number; y: number; k: number }

interface Props {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedNodeId: string | null
  searchScores: Map<string, number> | null
  onNodeClick: (node: GraphNode) => void
  onNodeDeleted?: () => void
}

// ── Group legend ──────────────────────────────────────────────────────────────
function CommunityLegend({
  groups,
  focusedGroup,
  onGroupClick,
}: {
  groups: { id: number; label: string; count: number }[]
  focusedGroup: number | null
  onGroupClick: (id: number | null) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  if (groups.length === 0) return null
  return (
    <div className="absolute bottom-4 left-4 z-20 select-none">
      <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-2xl">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/60 hover:text-white/90 transition-colors"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="font-semibold tracking-wide uppercase text-[10px]">Groups</span>
          <svg className={`ml-auto w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-180'}`} viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        {!collapsed && (
          <div className="px-3 pb-3 flex flex-col gap-0.5 max-h-56 overflow-y-auto">
            {groups.map(g => {
              const isFocused = focusedGroup === g.id
              return (
                <button
                  key={g.id}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1 rounded-lg transition-colors ${
                    isFocused ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  onClick={() => onGroupClick(isFocused ? null : g.id)}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: communityColor(g.id), boxShadow: isFocused ? `0 0 6px ${communityColor(g.id)}` : undefined }}
                  />
                  <span className={`text-[11px] whitespace-nowrap ${isFocused ? 'text-white' : 'text-white/70'}`}>
                    {g.label}
                  </span>
                  <span className="text-[10px] text-white/30 ml-auto">{g.count}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function GraphCanvas({
  nodes, edges, selectedNodeId, searchScores, onNodeClick, onNodeDeleted,
}: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const simRef       = useRef<d3.Simulation<SimNode, SimLink> | null>(null)

  const transformRef  = useRef<Transform>({ x: 0, y: 0, k: 1 })
  const simNodesRef   = useRef<SimNode[]>([])
  const simLinksRef   = useRef<SimLink[]>([])

  const activeWorkspaceId = useAppStore(s => s.activeWorkspaceId)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [ctxMenu,       setCtxMenu]       = useState<{ x: number; y: number; node: GraphNode } | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const [focusedGroup,  setFocusedGroup]  = useState<number | null>(null)
  const [localDepth,    setLocalDepth]    = useState<1 | 2 | 3>(1)
  const [dims,          setDims]          = useState({ w: 800, h: 600 })
  const [cursor,        setCursor]        = useState<'default' | 'pointer' | 'grab' | 'grabbing'>('default')

  // Refs synced with state/props
  const focusedNodeIdRef  = useRef<string | null>(null)
  const focusedGroupRef   = useRef<number | null>(null)
  const localDepthRef     = useRef<1 | 2 | 3>(1)
  const hoveredNodeRef    = useRef<SimNode | null>(null)
  const onNodeClickRef    = useRef(onNodeClick)
  const onNodeDeletedRef  = useRef(onNodeDeleted)
  const dimsRef           = useRef(dims)
  const selectedNodeIdRef = useRef(selectedNodeId)
  const searchScoresRef   = useRef(searchScores)

  useEffect(() => { focusedNodeIdRef.current  = focusedNodeId }, [focusedNodeId])
  useEffect(() => { focusedGroupRef.current   = focusedGroup  }, [focusedGroup])
  useEffect(() => { localDepthRef.current     = localDepth    }, [localDepth])
  useEffect(() => { onNodeClickRef.current    = onNodeClick   }, [onNodeClick])
  useEffect(() => { onNodeDeletedRef.current  = onNodeDeleted }, [onNodeDeleted])
  useEffect(() => { dimsRef.current           = dims          }, [dims])
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId }, [selectedNodeId])
  useEffect(() => { searchScoresRef.current   = searchScores  }, [searchScores])

  // ── Pointer state (refs only — no re-renders) ─────────────────────────────
  const dragNodeRef    = useRef<SimNode | null>(null)
  const dragStartRef   = useRef<{ x: number; y: number } | null>(null)
  const dragMovedRef   = useRef(false)
  const isPanningRef   = useRef(false)
  const panStartRef    = useRef({ x: 0, y: 0, tx: 0, ty: 0 })
  const clickTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastClickNodeIdRef = useRef<string | null>(null)
  const smoothAnimRef = useRef<number>(0)

  // ── Degree map ────────────────────────────────────────────────────────────
  const degreeMap = useMemo(() => {
    const m = new Map<string, number>()
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      m.set(s, (m.get(s) ?? 0) + 1)
      m.set(t, (m.get(t) ?? 0) + 1)
    })
    return m
  }, [edges])
  const degreeMapRef = useRef(degreeMap)
  useEffect(() => { degreeMapRef.current = degreeMap }, [degreeMap])

  // ── Adjacency index ────────────────────────────────────────────────────────
  const adjRef = useRef<Map<string, Set<string>>>(new Map())
  useEffect(() => {
    const adj = new Map<string, Set<string>>()
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      if (!adj.has(s)) adj.set(s, new Set())
      if (!adj.has(t)) adj.set(t, new Set())
      adj.get(s)!.add(t)
      adj.get(t)!.add(s)
    })
    adjRef.current = adj
  }, [edges])

  function getNeighbourhood(nodeId: string, depth: number): Set<string> {
    const visited = new Set<string>([nodeId])
    let frontier  = new Set<string>([nodeId])
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>()
      frontier.forEach(id => {
        adjRef.current.get(id)?.forEach(nbr => {
          if (!visited.has(nbr)) { visited.add(nbr); next.add(nbr) }
        })
      })
      frontier = next
    }
    return visited
  }

  function nodeRadius(nodeId: string): number {
    return 4 + Math.sqrt(degreeMapRef.current.get(nodeId) ?? 0) * 2
  }

  // ── Group list derived from nodes ─────────────────────────────────────────
  const groupList = useMemo(() => {
    const m = new Map<number, { label: string; count: number }>()
    nodes.forEach(n => {
      const cid = n.community_id ?? 0
      if (!m.has(cid)) m.set(cid, { label: n.community_label || 'Other', count: 0 })
      m.get(cid)!.count++
    })
    return Array.from(m.entries())
      .map(([id, d]) => ({ id, label: d.label, count: d.count }))
      .sort((a, b) => b.count - a.count)
  }, [nodes])

  // Group target positions — arranged in a circle around canvas centre.
  // Used by cluster forces to nudge same-group nodes together.
  const groupTargetsRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  useEffect(() => {
    const { w, h } = dimsRef.current
    const cx = w / 2, cy = h / 2
    const n = groupList.length
    if (n === 0) return
    const radius = Math.min(cx, cy) * 0.38
    const targets = new Map<number, { x: number; y: number }>()
    groupList.forEach((g, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2
      targets.set(g.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      })
    })
    groupTargetsRef.current = targets
  }, [groupList, dims])

  // ── ResizeObserver ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setDims({ w: Math.floor(width), h: Math.floor(height) })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // ── Quadtree hit-test ─────────────────────────────────────────────────────
  function findNodeAt(clientX: number, clientY: number): SimNode | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect        = canvas.getBoundingClientRect()
    const { k, x: tx, y: ty } = transformRef.current
    const wx = (clientX - rect.left - tx) / k
    const wy = (clientY - rect.top  - ty) / k
    const qt = d3.quadtree<SimNode>()
      .x(d => d.x).y(d => d.y)
      .addAll(simNodesRef.current)
    return qt.find(wx, wy, (nodeRadius('') + 12) / k) ?? null
  }

  // ── Canvas render ─────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx   = canvas.getContext('2d')
    if (!ctx) return

    const { k, x: tx, y: ty } = transformRef.current
    const simNodes   = simNodesRef.current
    const simLinks   = simLinksRef.current
    const focusedNId = focusedNodeIdRef.current
    const focusedG   = focusedGroupRef.current
    const hovered    = hoveredNodeRef.current
    const depth      = localDepthRef.current
    const selId      = selectedNodeIdRef.current
    const scores     = searchScoresRef.current
    const dpr        = window.devicePixelRatio || 1

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.translate(tx, ty)
    ctx.scale(k, k)

    // Determine visibility sets
    const visibleIds = focusedNId ? getNeighbourhood(focusedNId, depth) : null

    // Determine which group is active (node focus takes priority)
    const activeGroup = focusedNId
      ? (simNodes.find(n => n.id === focusedNId)?.community_id ?? null)
      : focusedG

    // ── Phase 1: Group rings ───────────────────────────────────────────────
    // Compute centroids + radii from current sim positions
    const groupStats = new Map<number, { sx: number; sy: number; count: number; maxDist: number }>()
    simNodes.forEach(n => {
      const cid = n.community_id ?? 0
      if (!groupStats.has(cid)) groupStats.set(cid, { sx: 0, sy: 0, count: 0, maxDist: 0 })
      const s = groupStats.get(cid)!
      s.sx += n.x; s.sy += n.y; s.count++
    })
    // centroid pass
    const groupCentroids = new Map<number, { cx: number; cy: number; r: number; label: string }>()
    groupStats.forEach((s, cid) => {
      const cx = s.sx / s.count, cy = s.sy / s.count
      groupCentroids.set(cid, { cx, cy, r: 0, label: '' })
    })
    // radius pass
    simNodes.forEach(n => {
      const cid = n.community_id ?? 0
      const c = groupCentroids.get(cid)!
      const dist = Math.sqrt((n.x - c.cx) ** 2 + (n.y - c.cy) ** 2) + nodeRadius(n.id) + 18
      if (dist > c.r) c.r = dist
      c.label = n.community_label || 'Other'
    })

    groupCentroids.forEach((c, cid) => {
      if (c.r < 1) return
      const color = communityColor(cid)
      const isFocused = activeGroup === cid
      const isOther   = activeGroup !== null && !isFocused

      ctx.save()
      ctx.globalAlpha = isOther ? 0.03 : isFocused ? 0.12 : 0.07

      // Fill ring
      ctx.beginPath()
      ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      ctx.globalAlpha = isOther ? 0.04 : isFocused ? 0.5 : 0.18
      ctx.strokeStyle = color
      ctx.lineWidth = isFocused ? 1.5 : 1
      if (!isFocused) ctx.setLineDash([5, 6])
      ctx.stroke()
      ctx.setLineDash([])

      // Group label above ring
      ctx.globalAlpha = isOther ? 0.08 : isFocused ? 0.9 : 0.4
      const labelFs = Math.max(9, Math.min(13, 11 / Math.max(k * 0.5, 0.3)))
      ctx.font = `600 ${labelFs}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = color
      ctx.fillText(c.label, c.cx, c.cy - c.r + 2)
      ctx.restore()
    })

    // ── Phase 2: Edges ────────────────────────────────────────────────────
    simLinks.forEach(link => {
      const s = link.source as SimNode
      const t = link.target as SimNode
      if (s.x == null || t.x == null) return

      const weight      = link.weight ?? 0.5
      const crossGroup  = (s.community_id ?? 0) !== (t.community_id ?? 0)
      let alpha         = crossGroup
        ? 0.06 + weight * 0.08   // cross-group: subtle
        : 0.15 + weight * 0.4    // same-group: normal

      // Dim edges when a group is focused
      if (activeGroup !== null) {
        const sInGroup = (s.community_id ?? 0) === activeGroup
        const tInGroup = (t.community_id ?? 0) === activeGroup
        if (!sInGroup && !tInGroup) alpha *= 0.1
        else if (!sInGroup || !tInGroup) alpha *= 0.3  // cross-group edge to focused group
      } else if (visibleIds) {
        alpha = (visibleIds.has(s.id) && visibleIds.has(t.id)) ? alpha : 0.04
      } else if (hovered) {
        const adj  = adjRef.current.get(hovered.id)
        const near = s.id === hovered.id || t.id === hovered.id
                  || (adj?.has(s.id) ?? false) || (adj?.has(t.id) ?? false)
        alpha = near ? Math.min(alpha * 1.5, 0.9) : 0.04
      } else if (scores) {
        alpha = (scores.has(s.id) && scores.has(t.id)) ? alpha : 0.04
      }

      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = communityColor(s.community_id ?? 0)
      ctx.lineWidth   = crossGroup ? weight * 1.2 : weight * 2.5
      if (link.forced || crossGroup) ctx.setLineDash(crossGroup ? [3, 5] : [4, 5])
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(t.x, t.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    })

    // ── Phase 3: Nodes ─────────────────────────────────────────────────────
    simNodes.forEach(node => {
      const r          = nodeRadius(node.id)
      const color      = communityColor(node.community_id ?? 0)
      const isSelected = node.id === selId
      const isHovered  = node === hovered
      const deg        = degreeMapRef.current.get(node.id) ?? 0
      const score      = scores?.get(node.id) ?? 0
      const isMatch    = scores !== null && score > 0
      const inGroup    = activeGroup === null || (node.community_id ?? 0) === activeGroup

      let alpha = 1
      if (activeGroup !== null) {
        alpha = inGroup ? 1 : 0.07
      } else if (visibleIds) {
        alpha = visibleIds.has(node.id) ? 1 : 0.08
      } else if (scores && !isMatch && !isSelected) {
        alpha = 0.12
      } else if (hovered && !isHovered && !adjRef.current.get(hovered.id)?.has(node.id) && !isSelected) {
        alpha = 0.20
      }

      ctx.save()
      ctx.globalAlpha = alpha

      // Glow halo
      if (isSelected || isHovered) {
        const haloR = r + (isSelected ? 10 : 6)
        const g = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, haloR)
        g.addColorStop(0, hexAlpha(color, isSelected ? 0.5 : 0.28))
        g.addColorStop(1, hexAlpha(color, 0))
        ctx.beginPath()
        ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2)
        ctx.fillStyle = g
        ctx.fill()
      }

      // Core dot
      ctx.beginPath()
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2)
      if (isSelected) {
        ctx.fillStyle = '#ffffff'; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()
      } else {
        ctx.fillStyle = color; ctx.fill()
      }

      // Label — show when: selected, hovered, high-degree, focused group member
      const showLabel = isSelected || isHovered || deg > 3 || (inGroup && activeGroup !== null)
      if (showLabel) {
        const raw   = (node.label || node.name || '').replace(/\.[^.]+$/, '')
        const label = raw.length > 28 ? raw.slice(0, 25) + '\u2026' : raw
        const fs    = Math.max(10, Math.min(14, 12 / Math.max(k * 0.6, 0.4)))
        ctx.font         = `500 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`
        ctx.textAlign    = 'center'
        ctx.textBaseline = 'top'
        const labelY = node.y + r + 5 / Math.max(k, 0.5)
        const tw     = ctx.measureText(label).width
        const pad    = 4
        ctx.fillStyle = 'rgba(10,10,14,0.88)'
        ctx.beginPath()
        ctx.roundRect(node.x - tw / 2 - pad, labelY - 1, tw + pad * 2, fs + 4, 4)
        ctx.fill()
        ctx.fillStyle = isSelected ? '#ffffff' : hexAlpha(color, 0.95)
        ctx.fillText(label, node.x, labelY)
      }

      ctx.restore()
    })

    ctx.restore()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Smooth transform animation ────────────────────────────────────────────
  function smoothTo(targetX: number, targetY: number, targetK: number, ms = 600) {
    cancelAnimationFrame(smoothAnimRef.current)
    const start = performance.now()
    const { x: x0, y: y0, k: k0 } = transformRef.current
    function step(now: number) {
      const t    = Math.min((now - start) / ms, 1)
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      transformRef.current = {
        x: x0 + (targetX - x0) * ease,
        y: y0 + (targetY - y0) * ease,
        k: k0 + (targetK - k0) * ease,
      }
      render()
      if (t < 1) smoothAnimRef.current = requestAnimationFrame(step)
    }
    smoothAnimRef.current = requestAnimationFrame(step)
  }

  // Focus a group: dim everything else and pan to its centroid
  function focusGroup(groupId: number) {
    setFocusedGroup(groupId)
    setFocusedNodeId(null)

    // Compute centroid of group members
    const members = simNodesRef.current.filter(n => (n.community_id ?? 0) === groupId)
    if (members.length === 0) return
    let cx = 0, cy = 0
    members.forEach(n => { cx += n.x; cy += n.y })
    cx /= members.length; cy /= members.length

    const { w, h } = dimsRef.current
    const targetK = Math.min(transformRef.current.k * 1.2, 3)
    smoothTo(w / 2 - cx * targetK, h / 2 - cy * targetK, targetK, 600)
  }

  function handleLegendClick(groupId: number | null) {
    if (groupId === null) {
      setFocusedGroup(null)
      setFocusedNodeId(null)
    } else {
      focusGroup(groupId)
    }
    render()
  }

  // ── D3 simulation setup ───────────────────────────────────────────────────
  useEffect(() => {
    if (nodes.length === 0) {
      simNodesRef.current = []; simLinksRef.current = []
      simRef.current?.stop(); render(); return
    }

    const posCache = new Map<string, { x: number; y: number }>()
    simNodesRef.current.forEach(n => { if (n.x != null) posCache.set(n.id, { x: n.x, y: n.y }) })

    const cx = dimsRef.current.w / 2, cy = dimsRef.current.h / 2
    const simNodes: SimNode[] = nodes.map(n => {
      const p = posCache.get(n.id)
      // Start near group target if no cached position
      const gt = groupTargetsRef.current.get(n.community_id ?? 0)
      const defaultX = gt ? gt.x + (Math.random() - 0.5) * 60 : cx + (Math.random() - 0.5) * 200
      const defaultY = gt ? gt.y + (Math.random() - 0.5) * 60 : cy + (Math.random() - 0.5) * 200
      return { ...n, x: p?.x ?? defaultX, y: p?.y ?? defaultY, vx: 0, vy: 0 } as SimNode
    })
    const simLinks: SimLink[] = edges.map(e => ({
      source:  typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target:  typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      weight:  e.weight,
      forced:  e.forced ?? false,
    }))

    simNodesRef.current = simNodes
    simLinksRef.current = simLinks
    simRef.current?.stop()

    const sim = d3.forceSimulation<SimNode>(simNodes)
      // Repulsion — stronger to give nodes more breathing room
      .force('charge', d3.forceManyBody<SimNode>().strength(-160))
      // Semantic edges
      .force('link',
        (d3.forceLink<SimNode, SimLink>(simLinks) as d3.ForceLink<SimNode, SimLink>)
          .id(d => d.id)
          .distance(d => {
            const sl = d as SimLink
            const s = sl.source as SimNode, t = sl.target as SimNode
            const crossGroup = (s?.community_id ?? 0) !== (t?.community_id ?? 0)
            // Cross-group edges are longer so groups stay separated
            return crossGroup ? 160 / Math.max(sl.weight, 0.1) : 60 / Math.max(sl.weight, 0.1)
          })
          .strength(d => {
            const sl = d as SimLink
            const s = sl.source as SimNode, t = sl.target as SimNode
            const crossGroup = (s?.community_id ?? 0) !== (t?.community_id ?? 0)
            // Cross-group links pull weaker so groups stay cohesive
            return crossGroup ? Math.min(sl.weight, 1) * 0.3 : Math.min(sl.weight, 1)
          })
      )
      // Cluster forces — pull same-group nodes toward their group target position
      .force('cluster-x', d3.forceX<SimNode>(n => {
        return groupTargetsRef.current.get(n.community_id ?? 0)?.x ?? cx
      }).strength(0.08))
      .force('cluster-y', d3.forceY<SimNode>(n => {
        return groupTargetsRef.current.get(n.community_id ?? 0)?.y ?? cy
      }).strength(0.08))
      // Collision to prevent overlap
      .force('collide', d3.forceCollide<SimNode>().radius(d => nodeRadius(d.id) + 6).strength(0.8))
      .alphaDecay(0.02)
      .velocityDecay(0.4)
      .on('tick', render)

    simRef.current = sim
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  // Re-render on search / selection changes
  useEffect(() => { render() }, [searchScores, selectedNodeId, render])

  // ── Canvas DPR sizing ─────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width  = dims.w * dpr
    canvas.height = dims.h * dpr
    render()
  }, [dims, render])

  // ── Centre on best search result ──────────────────────────────────────────
  useEffect(() => {
    if (!searchScores || searchScores.size === 0) return
    const timer = setTimeout(() => {
      let bestId = '', bestScore = -1
      searchScores.forEach((sc, id) => { if (sc > bestScore) { bestScore = sc; bestId = id } })
      const top = simNodesRef.current.find(n => n.id === bestId)
      if (top?.x != null) {
        const targetK = Math.max(transformRef.current.k, 2)
        const { w, h } = dimsRef.current
        // Also focus the group of the best result
        const bestNode = nodes.find(n => n.id === bestId)
        if (bestNode?.community_id != null) setFocusedGroup(bestNode.community_id)
        smoothTo(w / 2 - top.x * targetK, h / 2 - top.y * targetK, targetK, 700)
      }
    }, 800)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchScores])

  // ── Pointer handlers ──────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const found = findNodeAt(e.clientX, e.clientY)
    if (found) {
      dragNodeRef.current  = found
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      dragMovedRef.current = false
      found.fx = found.x; found.fy = found.y
      setCursor('grabbing')
    } else {
      isPanningRef.current = true
      panStartRef.current  = {
        x: e.clientX, y: e.clientY,
        tx: transformRef.current.x, ty: transformRef.current.y,
      }
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      dragMovedRef.current = false
      setCursor('grabbing')
    }
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragNodeRef.current) {
      const ds = dragStartRef.current!
      const dx = e.clientX - ds.x, dy = e.clientY - ds.y
      if (!dragMovedRef.current && Math.sqrt(dx * dx + dy * dy) > 4) dragMovedRef.current = true
      const canvas = canvasRef.current!
      const rect   = canvas.getBoundingClientRect()
      const { k, x: tx, y: ty } = transformRef.current
      dragNodeRef.current.fx = (e.clientX - rect.left - tx) / k
      dragNodeRef.current.fy = (e.clientY - rect.top  - ty) / k
      simRef.current?.alphaTarget(0.3).restart()
      return
    }
    if (isPanningRef.current) {
      const { x: sx, y: sy, tx, ty } = panStartRef.current
      const dx = e.clientX - sx, dy = e.clientY - sy
      if (!dragMovedRef.current && Math.sqrt(dx * dx + dy * dy) > 4) dragMovedRef.current = true
      transformRef.current = { x: tx + dx, y: ty + dy, k: transformRef.current.k }
      render()
      return
    }
    // Hover
    const found = findNodeAt(e.clientX, e.clientY)
    if (found !== hoveredNodeRef.current) {
      hoveredNodeRef.current = found ?? null
      setCursor(found ? 'pointer' : 'default')
      render()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    ;(e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId)
    isPanningRef.current = false

    const node  = dragNodeRef.current
    const moved = dragMovedRef.current
    dragNodeRef.current = null

    setCursor(findNodeAt(e.clientX, e.clientY) ? 'pointer' : 'default')

    if (node) {
      node.fx = null; node.fy = null
      simRef.current?.alphaTarget(0)

      if (!moved) {
        // Single-click vs double-click detection
        const id = node.id
        if (lastClickNodeIdRef.current === id && clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current)
          clickTimerRef.current = null
          lastClickNodeIdRef.current = null
          openFile(node.path)
          return
        }
        lastClickNodeIdRef.current = id
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current      = null
          lastClickNodeIdRef.current = null

          // Open inspector + focus this node's group
          setFocusedNodeId(id)
          setFocusedGroup(null)   // node focus overrides group focus
          onNodeClickRef.current(node)

          const { w, h } = dimsRef.current
          const { k }    = transformRef.current
          smoothTo(w / 2 - node.x * k, h / 2 - node.y * k, k, 600)
        }, 280)
      }
    } else if (!moved) {
      // Click on empty space → clear all focus
      setFocusedNodeId(null)
      setFocusedGroup(null)
      render()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render])

  const handlePointerLeave = useCallback(() => {
    isPanningRef.current   = false
    dragNodeRef.current    = null
    hoveredNodeRef.current = null
    setCursor('default')
    render()
  }, [render])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const { k, x: tx, y: ty } = transformRef.current
    const factor = Math.exp(-e.deltaY * 0.001)
    const newK   = Math.min(12, Math.max(0.05, k * factor))
    transformRef.current = {
      x: mx - (mx - tx) * (newK / k),
      y: my - (my - ty) * (newK / k),
      k: newK,
    }
    render()
  }, [render])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const found = findNodeAt(e.clientX, e.clientY)
    if (found) setCtxMenu({ x: e.clientX, y: e.clientY, node: found })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleRemoveFromBina(node: GraphNode) {
    setCtxMenu(null)
    if (!activeWorkspaceId) return
    try {
      await api.deleteFile(node.path, activeWorkspaceId)
      if (focusedNodeIdRef.current === node.id) setFocusedNodeId(null)
      onNodeDeletedRef.current?.()
    } catch {}
  }

  // Focused node's group label for breadcrumb
  const focusedGroupLabel = useMemo(() => {
    const gid = focusedGroup ?? (
      focusedNodeId
        ? (simNodesRef.current.find(n => n.id === focusedNodeId)?.community_id ?? null)
        : null
    )
    if (gid === null) return null
    return groupList.find(g => g.id === gid)?.label ?? null
  }, [focusedGroup, focusedNodeId, groupList])

  const activeFocusGroupId = useMemo(() => {
    if (focusedGroup !== null) return focusedGroup
    if (focusedNodeId) {
      return simNodesRef.current.find(n => n.id === focusedNodeId)?.community_id ?? null
    }
    return null
  }, [focusedGroup, focusedNodeId])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ background: '#0c0c0f' }}>

      <canvas
        ref={canvasRef}
        style={{ width: dims.w, height: dims.h, display: 'block', cursor, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />

      {/* Focus breadcrumb — visible when a group is active */}
      {focusedGroupLabel && (
        <div className="absolute top-4 left-4 z-20 select-none animate-fade-in">
          <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-xl px-3.5 py-2 shadow-2xl flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: activeFocusGroupId !== null ? communityColor(activeFocusGroupId) : '#fff' }}
            />
            <span className="text-white/80 text-sm font-medium">{focusedGroupLabel}</span>
            <button
              className="ml-2 text-white/30 hover:text-white/70 text-xs transition-colors"
              onClick={() => { setFocusedGroup(null); setFocusedNodeId(null); render() }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Depth slider — only while a specific node is focused */}
      {focusedNodeId && (
        <div className="absolute top-4 right-4 z-20 select-none animate-fade-in">
          <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-xl px-4 py-3 shadow-2xl flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[11px] text-white/50 uppercase tracking-wide font-semibold">Depth</span>
              <button
                className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                onClick={() => { setFocusedNodeId(null); render() }}
              >
                ✕ clear
              </button>
            </div>
            <div className="flex items-center gap-1">
              {([1, 2, 3] as const).map(d => (
                <button
                  key={d}
                  className={`w-8 h-8 rounded-lg text-sm font-bold transition-all ${
                    localDepth === d
                      ? 'bg-white/20 text-white'
                      : 'text-white/40 hover:text-white/70 hover:bg-white/10'
                  }`}
                  onClick={() => setLocalDepth(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Group legend */}
      <CommunityLegend
        groups={groupList}
        focusedGroup={activeFocusGroupId}
        onGroupClick={handleLegendClick}
      />

      {/* Context menu */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
          <div
            className="fixed z-50 bg-bina-surface border border-bina-border rounded-xl shadow-2xl py-1.5 min-w-[180px] overflow-hidden animate-fade-in"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <div className="px-3 py-1.5 border-b border-bina-border/50 mb-1">
              <p className="text-bina-text text-xs font-medium truncate max-w-[160px]">
                {ctxMenu.node.name || ctxMenu.node.label}
              </p>
              <p className="text-bina-muted text-[10px]">{ctxMenu.node.doc_type}</p>
            </div>
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-text hover:bg-bina-border/40 transition-colors text-left"
              onClick={() => { setCtxMenu(null); openFile(ctxMenu.node.path) }}
            >
              Open file
            </button>
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-text hover:bg-bina-border/40 transition-colors text-left"
              onClick={() => { setCtxMenu(null); showInFinder(ctxMenu.node.path) }}
            >
              Show in Finder
            </button>
            <div className="h-px bg-bina-border/50 my-1" />
            <button
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors text-left"
              onClick={() => handleRemoveFromBina(ctxMenu.node)}
            >
              Remove from Bina
            </button>
          </div>
        </>
      )}
    </div>
  )
}
