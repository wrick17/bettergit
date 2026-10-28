import { useSyncExternalStore } from 'react'
import { ActionError, failureReason } from './repo-busy'

// Failures the user has not marked as read, newest first. They stay, across restarts too, until marked read.
export interface Notification {
  id: string
  // What the user tried, such as "Pulling in bettergit". Shown as "<action> failed".
  action: string
  reason: string
  // The sidebar path of the repo it happened in, for Go to repository.
  repo?: string
  time: number
  // How many times the same failure happened while unread.
  count: number
}

const KEY = 'bettergit.notifications'
const MAX_ENTRIES = 50
const MAX_TEXT = 2000

// Stored text drops any user:password@ in URLs, such as a token in a clone URL that Git repeats in its error.
const clip = (value: unknown, max = MAX_TEXT) => (typeof value === 'string' ? value.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1').slice(0, max) : '')

// Stored entries come back checked, so a damaged or hand-edited store cannot break the hub.
export function parseNotifications(raw: string | null): Notification[] {
  try {
    const list: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(list)) return []
    return list.flatMap((item): Notification[] => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as Record<string, unknown>
      const action = clip(entry.action, 200)
      const id = clip(entry.id, 64)
      if (!action || !id) return []
      return [{
        id, action, reason: clip(entry.reason),
        repo: typeof entry.repo === 'string' && entry.repo.startsWith('/') ? clip(entry.repo, 1000) : undefined,
        time: Number.isFinite(entry.time) ? entry.time as number : Date.now(),
        count: Number.isInteger(entry.count) && (entry.count as number) > 0 ? entry.count as number : 1,
      }]
    }).slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

let entries: Notification[] = parseNotifications(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY))
// The newest failure, for the brief announcement. Null once it has been shown or when none is new.
let latest: Notification | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function set(next: Notification[], announce: Notification | null = latest) {
  entries = next.slice(0, MAX_ENTRIES)
  latest = announce
  try { localStorage.setItem(KEY, JSON.stringify(entries)) } catch { /* storage full or unavailable: entries last this session */ }
  listeners.forEach((listener) => listener())
}

export const useNotifications = () => useSyncExternalStore(subscribe, () => entries)
export const useLatestNotification = () => useSyncExternalStore(subscribe, () => latest)
export const clearLatest = () => { if (latest) { latest = null; listeners.forEach((listener) => listener()) } }

// Adds a failure. The same failure again while unread raises its count instead of adding a row. A repeat is announced
// unless `quietRepeat`, which background work uses so a failure every interval does not keep announcing itself.
export function notify(input: { action: string; reason: string; repo?: string }, quietRepeat = false) {
  const action = clip(input.action, 200)
  const reason = clip(input.reason)
  const same = entries.find((entry) => entry.action === action && entry.reason === reason && entry.repo === input.repo)
  const time = Date.now()
  if (same) {
    const bumped = { ...same, time, count: same.count + 1 }
    set([bumped, ...entries.filter((entry) => entry !== same)], quietRepeat ? latest : bumped)
    return
  }
  const entry = { id: `${time.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, action, reason, repo: input.repo, time, count: 1 }
  set([entry, ...entries], entry)
}

// Adds a caught failure. One that carries its own action and repo (ActionError) keeps them; otherwise `action` names what
// the user tried and `repo` where. A failure a dialog shows inline is added too, so it is still here after the dialog closes.
export function notifyFailure(action: string, failure: unknown, repo?: string) {
  notify(failure instanceof ActionError
    ? { action: failure.action, reason: failure.message, repo: failure.repo ?? repo }
    : { action, reason: failureReason(failure), repo })
}

export const markRead = (id: string) => set(entries.filter((entry) => entry.id !== id), latest?.id === id ? null : latest)
export const markAllRead = () => set([], null)
