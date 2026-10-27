import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react'

// The file shown at the top of a diff pane. `section` is the data-section of the diff it is in, if that diff has one.
export interface ActiveFile {
  path: string
  section: string | null
}

export interface ActiveFiles {
  get: () => ActiveFile | null
  subscribe: (listener: () => void) => () => void
  // Reads the pane again in the next frame. Calls in the same frame share one read.
  probe: () => void
}

// The sticky diff toolbar's height (--diff-toolbar-height) plus a few pixels, so the read lands on the file header that
// sticks below the toolbar, or on the rows of the file under it.
const PROBE_Y = 46

// Kept outside React state, so a scroll that moves into another file re-renders only the file lists that read it,
// never the pane or its diffs. One hit test per frame, however many files the pane holds.
export function useActiveFiles(pane: RefObject<HTMLElement | null>): ActiveFiles {
  const frame = useRef(0)
  const files = useMemo<ActiveFiles>(() => {
    let value: ActiveFile | null = null
    const listeners = new Set<() => void>()
    const read = (): ActiveFile | null => {
      const element = pane.current
      if (!element) return null
      const box = element.getBoundingClientRect()
      const y = box.top + PROBE_Y
      const point = document.elementFromPoint(box.left + box.width / 2, y)
      // A dialog or menu over the pane hides it, so the mark stays as it was.
      if (!point || !element.contains(point)) return value
      let file = point.closest<HTMLElement>('[data-path]')
      if (!file) {
        // Between files, as on a section heading or a commit's header: the last file that starts above, else the first.
        const all = Array.from(element.querySelectorAll<HTMLElement>('[data-path]'))
        file = all.filter((candidate) => candidate.getBoundingClientRect().top <= y).pop() ?? all[0] ?? null
      }
      if (!file || file.getBoundingClientRect().top >= box.bottom) return null
      return { path: file.dataset.path ?? '', section: file.closest<HTMLElement>('[data-section]')?.dataset.section ?? null }
    }
    return {
      get: () => value,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      probe: () => {
        if (frame.current) return
        frame.current = requestAnimationFrame(() => {
          frame.current = 0
          const next = read()
          if (next?.path === value?.path && next?.section === value?.section) return
          value = next
          listeners.forEach((listener) => listener())
        })
      },
    }
  }, [])
  // Cleared as well as cancelled: StrictMode and hot reload run this cleanup and keep the hook, and a stale id would
  // make every later probe wait for a frame that never comes.
  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }, [])
  return files
}

const NONE = () => null
const NO_SUBSCRIBE = () => () => {}

export function useActiveFile(files: ActiveFiles | undefined): ActiveFile | null {
  return useSyncExternalStore(files?.subscribe ?? NO_SUBSCRIBE, files?.get ?? NONE)
}

// Keeps the list's marked row on screen as the diff scrolls, with no animation, and moves only the list's own scroller.
// `key` is the marked file, so the list moves only when that changes.
export function useKeepInView(list: RefObject<HTMLElement | null>, key: string | null) {
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('.in-view')
    // The nearest box that scrolls. The Changes tree is overflow: auto too, but grows with its rows inside the list.
    let scroller = row?.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement
    }
    if (!row || !scroller) return
    const box = scroller.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    // A sticky section title covers the top of the Changes list.
    const top = box.top + (row.closest('.group')?.querySelector<HTMLElement>(':scope > h3')?.offsetHeight ?? 0)
    if (rect.top < top) scroller.scrollTop -= top - rect.top
    else if (rect.bottom > box.bottom) scroller.scrollTop += rect.bottom - box.bottom
  }, [key])
}
