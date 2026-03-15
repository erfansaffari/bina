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
  community_id: number         // structural group ID → maps to COMMUNITY_PALETTE
  community_label?: string     // "Lectures", "Assignments", etc.
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

export interface GroupNode {
  id: number
  label: string
  count: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

export interface GroupEdge {
  source: number | GroupNode
  target: number | GroupNode
  weight: number
}

export interface GroupGraphData {
  groups: GroupNode[]
  edges: GroupEdge[]
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
  failed_reasons?: string[]
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
  // v3 model selection
  processing_path?: 'hosted' | 'local' | 'user_api'
  model_name?: string
  vector_backend?: 'moorcheh' | 'chromadb'
}

export interface WorkspaceFolder {
  folder_path: string
  file_count: number
  added_at: string | null
}

export type AppScreen = 'onboarding' | 'main'

export interface QueryResult {
  answer: string | null
  results?: Array<{ hash: string; name: string; path: string; summary: string; score: number }>
  mode: 'agent' | 'search' | 'fallback'
  workspace_id: string
}

export interface WorkspaceModelConfig {
  processing_path: string
  model_name: string | null
  embed_model: string
  vector_backend: string
  has_user_api_key?: boolean
}

export interface AppSettingsResponse {
  moorcheh_api_key_set: boolean
  moorcheh_connected: boolean
}
