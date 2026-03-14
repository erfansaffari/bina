import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

interface Props {
  onSearch: (query: string) => void
  searchMs: number | null
}

export default function SearchBar({ onSearch, searchMs }: Props) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onSearch(value)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [value, onSearch])

  // Global ⌘K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      className={`flex items-center gap-3 bg-bina-surface border rounded-2xl px-4 py-3 transition-all duration-200 ${
        focused
          ? 'border-bina-accent/60 shadow-lg shadow-bina-accent/10'
          : 'border-bina-border'
      }`}
    >
      <Search
        className={`w-4 h-4 flex-shrink-0 transition-colors ${
          focused ? 'text-bina-accent' : 'text-bina-muted'
        }`}
      />
      <input
        ref={inputRef}
        id="bina-search"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Ask anything about your files…"
        className="flex-1 bg-transparent text-bina-text placeholder-bina-muted/60 outline-none text-sm font-sans"
      />
      <div className="flex items-center gap-2 flex-shrink-0">
        {searchMs !== null && value && (
          <span className="text-bina-muted text-xs font-mono">{searchMs}ms</span>
        )}
        {value ? (
          <button
            onClick={() => { setValue(''); onSearch('') }}
            className="text-bina-muted hover:text-bina-text transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <kbd className="text-bina-muted/50 text-xs border border-bina-border rounded px-1.5 py-0.5 font-mono">
            ⌘K
          </kbd>
        )}
      </div>
    </div>
  )
}
