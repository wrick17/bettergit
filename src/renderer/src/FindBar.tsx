import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { IconButton } from './Icons'
import { clearHighlight, revealMatch, scopedMatches, setFindQuery, setFindScope, useFindScope, useFindSources, type FindSource, type Match } from './find'
import { splitPath } from './paths'

// One find for every diff on screen, read-only rows and editors alike. ⌘F opens it (also from the Edit menu), Enter and
// ⌘G go to the next match, Shift+Enter and ⇧⌘G to the previous one, and Escape closes it. A file header's Find button
// narrows it to that file until the scope is cleared or the bar closes.
export function FindBar({ open, onClose, focusKey }: { open: boolean; onClose: () => void; focusKey: number }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const sources = useFindSources()
  const scope = useFindScope()
  const matches = useMemo(() => (open ? scopedMatches(sources, query) : []), [open, sources, query, scope])
  const current = matches.length ? Math.min(index, matches.length - 1) : -1
  const go = (step: number) => {
    if (!matches.length) return
    const next = (current + step + matches.length) % matches.length
    setIndex(next)
    reveal(matches[next])
  }

  // Each ⌘F focuses the field and selects its text, so typing replaces the last search.
  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.select())
  }, [open, focusKey])

  // A new scope starts counting from its first match.
  useEffect(() => setIndex(0), [scope])

  // Every match on screen is highlighted while the bar is open; closing it clears them.
  useEffect(() => {
    setFindQuery(open ? query : '')
  }, [open, query])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        go(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!open) return null
  const close = () => {
    clearHighlight()
    setFindScope(null)
    onClose()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      go(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  return (
    <div className="find-bar" role="search" aria-label="Find in diff">
      <input
        ref={input}
        value={query}
        placeholder={scope ? `Find in ${splitPath(scope.path).name}` : 'Find in diff'}
        aria-label={scope ? `Find in ${scope.path}` : 'Find in diff'}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value
          setQuery(next)
          setIndex(0)
          // The first match shows as the query is typed.
          const first = scopedMatches(sources, next, 1)[0]
          if (first) reveal(first)
          else clearHighlight()
        }}
        onKeyDown={onKeyDown}
      />
      {scope && (
        <span className="find-scope" title={scope.path}>
          {splitPath(scope.path).name}
          <IconButton icon="close" label="Search all diffs" onClick={() => setFindScope(null)} />
        </span>
      )}
      <span className="find-count" role="status">{query ? (matches.length ? `${current + 1} of ${matches.length}` : 'No results') : ''}</span>
      <IconButton icon="chevronUp" label="Previous match (⇧⌘G)" disabled={!matches.length} onClick={() => go(-1)} />
      <IconButton icon="chevronDown" label="Next match (⌘G)" disabled={!matches.length} onClick={() => go(1)} />
      <IconButton icon="close" label="Close find (Escape)" onClick={close} />
    </div>
  )
}

function reveal({ source, match }: { source: FindSource; match: Match }) {
  void revealMatch(source, match)
}
