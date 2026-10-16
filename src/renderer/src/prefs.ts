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

// Extension to Shiki language, from Settings. Set by the app whenever the config changes.
const languageStore = createStore<Record<string, string>>({})

export const setLanguageOverrides = languageStore.set

export function useLanguageOverrides(): Record<string, string> {
  return useSyncExternalStore(languageStore.subscribe, languageStore.get)
}
