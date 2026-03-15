import { useState, useEffect, useRef } from 'react'
import { X, Trash2, ChevronDown } from 'lucide-react'
import { workspacesApi, confirmDialog } from '../api'
import { useAppStore } from '../store/appStore'
import type { Workspace } from '../types'

const EMOJIS = ['📁', '📚', '💼', '🔬', '🎨', '📝', '🧪', '📊', '🗂️', '🔒', '💡', '🌍', '🎯', '📐', '🏗️', '🧠', '📌', '🗃️', '🔖', '✏️']

const COLOURS = [
  '#4F46E5',
  '#0D9488',
  '#D97706',
  '#DC2626',
  '#7C3AED',
  '#DB2777',
]

interface Props {
  open: boolean
  editWorkspace?: Workspace | null
  onClose: () => void
  onCreated?: (ws: Workspace) => void
}

export default function WorkspaceModal({ open, editWorkspace, onClose, onCreated }: Props) {
  const { loadWorkspaces, setActiveWorkspace, workspaces } = useAppStore()

  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('📁')
  const [colour, setColour] = useState('#4F46E5')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  // AI Settings state (edit mode only)
  const [aiOpen, setAiOpen] = useState(false)
  const [processingPath, setProcessingPath] = useState<'hosted' | 'local' | 'user_api'>('hosted')
  const [originalPath, setOriginalPath] = useState<'hosted' | 'local' | 'user_api'>('hosted')
  const [modelName, setModelName] = useState('')
  const [userApiKey, setUserApiKey] = useState('')
  const [userApiBase, setUserApiBase] = useState('')
  const [vectorBackend, setVectorBackend] = useState<'moorcheh' | 'chromadb'>('moorcheh')
  const [savingModel, setSavingModel] = useState(false)
  const [modelSavedOk, setModelSavedOk] = useState(false)

  const isEditing = Boolean(editWorkspace)

  useEffect(() => {
    if (open) {
      if (editWorkspace) {
        setName(editWorkspace.name)
        setEmoji(editWorkspace.emoji || '📁')
        setColour(editWorkspace.colour || '#4F46E5')
      } else {
        setName('')
        setEmoji('📁')
        setColour('#4F46E5')
      }
      setAiOpen(false)
      setModelSavedOk(false)
      // Autofocus name input
      setTimeout(() => nameRef.current?.focus(), 50)
    }
  }, [open, editWorkspace])

  // Fetch AI config when opening in edit mode
  useEffect(() => {
    if (!open || !isEditing || !editWorkspace?.id) return
    workspacesApi.getModel(editWorkspace.id).then(config => {
      const path = (config.processing_path as 'hosted' | 'local' | 'user_api') || 'hosted'
      setProcessingPath(path)
      setOriginalPath(path)
      setModelName(config.model_name || '')
      setUserApiKey(config.has_user_api_key ? '••••••••' : '')
      setUserApiBase('')
      setVectorBackend((config.vector_backend as 'moorcheh' | 'chromadb') || 'moorcheh')
    }).catch(() => {})
  }, [open, isEditing, editWorkspace?.id])

  async function handleSubmit() {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (isEditing && editWorkspace) {
        await workspacesApi.update(editWorkspace.id, { name: name.trim(), emoji, colour })
        await loadWorkspaces()
        onClose()
      } else {
        const ws = await workspacesApi.create(
          name.trim(), emoji, colour,
          processingPath,
          modelName || undefined,
          userApiKey && !userApiKey.includes('•') ? userApiKey : undefined,
          userApiBase || undefined,
          vectorBackend,
        )
        await loadWorkspaces()
        setActiveWorkspace(ws.id)
        onCreated?.(ws)
        onClose()
      }
    } catch (err) {
      console.error('Failed to save workspace', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!editWorkspace) return
    const confirmed = await confirmDialog(
      `Delete "${editWorkspace.name}"?`,
      'All files in this workspace will be removed from Bina. Files on disk are not affected.'
    )
    if (!confirmed) return

    setDeleting(true)
    try {
      await workspacesApi.delete(editWorkspace.id)
      await loadWorkspaces()
      // Switch to another workspace if available
      const remaining = workspaces.filter(w => w.id !== editWorkspace.id)
      if (remaining.length > 0) {
        setActiveWorkspace(remaining[0].id)
      } else {
        setActiveWorkspace('')
      }
      onClose()
    } catch (err) {
      console.error('Failed to delete workspace', err)
    } finally {
      setDeleting(false)
    }
  }

  async function saveModelConfig() {
    if (!editWorkspace?.id) return
    setSavingModel(true)
    try {
      await workspacesApi.updateModel(editWorkspace.id, {
        processing_path: processingPath,
        model_name: modelName || undefined,
        user_api_key: userApiKey && !userApiKey.includes('•') ? userApiKey : undefined,
        user_api_base: userApiBase || undefined,
        vector_backend: vectorBackend,
      })
      setOriginalPath(processingPath)
      setModelSavedOk(true)
      setTimeout(() => setModelSavedOk(false), 2000)
    } catch (err) {
      console.error('Failed to save AI settings', err)
    } finally {
      setSavingModel(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm mx-4 bg-bina-surface border border-bina-border rounded-2xl shadow-2xl animate-slide-up overflow-y-auto max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <h2 className="text-bina-text font-semibold text-base">
            {isEditing ? 'Edit workspace' : 'New workspace'}
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-bina-muted hover:text-bina-text hover:bg-bina-border/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4">
          {/* Emoji picker */}
          <div>
            <p className="text-bina-muted text-xs font-medium mb-2">Icon</p>
            <div className="grid grid-cols-10 gap-1">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={`h-8 w-8 rounded-lg flex items-center justify-center text-base transition-all ${
                    emoji === e
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
          <div>
            <p className="text-bina-muted text-xs font-medium mb-2">Name</p>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Workspace name"
              className="w-full bg-bina-bg border border-bina-border rounded-xl px-3 py-2.5 text-bina-text text-sm placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
              maxLength={40}
            />
          </div>

          {/* Colour swatches */}
          <div>
            <p className="text-bina-muted text-xs font-medium mb-2">Colour</p>
            <div className="flex gap-2">
              {COLOURS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColour(c)}
                  className={`w-8 h-8 rounded-full transition-all ${
                    colour === c ? 'scale-125 ring-2 ring-offset-2 ring-offset-bina-surface ring-white/40' : 'hover:scale-110'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          {/* Preview */}
          <div
            className="flex items-center gap-3 p-3 rounded-xl"
            style={{ backgroundColor: `${colour}15`, border: `1px solid ${colour}33` }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
              style={{ backgroundColor: `${colour}25` }}
            >
              {emoji}
            </div>
            <div>
              <p className="text-bina-text text-sm font-medium">{name || 'Workspace name'}</p>
              <p className="text-bina-muted text-xs">0 files</p>
            </div>
          </div>

          {/* AI Settings */}
          <div className="border border-bina-border rounded-xl overflow-hidden">
            {isEditing ? (
              <button
                onClick={() => setAiOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-bina-text hover:bg-bina-border/20 transition-colors"
              >
                AI Settings
                <ChevronDown className={`w-4 h-4 text-bina-muted transition-transform duration-200 ${aiOpen ? 'rotate-180' : ''}`} />
              </button>
            ) : (
              <div className="px-4 py-3 text-sm font-medium text-bina-text border-b border-bina-border/50">
                AI Settings
              </div>
            )}

            {(!isEditing || aiOpen) && (
              <div className="px-4 pb-4 space-y-4">
                {/* Processing path */}
                <div className="pt-3">
                  <p className="text-bina-muted text-xs font-medium mb-2">Processing path</p>
                  <div className="space-y-2.5">
                    {([
                      ['hosted', 'Hosted AI (recommended)', 'Uses the free hosted server. Fast. Requires internet.'],
                      ['local', 'Local AI (private)', 'All AI runs on your Mac. Slower. Nothing leaves your device.'],
                      ['user_api', 'Your API Key', ''],
                    ] as const).map(([value, label, desc]) => (
                      <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="radio"
                          name="processing_path"
                          value={value}
                          checked={processingPath === value}
                          onChange={() => setProcessingPath(value)}
                          className="mt-0.5 accent-bina-accent"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-bina-text text-xs font-medium">{label}</p>
                          {desc && <p className="text-bina-muted text-[11px] mt-0.5">{desc}</p>}
                          {value === 'user_api' && processingPath === 'user_api' && (
                            <div className="mt-2 space-y-2">
                              <input
                                type="password"
                                value={userApiKey}
                                onChange={e => setUserApiKey(e.target.value)}
                                placeholder="Paste your OpenAI-compatible API key"
                                className="w-full bg-bina-bg border border-bina-border rounded-lg px-3 py-2 text-bina-text text-xs placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
                              />
                              <input
                                type="text"
                                value={userApiBase}
                                onChange={e => setUserApiBase(e.target.value)}
                                placeholder="Base URL (optional — leave blank for OpenAI)"
                                className="w-full bg-bina-bg border border-bina-border rounded-lg px-3 py-2 text-bina-text text-xs placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
                              />
                              <input
                                type="text"
                                value={modelName}
                                onChange={e => setModelName(e.target.value)}
                                placeholder="Model name (e.g. gpt-4o-mini)"
                                className="w-full bg-bina-bg border border-bina-border rounded-lg px-3 py-2 text-bina-text text-xs placeholder:text-bina-muted/50 focus:outline-none focus:border-bina-accent transition-colors"
                              />
                            </div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Vector store */}
                <div>
                  <p className="text-bina-muted text-xs font-medium mb-2">Vector search storage</p>
                  <div className="space-y-2">
                    {([
                      ['chromadb', 'Local (default)', 'Vectors stay on your Mac. No API key needed. Fully offline.'],
                      ['moorcheh', 'Moorcheh (optional)', 'Hosted vector search. Requires a Moorcheh API key in Settings.'],
                    ] as const).map(([value, label, desc]) => (
                      <label key={value} className="flex items-start gap-2.5 cursor-pointer">
                        <input
                          type="radio"
                          name="vector_backend"
                          value={value}
                          checked={vectorBackend === value}
                          onChange={() => setVectorBackend(value)}
                          className="mt-0.5 accent-bina-accent"
                        />
                        <div>
                          <p className="text-bina-text text-xs font-medium">{label}</p>
                          <p className="text-bina-muted text-[11px] mt-0.5">{desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Re-embed warning (edit mode only — on create there's nothing to re-embed) */}
                {isEditing && processingPath !== originalPath && (
                  <div className="flex gap-2 p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                    <span className="text-yellow-400 text-sm flex-shrink-0">⚠</span>
                    <p className="text-yellow-300 text-xs leading-relaxed">
                      Changing the AI path will re-embed all files in this workspace on next index. This may take a few minutes.
                    </p>
                  </div>
                )}

                {/* Save AI Settings sub-button (edit mode only) */}
                {isEditing && (
                  <button
                    onClick={saveModelConfig}
                    disabled={savingModel}
                    className="w-full px-4 py-2 rounded-xl bg-bina-accent text-white text-xs font-medium hover:bg-bina-accent/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {modelSavedOk ? 'Saved!' : savingModel ? 'Saving…' : 'Save AI Settings'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className={`flex gap-2 ${isEditing ? 'justify-between' : 'justify-end'}`}>
            {isEditing && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-red-400 hover:text-red-300 hover:bg-red-500/10 text-xs font-medium transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {deleting ? 'Deleting…' : 'Delete workspace'}
              </button>
            )}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-bina-muted hover:text-bina-text hover:bg-bina-border/50 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!name.trim() || saving}
                className="px-4 py-2 rounded-xl bg-bina-accent hover:bg-bina-accent/80 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create workspace'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
