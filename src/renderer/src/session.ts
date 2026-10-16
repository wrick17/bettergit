// The last state the user left the window in. Kept in localStorage, so a renderer reload returns to the same spot.
const KEY = 'bettergit.session'

export interface Place {
  file?: string
  staged?: boolean
  commit?: string
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
}

const EMPTY: Session = { selected: null, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, places: {} }

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
