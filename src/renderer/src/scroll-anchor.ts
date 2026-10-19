// Keeps what the reader is looking at still while content above it changes height: a row chunk mounting with its real
// (wrapped) rows instead of the estimate, or a file swapping its read-only rows for editor-look rows. The browser's own
// scroll anchoring misses these. One ResizeObserver per diff pane watches every chunk and file; it runs after layout and
// before paint, so the pane scrolls by each change above its top edge in the same frame, and nothing on screen moves.
// A chunk counts once its top is above the edge (it mounts whole). A file counts only when it was wholly above, and
// without the chunks inside it that resized in the same frame, so nothing is counted twice.
const observers = new WeakMap<HTMLElement, ResizeObserver>()
const heights = new WeakMap<Element, number>()
const files = new WeakSet<Element>()
// Panes whose position a caller sets itself this frame (a layout switch restoring its row), so it is not adjusted twice.
const suspended = new WeakSet<HTMLElement>()
// Files leaving from above the edge in this commit, per pane, with the position before they left.
const removals = new Map<HTMLElement, { from: number; height: number }>()

export function holdPlace(element: HTMLElement, file = false): () => void {
  if (file) files.add(element)
  const pane = element.closest<HTMLElement>('.diff-pane')
  if (!pane || typeof ResizeObserver === 'undefined') return () => undefined
  let observer = observers.get(pane)
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      const top = pane.getBoundingClientRect().top
      let shift = 0
      const changes = entries.flatMap((entry) => {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        const before = heights.get(entry.target)
        heights.set(entry.target, height)
        // A file that mounts above the edge (a refresh adding one) pushes the reader down by its whole height. Its chunks
        // are new too and are not counted.
        const added = before === undefined && files.has(entry.target) && !adopting.has(pane)
        return (before === undefined && !added) || before === height ? [] : [{ target: entry.target, delta: height - (before ?? 0), box: entry.target.getBoundingClientRect() }]
      })
      for (const { target, delta, box } of changes) {
        if (!files.has(target)) {
          if (box.top < top) shift += delta
          continue
        }
        const inner = changes.reduce((sum, other) => (other.target !== target && target.contains(other.target) ? sum + other.delta : sum), 0)
        if (box.bottom - delta <= top) shift += delta - inner
      }
      if (shift && !suspended.has(pane)) pane.scrollTop += shift
    })
    observers.set(pane, observer)
  }
  observer.observe(element)
  return () => {
    observer.unobserve(element)
    heights.delete(element)
    // A file removed from above the edge while its diff stays (a refresh dropping one) would pull the reader up. React
    // removes it after this cleanup, so the pane is set back in a microtask, before paint. The target is taken from the
    // position before removal, since the browser may already have clamped it near the bottom.
    const diff = element.parentElement
    const box = element.getBoundingClientRect()
    if (!file || !diff || box.bottom > pane.getBoundingClientRect().top) return
    let removal = removals.get(pane)
    if (!removal) {
      const next = { from: pane.scrollTop, height: 0 }
      removals.set(pane, (removal = next))
      queueMicrotask(() => {
        removals.delete(pane)
        if (diff.isConnected && !suspended.has(pane) && !adopting.has(pane)) pane.scrollTop = next.from - next.height
      })
    }
    removal.height += box.height
  }
}

// A pane whose view was just swapped whole (another section, say): the new files mounting and the old ones leaving are
// not moves of what the reader sees, but rows resizing above the edge still are, so those stay held.
const adopting = new WeakSet<HTMLElement>()
export function adoptView(pane: HTMLElement) {
  if (!observers.has(pane)) return
  adopting.add(pane)
  requestAnimationFrame(() => requestAnimationFrame(() => adopting.delete(pane)))
}

export function suspendHold(pane: HTMLElement) {
  if (!observers.has(pane)) return
  suspended.add(pane)
  requestAnimationFrame(() => requestAnimationFrame(() => suspended.delete(pane)))
}
