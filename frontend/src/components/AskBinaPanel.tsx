import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowUp, FileText, AlertCircle, Settings, Copy, Check } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { useAppStore } from '../store/appStore'
import type { QueryResult } from '../types'

interface Props {
  workspaceId: string
}

interface Source {
  name: string
  path: string
  score?: number
}

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
  sources?: Source[]
}

// ── Error classifier ──────────────────────────────────────────────────────────
type ErrorAction = 'open_settings' | 'copy_command' | null
interface BinaChatError { message: string; action: ErrorAction }

function classifyError(text: string): BinaChatError {
  const t = text.toLowerCase()
  if (t.includes('moorcheh') && (t.includes('api_key') || t.includes('not set') || t.includes('missing')))
    return { message: 'Moorcheh API key is not configured.', action: 'open_settings' }
  if (t.includes('401') || t.includes('unauthorized'))
    return { message: 'Moorcheh API key is invalid or expired.', action: 'open_settings' }
  if (t.includes('ollama') || t.includes('connection refused') || t.includes('11434'))
    return { message: 'Ollama is not running.', action: 'copy_command' }
  if (t.includes('huggingface') || t.includes('hosted') || t.includes('econnrefused'))
    return { message: 'Hosted AI server is unreachable. Check your connection.', action: null }
  return { message: 'Something went wrong. Check the backend logs.', action: null }
}

// ── Suggestion chips shown on empty state ─────────────────────────────────────
const SUGGESTIONS = [
  'What are these files about?',
  'Find files related to machine learning',
  'Summarize the key topics across all documents',
  'Which files mention deadlines or dates?',
]

// ── Bina avatar (logo) ────────────────────────────────────────────────────────
function BinaAvatar() {
  return (
    <div className="w-8 h-8 rounded-xl overflow-hidden flex-shrink-0 shadow-sm border border-bina-border/40">
      <img src="/logo.png" alt="Bina" className="w-full h-full object-contain" draggable={false} />
    </div>
  )
}

// ── User avatar ───────────────────────────────────────────────────────────────
function UserAvatar() {
  return (
    <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center text-white text-xs font-bold shadow-sm"
      style={{ background: 'linear-gradient(135deg, #0a9396, #005f73)' }}>
      U
    </div>
  )
}

// ── Source chip ───────────────────────────────────────────────────────────────
function SourceChip({ source }: { source: Source }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium
                 bg-bina-accent/8 border border-bina-accent/15 text-bina-accent
                 hover:bg-bina-accent/14 hover:border-bina-accent/25 transition-colors cursor-default"
      title={source.path}
    >
      <FileText className="w-3 h-3 flex-shrink-0" />
      <span className="max-w-[140px] truncate">{source.name}</span>
      {source.score !== undefined && source.score > 0 && (
        <span className="text-bina-accent/60 ml-0.5">{Math.round(source.score * 100)}%</span>
      )}
    </div>
  )
}

// ── Thinking dots ─────────────────────────────────────────────────────────────
function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map(i => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-bina-accent/60"
          style={{
            animation: 'thinkingPulse 1.4s ease-in-out infinite',
            animationDelay: `${i * 0.16}s`,
          }}
        />
      ))}
    </div>
  )
}

// ── Single message row ────────────────────────────────────────────────────────
function MessageRow({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'

  if (isUser) {
    return (
      <div className="flex items-start gap-3 justify-end group" style={{ animation: 'msgSlideIn 0.22s ease-out' }}>
        <div className="max-w-[80%]">
          <div className="px-4 py-3 rounded-2xl rounded-tr-sm text-sm leading-relaxed text-bina-text selectable"
            style={{
              background: 'linear-gradient(135deg, rgba(10,147,150,0.10) 0%, rgba(0,95,115,0.08) 100%)',
              border: '1px solid rgba(10,147,150,0.18)',
            }}>
            <p className="whitespace-pre-wrap">{msg.content}</p>
          </div>
        </div>
        <UserAvatar />
      </div>
    )
  }

  // Assistant
  return (
    <div className="flex items-start gap-3 group" style={{ animation: 'msgSlideIn 0.22s ease-out' }}>
      <BinaAvatar />
      <div className="flex-1 min-w-0">
        {msg.isError ? (
          <ErrorBubble content={msg.content} />
        ) : (
          <>
            <div className="prose-bina text-sm leading-relaxed text-bina-text/90 selectable">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p className="mb-2 last:mb-0 whitespace-pre-wrap">{children}</p>,
                  strong: ({ children }) => <strong className="font-semibold text-bina-text">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  h1: ({ children }) => <h1 className="text-base font-bold text-bina-text mt-3 mb-1">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold text-bina-text mt-3 mb-1">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-bina-text mt-2 mb-0.5">{children}</h3>,
                  ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-2 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-2 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="text-bina-text/90">{children}</li>,
                  code: ({ children, className }) => {
                    const isBlock = className?.includes('language-')
                    return isBlock
                      ? <code className="block bg-bina-surface border border-bina-border rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto my-2 text-bina-text">{children}</code>
                      : <code className="bg-bina-surface border border-bina-border rounded px-1 py-0.5 text-xs font-mono text-bina-accent">{children}</code>
                  },
                  pre: ({ children }) => <pre className="my-2">{children}</pre>,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-bina-accent/40 pl-3 my-2 text-bina-muted italic">{children}</blockquote>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-3">
                      <table className="w-full text-xs border-collapse border border-bina-border/50 rounded-lg overflow-hidden">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="bg-bina-accent/8">{children}</thead>,
                  th: ({ children }) => <th className="px-3 py-2 text-left font-semibold text-bina-text border border-bina-border/40">{children}</th>,
                  td: ({ children }) => <td className="px-3 py-2 text-bina-text/85 border border-bina-border/30 align-top">{children}</td>,
                  tr: ({ children }) => <tr className="even:bg-bina-surface/50">{children}</tr>,
                  hr: () => <hr className="my-3 border-bina-border/40" />,
                  a: ({ href, children }) => (
                    <a href={href} className="text-bina-accent underline hover:text-bina-accent/70">{children}</a>
                  ),
                }}
              >
                {msg.content}
              </ReactMarkdown>
            </div>
            {msg.sources && msg.sources.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {msg.sources.map((s, i) => <SourceChip key={i} source={s} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Error bubble ──────────────────────────────────────────────────────────────
function ErrorBubble({ content }: { content: string }) {
  const { setGlobalSettingsOpen } = useAppStore()
  const err = classifyError(content)
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText('ollama serve')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-50 border border-red-200/80 text-sm">
      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
      <div>
        <p className="text-red-700 font-medium">{err.message}</p>
        {err.action === 'open_settings' && (
          <button
            onClick={() => setGlobalSettingsOpen(true)}
            className="mt-1 flex items-center gap-1 text-xs text-bina-accent hover:underline"
          >
            <Settings className="w-3 h-3" /> Open Settings →
          </button>
        )}
        {err.action === 'copy_command' && (
          <button
            onClick={handleCopy}
            className="mt-1 flex items-center gap-1 text-xs text-bina-accent hover:underline"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied!' : 'Copy: ollama serve'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function AskBinaPanel({ workspaceId }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const msgIdRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll the container itself to its bottom — avoids WebKit/Electron ancestor-bubbling
  // that happens with scrollIntoView when the window has overflow:hidden
  useEffect(() => {
    if ((messages.length > 0 || loading) && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, loading])


  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
  }, [input])

  const handleSend = useCallback(async () => {
    const query = input.trim()
    if (!query || loading) return

    const userMsgId = ++msgIdRef.current
    setInput('')
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content: query }])
    setLoading(true)

    try {
      const result: QueryResult = await api.query(query, workspaceId, 'agent')
      const sources: Source[] = result.results?.map(r => ({
        name: r.name, path: r.path, score: r.score,
      })) ?? []
      setMessages(prev => [...prev, {
        id: ++msgIdRef.current,
        role: 'assistant',
        content: result.answer?.trim() || 'No answer found.',
        sources,
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        id: ++msgIdRef.current,
        role: 'assistant',
        content: err instanceof Error ? err.message : 'Unknown error',
        isError: true,
      }])
    } finally {
      setLoading(false)
    }
  }, [input, loading, workspaceId])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = input.trim().length > 0 && !loading

  return (
    <>
      {/* Keyframe styles injected once */}
      <style>{`
        @keyframes thinkingPulse {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
          40%            { opacity: 1;    transform: scale(1);    }
        }
        @keyframes msgSlideIn {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>

      <div className="absolute inset-0 flex flex-col bg-white">

        {/* ── Scrollable messages ─────────────────────────────────────── */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-[720px] mx-auto w-full px-5 py-8 space-y-6">

            {/* Empty state */}
            {messages.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center min-h-[50vh] text-center select-none">
                <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-md border border-bina-border/30 mb-5">
                  <img src="/logo.png" alt="Bina" className="w-full h-full object-contain" draggable={false} />
                </div>
                <h2 className="text-bina-text text-xl font-display font-semibold mb-1">Ask Bina</h2>
                <p className="text-bina-muted text-sm max-w-xs leading-relaxed">
                  Ask anything about your files. Bina searches your knowledge graph and reasons over your documents.
                </p>
                <div className="mt-6 grid grid-cols-2 gap-2 w-full max-w-sm">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => { setInput(s); textareaRef.current?.focus() }}
                      className="text-left text-xs px-3.5 py-2.5 rounded-xl border border-bina-border
                                 text-bina-muted hover:text-bina-text hover:border-bina-accent/30
                                 hover:bg-bina-accent/4 transition-all duration-150 leading-snug"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Messages */}
            {messages.map(msg => <MessageRow key={msg.id} msg={msg} />)}

            {/* Thinking indicator */}
            {loading && (
              <div className="flex items-start gap-3" style={{ animation: 'msgSlideIn 0.18s ease-out' }}>
                <BinaAvatar />
                <div className="flex-1 pt-1">
                  <ThinkingDots />
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ── Input bar ───────────────────────────────────────────────── */}
        <div className="flex-shrink-0 pb-6 px-4">
          <div className="max-w-[720px] mx-auto w-full">
            <div
              className="relative rounded-2xl border transition-all duration-200"
              style={{
                background: 'rgba(255,255,255,0.92)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                borderColor: loading ? 'rgba(10,147,150,0.35)' : 'rgba(10,147,150,0.22)',
                boxShadow: '0 4px 24px rgba(0,95,115,0.08), 0 1px 4px rgba(0,18,25,0.05)',
              }}
            >
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything about your files…"
                rows={1}
                disabled={loading}
                className="w-full resize-none bg-transparent px-4 pt-3.5 pb-12 text-sm text-bina-text
                           placeholder-bina-muted/50 outline-none leading-relaxed
                           disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ maxHeight: 180, minHeight: 52 }}
              />

              {/* Bottom bar of input: hint + send */}
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 pb-2.5 pointer-events-none">
                <span className="text-[11px] text-bina-muted/40 select-none pointer-events-none">
                  {loading ? 'Thinking…' : 'Enter to send · Shift+Enter for new line'}
                </span>
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className="pointer-events-auto w-8 h-8 rounded-xl flex items-center justify-center
                             transition-all duration-150 disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{
                    background: canSend
                      ? 'linear-gradient(135deg, #0a9396, #005f73)'
                      : 'rgba(10,147,150,0.15)',
                  }}
                >
                  <ArrowUp className="w-4 h-4 text-white" strokeWidth={2.5} />
                </button>
              </div>
            </div>

            <p className="text-center text-[10px] text-bina-muted/35 mt-2 select-none">
              Bina processes everything locally. Nothing leaves your machine.
            </p>
          </div>
        </div>

      </div>
    </>
  )
}
