import { useSyncExternalStore } from 'react'

// Small renderer-side stores. Each one is read with useSyncExternalStore, so every view that uses it re-renders on change.
type Listener = () => void

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

// Unchanged lines shown around each change. 100000 is "All": the whole file.
export const CONTEXT_OPTIONS = [3, 10, 25, 100000]
// Start legacy All users with compact context once; an All choice made after this still persists.
const CONTEXT_KEY = 'bettergit.contextLines.v2'
const legacyContext = Number(localStorage.getItem('bettergit.contextLines'))
const savedContext = Number(localStorage.getItem(CONTEXT_KEY) ?? (legacyContext === 100000 ? 3 : legacyContext))
const contextStore = createStore(CONTEXT_OPTIONS.includes(savedContext) ? savedContext : 3)

export function setContextLines(next: number) {
  localStorage.setItem(CONTEXT_KEY, String(next))
  contextStore.set(next)
}

export function useContextLines(): number {
  return useSyncExternalStore(contextStore.subscribe, contextStore.get)
}

// Hides whitespace-only edits in every diff (git --ignore-all-space). Off by default.
const IGNORE_WHITESPACE_KEY = 'bettergit.ignoreWhitespace'
const ignoreWhitespaceStore = createStore(localStorage.getItem(IGNORE_WHITESPACE_KEY) === 'true')

export function setIgnoreWhitespace(next: boolean) {
  localStorage.setItem(IGNORE_WHITESPACE_KEY, String(next))
  ignoreWhitespaceStore.set(next)
}

export function useIgnoreWhitespace(): boolean {
  return useSyncExternalStore(ignoreWhitespaceStore.subscribe, ignoreWhitespaceStore.get)
}

// One raw/formatted choice for every diff, restored when the renderer reloads.
const FORMAT_MARKDOWN_KEY = 'bettergit.formatMarkdown'
const formatMarkdownStore = createStore(localStorage.getItem(FORMAT_MARKDOWN_KEY) === 'true')

export function setFormatMarkdown(next: boolean) {
  localStorage.setItem(FORMAT_MARKDOWN_KEY, String(next))
  formatMarkdownStore.set(next)
}

export function useFormatMarkdown(): boolean {
  return useSyncExternalStore(formatMarkdownStore.subscribe, formatMarkdownStore.get)
}

// Long lines in raw diffs and editors wrap (the default) or scroll sideways.
const WRAP_KEY = 'bettergit.wordWrap'
const wrapStore = createStore(localStorage.getItem(WRAP_KEY) !== 'false')

export function setWordWrap(next: boolean) {
  localStorage.setItem(WRAP_KEY, String(next))
  wrapStore.set(next)
}

export function useWordWrap(): boolean {
  return useSyncExternalStore(wrapStore.subscribe, wrapStore.get)
}

// Extension to Shiki language, from Settings. Set by the app whenever the config changes.
const languageStore = createStore<Record<string, string>>({})

export const setLanguageOverrides = languageStore.set

// Views key their colours on this object's identity, so a new syntax theme (recolour) re-colours them as a language change does.
export function useLanguageOverrides(): Record<string, string> {
  return useSyncExternalStore(languageStore.subscribe, languageStore.get)
}

export const recolour = () => languageStore.set({ ...languageStore.get() })
export const onRecolour = languageStore.subscribe

// Branches hidden from the branch picker and History, by full ref, per repository. A view choice only: no Git ref changes.
// Saved data is checked on load, so a hand edit or an older shape can only hide branch refs.
const HIDDEN_KEY = 'bettergit.hiddenBranches'
const isBranchRef = (ref: unknown): ref is string => typeof ref === 'string' && /^refs\/(heads|remotes)\/[^\n]+$/.test(ref)
const cleanRefs = (refs: unknown) => Array.isArray(refs) ? [...new Set(refs.filter(isBranchRef))].sort() : []
function loadHidden(): Record<string, string[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).flatMap(([repo, refs]) => {
      const kept = cleanRefs(refs)
      return kept.length ? [[repo, kept]] : []
    }))
  } catch {
    return {}
  }
}
const hiddenStore = createStore(loadHidden())
const NO_REFS: string[] = []

// Replaces one repository's hidden set; an empty one shows every branch again. Other repositories keep theirs.
export function setHiddenBranches(repo: string, refs: string[]) {
  const next = { ...hiddenStore.get() }
  const kept = cleanRefs(refs)
  if (kept.length) next[repo] = kept
  else delete next[repo]
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(next))
  hiddenStore.set(next)
}

export const hiddenBranches = (repo: string): string[] => hiddenStore.get()[repo] ?? NO_REFS

// Sorted and stable until it changes, so views can use it as a dependency.
export function useHiddenBranches(repo: string): string[] {
  return useSyncExternalStore(hiddenStore.subscribe, () => hiddenBranches(repo))
}
