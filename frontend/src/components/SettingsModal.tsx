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

interface Settings {
  llm_model: string
  similarity_threshold: number
  max_graph_neighbours: number
}

type PullState = { status: string; percent: number; error: string | null }

const MODEL_ICONS: Record<string, React.ReactNode> = {
  'qwen3.5:2b':       <Zap className="w-4 h-4 text-bina-accent" />,
  'nomic-embed-text': <Cpu className="w-4 h-4 text-bina-green" />,
}

export default function SettingsModal({ open, onClose, onIndexCleared }: Props) {
  const { loadWorkspaces } = useAppStore()

  // Graph settings
  const [settings, setSettings] = useState<Settings>({
    llm_model: 'qwen3.5:2b',
    similarity_threshold: 0.72,
    max_graph_neighbours: 5,
  })
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [clearing, setClearing] = useState(false)
  const [saved, setSaved]       = useState(false)

  // Ollama models
  const [models, setModels]     = useState<ModelStatus[]>([])
  const [pulling, setPulling]   = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, PullState>>({})

  // Moorcheh
  const [moorchehKey, setMoorchehKey]           = useState('')
  const [moorchehKeySet, setMoorchehKeySet]     = useState(false)
  const [moorchehConnected, setMoorchehConnected] = useState(false)
  const [testingMoorcheh, setTestingMoorcheh]   = useState(false)
  const [savingMoorcheh, setSavingMoorcheh]     = useState(false)
  const [moorchehSavedOk, setMoorchehSavedOk]  = useState(false)

  const checkModels = useCallback(async () => {
    try {
      const res = await modelsApi.status()
      setModels(res.models)
    } catch {}
  }, [])

  const checkMoorcheh = useCallback(async () => {
    try {
      const res = await appSettingsApi.get()
      setMoorchehKeySet(res.moorcheh_api_key_set)
      setMoorchehConnected(res.moorcheh_connected)
      if (res.moorcheh_api_key_set) setMoorchehKey('••••••••')
      else setMoorchehKey('')
    } catch {}
  }, [])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSaved(false)
    setMoorchehSavedOk(false)
    Promise.all([
      settingsApi.get().then(s => setSettings(s)).catch(() => {}),
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

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await settingsApi.update(settings)
      setSettings(updated)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {}
    setSaving(false)
  }

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

  async function handleSaveMoorcheh() {
    if (!moorchehKey || moorchehKey.includes('•')) return
    setSavingMoorcheh(true)
    try {
      await appSettingsApi.save({ moorcheh_api_key: moorchehKey })
      setMoorchehKeySet(true)
      setMoorchehKey('••••••••')
      setMoorchehSavedOk(true)
      setTimeout(() => setMoorchehSavedOk(false), 2000)
      // Re-check connection status after saving
      setTimeout(checkMoorcheh, 500)
    } catch {}
    setSavingMoorcheh(false)
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
                {/* ── Moorcheh API Key ───────────────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-bina-muted uppercase tracking-wider">
                      Moorcheh (Optional)
                    </p>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${moorchehConnected ? 'bg-green-500' : 'bg-bina-muted/40'}`} />
                      <span className="text-xs text-bina-muted">
                        {moorchehConnected ? 'Connected' : moorchehKeySet ? 'Key set' : 'Not configured'}
                      </span>
                    </div>
                  </div>
                  <p className="text-bina-muted/70 text-[11px] mb-3 leading-relaxed">
                    Moorcheh is a hosted vector search service. <strong className="text-bina-muted">Optional</strong> — Bina works fully offline without it using local ChromaDB.
                    Only needed if you explicitly set a workspace to use Moorcheh storage.
                  </p>
                  <input
                    type="password"
                    value={moorchehKey}
                    onChange={e => setMoorchehKey(e.target.value)}
                    placeholder="Paste your Moorcheh API key"
                    className="w-full bg-bina-bg border border-bina-border rounded-xl px-3 py-2.5 text-bina-text text-sm placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
                  />
                  <div className="flex gap-2 mt-2.5">
                    <button
                      onClick={handleTestMoorcheh}
                      disabled={testingMoorcheh}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium border border-bina-border text-bina-muted hover:text-bina-text hover:border-bina-accent/40 transition-colors disabled:opacity-50"
                    >
                      {testingMoorcheh ? 'Testing…' : 'Test connection'}
                    </button>
                    <button
                      onClick={handleSaveMoorcheh}
                      disabled={savingMoorcheh || !moorchehKey || moorchehKey.includes('•')}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-bina-accent text-white hover:bg-bina-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {moorchehSavedOk ? '✓ Saved' : savingMoorcheh ? 'Saving…' : 'Save key'}
                    </button>
                  </div>
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

                {/* ── Similarity threshold ───────────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-bina-muted uppercase tracking-wider">
                      Similarity Threshold
                    </p>
                    <span className="text-bina-accent font-mono text-sm font-medium">
                      {settings.similarity_threshold.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range" min={0.50} max={0.95} step={0.01}
                    value={settings.similarity_threshold}
                    onChange={e => setSettings(s => ({ ...s, similarity_threshold: parseFloat(e.target.value) }))}
                    className="w-full accent-bina-accent"
                  />
                  <div className="flex justify-between text-bina-muted/50 text-[10px] mt-1">
                    <span>0.50 — more connections</span>
                    <span>0.95 — fewer, stronger</span>
                  </div>
                </section>

                {/* ── Max neighbours ─────────────────────────────── */}
                <section>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-medium text-bina-muted uppercase tracking-wider">
                      Max Graph Connections per File
                    </p>
                    <span className="text-bina-accent font-mono text-sm font-medium">
                      {settings.max_graph_neighbours}
                    </span>
                  </div>
                  <input
                    type="range" min={1} max={10} step={1}
                    value={settings.max_graph_neighbours}
                    onChange={e => setSettings(s => ({ ...s, max_graph_neighbours: parseInt(e.target.value) }))}
                    className="w-full accent-bina-accent"
                  />
                  <div className="flex justify-between text-bina-muted/50 text-[10px] mt-1">
                    <span>1 — sparse</span><span>10 — rich</span>
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
              <div className="flex items-center gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm text-bina-muted hover:text-bina-text transition-colors rounded-lg hover:bg-bina-border/40">
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="btn-primary text-sm px-6 py-2 disabled:opacity-50"
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving…
                    </span>
                  ) : saved ? '✓ Saved' : 'Save Settings'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
