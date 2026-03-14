export interface GraphNode {
  id: string
  label: string
  summary: string
  keywords: string[]
  entities: Record<string, string[]>
  doc_type: string
  status: 'ok' | 'failed'
  score: number
  from_graph: boolean
  // Injected by react-force-graph at runtime
  x?: number
  y?: number
  vx?: number
  vy?: number
}

export interface GraphEdge {
  source: string | GraphNode
  target: string | GraphNode
  weight: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface SearchResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  query: string
  ms: number
}

export interface StatusData {
  indexed: number
  failed: number
  vectors: number
  watched_folder: string | null
  graph_nodes: number
  graph_edges: number
}

export interface ProgressData {
  running: boolean
  total: number
  current: number
  current_file: string
  done: boolean
  ok: number
  failed: number
}

export type AppScreen = 'onboarding' | 'main'
