import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

// A resizable column width, remembered between launches. Spread `handle` onto a divider element:
// drag it, double-click to restore the default, or use the arrow keys (Shift for bigger steps).
// Dragging writes the grid directly, so React only re-renders once, on release.
// With `cap` (a percent of the grid), the track never renders wider than the cap. Render `track` so React and the drag agree.
export function useResizable(key: string, initial: number, min: number, max: number, cap?: number) {
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)))
  const [size, setSize] = useState(() => clamp(Number(localStorage.getItem(key)) || initial))
  const latest = useRef(size)
  const drag = useRef<{ x: number; size: number; px: number; frame: number; grid: HTMLElement } | null>(null)

  const commit = (next: number) => {
    latest.current = clamp(next)
    setSize(latest.current)
    localStorage.setItem(key, String(latest.current))
  }
  const track = (px: number) => (cap ? `min(${px}px, ${cap}%)` : `${px}px`)
  const paint = (grid: HTMLElement, px: number) => {
    grid.style.gridTemplateColumns = `${track(px)} 9px minmax(0, 1fr)`
  }

  const handle = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': size,
    tabIndex: 0,
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      const grid = event.currentTarget.parentElement
      if (!grid) return
      event.currentTarget.setPointerCapture(event.pointerId)
      // A capped track can render narrower than the saved width. A move starts from the rendered width, so it does not jump,
      // and a click without a move keeps the saved width.
      const shown = cap ? parseFloat(getComputedStyle(grid).gridTemplateColumns) : NaN
      drag.current = { x: event.clientX, size: shown || latest.current, px: latest.current, frame: 0, grid }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      d.px = clamp(d.size + event.clientX - d.x)
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
      paint(d.grid, d.px)
      commit(d.px)
    },
    onDoubleClick: () => commit(initial),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 48 : 12
      if (event.key === 'ArrowLeft') commit(latest.current - step)
      else if (event.key === 'ArrowRight') commit(latest.current + step)
    },
  }

  return { size, track: track(size), handle }
}
