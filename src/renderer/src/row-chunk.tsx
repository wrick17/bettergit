import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useWordWrap } from './prefs'
import { holdPlace, isNear, watchNear } from './scroll-anchor'

// Rows mount in chunks, and only near the screen: a large diff costs about one screen of rows to render, toggle or
// scroll. Chunks above and below keep their last measured height, so the scrollbar and scroll position hold still.
export const CHUNK_ROWS = 50
// Unified and split rows are one 22px line unless a long line wraps; the first mount replaces this estimate.
const ROW_ESTIMATE = 22

// A chunk also ends before each row in `breaks` (ascending), so a conflict's controls can sit between chunks.
export function chunked(rows: number, render: (start: number, end: number) => ReactNode, breaks: number[] = []): ReactNode[] {
  const out: ReactNode[] = []
  let next = 0
  for (let start = 0; start < rows;) {
    while (next < breaks.length && breaks[next] <= start) next++
    const end = Math.min(rows, start + CHUNK_ROWS, breaks[next] ?? rows)
    out.push(render(start, end))
    start = end
  }
  return out
}

export function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => start + index)
}

// One observer for every chunk. `scrollMargin` extends the diff pane's clip as well as the viewport, so chunks mount
// about a screen before they scroll in.
const NEAR = '1200px 0px'
let chunkObserver: IntersectionObserver | null = null
const chunkCallbacks = new WeakMap<Element, (near: boolean) => void>()
function observeChunk(element: Element, onChange: (near: boolean) => void) {
  chunkObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) chunkCallbacks.get(entry.target)?.(entry.isIntersecting)
  }, { rootMargin: NEAR, scrollMargin: NEAR } as IntersectionObserverInit)
  chunkCallbacks.set(element, onChange)
  chunkObserver.observe(element)
  return () => {
    chunkObserver?.unobserve(element)
    chunkCallbacks.delete(element)
  }
}

// `lines` (file:hunk:first:last source lines) lets find scroll an unmounted chunk into view so its rows mount.
// A chunk holding a move's end stays mounted, so its connector always has both ends to measure.
// `range` names what an editor-look chunk holds (old first:last, current first:last), so find can scroll to it.
export function RowChunk({ rows, lines, range, pinned, render, estimate }: { rows: number; lines?: string; range?: string; pinned: boolean; render: () => ReactNode; estimate?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  // Without an observer (server rendering, tests) every row renders.
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  const height = useRef(estimate ?? rows * ROW_ESTIMATE)
  // Word wrap changes row heights, so a placeholder measured under the other setting goes back to the estimate.
  const wrap = useWordWrap()
  const measuredFor = useRef(wrap)
  if (measuredFor.current !== wrap) {
    measuredFor.current = wrap
    height.current = estimate ?? rows * ROW_ESTIMATE
  }
  // The first frame already shows the rows on screen: the chunk measures itself before paint instead of waiting for the observer.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const check = () => { if (isNear(element.getBoundingClientRect())) setNear(true) }
    check()
    const release = holdPlace(element, false, element.firstChild ? undefined : height.current)
    const unwatch = watchNear(element, check)
    const stop = observeChunk(element, (next) => {
      if (!next && element.firstChild) height.current = element.offsetHeight
      setNear(next)
    })
    return () => {
      stop()
      unwatch()
      release()
    }
  }, [])
  const show = near || pinned
  // The rows are kept while only the wrap setting changes: it is a class on the diff, so rows need not render again.
  const rendered = useMemo(() => (show ? render() : null), [show, render])
  return <div ref={ref} className="row-chunk" data-lines={lines} data-range={range} style={show ? undefined : { height: height.current }}>{rendered}</div>
}
