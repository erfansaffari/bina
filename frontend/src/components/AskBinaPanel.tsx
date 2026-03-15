import { useState, useRef, useEffect } from 'react'
import { Brain, FileText } from 'lucide-react'
import { api } from '../api'
import { useAppStore } from '../store/appStore'
import type { QueryResult } from '../types'

interface Props {
  workspaceId: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
  mode?: string
  sources?: Array<{ name: string; path: string; score?: number }>
}

interface BinaChatError {
  type: 'moorcheh_missing_key' | 'moorcheh_unauthorized' | 'ollama_unavailable' | 'hosted_unreachable' | 'unknown'
  message: string
  action: 'open_settings' | 'copy_command' | null
}

function classifyError(errorText: string): BinaChatError {
  const lower = errorText.toLowerCase()

  if (lower.includes('moorcheh') && (
    lower.includes('api_key') || lower.includes('not set') || lower.includes('missing')
  )) {
    return { type: 'moorcheh_missing_key', message: 'Moorcheh API key is not configured.', action: 'open_settings' }
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return { type: 'moorcheh_unauthorized', message: 'Moorcheh API key is invalid or expired.', action: 'open_settings' }
  }
  if (lower.includes('ollama') || lower.includes('connection refused') || lower.includes('11434')) {
    return { type: 'ollama_unavailable', message: 'Ollama is not running. Start it with: ollama serve', action: 'copy_command' }
  }
  if (lower.includes('huggingface') || lower.includes('hosted') || lower.includes('econnrefused')) {
    return { type: 'hosted_unreachable', message: 'The hosted AI server is unreachable. Check your internet connection.', action: null }
  }
  return { type: 'unknown', message: 'Something went wrong. Check the backend logs.', action: null }
}

function ErrorMessage({ error, onOpenSettings, onCopyCommand }: {
  error: BinaChatError
  onOpenSettings: () => void
  onCopyCommand: (cmd: string) => void
}) {
  return (
    <div className="rounded-xl px-4 py-3 bg-red-500/8 border border-red-500/20 text-bina-text text-sm leading-relaxed">
      <p className="font-medium mb-1.5">{error.message}</p>
      {error.action === 'open_settings' && (
        <button
          onClick={onOpenSettings}
          className="text-xs text-bina-accent underline bg-transparent border-none cursor-pointer p-0"
        >
          Open Settings to fix this →
        </button>
      )}
      {error.action === 'copy_command' && (
        <button
          onClick={() => onCopyCommand('ollama serve')}
          className="text-xs text-bina-accent underline bg-transparent border-none cursor-pointer p-0"
        >
          Copy command
        </button>
      )}
    </div>
  )
}

export default function AskBinaPanel({ workspaceId }: Props) {
  const { setGlobalSettingsOpen } = useAppStore()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const query = input.trim()
    if (!query || loading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: query }])
    setLoading(true)

    try {
      const result: QueryResult = await api.query(query, workspaceId, 'agent')

      const sources = result.results?.map(r => ({
        name: r.name,
        path: r.path,
        score: r.score,
      })) ?? []

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: result.answer?.trim() || 'No answer found.',
        mode: result.mode,
        sources,
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: err instanceof Error ? err.message : 'Unknown error',
        isError: true,
      }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-bina-bg">
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in">
            <div className="mb-3 text-bina-accent">
              <Brain className="w-10 h-10 mx-auto" strokeWidth={1.5} />
            </div>
            <p className="text-bina-text text-lg font-display font-semibold">Ask Bina</p>
            <p className="text-bina-muted text-sm mt-1 max-w-xs">
              Ask questions about your files. Bina will search your knowledge graph and reason over your documents.
            </p>
            <div className="flex gap-2 mt-4">
              {['What are these files about?', 'Find files related to…', 'Summarize…'].map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-xs px-3 py-1.5 rounded-full bg-bina-surface border border-bina-border text-bina-muted hover:text-bina-text hover:border-bina-accent/30 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] ${msg.isError ? '' : `rounded-2xl px-4 py-2.5 ${
              msg.role === 'user'
                ? 'bg-bina-accent/20 text-bina-text'
                : 'bg-bina-surface border border-bina-border text-bina-text'
            }`}`}>
              {msg.isError ? (
                <ErrorMessage
                  error={classifyError(msg.content)}
                  onOpenSettings={() => setGlobalSettingsOpen(true)}
                  onCopyCommand={(cmd) => navigator.clipboard.writeText(cmd)}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              )}
              {msg.sources && msg.sources.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-bina-border/50">
                  {msg.sources.map((s, j) => (
                    <span
                      key={j}
                      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-bina-accent/10 text-bina-accent cursor-pointer hover:bg-bina-accent/20 transition-colors"
                      title={s.path}
                    >
                      <FileText className="w-2.5 h-2.5 flex-shrink-0" /> {s.name}
                    </span>
                  ))}
                </div>
              )}
              {msg.mode && msg.mode !== 'agent' && (
                <span className="inline-block mt-1 text-[10px] text-bina-muted/60">
                  {msg.mode === 'fallback' ? 'direct search' : msg.mode}
                </span>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-bina-surface border border-bina-border rounded-2xl px-4 py-3 flex items-center gap-2">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-bina-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 bg-bina-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 bg-bina-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-bina-muted">Thinking…</span>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-bina-border/50">
        <form
          onSubmit={(e) => { e.preventDefault(); handleSend() }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask anything about your files…"
            className="flex-1 bg-bina-surface border border-bina-border rounded-xl px-4 py-2.5 text-sm text-bina-text placeholder-bina-muted/40 focus:outline-none focus:border-bina-accent/50 transition-colors"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 py-2.5 bg-bina-accent text-white rounded-xl text-sm font-medium hover:bg-bina-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
