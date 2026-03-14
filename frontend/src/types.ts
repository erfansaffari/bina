export interface GraphNode {
  id: string        // file MD5 hash
  name: string      // filename without path
  path: string      // full absolute path
  label: string     // same as name (kept for compat)
  summary: string
  keywords: string[]
  entities: Record<string, string[]>
  doc_type: string
  status: 'done' | 'failed' | 'pending' | 'ok'
  score: number
  relevance_score: number
  from_graph: boolean
  community_id: number  // Louvain partition ID → maps to COMMUNITY_PALETTE
  // Injected by D3 simulation at runtime
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

export interface GraphEdge {
  source: string | GraphNode
  target: string | GraphNode
  weight: number
  forced?: boolean  // true = artificial edge for isolated node (rendered dotted)
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
  watched_folders: string[]
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

export interface Workspace {
  id: string
  name: string
  emoji: string
  colour: string
  file_count: number
  folder_count: number
  created_at: string
  last_opened: string
}

export interface WorkspaceFolder {
  folder_path: string
  file_count: number
  added_at: string | null
}

export type AppScreen = 'onboarding' | 'main'
