import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { DiffFile } from '../../main/git/diff'
import { mountedEditors } from './DiffEditor'
import type { Mounted } from './cm-editor'

// In-app find over the diffs on screen. It searches the diff data, not the DOM, so rows that are not mounted (chunks
// off screen, collapsed files) are found the same as rows on screen; revealing a match mounts its rows first.

export interface Match {
  file: number
  hunk: number
  line: number
  // UTF-16 offsets of the match in the line's text.
  start: number
  end: number
}

// Every case-insensitive occurrence of the query in every line of every hunk, both sides, in reading order.
export function findMatches(files: DiffFile[], query: string): Match[] {
  const needle = query.toLowerCase()
  const out: Match[] = []
  if (!needle) return out
  files.forEach((file, fileIndex) => file.hunks.forEach((hunk, hunkIndex) => hunk.lines.forEach((line, lineIndex) => {
    const text = line.text.toLowerCase()
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      out.push({ file: fileIndex, hunk: hunkIndex, line: lineIndex, start: at, end: at + needle.length })
    }
  })))
  return out
}

// A diff on screen that find can search. Registered by each DiffView while it is mounted.
export interface FindSource {
  container: RefObject<HTMLDivElement | null>
  files: DiffFile[]
  // Opens a collapsed file, so its match can show.
  openFile: (path: string) => void
}

const sources = new Set<FindSource>()
const listeners = new Set<() => void>()
let version = 0
const changed = () => {
  version++
  listeners.forEach((listener) => listener())
}

export function useFindSource(container: RefObject<HTMLDivElement | null>, files: DiffFile[], openFile: (path: string) => void) {
  const open = useRef(openFile)
  open.current = openFile
  useLayoutEffect(() => {
    const source: FindSource = { container, files, openFile: (path) => open.current(path) }
    sources.add(source)
    changed()
    return () => {
      sources.delete(source)
      changed()
    }
  }, [container, files])
}

// The sources on screen, in page order. Re-read whenever a diff mounts, unmounts or gets new files.
export function useFindSources(): FindSource[] {
  useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => version)
  return [...sources]
    .filter((source) => source.container.current?.isConnected && source.container.current.getClientRects().length > 0)
    .sort((a, b) => (a.container.current!.compareDocumentPosition(b.container.current!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
let revealing = 0

// Scrolls a match into view and highlights it. A collapsed file opens; a chunk that is not mounted is scrolled to, so it
// mounts, and the row is looked for again on the next frames. An editable file reveals the line in its editor.
export async function revealMatch(source: FindSource, match: Match) {
  const run = ++revealing
  const container = source.container.current
  const file = source.files[match.file]
  const line = file?.hunks[match.hunk]?.lines[match.line]
  if (!container || !line) return
  const path = file.newPath ?? file.oldPath ?? ''
  const section = () => container.querySelector<HTMLElement>(`[data-file-index="${match.file}"]`)
  if (section()?.querySelector(':scope > .collapsed-note')) source.openFile(path)
  for (let frame = 0; frame < 90 && run === revealing; frame++) {
    if (frame) await nextFrame()
    const host = section()?.querySelector<HTMLElement>('.diff-editor')
    const editor = host && mountedEditors.get(host)
    if (editor) {
      const lines = file.hunks[match.hunk].lines
      const old = line.type === 'del'
      const near = lines.slice(match.line).find((other) => other.newNo != null) ?? [...lines.slice(0, match.line)].reverse().find((other) => other.newNo != null)
      clearHighlight()
      marked = editor
      const side = old ? 'old' : 'new'
      // A removed line in the unified editor is drawn from the old text, so the current line next to it is used.
      const number = (old ? line.oldNo : line.newNo) ?? 1
      const target = old && host.querySelector('.cm-mergeView') === null ? near?.newNo ?? 1 : number
      const pane = container.closest<HTMLElement>('.diff-pane')
      // An editor off screen has drawn no lines near the screen to step from, so it is brought on screen first.
      const hostBox = host.getBoundingClientRect()
      const paneBox = pane?.getBoundingClientRect()
      if (paneBox && (hostBox.bottom < paneBox.top || hostBox.top > paneBox.bottom)) {
        host.scrollIntoView({ block: hostBox.top > paneBox.bottom ? 'start' : 'end' })
        await nextFrame()
        await nextFrame()
      }
      // The side's editor: the old one is the first of a split view's two.
      const editors = host.querySelectorAll<HTMLElement>('.cm-editor')
      const sideEditor = editors.length > 1 && side === 'old' && target === number ? editors[0] : editors[editors.length - 1]
      editor.reveal(side, number, match.start, match.end, target)
      const gutter = () => [...(sideEditor?.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement') ?? [])]
        .filter((element) => element.offsetHeight > 0 && Number(element.textContent) > 0)
      // The mark, or for a removed line in the unified editor, the current line beside it.
      const shown = () => host.querySelector('.cm-find-current') ?? (target !== number ? gutter().find((element) => Number(element.textContent) === target) : undefined)
      // The editor knows real heights only for lines it has drawn, and corrects the rest as it draws them, so the pane
      // steps toward the line a screen at a time until it is drawn, then keeps it centred until it holds still.
      let steady = 0
      for (let step = 0; step < 90 && run === revealing && pane; step++) {
        const element = shown()
        const bounds = pane.getBoundingClientRect()
        if (element) {
          const box = element.getBoundingClientRect()
          if (box.top >= bounds.top + 40 && box.bottom <= bounds.bottom) {
            if (++steady >= 3) return
          } else {
            steady = 0
            element.scrollIntoView({ block: 'center' })
          }
        } else {
          steady = 0
          const drawn = gutter().map((item) => ({ line: Number(item.textContent), box: item.getBoundingClientRect() }))
          const after = drawn.filter((entry) => entry.line > target).sort((x, y) => x.line - y.line)[0]
          const before = drawn.filter((entry) => entry.line < target).sort((x, y) => y.line - x.line)[0]
          const place = after && after.box.top <= bounds.top ? -1 : before && before.box.bottom >= bounds.bottom ? 1 : 0
          pane.scrollTop += place * pane.clientHeight
        }
        await nextFrame()
      }
      return
    }
    const rows = [...container.querySelectorAll<HTMLElement>(`[data-source-row="${match.file}:${match.hunk}:${match.line}"]`)]
    // A context line shows on both sides of a split row: the new side is used.
    const row = line.type === 'del' ? rows[0] : rows[rows.length - 1]
    if (row) {
      row.scrollIntoView({ block: 'center' })
      highlight(row, match)
      return
    }
    const chunk = [...container.querySelectorAll<HTMLElement>('[data-lines]')].find((element) => {
      const [fileIndex, hunkIndex, first, last] = element.dataset.lines!.split(':').map(Number)
      return fileIndex === match.file && hunkIndex === match.hunk && first <= match.line && match.line <= last
    })
    ;(chunk ?? section())?.scrollIntoView({ block: 'center' })
  }
}

// The current match uses the CSS Custom Highlight API, so no row re-renders. A row without the line's text (formatted
// Markdown shows its source gutter only) is highlighted whole.
function highlight(row: HTMLElement, match: Match) {
  clearHighlight()
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight
  const code = row.querySelector('code')
  if (!code || !highlights || !Highlight) {
    row.classList.add('find-row')
    return
  }
  const range = document.createRange()
  let offset = 0
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length
    if (offset <= match.start && match.start <= offset + length) range.setStart(node, match.start - offset)
    if (offset <= match.end && match.end <= offset + length) {
      range.setEnd(node, match.end - offset)
      break
    }
    offset += length
  }
  setHighlight(range)
}

function setHighlight(range: Range) {
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight
  if (highlights && Highlight) highlights.set('find-current', new Highlight(range))
}

// The editor holding the current match's mark, if the match is in an editable file.
let marked: Mounted | null = null

export function clearHighlight() {
  marked?.unmark()
  marked = null
  ;(globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete('find-current')
  document.querySelectorAll('.find-row').forEach((element) => element.classList.remove('find-row'))
}
