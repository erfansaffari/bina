/**
 * Knowledge graph — D3 v7 + Canvas.
 *
 * Group rings separate structural clusters. Dense node clumps (2-core within
 * a group) auto-collapse into one sub-cluster node — click to expand, right-
 * click member → "Collapse sub-group". Labels only on hover/selected (or all
 * group members when a group is focused).
 *
 * Pan/zoom MANUAL (no d3-zoom).
 */
import { useRef, useCallback, useEffect, useState, useMemo } from 'react'
import * as d3 from 'd3'
import type { GraphNode, GraphEdge } from '../types'
import { openFile, showInFinder, api } from '../api'
import { useAppStore } from '../store/appStore'

// ── Spring palette ─────────────────────────────────────────────────────────────
const COMMUNITY_PALETTE = [
  '#6366F1', // indigo
  '#F43F5E', // rose
  '#10B981', // emerald
  '#8B5CF6', // violet
  '#3B82F6', // blue
  '#F59E0B', // amber
  '#06B6D4', // cyan
  '#EC4899', // pink
]
function communityColor(id: number) {
  return COMMUNITY_PALETTE[(id ?? 0) % COMMUNITY_PALETTE.length]
}
function hexAlpha(hex: string, a: number) {
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
  source: SimNode | string; target: SimNode | string
  weight: number; forced?: boolean
}

interface SubClusterMeta {
  id: string           // stable: "sc-" + sorted first member hash
  groupId: number
  nodeIds: string[]
  label: string        // first member's name (truncated)
}

// ── 2-core sub-cluster detection ──────────────────────────────────────────────
// Within each structural group, find densely connected subgraphs (every node
// has ≥2 intra-group neighbours). Stable cluster IDs use the first sorted hash.
function computeSubClusters(
  nodes: GraphNode[],
  adj: Map<string, Set<string>>,
): { map: Map<string, string>; list: SubClusterMeta[] } {
  const map = new Map<string, string>()   // nodeId → clusterId
  const byGroup = new Map<number, string[]>()
  nodes.forEach(n => {
    const cid = n.community_id ?? 0
    if (!byGroup.has(cid)) byGroup.set(cid, [])
    byGroup.get(cid)!.push(n.id)
  })

  byGroup.forEach((nodeIds, gid) => {
    const nodeSet = new Set(nodeIds)

    // Intra-group degree
    const deg = new Map<string, number>()
    nodeIds.forEach(id => {
      let d = 0; adj.get(id)?.forEach(nbr => { if (nodeSet.has(nbr)) d++ }); deg.set(id, d)
    })

    // 2-core peeling
    const core = new Set(nodeIds)
    let changed = true
    while (changed) {
      changed = false
      core.forEach(id => {
        if ((deg.get(id) ?? 0) < 2) {
          core.delete(id)
          adj.get(id)?.forEach(nbr => {
            if (core.has(nbr)) deg.set(nbr, (deg.get(nbr) ?? 0) - 1)
          })
          changed = true
        }
      })
    }
    if (core.size < 3) return

    // Connected components within 2-core, size 3-15
    const visited = new Set<string>()
    core.forEach(startId => {
      if (visited.has(startId)) return
      const comp: string[] = []
      const queue = [startId]
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (visited.has(cur)) continue
        visited.add(cur); comp.push(cur)
        adj.get(cur)?.forEach(nbr => {
          if (!visited.has(nbr) && core.has(nbr)) queue.push(nbr)
        })
      }
      if (comp.length >= 3 && comp.length <= 15) {
        // Stable ID: first node hash in sorted order
        const cid = 'sc-' + [...comp].sort()[0].slice(0, 8)
        comp.forEach(id => map.set(id, cid))
      }
    })
  })

  // Build meta list
  const metaMap = new Map<string, SubClusterMeta>()
  nodes.forEach(n => {
    const cid = map.get(n.id)
    if (!cid) return
    if (!metaMap.has(cid)) {
      metaMap.set(cid, { id: cid, groupId: n.community_id ?? 0, nodeIds: [], label: '' })
    }
    const m = metaMap.get(cid)!
    m.nodeIds.push(n.id)
    if (!m.label) m.label = (n.name || '').replace(/\.[^.]+$/, '').slice(0, 15)
  })

  return { map, list: Array.from(metaMap.values()) }
}

// ── Group legend ──────────────────────────────────────────────────────────────
function CommunityLegend({
  groups, focusedGroup, onGroupClick,
}: {
  groups: { id: number; label: string; count: number }[]
  focusedGroup: number | null
  onGroupClick: (id: number | null) => void
}) {
  const [collapsed, setCollapsed] = useState(true)
  if (groups.length === 0) return null
  return (
    <div className="absolute bottom-4 left-4 z-20 select-none">
      <div className="glass rounded-xl overflow-hidden shadow-lg">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-bina-muted hover:text-bina-text transition-colors"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="font-semibold tracking-wide uppercase text-[10px]">Groups</span>
          <svg className={`ml-auto w-3 h-3 transition-transform ${collapsed ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none">
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
                  className={`flex items-center gap-2 w-full text-left px-2 py-1 rounded-lg transition-colors ${isFocused ? 'bg-bina-accent/10' : 'hover:bg-bina-accent/5'}`}
                  onClick={() => onGroupClick(isFocused ? null : g.id)}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: communityColor(g.id), boxShadow: isFocused ? `0 0 6px ${communityColor(g.id)}` : undefined }}
                  />
                  <span className={`text-[11px] whitespace-nowrap ${isFocused ? 'text-bina-text font-medium' : 'text-bina-muted'}`}>{g.label}</span>
                  <span className="text-[10px] text-bina-muted/50 ml-auto">{g.count}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
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

  // Sub-cluster state
  const clusterMapRef     = useRef(new Map<string, string>())   // nodeId → clusterId
  const clusterMetaRef     = useRef<SubClusterMeta[]>([])
  const clusterMetricsRef  = useRef(new Map<string, { cx: number; cy: number; r: number; groupId: number }>())
  const closeButtonsRef    = useRef(new Map<string, { x: number; y: number }>())
  const topoFingerprintRef = useRef('')
  const [expandedClusters, setExpandedClusters] = useState(new Set<string>())
  const expandedClustersRef = useRef(new Set<string>())
  useEffect(() => { expandedClustersRef.current = expandedClusters }, [expandedClusters])

  const activeWorkspaceId = useAppStore(s => s.activeWorkspaceId)

  const [ctxMenu,      setCtxMenu]      = useState<{ x: number; y: number; node: GraphNode } | null>(null)
  const [focusedGroup, setFocusedGroup] = useState<number | null>(null)
  const [dims,         setDims]         = useState({ w: 800, h: 600 })
  const [cursor,       setCursor]       = useState<'default' | 'pointer' | 'grab' | 'grabbing'>('default')

  const focusedGroupRef   = useRef<number | null>(null)
  const hoveredNodeRef    = useRef<SimNode | null>(null)
  const hoveredClusterRef = useRef<string | null>(null)
  const onNodeClickRef    = useRef(onNodeClick)
  const onNodeDeletedRef  = useRef(onNodeDeleted)
  const dimsRef           = useRef(dims)
  const selectedNodeIdRef = useRef(selectedNodeId)
  const searchScoresRef   = useRef(searchScores)
  const adjRef            = useRef(new Map<string, Set<string>>())
  const degreeMapRef      = useRef(new Map<string, number>())

  const dragNodeRef    = useRef<SimNode | null>(null)
  const dragStartRef   = useRef<{ x: number; y: number } | null>(null)
  const dragMovedRef   = useRef(false)
  const isPanningRef   = useRef(false)
  const panStartRef    = useRef({ x: 0, y: 0, tx: 0, ty: 0 })
  const clickTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastClickRef   = useRef<string | null>(null)
  const smoothAnimRef  = useRef<number>(0)

  // Imperative tooltip ref — updated directly to avoid React re-renders on every mouse move
  const tooltipRef = useRef<HTMLDivElement>(null)

  const groupTargetsRef = useRef(new Map<number, { x: number; y: number }>())

  // Hub overview mode — declared before useEffects to avoid TDZ
  const [graphViewMode, setGraphViewMode] = useState<'hub' | 'all'>('hub')
  const graphViewModeRef = useRef<'hub' | 'all'>('hub')
  const groupListRef     = useRef<{ id: number; label: string; count: number }[]>([])
  const hubRectsRef      = useRef(new Map<number, { x: number; y: number; r: number }>())

  useEffect(() => { focusedGroupRef.current   = focusedGroup  }, [focusedGroup])
  useEffect(() => { onNodeClickRef.current    = onNodeClick   }, [onNodeClick])
  useEffect(() => { onNodeDeletedRef.current  = onNodeDeleted }, [onNodeDeleted])
  useEffect(() => { dimsRef.current           = dims          }, [dims])
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId }, [selectedNodeId])
  useEffect(() => { searchScoresRef.current   = searchScores  }, [searchScores])
  useEffect(() => { graphViewModeRef.current  = graphViewMode }, [graphViewMode])

  // ── Group list ────────────────────────────────────────────────────────────
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

  // Keep ref in sync — must be after groupList useMemo to avoid TDZ
  useEffect(() => { groupListRef.current = groupList }, [groupList])

  useEffect(() => {
    const { w, h } = dimsRef.current
    const cx = w / 2, cy = h / 2, n = groupList.length
    if (!n) return
    const radius = Math.min(cx, cy) * 0.38
    const targets = new Map<number, { x: number; y: number }>()
    groupList.forEach((g, i) => {
      const angle = (i / n) * 2 * Math.PI - Math.PI / 2
      targets.set(g.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  function nodeRadius(id: string) { return 4 + Math.sqrt(degreeMapRef.current.get(id) ?? 0) * 2 }
  function clusterRadius(count: number) { return 14 + Math.sqrt(count) * 3.5 }

  function findNodeAt(cx: number, cy: number): SimNode | null {
    const canvas = canvasRef.current; if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const { k, x: tx, y: ty } = transformRef.current
    const wx = (cx - rect.left - tx) / k, wy = (cy - rect.top - ty) / k
    // Only hit-test visible (non-collapsed) nodes
    const visible = simNodesRef.current.filter(n => {
      const cid = clusterMapRef.current.get(n.id)
      return !cid || expandedClustersRef.current.has(cid)
    })
    return d3.quadtree<SimNode>().x(d => d.x).y(d => d.y).addAll(visible)
      .find(wx, wy, (nodeRadius('') + 12) / k) ?? null
  }

  function findClusterAt(cx: number, cy: number): string | null {
    const canvas = canvasRef.current; if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const { k, x: tx, y: ty } = transformRef.current
    const wx = (cx - rect.left - tx) / k, wy = (cy - rect.top - ty) / k
    for (const [cid, m] of clusterMetricsRef.current.entries()) {
      if (expandedClustersRef.current.has(cid)) continue
      const dx = wx - m.cx, dy = wy - m.cy
      if (dx * dx + dy * dy <= m.r * m.r) return cid
    }
    return null
  }

  // Hit-test the "×" close button drawn at top of each expanded cluster ring
  function findCollapseButtonAt(cx: number, cy: number): string | null {
    const canvas = canvasRef.current; if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const { k, x: tx, y: ty } = transformRef.current
    const wx = (cx - rect.left - tx) / k, wy = (cy - rect.top - ty) / k
    for (const [cid, btn] of closeButtonsRef.current.entries()) {
      const dx = wx - btn.x, dy = wy - btn.y
      if (dx * dx + dy * dy <= 100) return cid  // 10px radius
    }
    return null
  }

  function findHubAt(cx: number, cy: number): number | null {
    const canvas = canvasRef.current; if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const { k, x: tx, y: ty } = transformRef.current
    const wx = (cx - rect.left - tx) / k, wy = (cy - rect.top - ty) / k
    for (const [gid, hub] of hubRectsRef.current.entries()) {
      const dx = wx - hub.x, dy = wy - hub.y
      if (dx * dx + dy * dy <= hub.r * hub.r) return gid
    }
    return null
  }

  // ── Canvas render ─────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d'); if (!ctx) return

    const { k, x: tx, y: ty } = transformRef.current
    const simNodes  = simNodesRef.current
    const simLinks  = simLinksRef.current
    const focusedG  = focusedGroupRef.current
    const hovered   = hoveredNodeRef.current
    const hCluster  = hoveredClusterRef.current
    const selId     = selectedNodeIdRef.current
    const scores    = searchScoresRef.current
    const dpr       = window.devicePixelRatio || 1

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.translate(tx, ty)
    ctx.scale(k, k)

    // ── Hub overview mode ─────────────────────────────────────────────────
    if (graphViewModeRef.current === 'hub') {
      const targets = groupTargetsRef.current
      const groups  = groupListRef.current
      hubRectsRef.current.clear()

      groups.forEach(g => {
        const pos = targets.get(g.id)
        if (!pos) return

        const r     = Math.max(30, Math.min(72, 22 + Math.sqrt(g.count) * 5.5))
        const color = communityColor(g.id)

        // 3D sphere effect — off-center highlight
        const grad = ctx.createRadialGradient(
          pos.x - r * 0.28, pos.y - r * 0.28, r * 0.08,
          pos.x, pos.y, r,
        )
        grad.addColorStop(0,   'rgba(255,255,255,0.65)')
        grad.addColorStop(0.35, hexAlpha(color, 0.88))
        grad.addColorStop(1,   hexAlpha(color, 0.55))

        // Shadow
        ctx.shadowColor = hexAlpha(color, 0.3)
        ctx.shadowBlur  = 20
        ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2)
        ctx.fillStyle = grad; ctx.fill()
        ctx.shadowBlur = 0

        // Rim stroke
        ctx.strokeStyle = hexAlpha(color, 0.35)
        ctx.lineWidth   = 1.5; ctx.stroke()

        // Labels
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const labelY = pos.y + r + 10
        ctx.font      = `600 13px -apple-system, BlinkMacSystemFont, sans-serif`
        ctx.fillStyle = '#1E1B4B'
        ctx.fillText(g.label, pos.x, labelY)
        ctx.font      = `400 11px -apple-system, BlinkMacSystemFont, sans-serif`
        ctx.fillStyle = '#6B7280'
        ctx.fillText(`${g.count} files`, pos.x, labelY + 17)

        hubRectsRef.current.set(g.id, { x: pos.x, y: pos.y, r })
      })

      ctx.restore(); return
    }

    // ── Compute cluster metrics (centroid + radius per cluster) ───────────
    const cMetrics = new Map<string, { cx: number; cy: number; r: number; groupId: number; count: number }>()
    for (const meta of clusterMetaRef.current) {
      let sx = 0, sy = 0, cnt = 0
      meta.nodeIds.forEach(id => {
        const n = simNodes.find(sn => sn.id === id)
        if (n) { sx += n.x; sy += n.y; cnt++ }
      })
      if (cnt > 0) {
        const ccx = sx / cnt, ccy = sy / cnt
        let r = clusterRadius(meta.nodeIds.length)
        if (expandedClustersRef.current.has(meta.id)) {
          // For expanded clusters, use the actual bounding radius
          meta.nodeIds.forEach(id => {
            const n = simNodes.find(sn => sn.id === id)
            if (n) {
              const dist = Math.sqrt((n.x - ccx) ** 2 + (n.y - ccy) ** 2) + nodeRadius(id) + 16
              if (dist > r) r = dist
            }
          })
        }
        cMetrics.set(meta.id, { cx: ccx, cy: ccy, r, groupId: meta.groupId, count: meta.nodeIds.length })
      }
    }
    clusterMetricsRef.current = cMetrics

    // Set of hidden node IDs (members of collapsed clusters)
    const hidden = new Set<string>()
    for (const meta of clusterMetaRef.current) {
      if (!expandedClustersRef.current.has(meta.id)) {
        meta.nodeIds.forEach(id => hidden.add(id))
      }
    }

    // ── Phase 1: Group rings ───────────────────────────────────────────────
    const gStats = new Map<number, { sx: number; sy: number; n: number }>()
    simNodes.forEach(node => {
      if (hidden.has(node.id)) return
      const cid = node.community_id ?? 0
      if (!gStats.has(cid)) gStats.set(cid, { sx: 0, sy: 0, n: 0 })
      const s = gStats.get(cid)!; s.sx += node.x; s.sy += node.y; s.n++
    })
    // Include collapsed cluster centroids in group ring computation
    cMetrics.forEach((m, scid) => {
      if (!expandedClustersRef.current.has(scid)) {
        if (!gStats.has(m.groupId)) gStats.set(m.groupId, { sx: 0, sy: 0, n: 0 })
        const s = gStats.get(m.groupId)!; s.sx += m.cx; s.sy += m.cy; s.n++
      }
    })

    type GC = { cx: number; cy: number; r: number; label: string }
    const gCentroids = new Map<number, GC>()
    gStats.forEach((s, cid) => {
      if (s.n > 0) gCentroids.set(cid, { cx: s.sx / s.n, cy: s.sy / s.n, r: 0, label: '' })
    })
    simNodes.forEach(n => {
      if (hidden.has(n.id)) return
      const c = gCentroids.get(n.community_id ?? 0); if (!c) return
      const d = Math.sqrt((n.x - c.cx) ** 2 + (n.y - c.cy) ** 2) + nodeRadius(n.id) + 22
      if (d > c.r) c.r = d
      c.label = n.community_label || 'Other'
    })
    cMetrics.forEach((m, scid) => {
      if (expandedClustersRef.current.has(scid)) return
      const c = gCentroids.get(m.groupId); if (!c) return
      const d = Math.sqrt((m.cx - c.cx) ** 2 + (m.cy - c.cy) ** 2) + m.r + 22
      if (d > c.r) c.r = d
    })

    gCentroids.forEach((c, cid) => {
      if (c.r < 1) return
      const color = communityColor(cid)
      // In search mode, rings are neutral (focusedG was cleared on search start)
      const isFocus = scores === null && focusedG === cid
      const isOther = scores === null && focusedG !== null && !isFocus

      ctx.save()
      ctx.globalAlpha = isOther ? 0.03 : isFocus ? 0.10 : 0.06
      ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.fill()

      ctx.globalAlpha = isOther ? 0.05 : isFocus ? 0.50 : 0.18
      ctx.strokeStyle = color; ctx.lineWidth = isFocus ? 1.5 : 1
      if (!isFocus) ctx.setLineDash([5, 6])
      ctx.stroke(); ctx.setLineDash([])

      ctx.globalAlpha = isOther ? 0.10 : isFocus ? 0.85 : 0.50
      const fs = Math.max(9, Math.min(13, 11 / Math.max(k * 0.5, 0.3)))
      ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillStyle = color
      ctx.fillText(c.label, c.cx, c.cy - c.r + 2)
      ctx.restore()
    })

    // ── Phase 2: Edges ────────────────────────────────────────────────────
    // Aggregate edges that touch collapsed cluster nodes
    type AggEdge = { x1: number; y1: number; x2: number; y2: number; w: number; color: string }
    const aggEdges = new Map<string, AggEdge>()

    simLinks.forEach(link => {
      const s = link.source as SimNode, t = link.target as SimNode
      if (!s?.x || !t?.x) return

      const sCid = clusterMapRef.current.get(s.id)
      const tCid = clusterMapRef.current.get(t.id)
      const sColl = !!sCid && !expandedClustersRef.current.has(sCid)
      const tColl = !!tCid && !expandedClustersRef.current.has(tCid)

      if (sColl || tColl) {
        if (sColl && tColl && sCid === tCid) return   // intra-cluster: skip
        const sm = sColl ? cMetrics.get(sCid!) : null
        const tm = tColl ? cMetrics.get(tCid!) : null
        const x1 = sm ? sm.cx : s.x, y1 = sm ? sm.cy : s.y
        const x2 = tm ? tm.cx : t.x, y2 = tm ? tm.cy : t.y
        const key = `${x1.toFixed(0)},${y1.toFixed(0)}|${x2.toFixed(0)},${y2.toFixed(0)}`
        if (!aggEdges.has(key)) {
          aggEdges.set(key, { x1, y1, x2, y2, w: 0, color: communityColor(s.community_id ?? 0) })
        }
        aggEdges.get(key)!.w += link.weight
        return
      }

      // Regular edge
      const cross = (s.community_id ?? 0) !== (t.community_id ?? 0)
      let alpha = cross ? 0.28 + link.weight * 0.18 : 0.55 + link.weight * 0.35

      // Search mode takes priority over group focus (same mutual exclusion as nodes)
      if (scores !== null) {
        const sMatch = (scores.get(s.id) ?? 0) > 0
        const tMatch = (scores.get(t.id) ?? 0) > 0
        if (sMatch && tMatch)      alpha = Math.min(alpha * 1.4, 0.85)  // both match: bright
        else if (sMatch || tMatch) alpha *= 0.3                           // one match: subtle
        else                       alpha = 0.03                           // no match: almost invisible
      } else if (focusedG !== null) {
        const sIn = (s.community_id ?? 0) === focusedG
        const tIn = (t.community_id ?? 0) === focusedG
        if (!sIn && !tIn) alpha *= 0.08
        else if (!sIn || !tIn) alpha *= 0.25
      } else if (hovered) {
        const adj = adjRef.current.get(hovered.id)
        const near = s.id === hovered.id || t.id === hovered.id
                  || (adj?.has(s.id) ?? false) || (adj?.has(t.id) ?? false)
        alpha = near ? Math.min(alpha * 1.5, 0.9) : 0.04
      }

      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = communityColor(s.community_id ?? 0)
      ctx.lineWidth = cross ? link.weight * 1.2 : link.weight * 2.5
      if (link.forced || cross) ctx.setLineDash(cross ? [3, 5] : [4, 5])
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y)
      ctx.stroke(); ctx.setLineDash([])
      ctx.restore()
    })

    // Draw aggregated cluster edges
    aggEdges.forEach(e => {
      const faded = focusedG !== null
      ctx.save()
      ctx.globalAlpha = faded ? 0.08 : 0.35
      ctx.strokeStyle = e.color
      ctx.lineWidth = Math.min(1 + Math.sqrt(e.w * 8), 5)
      ctx.setLineDash([4, 4])
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2)
      ctx.stroke(); ctx.setLineDash([])
      ctx.restore()
    })

    // ── Phase 3a: Expanded cluster rings + close buttons ─────────────────
    const newCloseButtons = new Map<string, { x: number; y: number }>()
    for (const meta of clusterMetaRef.current) {
      if (!expandedClustersRef.current.has(meta.id)) continue
      const m = cMetrics.get(meta.id); if (!m || m.r < 5) continue
      const color = communityColor(m.groupId)
      const isOther = focusedG !== null && m.groupId !== focusedG

      // Subtle dashed ring around expanded cluster
      ctx.save()
      ctx.globalAlpha = isOther ? 0.05 : 0.2
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([4, 5])
      ctx.beginPath(); ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2)
      ctx.stroke(); ctx.setLineDash([])
      ctx.restore()

      // Close "×" button at top of ring
      const btnX = m.cx, btnY = m.cy - m.r - 1
      newCloseButtons.set(meta.id, { x: btnX, y: btnY })

      ctx.save()
      ctx.globalAlpha = isOther ? 0.12 : 1
      ctx.beginPath(); ctx.arc(btnX, btnY, 8, 0, Math.PI * 2)
      ctx.fillStyle = hexAlpha(color, 0.85); ctx.fill()
      ctx.font = `bold 11px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.fillText('×', btnX, btnY + 0.5)
      ctx.restore()
    }
    closeButtonsRef.current = newCloseButtons

    // ── Phase 3b: Collapsed cluster nodes ─────────────────────────────────
    for (const meta of clusterMetaRef.current) {
      if (expandedClustersRef.current.has(meta.id)) continue
      const m = cMetrics.get(meta.id); if (!m) continue
      const color = communityColor(m.groupId)
      const isHov = hCluster === meta.id
      const isOther = focusedG !== null && m.groupId !== focusedG

      ctx.save()
      ctx.globalAlpha = isOther ? 0.18 : 1

      // Hover glow
      if (isHov) {
        const grd = ctx.createRadialGradient(m.cx, m.cy, m.r * 0.5, m.cx, m.cy, m.r + 12)
        grd.addColorStop(0, hexAlpha(color, 0.2)); grd.addColorStop(1, hexAlpha(color, 0))
        ctx.beginPath(); ctx.arc(m.cx, m.cy, m.r + 12, 0, Math.PI * 2)
        ctx.fillStyle = grd; ctx.fill()
      }

      // Fill
      ctx.beginPath(); ctx.arc(m.cx, m.cy, m.r, 0, Math.PI * 2)
      ctx.fillStyle = hexAlpha(color, isHov ? 0.22 : 0.1); ctx.fill()

      // Dashed border (signals expandable)
      ctx.strokeStyle = hexAlpha(color, isHov ? 0.95 : 0.55)
      ctx.lineWidth = isHov ? 2.5 : 1.5
      ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([])

      // Label
      const fs = Math.max(9.5, Math.min(12, 10.5 / Math.max(k * 0.5, 0.3)))
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = isHov ? '#ffffff' : hexAlpha('#ffffff', 0.78)
      ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.fillText(meta.label, m.cx, m.cy - fs * 0.55)

      ctx.font = `400 ${fs * 0.82}px -apple-system, BlinkMacSystemFont, sans-serif`
      ctx.fillStyle = hexAlpha('#ffffff', 0.42)
      ctx.fillText(`${meta.nodeIds.length} files  ▸`, m.cx, m.cy + fs * 0.65)

      ctx.restore()
    }

    // ── Phase 4: Regular nodes ─────────────────────────────────────────────
    simNodes.forEach(node => {
      if (hidden.has(node.id)) return

      const r = nodeRadius(node.id)
      const color = communityColor(node.community_id ?? 0)
      const isSel   = node.id === selId
      const isHov   = node === hovered
      const inGroup = focusedG === null || (node.community_id ?? 0) === focusedG
      const score   = scores?.get(node.id) ?? 0
      const isMatch = scores !== null && score > 0

      // Priority: search scores > group focus > hover dim
      // Search mode and group focus are mutually exclusive: clearing focusedGroup
      // on search ensures we never reach the group branch while scores are active.
      let alpha = 1
      if (scores !== null) {
        alpha = (isMatch || isSel) ? 1 : 0.08
      } else if (focusedG !== null) {
        alpha = inGroup ? 1 : 0.07
      } else if (hovered && !isHov && !adjRef.current.get(hovered.id)?.has(node.id) && !isSel) {
        alpha = 0.20
      }

      // Boost matched nodes slightly — make them appear larger
      const rBoost = (isMatch && !isSel) ? r * 1.35 : r
      ctx.save(); ctx.globalAlpha = alpha

      if (isSel || isHov || isMatch) {
        const haloR = rBoost + (isSel ? 10 : isMatch ? 8 : 6)
        const g = ctx.createRadialGradient(node.x, node.y, rBoost * 0.4, node.x, node.y, haloR)
        g.addColorStop(0, hexAlpha(color, isSel ? 0.5 : isMatch ? 0.35 : 0.28))
        g.addColorStop(1, hexAlpha(color, 0))
        ctx.beginPath(); ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2)
        ctx.fillStyle = g; ctx.fill()
      }

      ctx.beginPath(); ctx.arc(node.x, node.y, rBoost, 0, Math.PI * 2)
      if (isSel) {
        ctx.fillStyle = '#ffffff'; ctx.fill()
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke()
      } else {
        ctx.fillStyle = color; ctx.fill()
        // Subtle white inner highlight for depth
        const shine = ctx.createRadialGradient(
          node.x - rBoost * 0.25, node.y - rBoost * 0.25, rBoost * 0.05,
          node.x, node.y, rBoost
        )
        shine.addColorStop(0, 'rgba(255,255,255,0.28)')
        shine.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = shine; ctx.fill()
      }

      // Show label: hover/selected, group focus members, or search matches
      const showLabel = isSel || isHov || isMatch || (inGroup && focusedG !== null)
      if (showLabel) {
        const raw   = (node.label || node.name || '').replace(/\.[^.]+$/, '')
        const label = raw.length > 22 ? raw.slice(0, 19) + '\u2026' : raw
        const fs    = Math.max(10, Math.min(13, 12 / Math.max(k * 0.6, 0.4)))
        ctx.font = `500 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const labelY = node.y + rBoost + 5 / Math.max(k, 0.5)
        const tw     = ctx.measureText(label).width
        const pad    = 4
        // White frosted backdrop
        ctx.fillStyle = 'rgba(255,255,255,0.92)'
        ctx.shadowColor = 'rgba(99,102,241,0.12)'
        ctx.shadowBlur  = 4
        ctx.beginPath()
        ctx.roundRect(node.x - tw / 2 - pad, labelY - 1, tw + pad * 2, fs + 4, 4)
        ctx.fill()
        ctx.shadowBlur = 0
        // Dark ink text
        ctx.fillStyle = '#1E1B4B'
        ctx.fillText(label, node.x, labelY)
      }

      ctx.restore()
    })

    ctx.restore()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Smooth pan/zoom animation ─────────────────────────────────────────────
  function smoothTo(targetX: number, targetY: number, targetK: number, ms = 600) {
    cancelAnimationFrame(smoothAnimRef.current)
    const start = performance.now()
    const { x: x0, y: y0, k: k0 } = transformRef.current
    function step(now: number) {
      const t = Math.min((now - start) / ms, 1)
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

  function focusGroupAndPan(groupId: number) {
    setFocusedGroup(groupId)
    const members = simNodesRef.current.filter(n => (n.community_id ?? 0) === groupId
      && !(() => { const c = clusterMapRef.current.get(n.id); return c && !expandedClustersRef.current.has(c) })())
    if (!members.length) return
    let cx = 0, cy = 0
    members.forEach(n => { cx += n.x; cy += n.y })
    cx /= members.length; cy /= members.length
    const { w, h } = dimsRef.current
    const targetK = Math.min(transformRef.current.k * 1.15, 3.5)
    smoothTo(w / 2 - cx * targetK, h / 2 - cy * targetK, targetK, 600)
  }

  // Pause simulation in hub mode, resume in all mode
  useEffect(() => {
    if (!simRef.current) return
    if (graphViewMode === 'hub') {
      simRef.current.stop()
    } else {
      simRef.current.alpha(0.15).restart()
    }
  }, [graphViewMode])

  // ── D3 simulation ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (nodes.length === 0) {
      simNodesRef.current = []; simLinksRef.current = []
      clusterMapRef.current = new Map(); clusterMetaRef.current = []
      topoFingerprintRef.current = ''
      simRef.current?.stop(); render(); return
    }

    // Only restart simulation when topology changes (node IDs or edge connections).
    // Score-only updates (from search) produce new node array refs but same topology
    // — without this guard they restart the sim and cause the "waving" bug.
    const nodeKey = nodes.map(n => n.id).sort().join(',')
    const edgeKey = edges.map(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      return [s, t].sort().join('-')
    }).sort().join(',')
    const fingerprint = nodeKey + '|' + edgeKey
    if (fingerprint === topoFingerprintRef.current) {
      render(); return   // topology unchanged — just re-render (scores/meta changed)
    }
    topoFingerprintRef.current = fingerprint

    // Build adjacency + degree maps
    const adj  = new Map<string, Set<string>>()
    const dm   = new Map<string, number>()
    edges.forEach(e => {
      const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      if (!adj.has(s)) adj.set(s, new Set()); if (!adj.has(t)) adj.set(t, new Set())
      adj.get(s)!.add(t); adj.get(t)!.add(s)
      dm.set(s, (dm.get(s) ?? 0) + 1); dm.set(t, (dm.get(t) ?? 0) + 1)
    })
    adjRef.current = adj; degreeMapRef.current = dm

    // Compute sub-clusters and reset expansion for any new cluster IDs
    const { map: cMap, list: cList } = computeSubClusters(nodes, adj)
    clusterMapRef.current = cMap
    clusterMetaRef.current = cList
    // Remove stale expanded cluster IDs (clusters that no longer exist)
    const validIds = new Set(cList.map(c => c.id))
    setExpandedClusters(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)))
      return next.size === prev.size ? prev : next
    })

    // Cache existing positions
    const posCache = new Map<string, { x: number; y: number }>()
    simNodesRef.current.forEach(n => { if (n.x != null) posCache.set(n.id, { x: n.x, y: n.y }) })

    const cx = dimsRef.current.w / 2, cy = dimsRef.current.h / 2
    const simNodes: SimNode[] = nodes.map(n => {
      const p = posCache.get(n.id)
      const gt = groupTargetsRef.current.get(n.community_id ?? 0)
      const dx = gt ? gt.x + (Math.random() - 0.5) * 60 : cx + (Math.random() - 0.5) * 200
      const dy = gt ? gt.y + (Math.random() - 0.5) * 60 : cy + (Math.random() - 0.5) * 200
      return { ...n, x: p?.x ?? dx, y: p?.y ?? dy, vx: 0, vy: 0 } as SimNode
    })
    const simLinks: SimLink[] = edges.map(e => ({
      source: typeof e.source === 'string' ? e.source : (e.source as GraphNode).id,
      target: typeof e.target === 'string' ? e.target : (e.target as GraphNode).id,
      weight: e.weight, forced: e.forced ?? false,
    }))

    simNodesRef.current = simNodes
    simLinksRef.current = simLinks
    simRef.current?.stop()

    const sim = d3.forceSimulation<SimNode>(simNodes)
      .force('charge', d3.forceManyBody<SimNode>().strength(-160))
      .force('link',
        (d3.forceLink<SimNode, SimLink>(simLinks) as d3.ForceLink<SimNode, SimLink>)
          .id(d => d.id)
          .distance(d => {
            const sl = d as SimLink
            const s = sl.source as SimNode, t = sl.target as SimNode
            const cross = (s?.community_id ?? 0) !== (t?.community_id ?? 0)
            return cross ? 160 / Math.max(sl.weight, 0.1) : 60 / Math.max(sl.weight, 0.1)
          })
          .strength(d => {
            const sl = d as SimLink
            const s = sl.source as SimNode, t = sl.target as SimNode
            const cross = (s?.community_id ?? 0) !== (t?.community_id ?? 0)
            return cross ? Math.min(sl.weight, 1) * 0.3 : Math.min(sl.weight, 1)
          })
      )
      .force('cluster-x', d3.forceX<SimNode>(n => groupTargetsRef.current.get(n.community_id ?? 0)?.x ?? cx).strength(0.08))
      .force('cluster-y', d3.forceY<SimNode>(n => groupTargetsRef.current.get(n.community_id ?? 0)?.y ?? cy).strength(0.08))
      .force('collide', d3.forceCollide<SimNode>().radius(d => nodeRadius(d.id) + 6).strength(0.8))
      .alphaDecay(0.02).velocityDecay(0.4)
      .on('tick', render)

    simRef.current = sim
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  useEffect(() => { render() }, [searchScores, selectedNodeId, graphViewMode, render])

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = dims.w * dpr; canvas.height = dims.h * dpr
    render()
  }, [dims, render])

  // Centre on best search result (never set focusedGroup — search mode is its own visual layer)
  useEffect(() => {
    if (!searchScores || searchScores.size === 0) {
      // Search cleared — re-render so the dim overlay is removed
      render(); return
    }
    // Clear group focus so search scores aren't overridden
    setFocusedGroup(null)
    const timer = setTimeout(() => {
      let bestId = '', best = -1
      searchScores.forEach((sc, id) => { if (sc > best) { best = sc; bestId = id } })
      const top = simNodesRef.current.find(n => n.id === bestId)
      if (top?.x != null) {
        const targetK = Math.max(transformRef.current.k, 1.5)
        const { w, h } = dimsRef.current
        smoothTo(w / 2 - top.x * targetK, h / 2 - top.y * targetK, targetK, 700)
      }
    }, 400)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchScores])

  // ── Pointer handlers ──────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    dragMovedRef.current = false
    // In hub mode, only allow panning (no node dragging)
    if (graphViewModeRef.current === 'hub') {
      isPanningRef.current = true
      panStartRef.current  = { x: e.clientX, y: e.clientY, tx: transformRef.current.x, ty: transformRef.current.y }
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      setCursor('grabbing')
    } else {
      const node = findNodeAt(e.clientX, e.clientY)
      if (node) {
        dragNodeRef.current  = node
        dragStartRef.current = { x: e.clientX, y: e.clientY }
        node.fx = node.x; node.fy = node.y
        setCursor('grabbing')
      } else {
        isPanningRef.current = true
        panStartRef.current  = { x: e.clientX, y: e.clientY, tx: transformRef.current.x, ty: transformRef.current.y }
        dragStartRef.current = { x: e.clientX, y: e.clientY }
        setCursor('grabbing')
      }
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
      render(); return
    }
    // Hub mode — only check hub hit-testing
    if (graphViewModeRef.current === 'hub') {
      const hub = findHubAt(e.clientX, e.clientY)
      setCursor(hub !== null ? 'pointer' : 'default')
      if (tooltipRef.current) tooltipRef.current.style.display = 'none'
      return
    }

    // Hover — check close buttons, collapsed clusters, then nodes
    const closeBtn = findCollapseButtonAt(e.clientX, e.clientY)
    if (closeBtn) { setCursor('pointer'); return }

    const cl = findClusterAt(e.clientX, e.clientY)
    if (cl !== hoveredClusterRef.current) {
      hoveredClusterRef.current = cl
      if (cl) { hoveredNodeRef.current = null; setCursor('pointer'); render(); return }
    }
    const node = findNodeAt(e.clientX, e.clientY)
    if (node !== hoveredNodeRef.current) {
      hoveredNodeRef.current = node ?? null
      setCursor(node ? 'pointer' : (cl ? 'pointer' : 'default'))
      render()
    }

    // Update glass tooltip imperatively — no React re-render on every mouse move
    const tip = tooltipRef.current
    if (tip) {
      if (node && node.summary) {
        const summary = node.summary
        // Truncate to first 2 sentences
        const sentences = summary.split(/(?<=[.!?])\s+/)
        const short = sentences.slice(0, 2).join(' ')
        const name = tip.querySelector<HTMLElement>('.tip-name')
        const body = tip.querySelector<HTMLElement>('.tip-body')
        if (name) name.textContent = (node.label || node.name || '').replace(/\.[^.]+$/, '')
        if (body) body.textContent = short.length < summary.length ? short + '\u2026' : short
        // Position near cursor, keep within viewport
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) {
          const tx = e.clientX - rect.left + 16
          const ty = e.clientY - rect.top  - 10
          tip.style.left    = `${Math.min(tx, rect.width  - 240)}px`
          tip.style.top     = `${Math.max(0, Math.min(ty, rect.height - 80))}px`
          tip.style.display = 'block'
        }
      } else {
        tip.style.display = 'none'
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    ;(e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId)
    isPanningRef.current = false

    // Hub mode — click on a hub expands to All Files view, focused on that group
    if (graphViewModeRef.current === 'hub' && !dragMovedRef.current) {
      const hubId = findHubAt(e.clientX, e.clientY)
      dragNodeRef.current = null
      dragMovedRef.current = false
      if (hubId !== null) {
        setGraphViewMode('all')
        setFocusedGroup(hubId)
        focusedGroupRef.current = hubId
        simRef.current?.alpha(0.4).restart()
      }
      setCursor('default'); return
    }

    const node  = dragNodeRef.current
    const moved = dragMovedRef.current
    dragNodeRef.current = null

    setCursor(findNodeAt(e.clientX, e.clientY) ? 'pointer' : 'default')

    if (node) {
      node.fx = null; node.fy = null
      simRef.current?.alphaTarget(0)
      if (!moved) {
        const id = node.id
        if (lastClickRef.current === id && clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current)
          clickTimerRef.current = null; lastClickRef.current = null
          openFile(node.path); return
        }
        lastClickRef.current = id
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current = null; lastClickRef.current = null
          // Open inspector; only focus group when NOT in search mode
          onNodeClickRef.current(node)
          if (!searchScoresRef.current) setFocusedGroup(node.community_id ?? null)
          const { w, h } = dimsRef.current
          const { k }    = transformRef.current
          smoothTo(w / 2 - node.x * k, h / 2 - node.y * k, k, 500)
        }, 280)
      }
    } else if (!moved) {
      // Check close button (collapse expanded cluster) first
      const closeTarget = findCollapseButtonAt(e.clientX, e.clientY)
      if (closeTarget) {
        setExpandedClusters(prev => { const n = new Set(prev); n.delete(closeTarget); return n })
        return
      }

      // Check for collapsed cluster click → expand with burst animation
      const cl = findClusterAt(e.clientX, e.clientY)
      if (cl) {
        // Pin member nodes at cluster centroid so they burst outward naturally
        const metrics = clusterMetricsRef.current.get(cl)
        const meta    = clusterMetaRef.current.find(m => m.id === cl)
        if (metrics && meta) {
          meta.nodeIds.forEach(nodeId => {
            const sn = simNodesRef.current.find(n => n.id === nodeId)
            if (sn) {
              sn.x = metrics.cx + (Math.random() - 0.5) * 4
              sn.y = metrics.cy + (Math.random() - 0.5) * 4
              sn.vx = (Math.random() - 0.5) * 3
              sn.vy = (Math.random() - 0.5) * 3
            }
          })
          simRef.current?.alpha(0.5).restart()
        }
        setExpandedClusters(prev => { const n = new Set(prev); n.add(cl); return n })
        return
      }

      // Click on empty space → clear group focus
      setFocusedGroup(null)
      render()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render])

  const handlePointerLeave = useCallback(() => {
    isPanningRef.current   = false
    dragNodeRef.current    = null
    hoveredNodeRef.current = null
    hoveredClusterRef.current = null
    if (tooltipRef.current) tooltipRef.current.style.display = 'none'
    setCursor('default'); render()
  }, [render])

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = canvasRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const { k, x: tx, y: ty } = transformRef.current
    const factor = Math.exp(-e.deltaY * 0.001)
    const newK = Math.min(12, Math.max(0.05, k * factor))
    transformRef.current = { x: mx - (mx - tx) * (newK / k), y: my - (my - ty) * (newK / k), k: newK }
    render()
  }, [render])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const node = findNodeAt(e.clientX, e.clientY)
    if (node) setCtxMenu({ x: e.clientX, y: e.clientY, node })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleRemoveFromBina(node: GraphNode) {
    setCtxMenu(null)
    if (!activeWorkspaceId) return
    try {
      await api.deleteFile(node.path, activeWorkspaceId)
      onNodeDeletedRef.current?.()
    } catch {}
  }

  function collapseCluster(clusterId: string) {
    setExpandedClusters(prev => { const n = new Set(prev); n.delete(clusterId); return n })
  }

  // Focused group label for breadcrumb
  const focusedGroupLabel = useMemo(
    () => groupList.find(g => g.id === focusedGroup)?.label ?? null,
    [focusedGroup, groupList],
  )

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="w-full h-full relative" style={{ background: '#FAFBFF' }}>

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

      {/* Overview / All Files toggle */}
      <div className="absolute top-3 right-3 z-20 no-drag flex glass rounded-full p-1 gap-0.5 shadow-md select-none">
        <button
          onClick={() => setGraphViewMode('hub')}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-all duration-200 ${
            graphViewMode === 'hub'
              ? 'bg-bina-accent text-white shadow-sm'
              : 'text-bina-muted hover:text-bina-text'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setGraphViewMode('all')}
          className={`px-3 py-1 text-xs font-medium rounded-full transition-all duration-200 ${
            graphViewMode === 'all'
              ? 'bg-bina-accent text-white shadow-sm'
              : 'text-bina-muted hover:text-bina-text'
          }`}
        >
          All Files
        </button>
      </div>

      {/* Glass tooltip — populated imperatively, no React re-render on hover */}
      <div
        ref={tooltipRef}
        className="glass pointer-events-none"
        style={{
          display: 'none',
          position: 'absolute',
          zIndex: 30,
          maxWidth: 224,
          padding: '8px 12px',
          borderRadius: 12,
          boxShadow: '0 4px 20px rgba(99,102,241,0.1)',
        }}
      >
        <p className="tip-name text-bina-text text-xs font-semibold truncate mb-1" />
        <p className="tip-body text-bina-muted text-[11px] leading-relaxed" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} />
      </div>

      {/* Group focus breadcrumb */}
      {focusedGroupLabel && focusedGroup !== null && (
        <div className="absolute top-4 left-4 z-20 select-none animate-fade-in">
          <div className="glass rounded-xl px-3.5 py-2 shadow-lg flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: communityColor(focusedGroup) }} />
            <span className="text-bina-text text-sm font-medium">{focusedGroupLabel}</span>
            <button
              className="ml-2 text-bina-muted hover:text-bina-text text-xs transition-colors"
              onClick={() => { setFocusedGroup(null); render() }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Group legend */}
      <CommunityLegend
        groups={groupList}
        focusedGroup={focusedGroup}
        onGroupClick={id => {
          if (id === null) { setFocusedGroup(null); render() }
          else focusGroupAndPan(id)
        }}
      />

      {/* Context menu */}
      {ctxMenu && (() => {
        const nodeClusterId = clusterMapRef.current.get(ctxMenu.node.id)
        const canCollapse   = nodeClusterId != null && expandedClusters.has(nodeClusterId)
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCtxMenu(null)} />
            <div
              className="fixed z-50 glass rounded-xl shadow-xl py-1.5 min-w-[180px] overflow-hidden animate-fade-in"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <div className="px-3 py-1.5 border-b border-bina-border mb-1">
                <p className="text-bina-text text-xs font-medium truncate max-w-[160px]">
                  {ctxMenu.node.name || ctxMenu.node.label}
                </p>
                <p className="text-bina-muted text-[10px]">{ctxMenu.node.doc_type}</p>
              </div>
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-text hover:bg-bina-accent/8 transition-colors text-left"
                onClick={() => { setCtxMenu(null); openFile(ctxMenu.node.path) }}
              >
                Open file
              </button>
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-text hover:bg-bina-accent/8 transition-colors text-left"
                onClick={() => { setCtxMenu(null); showInFinder(ctxMenu.node.path) }}
              >
                Show in Finder
              </button>
              {canCollapse && (
                <>
                  <div className="h-px bg-bina-border my-1" />
                  <button
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-muted hover:bg-bina-accent/8 transition-colors text-left"
                    onClick={() => { collapseCluster(nodeClusterId!); setCtxMenu(null) }}
                  >
                    Collapse sub-group
                  </button>
                </>
              )}
              <div className="h-px bg-bina-border my-1" />
              <button
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-bina-red hover:bg-red-500/10 transition-colors text-left"
                onClick={() => handleRemoveFromBina(ctxMenu.node)}
              >
                Remove from Bina
              </button>
            </div>
          </>
        )
      })()}
    </div>
  )
}
