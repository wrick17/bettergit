import { useSyncExternalStore } from 'react'

// Sideways scrolling of one file's code while long lines do not wrap. Each file section keeps one offset. It moves every
// row's text (the `--sx` variable, a transform, so no row lays out again), the file's scrollbar, and any editor in the
// file, so both columns of a split view always move together. A scroll that comes back with the value already set stops
// there, so the parts never echo each other.
export interface HScroll {
  readonly x: number
  set: (x: number, from?: Element) => void
  // A scrolling element kept at the same offset, such as an editor's scroller. Returns its removal.
  follow: (element: HTMLElement) => () => void
}

const controllers = new WeakMap<Element, HScroll>()

export function hscrollOf(section: HTMLElement): HScroll {
  let controller = controllers.get(section)
  if (controller) return controller
  const followers = new Set<HTMLElement>()
  let x = 0
  const bar = () => section.querySelector<HTMLElement>(':scope > .hscroll')
  controller = {
    get x() { return x },
    set(next, from) {
      const scrollbar = bar()
      const max = scrollbar ? scrollbar.scrollWidth - scrollbar.clientWidth : Infinity
      next = Math.max(0, Math.min(next, max))
      if (next === x) return
      x = next
      section.style.setProperty('--sx', `${x}px`)
      for (const element of scrollbar ? [scrollbar, ...followers] : followers) {
        if (element !== from && element.scrollLeft !== x) element.scrollLeft = x
      }
    },
    follow(element) {
      followers.add(element)
      element.scrollLeft = x
      const onScroll = () => controller!.set(element.scrollLeft, element)
      element.addEventListener('scroll', onScroll, { passive: true })
      return () => {
        followers.delete(element)
        element.removeEventListener('scroll', onScroll)
      }
    },
  }
  controllers.set(section, controller)
  // A sideways wheel or trackpad swipe over static rows scrolls the file. Editors scroll themselves and report back.
  section.addEventListener('wheel', (event) => {
    if (!event.deltaX || !section.closest('.nowrap') || (event.target as Element).closest?.('.cm-scroller')) return
    controller!.set(x + event.deltaX)
  }, { passive: true })
  return controller
}

// The code font's metrics at the current appearance: one digit's width and the line height, measured once per change.
let metrics: { digit: number; line: number } | null = null
let version = 0
const listeners = new Set<() => void>()
let watching = false
function measure() {
  if (metrics) return metrics
  watch()
  const probe = document.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;white-space:pre;font:var(--code-size)/var(--code-line) var(--font-code)'
  probe.textContent = '0'.repeat(100)
  document.body.appendChild(probe)
  const box = probe.getBoundingClientRect()
  probe.remove()
  const next = { digit: box.width / 100, line: box.height || 22 }
  // Kept only once the code font has loaded, so a fallback font's width is measured again later.
  if (document.fonts?.status === 'loaded') metrics = next
  return next
}
// Settings > Appearance rewrites the code font and size on :root (appearance.ts), and a newly chosen font can finish
// loading later. Either measures again and, if the metrics moved, tells every subscriber, so sizes derived from them follow.
function watch() {
  if (watching || typeof MutationObserver === 'undefined') return
  watching = true
  const changed = () => {
    const before = metrics
    metrics = null
    const after = measure()
    if (before && before.digit === after.digit && before.line === after.line) return
    version++
    for (const listener of listeners) listener()
  }
  new MutationObserver(changed).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-density'] })
  document.fonts?.addEventListener('loadingdone', changed)
}
function subscribe(listener: () => void) {
  watch()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const charWidth = () => measure().digit
export const codeLine = () => measure().line
// Changes whenever the code font's metrics do. Put it in the dependencies of anything sized from them.
export const useCodeMetrics = () => useSyncExternalStore(subscribe, () => version)

// The widest line in columns, with tabs to the next stop. shortcut: every character counts as one column, so wide
// characters (CJK, emoji) can be cut short at the far right; upgrade to measuring mounted rows if that shows up.
export function columns(lines: Iterable<string>, tabSize: number): number {
  let widest = 0
  for (const line of lines) {
    let column = 0
    for (let index = 0; index < line.length; index++) column = line.charCodeAt(index) === 9 ? column + tabSize - (column % tabSize) : column + 1
    if (column > widest) widest = column
  }
  return widest
}
