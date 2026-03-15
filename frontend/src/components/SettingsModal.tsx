import { useState, useEffect, useCallback } from 'react'
import { X, Sliders, Trash2, Check, CheckCircle, Download, AlertCircle, Zap, Cpu } from 'lucide-react'
import { settingsApi, modelsApi, appSettingsApi } from '../api'
import type { ModelStatus } from '../api'
import { useAppStore } from '../store/appStore'
import { confirmDialog } from '../api'

interface Props {
  open: boolean
  onClose: () => void
  onIndexCleared: () => void
}

type PullState = { status: string; percent: number; error: string | null }

const MODEL_ICONS: Record<string, React.ReactNode> = {
  'qwen3.5:2b':       <Zap className="w-4 h-4 text-bina-accent" />,
  'nomic-embed-text': <Cpu className="w-4 h-4 text-bina-green" />,
}

export default function SettingsModal({ open, onClose, onIndexCleared }: Props) {
  const { loadWorkspaces } = useAppStore()

  const [loading, setLoading]   = useState(true)
  const [clearing, setClearing] = useState(false)

  // Ollama models
  const [models, setModels]     = useState<ModelStatus[]>([])
  const [pulling, setPulling]   = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, PullState>>({})

  // Moorcheh status only (key is set server-side via .env)
  const [moorchehConnected, setMoorchehConnected] = useState(false)
  const [testingMoorcheh, setTestingMoorcheh]     = useState(false)

  const checkModels = useCallback(async () => {
    try {
      const res = await modelsApi.status()
      setModels(res.models)
    } catch {}
  }, [])

  const checkMoorcheh = useCallback(async () => {
    try {
      const res = await appSettingsApi.get()
      setMoorchehConnected(res.moorcheh_connected)
    } catch {}
  }, [])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    Promise.all([
      checkModels(),
      checkMoorcheh(),
    ]).finally(() => setLoading(false))
  }, [open, checkModels, checkMoorcheh])

  // Poll pull progress
  useEffect(() => {
    const active = Object.entries(pulling).filter(([, v]) => v).map(([k]) => k)
    if (active.length === 0) return
    const interval = setInterval(async () => {
      for (const model of active) {
        try {
          const p = await modelsApi.pullProgress(model)
          setProgress(prev => ({ ...prev, [model]: p }))
          if (p.status === 'done') {
            setPulling(prev => ({ ...prev, [model]: false }))
            checkModels()
          }
        } catch {}
      }
    }, 600)
    return () => clearInterval(interval)
  }, [pulling, checkModels])

  if (!open) return null

  async function handleClearIndex() {
    const confirmed = await confirmDialog(
      'Clear all indexed data?',
      'This will permanently delete all file records, embeddings, and workspaces. This cannot be undone.',
    )
    if (!confirmed) return
    setClearing(true)
    try {
      await settingsApi.clearIndex()
      await loadWorkspaces()
      onIndexCleared()
      onClose()
    } catch {}
    setClearing(false)
  }

  async function handleInstall(modelName: string) {
    setPulling(prev => ({ ...prev, [modelName]: true }))
    setProgress(prev => ({ ...prev, [modelName]: { status: 'starting', percent: 0, error: null } }))
    try {
      await modelsApi.pull(modelName)
    } catch {
      setPulling(prev => ({ ...prev, [modelName]: false }))
    }
  }

  async function handleTestMoorcheh() {
    setTestingMoorcheh(true)
    await checkMoorcheh()
    setTestingMoorcheh(false)
  }

  const missingCount = models.filter(m => !m.installed).length

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />

      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-[500px] max-h-[85vh] bg-bina-surface border border-bina-border rounded-2xl shadow-2xl flex flex-col animate-slide-up overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-bina-border">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 text-bina-accent" />
              <h2 className="text-bina-text font-semibold text-base">Settings</h2>
            </div>
            <button onClick={onClose} className="text-bina-muted hover:text-bina-text transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-7">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-bina-accent border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <>
                {/* ── Moorcheh Status ────────────────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-bina-muted uppercase tracking-wider">
                      Moorcheh Vector Search
                    </p>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${moorchehConnected ? 'bg-green-500' : 'bg-bina-muted/40'}`} />
                      <span className="text-xs text-bina-muted">
                        {moorchehConnected ? 'Connected' : 'Not connected'}
                      </span>
                    </div>
                  </div>
                  <p className="text-bina-muted/70 text-[11px] mb-3 leading-relaxed">
                    Hosted vector search service configured server-side. Bina falls back to local ChromaDB automatically when unavailable.
                  </p>
                  <button
                    onClick={handleTestMoorcheh}
                    disabled={testingMoorcheh}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-bina-border text-bina-muted hover:text-bina-text hover:border-bina-accent/40 transition-colors disabled:opacity-50"
                  >
                    {testingMoorcheh ? 'Testing…' : 'Test connection'}
                  </button>
                </section>

                {/* ── Local AI Models (Ollama) ───────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-bina-muted uppercase tracking-wider">
                      Local AI Models (Ollama)
                    </p>
                    {missingCount > 0 && (
                      <span className="text-xs bg-bina-yellow/20 text-bina-yellow px-2 py-0.5 rounded-full">
                        {missingCount} not installed
                      </span>
                    )}
                    {missingCount === 0 && models.length > 0 && (
                      <span className="flex items-center gap-1 text-xs text-bina-green">
                        <CheckCircle className="w-3 h-3" /> All ready
                      </span>
                    )}
                  </div>
                  <p className="text-bina-muted/70 text-[11px] mb-3 leading-relaxed">
                    Required when workspace is set to Local AI. Models run fully on-device via Ollama.
                  </p>
                  <div className="space-y-2">
                    {models.map(m => {
                      const pull = progress[m.name]
                      const isPulling = pulling[m.name]
                      const pct = pull?.percent ?? 0
                      return (
                        <div
                          key={m.name}
                          className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                            m.installed ? 'border-bina-green/20 bg-bina-green/5' : 'border-bina-border bg-bina-bg'
                          }`}
                        >
                          {MODEL_ICONS[m.name] ?? <Cpu className="w-4 h-4 text-bina-muted" />}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-mono text-bina-text">{m.name}</p>
                            <p className="text-xs text-bina-muted">{m.role} · {m.size_gb} GB</p>
                            {isPulling && (
                              <div className="mt-1.5">
                                <div className="h-1 bg-bina-border rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-bina-accent rounded-full transition-all duration-300"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <p className="text-[10px] text-bina-muted/60 mt-0.5">
                                  {pull?.status} {pct > 0 ? `· ${pct}%` : ''}
                                </p>
                              </div>
                            )}
                          </div>
                          {m.installed ? (
                            <Check className="w-4 h-4 text-bina-green flex-shrink-0" />
                          ) : isPulling ? (
                            <div className="w-4 h-4 border-2 border-bina-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
                          ) : pull?.status === 'error' ? (
                            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                          ) : (
                            <button
                              onClick={() => handleInstall(m.name)}
                              className="flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-bina-accent/10 hover:bg-bina-accent/20 border border-bina-accent/30 text-bina-accent transition-colors"
                            >
                              <Download className="w-3 h-3" /> Install
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>

                {/* ── Danger zone ────────────────────────────────── */}
                <section className="border border-red-500/20 rounded-xl p-4 bg-red-500/5">
                  <p className="text-xs font-medium text-red-400 uppercase tracking-wider mb-1">Danger Zone</p>
                  <p className="text-bina-muted/70 text-[11px] mb-3 leading-relaxed">
                    Permanently delete all indexed files, embeddings, and workspaces.
                  </p>
                  <button
                    onClick={handleClearIndex}
                    disabled={clearing}
                    className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-400 text-sm px-4 py-2 rounded-lg transition-all disabled:opacity-50"
                  >
                    {clearing ? (
                      <><div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />Clearing…</>
                    ) : (
                      <><Trash2 className="w-3.5 h-3.5" />Clear All Index Data</>
                    )}
                  </button>
                </section>
              </>
            )}
          </div>

          {/* Footer */}
          {!loading && (
            <div className="px-6 py-4 border-t border-bina-border flex items-center justify-between gap-3">
              <span className="text-bina-muted/50 text-[10px]">Bina v3</span>
              <button onClick={onClose} className="px-4 py-2 text-sm text-bina-muted hover:text-bina-text transition-colors rounded-lg hover:bg-bina-border/40">
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
