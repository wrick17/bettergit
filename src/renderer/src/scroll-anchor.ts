// Keeps what the reader is looking at still while content above it changes height: a row chunk mounting with its real
// (wrapped) rows instead of the estimate, or a file swapping its read-only rows for editor-look rows. The browser's own
// scroll anchoring misses these. One ResizeObserver per diff pane watches every chunk and file; it runs after layout and
// before paint, so the pane scrolls by each change above its top edge in the same frame, and nothing on screen moves.
// A chunk counts once its top is above the edge (it mounts whole). A file counts only when it was wholly above, and
// without the chunks inside it that resized in the same frame, so nothing is counted twice.
const observers = new WeakMap<HTMLElement, ResizeObserver>()
const heights = new WeakMap<Element, number>()
const files = new WeakSet<Element>()
// Chunks given a placeholder height that the observer has not measured yet.
const unmeasured = new Set<Element>()
// Panes whose position a caller sets itself this frame (a layout switch restoring its row), so it is not adjusted twice.
const suspended = new WeakSet<HTMLElement>()
// Files leaving from above the edge in this commit, per pane, with the position before they left.
const removals = new Map<HTMLElement, { from: number; height: number }>()

function margins(element: Element) {
  const style = getComputedStyle(element)
  return parseFloat(style.marginTop) + parseFloat(style.marginBottom)
}

// `initial` is the height a chunk mounted with as a placeholder, so rows it mounts before its first measurement still count.
export function holdPlace(element: HTMLElement, file = false, initial?: number): () => void {
  if (file) files.add(element)
  const pane = element.closest<HTMLElement>('.diff-pane')
  if (!pane || typeof ResizeObserver === 'undefined') return () => undefined
  if (initial !== undefined) {
    heights.set(element, initial)
    unmeasured.add(element)
  }
  let observer = observers.get(pane)
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      const top = pane.getBoundingClientRect().top
      let shift = 0
      const changes = entries.flatMap((entry) => {
        unmeasured.delete(entry.target)
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        const before = heights.get(entry.target)
        heights.set(entry.target, height)
        return before === undefined || before === height ? [] : [{ target: entry.target, delta: height - before, box: entry.target.getBoundingClientRect() }]
      })
      // Chunks are taken top down: each one's top before this frame is its top now less the growth of those above it.
      let grown = 0
      for (const { delta, box } of changes.filter((change) => !files.has(change.target)).sort((a, b) => a.box.top - b.box.top)) {
        if (box.top - grown < top) shift += delta
        grown += delta
      }
      for (const { target, delta, box } of changes) {
        if (!files.has(target)) continue
        const inner = changes.reduce((sum, other) => (other.target !== target && target.contains(other.target) ? sum + other.delta : sum), 0)
        if (box.bottom - delta <= top) shift += delta - inner
      }
      if (shift && !suspended.has(pane)) pane.scrollTop += shift
    })
    observers.set(pane, observer)
  }
  observer.observe(element)
  // A new file can move existing rows before the observer's first delivery. Measure after the commit's layout effects,
  // before the next frame, and seed the observer so it only counts later resizes.
  if (file) queueMicrotask(() => {
    if (!element.isConnected || heights.has(element)) return
    const box = element.getBoundingClientRect()
    heights.set(element, box.height)
    const margin = margins(element)
    if (box.top - margin <= pane.getBoundingClientRect().top && !suspended.has(pane) && !adopting.has(pane)) pane.scrollTop += box.height + margin
  })
  return () => {
    observer.unobserve(element)
    heights.delete(element)
    unmeasured.delete(element)
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
    removal.height += box.height + margins(element)
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

// A row chunk mounts its rows once it is near the screen, which its observer reports only after a frame paints. A pane
// placed by code (a restore, or a jump to a file) asks the chunks it landed near to mount at once, so the first frame
// there paints rows, not placeholders. Files far from the screen are skipped, so their skipped content is never laid out.
const NEAR_PX = 1200
const nearChecks = new WeakMap<Element, () => void>()
export const isNear = (box: DOMRect) => box.bottom > -NEAR_PX && box.top < window.innerHeight + NEAR_PX

export function watchNear(element: Element, check: () => void) {
  nearChecks.set(element, check)
  return () => { nearChecks.delete(element) }
}

// Rows a chunk mounted before the pane was placed are already in the layout it was placed by, so they are not counted again.
export function mountNear(pane: HTMLElement) {
  for (const chunk of unmeasured) if (chunk.firstChild && pane.contains(chunk)) heights.set(chunk, (chunk as HTMLElement).offsetHeight)
  const view = pane.getBoundingClientRect()
  const shown: HTMLElement[] = []
  for (const file of pane.querySelectorAll<HTMLElement>('.diff-file')) {
    const box = file.getBoundingClientRect()
    if (!isNear(box)) continue
    for (const chunk of file.querySelectorAll('.row-chunk')) nearChecks.get(chunk)?.()
    // A file that was off screen stays skipped (content-visibility) until the browser looks again after this frame, so one
    // now on screen is laid out at once and handed back once the browser has seen it. Files off screen stay skipped.
    const onScreen = box.bottom > view.top && box.top < view.bottom
    if (onScreen && !file.style.contentVisibility && file.firstElementChild?.checkVisibility?.({ contentVisibilityAuto: true }) === false) shown.push(file)
  }
  if (!shown.length) return
  for (const file of shown) file.style.contentVisibility = 'visible'
  requestAnimationFrame(() => requestAnimationFrame(() => { for (const file of shown) file.style.contentVisibility = '' }))
}
