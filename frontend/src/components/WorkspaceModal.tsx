import { useState, useEffect, useRef } from 'react'
import { X, Trash2 } from 'lucide-react'
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
      // Autofocus name input
      setTimeout(() => nameRef.current?.focus(), 50)
    }
  }, [open, editWorkspace])

  async function handleSubmit() {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (isEditing && editWorkspace) {
        await workspacesApi.update(editWorkspace.id, { name: name.trim(), emoji, colour })
        await loadWorkspaces()
        onClose()
      } else {
        const ws = await workspacesApi.create(name.trim(), emoji, colour)
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
      <div className="relative z-10 w-full max-w-sm mx-4 bg-bina-surface border border-bina-border rounded-2xl shadow-2xl animate-slide-up">
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
