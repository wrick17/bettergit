import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import type { DiffFile } from '../../main/git/diff'
import { mountedEditors, previewReveals } from './DiffEditor'
import { suspendHold } from './scroll-anchor'
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
  // Highlights follow the container, not the files: a new diff in the same container is re-marked as its rows mount.
  useLayoutEffect(() => (container.current ? watchFind(container.current) : undefined), [container])
}

// Highlights every match in a diff container while a query is set, including rows that mount later. Returns the stop.
export function watchFind(element: HTMLElement) {
  containers.add(element)
  watch(element)
  return () => {
    containers.delete(element)
    observers.get(element)?.disconnect()
    observers.delete(element)
  }
}

// Every occurrence of the query in the rows on screen, drawn with the CSS Custom Highlight API, so no row re-renders.
// Rows mount and unmount as chunks scroll, editors redraw their lines, so each diff is watched while a query is set and
// only the lines that mounted or changed are searched again. Lines not mounted cost nothing until they mount.
// Each element here holds one line of text, except formatted Markdown, whose text nodes are searched one by one.
const SEARCHABLE = '.line > code, .split-cell > code, .ed-line > code, .cm-line, .cm-deletedLine, .md-content'
let needle = ''
const containers = new Set<HTMLElement>()
const observers = new Map<HTMLElement, MutationObserver>()
const marks = new Map<Element, Range[]>()

type HighlightSet = { add: (range: Range) => void; delete: (range: Range) => void; clear: () => void; priority: number }
let everyMatch: HighlightSet | null | undefined
function matchHighlight(): HighlightSet | null {
  if (everyMatch !== undefined) return everyMatch
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const Highlight = (globalThis as { Highlight?: new () => HighlightSet }).Highlight
  everyMatch = highlights && Highlight ? new Highlight() : null
  if (everyMatch) highlights!.set('find-match', everyMatch)
  return everyMatch
}

// Sets the query every diff highlights. Empty clears the highlights and stops watching.
export function setFindQuery(query: string) {
  const next = query.toLowerCase()
  if (next === needle) return
  needle = next
  for (const element of [...marks.keys()]) unmark(element)
  for (const element of containers) watch(element)
}

function watch(container: HTMLElement) {
  if (!needle || !matchHighlight()) {
    observers.get(container)?.disconnect()
    observers.delete(container)
    return
  }
  if (!observers.has(container)) {
    const observer = new MutationObserver(remark)
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    observers.set(container, observer)
  }
  container.querySelectorAll(SEARCHABLE).forEach(mark)
}

function remark(records: MutationRecord[]) {
  const touched = new Set<Element>()
  for (const record of records) {
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    const line = target?.closest(SEARCHABLE)
    if (line) touched.add(line)
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue
      if (node.matches(SEARCHABLE)) touched.add(node)
      node.querySelectorAll(SEARCHABLE).forEach((element) => touched.add(element))
    }
  }
  // Lines that left the page drop their ranges, so the highlight holds only what can still show.
  for (const element of marks.keys()) if (!element.isConnected) unmark(element)
  touched.forEach(mark)
}

function unmark(element: Element) {
  const ranges = marks.get(element)
  if (!ranges) return
  for (const range of ranges) everyMatch?.delete(range)
  marks.delete(element)
}

function mark(element: Element) {
  unmark(element)
  const highlight = matchHighlight()
  if (!needle || !highlight || !element.isConnected) return
  const ranges: Range[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  // shortcut: formatted Markdown is searched per text node, so a match that crosses bold or a link is not drawn; upgrade
  // if that is missed in practice.
  const groups = element.matches('.md-content') ? nodes.map((node) => [node]) : [nodes]
  for (const group of groups) {
    const text = group.map((node) => node.data).join('').toLowerCase()
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = rangeIn(group, at, at + needle.length)
      if (range) ranges.push(range)
    }
  }
  if (!ranges.length) return
  ranges.forEach((range) => highlight.add(range))
  marks.set(element, ranges)
}

// The range covering text offsets [start, end) across consecutive text nodes.
function rangeIn(nodes: Text[], start: number, end: number): Range | null {
  const range = document.createRange()
  let offset = 0
  let started = false
  for (const node of nodes) {
    const length = node.data.length
    if (!started && start < offset + length) {
      range.setStart(node, start - offset)
      started = true
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}

// The sources on screen, in page order. Re-read whenever a diff mounts, unmounts or gets new files.
export function useFindSources(): FindSource[] {
  useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => version)
  const next = [...sources]
    .filter((source) => source.container.current?.isConnected && source.container.current.getClientRects().length > 0)
    .sort((a, b) => (a.container.current!.compareDocumentPosition(b.container.current!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  // The same sources keep the same array, so a memo on it reruns exactly when a diff mounts, goes or gets new files
  // (new files register a new source).
  const last = useRef(next)
  if (next.length !== last.current.length || next.some((source, index) => source !== last.current[index])) last.current = next
  return last.current
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
// Find places rows itself, measuring the layout as it is, so the pane's own anchoring must not move them again.
function place(element: Element, block: ScrollLogicalPosition) {
  const pane = element.closest<HTMLElement>('.diff-pane')
  if (pane) suspendHold(pane)
  element.scrollIntoView({ block })
}
let revealing = 0

// Scrolls a match into view and highlights it. A collapsed file opens; a chunk that is not mounted is scrolled to, so it
// mounts, and the row is looked for again on the next frames. An editable file reveals the line in its editor.
export async function revealMatch(source: FindSource, match: Match) {
  const run = ++revealing
  // Checked right after every wait, before any scroll, unfold or mark: a newer reveal or a cleared find ends this one.
  const stale = () => run !== revealing
  const container = source.container.current
  const file = source.files[match.file]
  const line = file?.hunks[match.hunk]?.lines[match.line]
  if (!container || !line) return
  const path = file.newPath ?? file.oldPath ?? ''
  const section = () => container.querySelector<HTMLElement>(`[data-file-index="${match.file}"]`)
  if (section()?.querySelector(':scope > .collapsed-note')) source.openFile(path)
  for (let frame = 0; frame < 90; frame++) {
    if (frame) await nextFrame()
    if (stale()) return
    const host = section()?.querySelector<HTMLElement>('.diff-editor')
    const editor = host && mountedEditors.get(host)
    if (editor) {
      const lines = file.hunks[match.hunk].lines
      const old = line.type === 'del'
      const unifiedEditor = host.querySelector('.cm-mergeView') === null
      // A folded line opens first. A removed line in the unified editor is found in its removed block.
      editor.unfold(old ? 'old' : 'new', (old ? line.oldNo : line.newNo) ?? 1)
      if (old && unifiedEditor && line.oldNo) {
        unhighlight()
        let row: HTMLElement | null = null
        for (let step = 0; step < 30 && !(row = editor.deletedLine(line.oldNo)); step++) {
          await nextFrame()
          if (stale()) return
        }
        if (row) {
          place(row, 'center')
          highlight(row, match)
          return
        }
      }
      const near = lines.slice(match.line).find((other) => other.newNo != null) ?? [...lines.slice(0, match.line)].reverse().find((other) => other.newNo != null)
      unhighlight()
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
        place(host, hostBox.top > paneBox.bottom ? 'start' : 'end')
        await nextFrame()
        await nextFrame()
        if (stale()) return
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
      for (let step = 0; step < 90 && pane; step++) {
        const element = shown()
        const bounds = pane.getBoundingClientRect()
        if (element) {
          const box = element.getBoundingClientRect()
          if (box.top >= bounds.top + 40 && box.bottom <= bounds.bottom) {
            if (++steady >= 3) return
          } else {
            steady = 0
            place(element, 'center')
          }
        } else {
          steady = 0
          const drawn = gutter().map((item) => ({ line: Number(item.textContent), box: item.getBoundingClientRect() }))
          const after = drawn.filter((entry) => entry.line > target).sort((x, y) => x.line - y.line)[0]
          const before = drawn.filter((entry) => entry.line < target).sort((x, y) => y.line - x.line)[0]
          const step = after && after.box.top <= bounds.top ? -1 : before && before.box.bottom >= bounds.bottom ? 1 : 0
          suspendHold(pane)
          pane.scrollTop += step * pane.clientHeight
        }
        await nextFrame()
        if (stale()) return
      }
      return
    }
    const rows = [...container.querySelectorAll<HTMLElement>(`[data-source-row="${match.file}:${match.hunk}:${match.line}"]`)]
    // A context line shows on both sides of a split row: the new side is used.
    const row = line.type === 'del' ? rows[0] : rows[rows.length - 1]
    if (row) {
      place(row, 'center')
      highlight(row, match)
      return
    }
    // A file shown as editor-look rows opens the fold holding the line, or scrolls its part of the file into view.
    const preview = section()?.querySelector<HTMLElement>('.ed-preview')
    const open = preview && previewReveals.get(preview)
    if (open) {
      const old = line.type === 'del'
      open(old ? 'old' : 'new', (old ? line.oldNo : line.newNo) ?? 1)
      continue
    }
    const chunk = [...container.querySelectorAll<HTMLElement>('[data-lines]')].find((element) => {
      const [fileIndex, hunkIndex, first, last] = element.dataset.lines!.split(':').map(Number)
      return fileIndex === match.file && hunkIndex === match.hunk && first <= match.line && match.line <= last
    })
    const target = chunk ?? section()
    if (target) place(target, 'center')
  }
}

// The current match uses the CSS Custom Highlight API, so no row re-renders. A row without the line's text (formatted
// Markdown shows its source gutter only) is highlighted whole.
function highlight(row: HTMLElement, match: Match) {
  unhighlight()
  const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
  const Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight
  const code = row.querySelector('code') ?? (row.matches('.cm-deletedLine') ? row : null)
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
  const Highlight = (globalThis as { Highlight?: new (range: Range) => { priority: number } }).Highlight
  if (!highlights || !Highlight) return
  const current = new Highlight(range)
  // Drawn over the every-match highlight.
  current.priority = 1
  highlights.set('find-current', current)
}

// The editor holding the current match's mark, if the match is in an editable file.
let marked: Mounted | null = null

// Also stops a reveal still under way, so clearing or closing find never scrolls or highlights afterwards.
export function clearHighlight() {
  revealing++
  unhighlight()
}

function unhighlight() {
  marked?.unmark()
  marked = null
  ;(globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete('find-current')
  document.querySelectorAll('.find-row').forEach((element) => element.classList.remove('find-row'))
}
