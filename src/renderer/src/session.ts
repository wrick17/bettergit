import { useEffect, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react'
import { adoptView, mountNear } from './scroll-anchor'

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
  // History view: the search text, and the branch and HEAD commit it last followed.
  query?: string
  head?: string
}

export interface Session {
  selected: string | null
  tab: 'changes' | 'history'
  sidebarOpen: boolean
  // Expanded panes collapse to rails when false.
  listOpen: boolean
  detailOpen: boolean
  // The code diff inside the detail pane.
  diffOpen: boolean
  // Explicit toolbar choices override responsive folding; older sessions keep their automatic fold stops.
  panelPins?: Partial<Record<'sidebar' | 'list' | 'details', boolean>>
  // The file and commit open in each repository, keyed by repository path.
  places: Record<string, Place>
  // The state of each view, keyed by view id. It belongs to one key, such as a commit or a file, and comes back only for that key.
  views: Record<string, { key: string; value: unknown }>
}

const EMPTY: Session = { selected: null, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, diffOpen: true, places: {}, views: {} }

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
// Each element restores once per id and key, so a pane that mounts later (a pane shown again, or a new commit) restores too,
// and so does a pane that stays mounted while its key changes. With no saved position, the fallback runs instead.
// Returns the scroll handler to put on the container.
// `onScreen` is for a caller whose `ready` means the content is already laid out: the position is then set before that
// frame paints, in one step. `skip` marks the key restored without moving, for a caller placing the pane itself.
export function useScrollMemory(ref: RefObject<HTMLElement | null>, id: string, key: string, ready: boolean, fallback?: (element: HTMLElement) => void,
  { onScreen = false, skip = false }: { onScreen?: boolean; skip?: boolean } = {}) {
  const restored = useRef<{ element: HTMLElement; id: string; key: string; frame: number } | null>(null)
  // No dependency list: a container that mounts after the first render is caught on the render that mounts it.
  ;(onScreen ? useLayoutEffect : useEffect)(() => {
    const element = ref.current
    const last = restored.current
    if (last?.element === element && last.id === id && last.key === key) return
    // Frames still waiting belong to the view before this one.
    if (last) {
      cancelAnimationFrame(last.frame)
      restored.current = null
    }
    if (!element || !ready) return
    // A pane shown again before the 250ms write restores the position still buffered, not the older one in storage.
    flushScroll()
    const top = savedView<number | null>(id, key, null)
    const entry = { element, id, key, frame: 0 }
    restored.current = entry
    // The diff pane's hold must not move the pane for the files this view just swapped in.
    if (onScreen) adoptView(element)
    if (skip || (top === null && !fallback)) return
    if (onScreen) {
      if (top === null) fallback?.(element)
      else element.scrollTop = top
      mountNear(element)
      return
    }
    // Rows and diffs lay out a frame after their data arrives, so the position is set after two frames.
    entry.frame = requestAnimationFrame(() => {
      entry.frame = requestAnimationFrame(() => {
        if (top === null) fallback?.(element)
        else element.scrollTop = top
      })
    })
  })
  return (event: UIEvent<HTMLElement>) => rememberScroll(id, key, event.currentTarget.scrollTop)
}
