/**
 * Obsidian-style force-directed knowledge graph — D3 v7 simulation + Canvas.
 *
 * Physics: forceManyBody(-120), forceLink(80/w, w), forceCenter(0.05),
 *          forceCollide(r+4), alphaDecay 0.02, velocityDecay 0.4
 *
 * Pan/zoom is implemented MANUALLY (no d3-zoom) to eliminate conflicts with
 * React's synthetic mouse events which caused single-click to fail.
 */
import {
  useRef, useCallback, useEffect, useState, useMemo,
} from 'react'
import * as d3 from 'd3'
import type { GraphNode, GraphEdge } from '../types'
import { openFile, showInFinder, api } from '../api'
import { useAppStore } from '../store/appStore'

// ── 8-color community palette ─────────────────────────────────────────────────
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
  onNodeDeleted?: () => void   // called after a node is removed so parent reloads graph
}

// ── Community legend ──────────────────────────────────────────────────────────
function CommunityLegend({ communities }: { communities: Map<number, string[]> }) {
  const [collapsed, setCollapsed] = useState(false)
  if (communities.size === 0) return null
  return (
    <div className="absolute bottom-4 left-4 z-20 select-none">
      <div className="bg-black/70 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-2xl">
        <button
          className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white/60 hover:text-white/90 transition-colors"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="font-semibold tracking-wide uppercase text-[10px]">Communities</span>
          <svg className={`ml-auto w-3 h-3 transition-transform ${collapsed ? '' : 'rotate-180'}`} viewBox="0 0 12 12" fill="none">
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        {!collapsed && (
          <div className="px-3 pb-3 grid grid-cols-1 gap-1 max-h-52 overflow-y-auto">
            {Array.from(communities.entries()).map(([id, names]) => (
              <div key={id} className="flex items-center gap-2">
                <div
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: communityColor(id), boxShadow: `0 0 4px ${communityColor(id)}` }}
                />
                <span className="text-[11px] text-white/70 whitespace-nowrap">
                  {names.slice(0, 2).join(', ')}{names.length > 2 ? ` +${names.length - 2}` : ''}
                </span>
              </div>
            ))}
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

  // Transform: x/y pan offset in CSS px, k = zoom scale
  const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 })

  const simNodesRef = useRef<SimNode[]>([])
  const simLinksRef = useRef<SimLink[]>([])

  const activeWorkspaceId = useAppStore(s => s.activeWorkspaceId)

  // ── UI state ────────────────────────────────────────────────────────────────
  const [ctxMenu,       setCtxMenu]       = useState<{ x: number; y: number; node: GraphNode } | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  const [localDepth,    setLocalDepth]    = useState<1 | 2 | 3>(1)
  const [dims,          setDims]          = useState({ w: 800, h: 600 })
  const [cursor,        setCursor]        = useState<'default' | 'pointer' | 'grab' | 'grabbing'>('default')

  // Refs kept in sync with state/props (avoid stale closures in callbacks with [] deps)
  const focusedNodeIdRef  = useRef<string | null>(null)
  const localDepthRef     = useRef<1 | 2 | 3>(1)
  const hoveredNodeRef    = useRef<SimNode | null>(null)
  const onNodeClickRef    = useRef(onNodeClick)
  const onNodeDeletedRef  = useRef(onNodeDeleted)
  const dimsRef           = useRef(dims)
  const selectedNodeIdRef = useRef(selectedNodeId)
  const searchScoresRef   = useRef(searchScores)

  useEffect(() => { focusedNodeIdRef.current  = focusedNodeId }, [focusedNodeId])
  useEffect(() => { localDepthRef.current     = localDepth    }, [localDepth])
  useEffect(() => { onNodeClickRef.current    = onNodeClick   }, [onNodeClick])
  useEffect(() => { onNodeDeletedRef.current  = onNodeDeleted }, [onNodeDeleted])
  useEffect(() => { dimsRef.current           = dims          }, [dims])
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId }, [selectedNodeId])
  useEffect(() => { searchScoresRef.current   = searchScores  }, [searchScores])

  // ── Pointer / interaction state (all refs — don't need re-renders) ──────────
  const dragNodeRef    = useRef<SimNode | null>(null)
  const dragStartRef   = useRef<{ x: number; y: number } | null>(null)
  const dragMovedRef   = useRef(false)
  const isPanningRef   = useRef(false)
  const panStartRef    = useRef({ x: 0, y: 0, tx: 0, ty: 0 })

  // Double-click detection
  const clickTimerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastClickNodeIdRef = useRef<string | null>(null)

  // Animation frame for smooth centering
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

  // ── Community legend data ─────────────────────────────────────────────────
  const communities = useMemo(() => {
    const m = new Map<number, string[]>()
    nodes.forEach(n => {
      const cid = n.community_id ?? 0
      if (!m.has(cid)) m.set(cid, [])
      m.get(cid)!.push(n.name || n.label || n.id)
    })
    return m
  }, [nodes])

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

  // ── Quadtree hit-test (CSS pixel → world → nearest node) ─────────────────
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
    return qt.find(wx, wy, (nodeRadius('') + 8) / k) ?? null
  }

  // ── Canvas render ─────────────────────────────────────────────────────────
  // All dynamic values are read from refs — never needs to be recreated.
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx   = canvas.getContext('2d')
    if (!ctx) return

    const { k, x: tx, y: ty } = transformRef.current
    const simNodes   = simNodesRef.current
    const simLinks   = simLinksRef.current
    const focused    = focusedNodeIdRef.current
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

    const visibleIds = focused ? getNeighbourhood(focused, depth) : null

    // ── Links ───────────────────────────────────────────────────────────────
    simLinks.forEach(link => {
      const s = link.source as SimNode
      const t = link.target as SimNode
      if (s.x == null || t.x == null) return

      const weight = link.weight ?? 0.5
      let alpha    = 0.15 + weight * 0.4

      if (visibleIds) {
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
      ctx.lineWidth   = weight * 2.5
      if (link.forced) ctx.setLineDash([4, 5])
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(t.x, t.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()
    })

    // ── Nodes ───────────────────────────────────────────────────────────────
    simNodes.forEach(node => {
      const r          = nodeRadius(node.id)
      const color      = communityColor(node.community_id ?? 0)
      const isSelected = node.id === selId
      const isHovered  = node === hovered
      const deg        = degreeMapRef.current.get(node.id) ?? 0
      const score      = scores?.get(node.id) ?? 0
      const isMatch    = scores !== null && score > 0

      let alpha = 1
      if (visibleIds) {
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

      // Label: hover, selected, or degree > 3
      if (isSelected || isHovered || deg > 3) {
        const raw   = (node.label || node.name || '').replace(/\.[^.]+$/, '')
        const label = raw.length > 28 ? raw.slice(0, 25) + '…' : raw
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

  // ── Smooth transform animation (replaces d3 zoom transitions) ────────────
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

  // ── D3 simulation setup ────────────────────────────────────────────────────
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
      return { ...n, x: p?.x ?? cx + (Math.random() - 0.5) * 200,
                     y: p?.y ?? cy + (Math.random() - 0.5) * 200, vx: 0, vy: 0 } as SimNode
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
      .force('charge', d3.forceManyBody<SimNode>().strength(-120))
      .force('link',
        (d3.forceLink<SimNode, SimLink>(simLinks) as d3.ForceLink<SimNode, SimLink>)
          .id(d => d.id)
          .distance(d => 80 / Math.max((d as SimLink).weight, 0.1))
          .strength(d => Math.min((d as SimLink).weight, 1))
      )
      .force('center', (d3.forceCenter(cx, cy) as d3.ForceCenter<SimNode>).strength(0.05))
      .force('collide', d3.forceCollide<SimNode>().radius(d => nodeRadius(d.id) + 4))
      .alphaDecay(0.02)
      .velocityDecay(0.4)
      .on('tick', render)

    simRef.current = sim
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges])

  // Re-render when search / selection changes
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
        const k  = 2.5
        const { w, h } = dimsRef.current
        smoothTo(w / 2 - top.x * k, h / 2 - top.y * k, k, 700)
      }
    }, 800)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchScores])

  // ── Pointer event handlers ────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const found = findNodeAt(e.clientX, e.clientY)
    if (found) {
      dragNodeRef.current  = found
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      dragMovedRef.current = false
      found.fx = found.x
      found.fy = found.y
      setCursor('grabbing')
    } else {
      isPanningRef.current = true
      panStartRef.current  = {
        x: e.clientX, y: e.clientY,
        tx: transformRef.current.x, ty: transformRef.current.y,
      }
      setCursor('grabbing')
    }
    // Capture pointer so we get pointerup even if mouse leaves canvas
    ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragNodeRef.current) {
      // ── Node drag ─────────────────────────────────────────────────────────
      const ds = dragStartRef.current!
      const dx = e.clientX - ds.x, dy = e.clientY - ds.y
      // Only flag as "moved" after 4px threshold — prevents micro-movement
      // from swallowing what the user intended as a click
      if (!dragMovedRef.current && Math.sqrt(dx * dx + dy * dy) > 4) {
        dragMovedRef.current = true
      }
      const canvas = canvasRef.current!
      const rect   = canvas.getBoundingClientRect()
      const { k, x: tx, y: ty } = transformRef.current
      dragNodeRef.current.fx = (e.clientX - rect.left - tx) / k
      dragNodeRef.current.fy = (e.clientY - rect.top  - ty) / k
      simRef.current?.alphaTarget(0.3).restart()
      return
    }
    if (isPanningRef.current) {
      // ── Canvas pan ────────────────────────────────────────────────────────
      const { x: sx, y: sy, tx, ty } = panStartRef.current
      transformRef.current = {
        x: tx + (e.clientX - sx),
        y: ty + (e.clientY - sy),
        k: transformRef.current.k,
      }
      render()
      return
    }
    // ── Hover detection ───────────────────────────────────────────────────
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

    const node = dragNodeRef.current
    dragNodeRef.current = null

    setCursor(findNodeAt(e.clientX, e.clientY) ? 'pointer' : 'default')

    if (node) {
      node.fx = null; node.fy = null
      simRef.current?.alphaTarget(0)

      if (!dragMovedRef.current) {
        // ── Treat as click: open Inspector (single) or file (double) ─────
        const id = node.id

        if (lastClickNodeIdRef.current === id && clickTimerRef.current !== null) {
          clearTimeout(clickTimerRef.current)
          clickTimerRef.current      = null
          lastClickNodeIdRef.current = null
          openFile(node.path)
          return
        }

        lastClickNodeIdRef.current = id
        clickTimerRef.current = setTimeout(() => {
          clickTimerRef.current      = null
          lastClickNodeIdRef.current = null

          setFocusedNodeId(id)
          onNodeClickRef.current(node)   // open Inspector card

          // Smooth pan to node
          const { w, h } = dimsRef.current
          const { k }    = transformRef.current
          smoothTo(w / 2 - node.x * k, h / 2 - node.y * k, k, 600)
        }, 280)
      }
    } else if (!dragMovedRef.current) {
      // Click on empty space → clear local graph focus
      setFocusedNodeId(null)
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

  // ── Wheel zoom ─────────────────────────────────────────────────────────────
  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const canvas = canvasRef.current!
    const rect   = canvas.getBoundingClientRect()
    const mx     = e.clientX - rect.left
    const my     = e.clientY - rect.top

    const { k, x: tx, y: ty } = transformRef.current
    const factor = Math.exp(-e.deltaY * 0.001)
    const newK   = Math.min(12, Math.max(0.05, k * factor))
    // Zoom towards pointer
    transformRef.current = {
      x: mx - (mx - tx) * (newK / k),
      y: my - (my - ty) * (newK / k),
      k: newK,
    }
    render()
  }, [render])

  // ── Right-click context menu ───────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const found = findNodeAt(e.clientX, e.clientY)
    if (found) setCtxMenu({ x: e.clientX, y: e.clientY, node: found })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Delete file ───────────────────────────────────────────────────────────
  async function handleRemoveFromBina(node: GraphNode) {
    setCtxMenu(null)
    if (!activeWorkspaceId) return
    try {
      await api.deleteFile(node.path, activeWorkspaceId)
      // Clear focus/selection if this was the focused node
      if (focusedNodeIdRef.current === node.id) setFocusedNodeId(null)
      // Tell parent to reload graph immediately (don't wait for 5s poll)
      onNodeDeletedRef.current?.()
    } catch {}
  }

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

      {/* Depth slider — top-right, only while a node is focused */}
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

      {/* Community legend */}
      <CommunityLegend communities={communities} />

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
