import { useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { GUTTER } from './fold'

// A resizable column width, remembered between launches. Spread `handle` onto a divider element:
// drag it, double-click to restore the default, or use the arrow keys (Shift for bigger steps).
// Dragging writes the grid directly, so React only re-renders once, on release.
// With `cap` (a percent of the grid), the track never renders wider than the cap. Render `track` so React and the drag agree.
export function useResizable(key: string, initial: number, min: number, max: number, cap?: number) {
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)))
  const [size, setSize] = useState(() => clamp(Number(localStorage.getItem(key)) || initial))
  // The cap in pixels, measured when the divider is focused or used. An uncapped divider is never measured.
  const [limit, setLimit] = useState(Infinity)
  const latest = useRef(size)
  const drag = useRef<{ x: number; from: number; px: number; low: number; high: number; frame: number; grid: HTMLElement } | null>(null)

  const commit = (next: number) => {
    latest.current = clamp(next)
    setSize(latest.current)
    localStorage.setItem(key, String(latest.current))
  }
  const track = (px: number) => (cap ? `min(${px}px, ${cap}%)` : `${px}px`)
  const paint = (grid: HTMLElement, px: number) => {
    grid.style.gridTemplateColumns = `${track(px)} ${GUTTER}px minmax(0, 1fr)`
  }
  // The rendered width of a saved width, and the widths the track can take, under a cap of `px`.
  // A cap below the configured min pins the track: it neither shrinks nor grows, and the saved width is kept for a wider grid.
  const bounds = (px: number, saved: number) => {
    const high = Math.min(max, px)
    return { now: Math.min(saved, high), low: Math.min(min, high), high }
  }
  const measure = (grid: HTMLElement | null) => {
    if (!cap || !grid) return Infinity
    // The tracks fill the grid, so their sum is the width the percentage resolves against.
    const width = getComputedStyle(grid).gridTemplateColumns.split(' ').reduce((sum, px) => sum + parseFloat(px), 0)
    const px = Math.round((width * cap) / 100)
    // A grid that is not laid out has nothing to measure, so the track acts uncapped.
    if (!(px > 0)) return Infinity
    setLimit(px)
    return px
  }
  const shown = bounds(limit, size)

  const handle = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': shown.low,
    'aria-valuemax': shown.high,
    'aria-valuenow': shown.now,
    tabIndex: 0,
    onFocus: (event: FocusEvent<HTMLDivElement>) => measure(event.currentTarget.parentElement),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      const grid = event.currentTarget.parentElement
      if (!grid) return
      event.currentTarget.setPointerCapture(event.pointerId)
      // The grid's column transition would trail the pointer, so it is off until release.
      grid.dataset.resizing = ''
      // Measured with the transition off. A move starts from the rendered width, so it does not jump.
      const { now, low, high } = bounds(measure(grid), latest.current)
      drag.current = { x: event.clientX, from: now, px: now, low, high, frame: 0, grid }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      d.px = Math.min(d.high, Math.max(d.low, Math.round(d.from + event.clientX - d.x)))
      // One grid write per frame, however many pointer events arrive between frames.
      if (!d.frame) d.frame = requestAnimationFrame(() => {
        d.frame = 0
        paint(d.grid, d.px)
      })
    },
    onPointerUp: () => {
      const d = drag.current
      if (!d) return
      drag.current = null
      cancelAnimationFrame(d.frame)
      delete d.grid.dataset.resizing
      // A click, or a drag that cannot move the track, keeps the saved width and React's track.
      if (d.px === d.from) return paint(d.grid, latest.current)
      paint(d.grid, d.px)
      commit(d.px)
    },
    onDoubleClick: () => commit(initial),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 12
      const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      if (!delta) return
      // A step starts from the rendered width, so it moves the track at once. A step that cannot move it saves nothing.
      const { now, low, high } = bounds(measure(event.currentTarget.parentElement), latest.current)
      const next = Math.min(high, Math.max(low, now + delta))
      if (next !== now) commit(next)
    },
  }

  return { size, track: track(size), handle }
}
