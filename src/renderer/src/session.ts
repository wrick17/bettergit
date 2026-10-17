import { useEffect, useRef, type RefObject, type UIEvent } from 'react'

// The last state the user left the window in. Kept in localStorage, so a renderer reload returns to the same spot.
const KEY = 'bettergit.session'

export interface Place {
  file?: string
  staged?: boolean
  commit?: string
  // Changes view: the commit message being typed, the tree folders closed, and the files shown with more context.
  draft?: string
  collapsed?: string[]
  widened?: Record<string, number>
  // History view: the search text.
  query?: string
}

export interface Session {
  selected: string | null
  tab: 'changes' | 'history'
  sidebarOpen: boolean
  // The file or commit list, and the diff or commit detail. Either can be hidden on its own.
  listOpen: boolean
  detailOpen: boolean
  // The file and commit open in each repository, keyed by repository path.
  places: Record<string, Place>
  // The state of each view, keyed by view id. It belongs to one key, such as a commit or a file, and comes back only for that key.
  views: Record<string, { key: string; value: unknown }>
}

const EMPTY: Session = { selected: null, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} }

export function loadSession(): Session {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return EMPTY
  }
}

export function saveSession(patch: Partial<Session>) {
  localStorage.setItem(KEY, JSON.stringify({ ...loadSession(), ...patch }))
}

// Merges one repository's place. Missing keys are dropped, which clears them.
export function savePlace(repo: string, place: Place) {
  const session = loadSession()
  saveSession({ places: { ...session.places, [repo]: { ...session.places[repo], ...place } } })
}

// The saved state of a view, if it was saved for this key. Otherwise the fallback.
export function savedView<T>(id: string, key: string, fallback: T): T {
  const saved = loadSession().views[id]
  return saved?.key === key ? (saved.value as T) : fallback
}

export function saveView(id: string, key: string, value: unknown) {
  saveSession({ views: { ...loadSession().views, [id]: { key, value } } })
}

// Scroll fires every frame, so positions are written at most every 250ms. The last one is written when the window goes away.
const pendingScroll = new Map<string, { key: string; top: number }>()
let scrollTimer: number | undefined

function flushScroll() {
  window.clearTimeout(scrollTimer)
  scrollTimer = undefined
  if (!pendingScroll.size) return
  const views = { ...loadSession().views }
  for (const [id, { key, top }] of pendingScroll) views[id] = { key, value: top }
  pendingScroll.clear()
  saveSession({ views })
}

export function rememberScroll(id: string, key: string, top: number) {
  pendingScroll.set(id, { key, top })
  if (scrollTimer === undefined) scrollTimer = window.setTimeout(flushScroll, 250)
}

window.addEventListener('pagehide', flushScroll)

// Returns a scroll container to its saved position once it shows ready content with the key the position was saved for.
// Each element restores once, so a pane or diff that mounts later (a pane shown again, or a new commit) restores too.
// Returns the scroll handler to put on the container.
export function useScrollMemory(ref: RefObject<HTMLElement | null>, id: string, key: string, ready: boolean) {
  const restoredFor = useRef<HTMLElement | null>(null)
  // No dependency list: a container that mounts after the first render is caught on the render that mounts it.
  useEffect(() => {
    const element = ref.current
    if (!element || !ready || restoredFor.current === element) return
    restoredFor.current = element
    // A pane shown again before the 250ms write restores the position still buffered, not the older one in storage.
    flushScroll()
    const top = savedView<number | null>(id, key, null)
    if (top === null) return
    // Rows and diffs lay out a frame after their data arrives, so the position is set after two frames.
    requestAnimationFrame(() => requestAnimationFrame(() => { element.scrollTop = top }))
  })
  return (event: UIEvent<HTMLElement>) => rememberScroll(id, key, event.currentTarget.scrollTop)
}
