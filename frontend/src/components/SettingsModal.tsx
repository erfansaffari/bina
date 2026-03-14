import { useState, useEffect } from 'react'
import { X, Zap, Brain, Sliders, Trash2 } from 'lucide-react'
import { settingsApi } from '../api'
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

const MODEL_OPTIONS = [
  {
    id: 'llama3.2:3b',
    label: 'Fast',
    icon: Zap,
    desc: 'llama3.2:3b — 4 GB RAM · 5–10s/file',
    color: 'text-bina-accent',
    border: 'border-bina-accent',
    bg: 'bg-bina-accent/10',
  },
  {
    id: 'llama3.1:8b',
    label: 'Smart',
    icon: Brain,
    desc: 'llama3.1:8b — 8 GB RAM · 10–20s/file',
    color: 'text-bina-purple',
    border: 'border-bina-purple',
    bg: 'bg-bina-purple/10',
  },
]

export default function SettingsModal({ open, onClose, onIndexCleared }: Props) {
  const { loadWorkspaces } = useAppStore()

  const [settings, setSettings] = useState<Settings>({
    llm_model: 'llama3.2:3b',
    similarity_threshold: 0.72,
    max_graph_neighbours: 5,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [clearing, setClearing] = useState(false)
  const [saved, setSaved]     = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSaved(false)
    settingsApi.get()
      .then(s => setSettings(s))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div
          className="pointer-events-auto w-[480px] max-h-[80vh] bg-bina-surface border border-bina-border rounded-2xl shadow-2xl flex flex-col animate-slide-up overflow-hidden"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-bina-border">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 text-bina-accent" />
              <h2 className="text-bina-text font-semibold text-base">Settings</h2>
            </div>
            <button
              onClick={onClose}
              className="text-bina-muted hover:text-bina-text transition-colors"
            >
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
                {/* Model selector */}
                <section>
                  <p className="text-xs font-medium text-bina-muted uppercase tracking-wider mb-3">
                    AI Model
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {MODEL_OPTIONS.map(opt => {
                      const Icon = opt.icon
                      const selected = settings.llm_model === opt.id
                      return (
                        <button
                          key={opt.id}
                          onClick={() => setSettings(s => ({ ...s, llm_model: opt.id }))}
                          className={`p-4 rounded-xl border text-left transition-all duration-200 ${
                            selected
                              ? `${opt.bg} ${opt.border} shadow-md`
                              : 'bg-bina-bg border-bina-border hover:border-bina-muted/50'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <Icon className={`w-4 h-4 ${opt.color}`} />
                            <span className={`font-semibold text-sm ${selected ? opt.color : 'text-bina-text'}`}>
                              {opt.label}
                            </span>
                          </div>
                          <p className="text-bina-muted text-[11px] font-mono leading-relaxed">{opt.desc}</p>
                          {selected && (
                            <div className={`mt-2.5 h-0.5 rounded-full bg-gradient-to-r ${
                              opt.id === 'llama3.2:3b'
                                ? 'from-bina-accent to-transparent'
                                : 'from-bina-purple to-transparent'
                            }`} />
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-bina-muted/60 text-[11px] mt-2 leading-relaxed">
                    Changing the model only affects newly indexed files. Re-index to update existing ones.
                  </p>
                </section>

                {/* Similarity threshold */}
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
                    type="range"
                    min={0.50}
                    max={0.95}
                    step={0.01}
                    value={settings.similarity_threshold}
                    onChange={e =>
                      setSettings(s => ({ ...s, similarity_threshold: parseFloat(e.target.value) }))
                    }
                    className="w-full accent-bina-accent"
                  />
                  <div className="flex justify-between text-bina-muted/50 text-[10px] mt-1">
                    <span>0.50 — more connections</span>
                    <span>0.95 — fewer, stronger</span>
                  </div>
                  <p className="text-bina-muted/60 text-[11px] mt-2">
                    Minimum cosine similarity required to draw a graph edge. Changes take effect on next graph load.
                  </p>
                </section>

                {/* Max graph neighbours */}
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
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={settings.max_graph_neighbours}
                    onChange={e =>
                      setSettings(s => ({ ...s, max_graph_neighbours: parseInt(e.target.value) }))
                    }
                    className="w-full accent-bina-accent"
                  />
                  <div className="flex justify-between text-bina-muted/50 text-[10px] mt-1">
                    <span>1 — sparse graph</span>
                    <span>10 — rich graph</span>
                  </div>
                </section>

                {/* Danger zone */}
                <section className="border border-red-500/20 rounded-xl p-4 bg-red-500/5">
                  <p className="text-xs font-medium text-red-400 uppercase tracking-wider mb-1">
                    Danger Zone
                  </p>
                  <p className="text-bina-muted/70 text-[11px] mb-3 leading-relaxed">
                    Permanently delete all indexed files, embeddings, and workspaces. Cannot be undone.
                  </p>
                  <button
                    onClick={handleClearIndex}
                    disabled={clearing}
                    className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 text-red-400 text-sm px-4 py-2 rounded-lg transition-all disabled:opacity-50"
                  >
                    {clearing ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                        Clearing…
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear All Index Data
                      </>
                    )}
                  </button>
                </section>
              </>
            )}
          </div>

          {/* Footer */}
          {!loading && (
            <div className="px-6 py-4 border-t border-bina-border flex items-center justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-bina-muted hover:text-bina-text transition-colors rounded-lg hover:bg-bina-border/40"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary text-sm px-6 py-2 disabled:opacity-50"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Saving…
                  </span>
                ) : saved ? (
                  '✓ Saved'
                ) : (
                  'Save Settings'
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
