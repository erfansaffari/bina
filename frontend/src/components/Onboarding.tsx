import { useState, useRef } from 'react'
import { Lock, Zap, Brain, Folder, ChevronRight, Shield, Eye, HardDrive } from 'lucide-react'
import { api, workspacesApi, openFolder } from '../api'
import { useAppStore } from '../store/appStore'

const EMOJIS = ['📁', '📚', '💼', '🔬', '🎨', '📝', '🧪', '📊', '🗂️', '🔒', '💡', '🌍', '🎯', '📐', '🏗️', '🧠', '📌', '🗃️', '🔖', '✏️']
const COLOURS = ['#4F46E5', '#0D9488', '#D97706', '#DC2626', '#7C3AED', '#DB2777']

interface Props {
  onComplete: () => void
}

type Step = 'welcome' | 'privacy' | 'model' | 'folder' | 'workspace'

export default function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [model, setModel] = useState<'fast' | 'smart'>('fast')
  const [folder, setFolder] = useState<string | null>(null)
  const [wsName, setWsName] = useState('')
  const [wsEmoji, setWsEmoji] = useState('📁')
  const [wsColour, setWsColour] = useState('#4F46E5')
  const [indexing, setIndexing] = useState(false)
  const { setActiveWorkspace, loadWorkspaces } = useAppStore()
  const nameRef = useRef<HTMLInputElement>(null)

  const steps: Step[] = ['welcome', 'privacy', 'model', 'folder', 'workspace']

  async function handlePickFolder() {
    const picked = await openFolder()
    if (picked) {
      setFolder(picked)
      // Pre-fill workspace name with folder basename
      const basename = picked.split('/').pop() || picked
      setWsName(basename)
    }
  }

  async function handleStart() {
    if (!folder || !wsName.trim()) return
    setIndexing(true)
    try {
      // Create workspace
      const ws = await workspacesApi.create(wsName.trim(), wsEmoji, wsColour)
      // Add folder — this also starts the watcher and background scan
      await workspacesApi.addFolder(ws.id, folder)
      // Persist active workspace
      setActiveWorkspace(ws.id)
      try { localStorage.setItem('bina_active_workspace', ws.id) } catch {}
      await loadWorkspaces()
      onComplete()
    } catch {
      setIndexing(false)
    }
  }

  function goToWorkspaceStep() {
    if (!folder) return
    // Pre-fill name from folder basename
    if (!wsName) {
      const basename = folder.split('/').pop() || folder
      setWsName(basename)
    }
    setStep('workspace')
    setTimeout(() => nameRef.current?.focus(), 50)
  }

  return (
    <div className="flex h-full bg-bina-bg drag-region">
      {/* Left accent strip */}
      <div className="w-1 bg-gradient-to-b from-bina-accent via-bina-purple to-transparent flex-shrink-0" />

      <div className="flex flex-1 flex-col items-center justify-center px-12 animate-fade-in no-drag">
        {/* Step indicator */}
        <div className="flex gap-2 mb-12">
          {steps.map((s) => (
            <div
              key={s}
              className={`h-1 rounded-full transition-all duration-500 ${
                s === step ? 'w-8 bg-bina-accent' : 'w-3 bg-bina-border'
              }`}
            />
          ))}
        </div>

        {/* Welcome */}
        {step === 'welcome' && (
          <div className="flex flex-col items-center text-center max-w-md animate-slide-up">
            <div className="w-20 h-20 rounded-3xl bg-bina-accent/10 border border-bina-accent/20 flex items-center justify-center mb-8 animate-pulse-glow">
              <Eye className="w-10 h-10 text-bina-accent" />
            </div>
            <h1 className="text-5xl font-display font-semibold text-bina-text mb-3 tracking-tight">
              Bina
            </h1>
            <p className="text-bina-muted text-sm mb-2 font-mono">بینا</p>
            <p className="text-bina-text/70 text-lg mt-4 mb-10 leading-relaxed">
              Find any document by asking a question.<br />
              No folders. No tags. No searching.
            </p>
            <button onClick={() => setStep('privacy')} className="btn-primary">
              Get Started <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        )}

        {/* Privacy */}
        {step === 'privacy' && (
          <div className="flex flex-col items-center text-center max-w-md animate-slide-up">
            <div className="w-16 h-16 rounded-2xl bg-bina-green/10 border border-bina-green/20 flex items-center justify-center mb-8">
              <Lock className="w-8 h-8 text-bina-green" />
            </div>
            <h2 className="text-3xl font-display font-semibold text-bina-text mb-4">
              Your files stay yours
            </h2>
            <p className="text-bina-muted mb-8 leading-relaxed">
              Everything runs on your Mac. Nothing is sent anywhere.
            </p>
            <div className="w-full space-y-3 mb-10 text-left">
              {[
                { icon: HardDrive, text: 'AI models run locally on your device', color: 'text-bina-accent' },
                { icon: Shield, text: 'No internet required after setup', color: 'text-bina-green' },
                { icon: Lock, text: 'Your documents never leave your Mac', color: 'text-bina-purple' },
              ].map(({ icon: Icon, text, color }) => (
                <div key={text} className="flex items-center gap-3 bg-bina-surface border border-bina-border rounded-xl p-4">
                  <Icon className={`w-5 h-5 flex-shrink-0 ${color}`} />
                  <span className="text-bina-text/80 text-sm">{text}</span>
                </div>
              ))}
            </div>
            <button onClick={() => setStep('model')} className="btn-primary">
              Continue <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        )}

        {/* Model selection */}
        {step === 'model' && (
          <div className="flex flex-col items-center text-center max-w-lg animate-slide-up">
            <h2 className="text-3xl font-display font-semibold text-bina-text mb-2">
              Choose your mode
            </h2>
            <p className="text-bina-muted mb-8 text-sm">
              Both modes understand your files. Smart is better for dense technical documents.
            </p>
            <div className="flex gap-4 w-full mb-10">
              {[
                {
                  id: 'fast' as const,
                  icon: Zap,
                  label: 'Fast',
                  badge: 'Recommended',
                  model: 'llama3.2:3b',
                  ram: '4 GB RAM',
                  speed: '5–10s per file',
                  color: 'text-bina-accent',
                  glow: 'border-bina-accent',
                },
                {
                  id: 'smart' as const,
                  icon: Brain,
                  label: 'Smart',
                  badge: null,
                  model: 'llama3.1:8b',
                  ram: '8 GB RAM',
                  speed: '10–20s per file',
                  color: 'text-bina-purple',
                  glow: 'border-bina-purple',
                },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setModel(opt.id)}
                  className={`flex-1 p-5 rounded-2xl border text-left transition-all duration-200 ${
                    model === opt.id
                      ? `bg-bina-surface ${opt.glow} shadow-lg`
                      : 'bg-bina-surface/50 border-bina-border hover:border-bina-muted'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <opt.icon className={`w-6 h-6 ${opt.color}`} />
                    {opt.badge && (
                      <span className="text-xs bg-bina-accent/20 text-bina-accent px-2 py-0.5 rounded-full">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  <div className="font-semibold text-bina-text mb-1">{opt.label}</div>
                  <div className="text-xs text-bina-muted font-mono mb-3">{opt.model}</div>
                  <div className="space-y-1">
                    <div className="text-xs text-bina-muted">{opt.ram}</div>
                    <div className="text-xs text-bina-muted">{opt.speed}</div>
                  </div>
                  {model === opt.id && (
                    <div className={`mt-3 h-0.5 rounded-full bg-gradient-to-r ${
                      opt.id === 'fast' ? 'from-bina-accent to-transparent' : 'from-bina-purple to-transparent'
                    }`} />
                  )}
                </button>
              ))}
            </div>
            <button onClick={() => setStep('folder')} className="btn-primary">
              Continue <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        )}

        {/* Folder selection */}
        {step === 'folder' && (
          <div className="flex flex-col items-center text-center max-w-md animate-slide-up">
            <div className="w-16 h-16 rounded-2xl bg-bina-yellow/10 border border-bina-yellow/20 flex items-center justify-center mb-8">
              <Folder className="w-8 h-8 text-bina-yellow" />
            </div>
            <h2 className="text-3xl font-display font-semibold text-bina-text mb-2">
              Choose a folder
            </h2>
            <p className="text-bina-muted mb-8 text-sm leading-relaxed">
              Bina will watch this folder and understand everything inside it.<br />
              Your files are never moved or renamed.
            </p>

            <button
              onClick={handlePickFolder}
              className="w-full p-5 rounded-2xl border-2 border-dashed border-bina-border hover:border-bina-accent/50 hover:bg-bina-accent/5 transition-all duration-200 mb-4 text-center group"
            >
              {folder ? (
                <div>
                  <p className="text-bina-accent font-mono text-sm truncate">{folder}</p>
                  <p className="text-bina-muted text-xs mt-1">Click to change</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Folder className="w-8 h-8 text-bina-muted group-hover:text-bina-accent transition-colors" />
                  <p className="text-bina-muted text-sm">Click to select folder</p>
                </div>
              )}
            </button>

            <button
              onClick={goToWorkspaceStep}
              disabled={!folder}
              className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span className="flex items-center justify-center gap-2">
                Continue <ChevronRight className="w-4 h-4" />
              </span>
            </button>
          </div>
        )}

        {/* Workspace naming */}
        {step === 'workspace' && (
          <div className="flex flex-col items-center text-center max-w-md animate-slide-up">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6 text-3xl"
              style={{ backgroundColor: `${wsColour}20`, border: `1px solid ${wsColour}40` }}
            >
              {wsEmoji}
            </div>
            <h2 className="text-3xl font-display font-semibold text-bina-text mb-2">
              Name your workspace
            </h2>
            <p className="text-bina-muted mb-8 text-sm leading-relaxed">
              Workspaces keep your files organised. You can create as many as you need.
            </p>

            {/* Emoji picker */}
            <div className="w-full mb-4">
              <p className="text-bina-muted text-xs font-medium mb-2 text-left">Icon</p>
              <div className="grid grid-cols-10 gap-1">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setWsEmoji(e)}
                    className={`h-8 w-full rounded-lg flex items-center justify-center text-base transition-all ${
                      wsEmoji === e
                        ? 'bg-bina-accent/20 ring-1 ring-bina-accent scale-110'
                        : 'hover:bg-bina-border/50'
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            {/* Name input */}
            <div className="w-full mb-4">
              <p className="text-bina-muted text-xs font-medium mb-2 text-left">Name</p>
              <input
                ref={nameRef}
                type="text"
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleStart()}
                placeholder="Workspace name"
                className="w-full bg-bina-bg border border-bina-border rounded-xl px-3 py-2.5 text-bina-text text-sm placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
                maxLength={40}
              />
            </div>

            {/* Colour picker */}
            <div className="w-full mb-6">
              <p className="text-bina-muted text-xs font-medium mb-2 text-left">Colour</p>
              <div className="flex gap-2">
                {COLOURS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setWsColour(c)}
                    className={`w-8 h-8 rounded-full transition-all ${
                      wsColour === c ? 'scale-125 ring-2 ring-offset-2 ring-offset-bina-bg ring-white/40' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <button
              onClick={handleStart}
              disabled={!wsName.trim() || indexing}
              className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {indexing ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Setting up…
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Start using Bina <ChevronRight className="w-4 h-4" />
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
