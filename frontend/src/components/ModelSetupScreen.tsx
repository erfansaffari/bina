import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, Download, AlertCircle, Zap, Eye, Cpu } from 'lucide-react'
import { modelsApi } from '../api'

interface ModelInfo {
  name: string
  role: string
  size_gb: number
  installed: boolean
}

interface Props {
  onAllReady: () => void
}

const MODEL_ICONS: Record<string, React.ReactNode> = {
  'qwen3.5:2b':       <Eye className="w-5 h-5 text-bina-accent" />,
  'nomic-embed-text': <Cpu className="w-5 h-5 text-bina-green" />,
}

const MODEL_COLORS: Record<string, string> = {
  'qwen3.5:2b':       'border-bina-accent/40 bg-bina-accent/5',
  'nomic-embed-text': 'border-bina-green/40 bg-bina-green/5',
}

interface PullState {
  status: string
  percent: number
  error: string | null
}

export default function ModelSetupScreen({ onAllReady }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [pulling, setPulling] = useState<Record<string, boolean>>({})
  const [progress, setProgress] = useState<Record<string, PullState>>({})
  const [allDone, setAllDone] = useState(false)

  // Check model status on mount
  const checkStatus = useCallback(async () => {
    try {
      const res = await modelsApi.status()
      setModels(res.models)
      setLoading(false)
      if (res.all_ready) {
        setAllDone(true)
        setTimeout(onAllReady, 800)  // brief "all ready" flash before advancing
      }
    } catch {
      setLoading(false)
    }
  }, [onAllReady])

  useEffect(() => { checkStatus() }, [checkStatus])

  // Poll progress for pulling models
  useEffect(() => {
    const activePulls = Object.entries(pulling).filter(([, v]) => v).map(([k]) => k)
    if (activePulls.length === 0) return

    const interval = setInterval(async () => {
      const updates: Record<string, PullState> = {}
      let anyDone = false

      for (const modelName of activePulls) {
        try {
          const p = await modelsApi.pullProgress(modelName)
          updates[modelName] = p
          if (p.status === 'done') {
            anyDone = true
            setPulling(prev => ({ ...prev, [modelName]: false }))
          }
        } catch {}
      }

      setProgress(prev => ({ ...prev, ...updates }))

      if (anyDone) {
        // Re-check overall status
        const res = await modelsApi.status()
        setModels(res.models)
        if (res.all_ready) {
          setAllDone(true)
          setTimeout(onAllReady, 1500)
        }
      }
    }, 600)

    return () => clearInterval(interval)
  }, [pulling, onAllReady])

  async function handleInstall(modelName: string) {
    setPulling(prev => ({ ...prev, [modelName]: true }))
    setProgress(prev => ({ ...prev, [modelName]: { status: 'starting', percent: 0, error: null } }))
    try {
      await modelsApi.pull(modelName)
    } catch {
      setPulling(prev => ({ ...prev, [modelName]: false }))
      setProgress(prev => ({ ...prev, [modelName]: { status: 'error', percent: 0, error: 'Failed to start download' } }))
    }
  }

  async function handleInstallAll() {
    const missing = models.filter(m => !m.installed)
    for (const m of missing) {
      await handleInstall(m.name)
      // Small stagger so Ollama doesn't get hammered simultaneously
      await new Promise(r => setTimeout(r, 300))
    }
  }

  const missingCount = models.filter(m => !m.installed).length
  const anyPulling = Object.values(pulling).some(Boolean)

  return (
    <div className="flex flex-col items-center text-center max-w-lg animate-slide-up w-full">
      {/* Header */}
      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-8 transition-all duration-500 ${
        allDone
          ? 'bg-bina-green/10 border border-bina-green/20'
          : 'bg-bina-accent/10 border border-bina-accent/20'
      }`}>
        {allDone
          ? <CheckCircle className="w-8 h-8 text-bina-green" />
          : <Download className="w-8 h-8 text-bina-accent animate-pulse" />
        }
      </div>

      <h2 className="text-3xl font-display font-semibold text-bina-text mb-2">
        {allDone ? 'All models ready' : 'Set up AI models'}
      </h2>
      <p className="text-bina-muted mb-8 text-sm leading-relaxed">
        {allDone
          ? 'Everything is installed and ready to go.'
          : 'Bina needs three local AI models. They run entirely on your Mac — nothing is sent to the internet.'
        }
      </p>

      {/* Model cards */}
      {!loading && (
        <div className="w-full space-y-3 mb-8">
          {models.map(model => {
            const pull = progress[model.name]
            const isPulling = pulling[model.name]
            const pct = pull?.percent ?? 0
            const isError = pull?.status === 'error'

            return (
              <div
                key={model.name}
                className={`w-full p-4 rounded-xl border text-left transition-all duration-300 ${
                  model.installed
                    ? 'border-bina-green/30 bg-bina-green/5'
                    : MODEL_COLORS[model.name] ?? 'border-bina-border bg-bina-bg'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex-shrink-0">
                    {MODEL_ICONS[model.name] ?? <Cpu className="w-5 h-5 text-bina-muted" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-bina-text font-semibold text-sm font-mono">{model.name}</p>
                        <p className="text-bina-muted text-xs mt-0.5">{model.role} · {model.size_gb} GB</p>
                      </div>
                      <div className="flex-shrink-0">
                        {model.installed ? (
                          <span className="flex items-center gap-1 text-bina-green text-xs font-medium">
                            <CheckCircle className="w-3.5 h-3.5" /> Installed
                          </span>
                        ) : isError ? (
                          <span className="flex items-center gap-1 text-red-400 text-xs">
                            <AlertCircle className="w-3.5 h-3.5" /> Error
                          </span>
                        ) : isPulling ? (
                          <span className="text-bina-accent text-xs font-medium">{pct}%</span>
                        ) : (
                          <button
                            onClick={() => handleInstall(model.name)}
                            className="text-xs px-3 py-1 rounded-lg bg-bina-accent/10 hover:bg-bina-accent/20 border border-bina-accent/30 text-bina-accent transition-colors"
                          >
                            Install
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    {isPulling && (
                      <div className="mt-2">
                        <div className="h-1 bg-bina-border rounded-full overflow-hidden">
                          <div
                            className="h-full bg-bina-accent rounded-full transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-bina-muted/60 text-[10px] mt-1">
                          {pull?.status === 'starting' ? 'Connecting to Ollama…' : pull?.status ?? 'Downloading…'}
                        </p>
                      </div>
                    )}
                    {isError && (
                      <p className="text-red-400/70 text-[10px] mt-1 truncate">
                        {pull?.error ?? 'Unknown error'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-bina-accent border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Actions */}
      {!loading && !allDone && missingCount > 0 && (
        <button
          onClick={handleInstallAll}
          disabled={anyPulling}
          className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {anyPulling ? (
            <span className="flex items-center justify-center gap-2">
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Installing models…
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Download className="w-4 h-4" />
              Install {missingCount} missing model{missingCount > 1 ? 's' : ''}
            </span>
          )}
        </button>
      )}

      {!loading && !allDone && missingCount === 0 && (
        <button onClick={onAllReady} className="btn-primary w-full">
          Continue
        </button>
      )}

      <p className="text-bina-muted/50 text-[11px] mt-4 leading-relaxed">
        Requires Ollama to be running locally. Models are downloaded once and cached on your Mac.
      </p>
    </div>
  )
}
