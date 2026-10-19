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
const CONTEXT_KEY = 'bettergit.contextLines'
const savedContext = Number(localStorage.getItem(CONTEXT_KEY))
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
