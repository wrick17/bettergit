import { Fragment, memo, startTransition, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { DiffFile, DiffHunk, DiffLine, LineRef, MovedBlock } from '../../main/git/diff'
import { EDITORS } from '../../shared/editors'
import { EditorContext, useEditorLaunch, type EditorBridge } from './editor-launch'
import { Icon, IconButton, TextToggle, toggleLabel } from './Icons'
import { splitPath } from './paths'
import { CONTEXT_OPTIONS, setContextLines, setFormatMarkdown, setIgnoreWhitespace, useContextLines, useFormatMarkdown, useIgnoreWhitespace, useLanguageOverrides } from './prefs'
import { highlightFile, languageFor, type Segment } from './highlight'
import { emphasize, intralineSpans, type Piece, type Span } from './intraline'
import { savedView, saveView } from './session'
import { isMarkdownPath, MarkdownContent, markdownHunk, type MarkdownSide } from './MarkdownLine'
import { DraftActions, EditableDiff, type EditBridge } from './DiffEditor'
import { useFindSource } from './find'
import './intraline.css'

interface Props {
  files: DiffFile[]
  moves: MovedBlock[]
  // Set in the Changes view. Each file header then shows a checkbox. Checked = staged. Disabled while a repository change runs.
  stage?: { staged: boolean; disabled?: boolean; onToggle: (path: string, stage: boolean) => void }
  // Set in the Changes view. Each hunk gets an expand row above and below to show more context for that file.
  onExpand?: (file: DiffFile) => void
  // Where the open and closed choices of each file are saved. The choices come back only for the same key, such as a commit.
  persist?: { id: string; key: string }
  // Set by the conflict resolver, which shows a conflicted file here with its controls inline.
  conflict?: ConflictDecor
  // Replaces the text shown when there are no files. Set when the caller has nothing to show because a load failed.
  emptyHint?: string
  // Set in the Changes view for working-tree diffs. Each text file then edits in place, with save and discard in its header.
  edit?: EditBridge
}

// A row may get a class, and a plain row (a conflict marker) keeps its raw text uncoloured. Controls render above a row,
// or after a hunk's last row when the index equals the hunk's length.
export interface ConflictDecor {
  row: (line: DiffLine) => { className: string; plain: boolean } | undefined
  controls: (hunk: DiffHunk, index: number) => ReactNode
  splitRows: (hunk: DiffHunk) => SplitRow[]
}

export type DiffLayout = 'unified' | 'split'

// One layout choice shared by every diff on screen. Kept in the renderer, so it needs no restart.
const LAYOUT_KEY = 'bettergit.diffLayout'
const listeners = new Set<() => void>()
const sourceAnchors = new Set<() => { pane: HTMLElement; top: number; select: () => void } | undefined>()
let layout: DiffLayout = localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'

function captureSourceAnchors() {
  const panes = new Map<HTMLElement, { top: number; select: () => void }>()
  for (const remember of sourceAnchors) {
    const candidate = remember()
    if (candidate && (!panes.has(candidate.pane) || candidate.top < panes.get(candidate.pane)!.top)) panes.set(candidate.pane, candidate)
  }
  panes.forEach((candidate) => candidate.select())
}

export function setDiffLayout(next: DiffLayout) {
  if (next !== layout) captureSourceAnchors()
  layout = next
  localStorage.setItem(LAYOUT_KEY, next)
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useDiffLayout(): DiffLayout {
  return useSyncExternalStore(subscribe, () => layout)
}

// Moved lines get a tint and a label that names the other end of the move, so a block that
// left one place and landed in another can be followed by reading the labels.
export const DiffView = memo(function DiffView({ files, moves, stage, onExpand, persist, conflict, emptyHint, edit }: Props) {
  const layoutNow = useDiffLayout()
  const context = useContextLines()
  const ignoreWhitespace = useIgnoreWhitespace()
  const formatNow = useFormatMarkdown()
  // The toolbar shows a toggle at once. The diff under it re-renders from these deferred copies, in the background and
  // interruptibly, so a click, scroll or second toggle never waits for a large diff to rebuild.
  const shown = useDeferredValue(useMemo(() => ({ files, moves, layout: layoutNow, format: formatNow }), [files, moves, layoutNow, formatNow]))
  const current = shown.layout
  const formatMarkdown = shown.format
  const { labels, anchors } = useMemo(() => indexMoves(shown.files, shown.moves), [shown])
  const stats = useMemo(() => shown.files.map(countLines), [shown])
  // Conflict markers are source, so a conflicted file is never formatted.
  const formatted = formatMarkdown && !conflict
  const overrides = useLanguageOverrides()
  useTokens(shown.files, overrides)
  const containerRef = useRef<HTMLDivElement>(null)
  const headId = `move-head-${useId().replace(/\W/g, '')}`
  const [arrows, setArrows] = useState<Arrow[]>([])
  const [height, setHeight] = useState(0)
  // The user's open or closed choice per file path. Files without a choice use the default.
  const persistId = persist?.id
  const persistKey = persist?.key
  const [choices, setChoices] = useState<Record<string, boolean>>(() => (persistId !== undefined && persistKey !== undefined ? savedView(persistId, persistKey, {}) : {}))
  useEffect(() => {
    if (persistId !== undefined && persistKey !== undefined) saveView(persistId, persistKey, choices)
  }, [persistId, persistKey, choices])
  const toggleFile = useCallback((path: string, open: boolean) => setChoices((prev) => ({ ...prev, [path]: !open })), [])
  // File sections are memoised, so the callbacks they get stay the same object and always call the caller's latest one.
  const latest = useRef({ stage, onExpand, edit })
  latest.current = { stage, onExpand, edit }
  const stageFor = useMemo(() => stage && { staged: stage.staged, disabled: stage.disabled, onToggle: (path: string, next: boolean) => latest.current.stage?.onToggle(path, next) },
    [!!stage, stage?.staged, stage?.disabled])
  const expand = useMemo(() => onExpand && ((file: DiffFile) => latest.current.onExpand?.(file)), [!!onExpand])
  const editFor = useMemo<EditBridge | undefined>(() => edit && {
    repo: edit.repo,
    disabled: edit.disabled,
    load: (path) => latest.current.edit!.load(path),
    save: (path, loaded, text) => latest.current.edit!.save(path, loaded, text),
    onError: (error) => latest.current.edit!.onError(error),
  }, [!!edit, edit?.repo, edit?.disabled])

  useSourceAnchor(containerRef, current, formatMarkdown, shown.files)
  useFindSource(containerRef, shown.files, (path) => setChoices((prev) => ({ ...prev, [path]: true })))
  // Each moved block gets a curve from its old place to its new one. Positions are measured from the
  // rendered cells, so the arrows follow the layout and survive window resizes.
  useLayoutEffect(() => {
    const container = containerRef.current
    const moves = shown.moves
    if (!container || !moves.length) {
      setArrows([])
      return
    }
    const observed = new Set<Element>([container])
    const measure = () => {
      const box = container.getBoundingClientRect()
      const place = (id: string) => {
        const element = container.querySelector<HTMLElement>(`[data-move-id="${id}"]`)
        if (!element) return null
        const block = current === 'split' ? element.closest<HTMLElement>('.md-diff-block') ?? element : element
        const rect = block.getBoundingClientRect()
        observed.add(block)
        let top = rect.top
        let bottom = rect.bottom
        if (current === 'split' && block !== element) {
          const line = Number(element.dataset.sourceRow?.split(':').pop())
          let span = Infinity
          for (const node of block.querySelectorAll<HTMLElement>('[data-source-range]')) {
            const [first, last] = (node.dataset.sourceRange ?? '').split(':').map(Number)
            if (!(first <= line && line <= last) || last - first > span) continue
            const content = node.getBoundingClientRect()
            if (!content.height) continue
            observed.add(node)
            if (last - first < span) {
              top = content.top
              bottom = content.bottom
              span = last - first
            } else {
              top = Math.min(top, content.top)
              bottom = Math.max(bottom, content.bottom)
            }
          }
        }
        return { left: rect.left - box.left, right: rect.right - box.left, y: (top + bottom) / 2 - box.top }
      }
      const next: Arrow[] = []
      moves.forEach((_, index) => {
        const from = place(`${index}-from`)
        const to = place(`${index}-to`)
        if (!from || !to) return
        if (current === 'unified') {
          // The connector runs down the lane left of the line numbers, so it never crosses code. Each move takes its own
          // column in the lane, so crossing connectors stay apart. The arrowhead lands on the new line.
          const x = LANE_FIRST + (index % LANE_COLUMNS) * LANE_STEP
          next.push({ d: `M ${LANE_END} ${from.y} H ${x} V ${to.y} H ${LANE_END}`, head: true })
          return
        }
        // Side by side: connect facing block edges through the channel
        // between the columns. Each arrow bends at its own depth so crossing arrows stay readable.
        const x1 = from.right
        const x2 = to.left
        const depth = x1 + (x2 - x1) * (0.3 + (index % 4) * 0.13)
        next.push({ d: `M ${x1} ${from.y} C ${depth} ${from.y}, ${depth} ${to.y}, ${x2} ${to.y}`, head: false })
      })
      setArrows(next)
      setHeight(container.offsetHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observed.forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [shown, current, formatMarkdown, choices])

  // Optional controls sit left of the fixed ones, so showing or hiding them never moves unified/split or whitespace.
  const hasMarkdown = !conflict && files.some((file) => isMarkdownPath(pathOf(file)))
  return (
    <div className="diff" ref={containerRef}>
      {arrows.length > 0 && (
        <svg className="move-arrows" width="100%" height={height} aria-hidden="true">
          <defs>
            <marker id={headId} viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M0 0L6 3L0 6z" fill="var(--move)" />
            </marker>
          </defs>
          {arrows.map((arrow, index) => (
            <path key={index} d={arrow.d} fill="none" stroke="var(--move)" strokeWidth={1.5} strokeOpacity={0.9} markerEnd={arrow.head ? `url(#${headId})` : undefined} />
          ))}
        </svg>
      )}
      <div className="diff-toolbar">
        <span className="moves">
          {moves.length > 0 ? `${moves.length} moved block${moves.length === 1 ? '' : 's'} detected` : ''}
        </span>
        <div className="diff-toolbar-controls">
          {!onExpand && (
            <>
              <span className="moves">Context</span>
              <div className="context-toggle" role="group" aria-label="Lines of context">
                {CONTEXT_OPTIONS.map((value) => {
                  const lines = value === 100000 ? 'All lines' : `${value} lines`
                  return (
                    <TextToggle
                      key={value}
                      text={value === 100000 ? 'All' : String(value)}
                      label={context === value ? `${lines} of context: on` : toggleLabel(`${lines} of context: off`, `show ${lines.toLowerCase()} of context`)}
                      active={context === value}
                      onClick={() => setContextLines(value)}
                    />
                  )
                })}
              </div>
            </>
          )}
          {hasMarkdown && (
            <div className="diff-layout-toggle markdown-toggle" role="group" aria-label="Markdown formatting">
              {/* Formatting parses the visible Markdown hunk fragments on each side without inferring missing content, except a blank header for table rows cut below theirs; links and images stay inert, and raw view keeps the exact source. */}
              <IconButton
                icon="markdown"
                label={formatNow ? toggleLabel('Formatted Markdown: on', 'show the raw source') : toggleLabel('Formatted Markdown: off', 'format Markdown')}
                active={formatNow}
                onClick={() => {
                  captureSourceAnchors()
                  setFormatMarkdown(!formatNow)
                }}
              />
            </div>
          )}
          <div className="diff-layout-toggle" role="group" aria-label="Diff layout">
            <IconButton icon="rows" label={layoutNow === 'unified' ? 'Unified layout: on' : toggleLabel('Unified layout: off', 'show one column')} active={layoutNow === 'unified'} onClick={() => setDiffLayout('unified')} />
            <IconButton icon="columns" label={layoutNow === 'split' ? 'Split layout: on' : toggleLabel('Split layout: off', 'show side by side')} active={layoutNow === 'split'} onClick={() => setDiffLayout('split')} />
          </div>
          {/* Last in the row. It stays visible when the filtered patch is empty, so the user can turn the option off in place. */}
          <div className="diff-layout-toggle" role="group" aria-label="Whitespace">
            <IconButton
              icon="eyeOff"
              label={ignoreWhitespace ? toggleLabel('Whitespace changes: hidden', 'show them') : toggleLabel('Whitespace changes: shown', 'hide them')}
              active={ignoreWhitespace}
              onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
            />
          </div>
        </div>
      </div>
      {!shown.files.length && (
        <p className="hint">{emptyHint ?? (ignoreWhitespace ? 'No changes shown. Whitespace changes are hidden.' : 'No changes in this view.')}</p>
      )}
      {shown.files.map((file, fileIndex) => {
        const path = pathOf(file)
        const stat = stats[fileIndex]
        // A conflict being resolved starts open, even in a lock file, since its markers and actions are the point. A choice made by hand wins.
        const open = choices[path] ?? (!!conflict || !startsCollapsed(file, stat.adds + stat.dels))
        return (
          <FileSection
            key={`${fileIndex}-${path}`}
            file={file}
            fileIndex={fileIndex}
            stat={stat}
            open={open}
            onToggle={toggleFile}
            layout={current}
            formatted={formatted}
            language={languageFor(path, overrides)}
            tokens={fileTokens(file, overrides)}
            labels={labels}
            anchors={anchors}
            conflict={conflict}
            stage={stageFor}
            edit={editFor}
            onExpand={expand}
          />
        )
      })}
    </div>
  )
})

// One file: its sticky header and, while open, its hunks. Memoised, so a collapse, a file's colours arriving or a draft
// changing re-renders only that file.
const FileSection = memo(function FileSection({ file, fileIndex, stat, open, onToggle, layout, formatted, language, tokens, labels, anchors, conflict, stage, edit, onExpand }: {
  file: DiffFile
  fileIndex: number
  stat: { adds: number; dels: number }
  open: boolean
  onToggle: (path: string, open: boolean) => void
  layout: DiffLayout
  formatted: boolean
  language: string | null
  tokens: Segment[][][] | undefined
  labels: Map<string, string>
  anchors: Map<string, string>
  conflict?: ConflictDecor
  stage?: Props['stage']
  edit?: EditBridge
  onExpand?: (file: DiffFile) => void
}) {
  const path = pathOf(file)
  const changed = stat.adds + stat.dels
  const toggle = () => onToggle(path, open)
  const text = edit && !conflict && !file.binary && file.status !== 'deleted' ? edit : undefined
  const markdown = formatted && isMarkdownPath(path)
  // Formatted Markdown is not source, so it stays read-only; the raw view edits it.
  const editor = text && !markdown ? text : undefined
  // A conflict row shows only its own text: colours made for other lines, such as before a choice changed the file, are dropped.
  const decorate = (line: DiffLine, segments?: Segment[]) => {
    const row = conflict?.row(line)
    const fits = !conflict || (!row?.plain && segments?.map((segment) => segment.text).join('') === line.text)
    return { className: row?.className, segments: fits ? segments : undefined }
  }
  const unifiedRow = (hunk: DiffHunk, hunkIndex: number, lineIndex: number) => {
    const line = hunk.lines[lineIndex]
    const row = decorate(line, tokens?.[hunkIndex]?.[lineIndex])
    const source = key(fileIndex, hunkIndex, lineIndex)
    return (
      <Fragment key={lineIndex}>
        {conflict?.controls(hunk, lineIndex)}
        <UnifiedLine line={line} segments={row.segments} className={row.className} changed={spansOf(hunk).get(lineIndex)}
          label={labels.get(source)} anchor={anchors.get(source)} source={source} />
      </Fragment>
    )
  }
  const splitRow = (hunk: DiffHunk, hunkIndex: number, row: SplitRow, rowIndex: number) => {
    const leftKey = row.left ? key(fileIndex, hunkIndex, row.left.index) : undefined
    const rightKey = row.right ? key(fileIndex, hunkIndex, row.right.index) : undefined
    const leftLabel = leftKey ? labels.get(leftKey) : undefined
    const rightLabel = rightKey ? labels.get(rightKey) : undefined
    const left = row.left ? decorate(row.left.line, tokens?.[hunkIndex]?.[row.left.index]) : undefined
    const right = row.right ? decorate(row.right.line, tokens?.[hunkIndex]?.[row.right.index]) : undefined
    return (
      <Fragment key={rowIndex}>
        {conflict?.controls(hunk, row.controlIndex ?? (row.left ?? row.right)!.index)}
        {(leftLabel || rightLabel) && (
          <div className="split-row">
            {leftLabel ? <div className="move-note">{leftLabel}</div> : <div />}
            {rightLabel ? <div className="move-note">{rightLabel}</div> : <div />}
          </div>
        )}
        <div className="split-row">
          <SplitCell cell={row.left} side="old" segments={left?.segments} className={left?.className}
            changed={row.left ? spansOf(hunk).get(row.left.index) : undefined} label={leftLabel}
            anchor={leftKey ? anchors.get(leftKey) : undefined} source={leftKey} />
          <SplitCell cell={row.right} side="new" segments={right?.segments} className={right?.className}
            changed={row.right ? spansOf(hunk).get(row.right.index) : undefined} label={rightLabel}
            anchor={rightKey ? anchors.get(rightKey) : undefined} source={rightKey} />
        </div>
      </Fragment>
    )
  }
  const hunks = () => file.hunks.map((hunk, hunkIndex) => {
    const format = markdown && fitsMarkdown(hunk.lines)
    const pinned = (lines: number[]) => lines.some((index) => anchors.has(key(fileIndex, hunkIndex, index)))
    let body: ReactNode
    if (format) {
      body = <MarkdownHunkView lines={hunk.lines} changes={spansOf(hunk)} layout={layout} prefix={`${fileIndex}:${hunkIndex}`} labels={labels} anchors={anchors} />
    } else if (layout === 'unified') {
      body = conflict
        ? hunk.lines.map((_, lineIndex) => unifiedRow(hunk, hunkIndex, lineIndex))
        : chunked(hunk.lines.length, (start, end) => {
          const lines = range(start, end)
          return <RowChunk key={start} rows={end - start} lines={`${fileIndex}:${hunkIndex}:${start}:${end - 1}`} pinned={pinned(lines)}
            render={() => lines.map((lineIndex) => unifiedRow(hunk, hunkIndex, lineIndex))} />
        })
    } else {
      const rows = conflict ? conflict.splitRows(hunk) : toRows(hunk.lines)
      body = conflict
        ? rows.map((row, rowIndex) => splitRow(hunk, hunkIndex, row, rowIndex))
        : chunked(rows.length, (start, end) => {
          const slice = rows.slice(start, end)
          const lines = slice.flatMap((row) => [row.left?.index, row.right?.index].filter((index): index is number => index !== undefined))
          return <RowChunk key={start} rows={end - start} lines={`${fileIndex}:${hunkIndex}:${Math.min(...lines)}:${Math.max(...lines)}`} pinned={pinned(lines)}
            render={() => slice.map((row, offset) => splitRow(hunk, hunkIndex, row, start + offset))} />
        })
    }
    return (
      <Fragment key={hunkIndex}>
        {onExpand && <ExpandRow label={`Show more context above line ${edgeLines(hunk.lines).first}`} onExpand={() => onExpand(file)} />}
        <div className="hunk">
          <div className="hunk-header">{hunk.header}</div>
          {markdown && !format && <div className="md-fragment-note">Too large to format as Markdown. Showing the source diff.</div>}
          {body}
          {conflict?.controls(hunk, hunk.lines.length)}
        </div>
        {onExpand && <ExpandRow label={`Show more context below line ${edgeLines(hunk.lines).last}`} onExpand={() => onExpand(file)} />}
      </Fragment>
    )
  })
  return (
    <section className={`diff-file${editor ? ' editable' : ''}`} data-path={path} data-file-index={fileIndex}>
      <FileHeader file={file} stat={stat} open={open} onToggle={toggle} stage={stage}
        actions={text && <DraftActions edit={text} path={path} />} />
      {file.binary && <p className="hint">Binary file.</p>}
      {!open && file.hunks.length > 0 && (
        <div className="collapsed-note">
          <span>{changed} changed line{changed === 1 ? '' : 's'} hidden</span>
          <button onClick={toggle}>Show diff</button>
        </div>
      )}
      {open && conflict && layout === 'split' && <div className="split-row conflict-sides"><span>Incoming</span><span>Current</span></div>}
      {open && (editor
        ? <EditableDiff edit={editor} path={path} hunks={file.hunks} layout={layout} language={language} fallback={hunks()} />
        : hunks())}
    </section>
  )
})

// Rows mount in chunks, and only near the screen: a large diff costs about one screen of rows to render, toggle or
// scroll. Chunks above and below keep their last measured height, so the scrollbar and scroll position hold still.
const CHUNK_ROWS = 50
// Unified and split rows are one 22px line unless a long line wraps; the first mount replaces this estimate.
const ROW_ESTIMATE = 22

function chunked(rows: number, render: (start: number, end: number) => ReactNode): ReactNode[] {
  const out: ReactNode[] = []
  for (let start = 0; start < rows; start += CHUNK_ROWS) out.push(render(start, Math.min(rows, start + CHUNK_ROWS)))
  return out
}

function range(start: number, end: number) {
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
function RowChunk({ rows, lines, pinned, render }: { rows: number; lines: string; pinned: boolean; render: () => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // Without an observer (server rendering, tests) every row renders.
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined')
  const height = useRef(rows * ROW_ESTIMATE)
  // The first frame already shows the rows on screen: the chunk measures itself before paint instead of waiting for the observer.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const box = element.getBoundingClientRect()
    if (box.bottom > -1200 && box.top < window.innerHeight + 1200) setNear(true)
    return observeChunk(element, (next) => {
      if (!next && element.firstChild) height.current = element.offsetHeight
      setNear(next)
    })
  }, [])
  const show = near || pinned
  return <div ref={ref} className="row-chunk" data-lines={lines} style={show ? undefined : { height: height.current }}>{show ? render() : null}</div>
}

// Only the selected view restores its pane, even when staged and unstaged diffs share that pane.
// The pane keeps its existing scroll handler, so session persistence records the corrected position too.
function useSourceAnchor(containerRef: React.RefObject<HTMLDivElement | null>, layout: DiffLayout, formatted: boolean, files: DiffFile[]) {
  const saved = useRef<{ source: string; side?: string; offset: number } | null>(null)
  const previous = useRef({ layout, formatted, files })
  useLayoutEffect(() => {
    const container = containerRef.current
    const pane = container?.closest<HTMLElement>('.diff-pane')
    if (!container || !pane) return
    const changed = previous.current.layout !== layout || previous.current.formatted !== formatted
    if (changed && previous.current.files === files && saved.current) {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-source-row]')].filter((element) => element.dataset.sourceRow === saved.current!.source)
      const row = rows.find(element => element.dataset.sourceSide === saved.current!.side) ?? rows.find(element => !element.dataset.sourceSide || element.dataset.sourceSide === 'both') ?? rows[0]
      if (row) pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.current.offset
    }
    saved.current = null
    previous.current = { layout, formatted, files }
    const remember = () => {
      saved.current = null
      const box = pane.getBoundingClientRect()
      const toolbar = container.querySelector('.diff-toolbar')?.getBoundingClientRect()
      const top = Math.max(box.top, toolbar?.bottom ?? box.top) + 42
      const row = [...container.querySelectorAll<HTMLElement>('[data-source-row]')].find((element) => element.getBoundingClientRect().bottom > top)
      if (!row || row.getBoundingClientRect().top >= box.bottom) return
      const topOfRow = row.getBoundingClientRect().top
      const anchor = { source: row.dataset.sourceRow!, side: row.dataset.sourceSide, offset: topOfRow - box.top }
      return { pane, top: topOfRow, select: () => { saved.current = anchor } }
    }
    sourceAnchors.add(remember)
    return () => { sourceAnchors.delete(remember) }
  }, [containerRef, layout, formatted, files])
}

interface Arrow {
  d: string
  // Unified connectors end in an arrowhead at the new line.
  head: boolean
}

// The unified connector lane is 28px wide (styles.css `.lane`). Connectors use its first columns, and the arrowhead
// stops 2px before the code.
const LANE_END = 26
const LANE_FIRST = 5
const LANE_STEP = 5
const LANE_COLUMNS = 3

// Colours per file, kept with the file. A diff shown again (a toggle back, a cached reload) has its colours at once; new
// files show plain text until theirs arrive, each file re-rendering alone as its colours land.
const colours = new WeakMap<DiffFile, { overrides: Record<string, string>; tokens: Segment[][][] }>()

function fileTokens(file: DiffFile, overrides: Record<string, string>) {
  const entry = colours.get(file)
  return entry?.overrides === overrides ? entry.tokens : undefined
}

// Files are coloured one at a time in diff order, so the first files on screen get colours first. A new diff stops the
// old run between slices.
function useTokens(files: DiffFile[], overrides: Record<string, string>) {
  const [, setVersion] = useState(0)
  useEffect(() => {
    let stale = false
    void (async () => {
      for (const file of files) {
        if (fileTokens(file, overrides)) continue
        const tokens = await highlightFile(file, overrides, () => stale)
        if (stale) return
        colours.set(file, { overrides, tokens })
        startTransition(() => setVersion((version) => version + 1))
      }
    })()
    return () => { stale = true }
  }, [files, overrides])
}

// The changed words of each paired line, per hunk. Pure text work, so it does not wait for colours. Worked out only for a
// hunk on screen, since a collapsed file shows none, and kept with the hunk so a re-render does not compare again.
const intra = new WeakMap<DiffHunk, Map<number, Span[]>>()
function spansOf(hunk: DiffHunk) {
  let spans = intra.get(hunk)
  if (!spans) intra.set(hunk, (spans = intralineSpans(hunk.lines)))
  return spans
}

// Text is rendered as React text nodes, so code never reaches the DOM as markup. Changed spans wrap their pieces in `.intra`.
function Code({ text, segments, changed }: { text: string; segments?: Segment[]; changed?: Span[] }) {
  if (!segments && !changed?.length) return <code>{text}</code>
  const pieces: Piece[] = changed?.length
    ? emphasize(text, segments ?? [{ text }], changed)
    : (segments ?? []).map((segment) => ({ ...segment, changed: false }))
  return (
    <code>
      {pieces.map((piece, index) => (piece.light || piece.dark || piece.changed
        ? <span key={index} className={`${piece.light || piece.dark ? 'tok' : ''} ${piece.changed ? 'intra' : ''}`.trim()} style={{ '--tok-light': piece.light, '--tok-dark': piece.dark } as CSSProperties}>{piece.text}</span>
        : <span key={index}>{piece.text}</span>))}
    </code>
  )
}

// The label gets its own line above the moved line, so it never takes code width or covers code.
export function UnifiedLine({ line, segments, changed, label, anchor, source, className }: { line: DiffLine; segments?: Segment[]; changed?: Span[]; label?: string; anchor?: string; source?: string; className?: string }) {
  return (
    <>
      {label && <div className="move-note lane-note">{label}</div>}
      <div className={`line ${line.type}${label ? ' moved' : ''}${className ? ` ${className}` : ''}`} data-move-id={anchor} data-source-row={source}>
        <span className="lane" aria-hidden="true" />
        <span className="gutter">{line.oldNo ?? ''}</span>
        <span className="gutter">{line.newNo ?? ''}</span>
        <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
        <Code text={line.text} segments={segments} changed={label ? undefined : changed} />
      </div>
    </>
  )
}

// The first and last line numbers of a hunk. The expand rows above and below name them.
function edgeLines(lines: DiffLine[]) {
  const numbers = lines.map((line) => line.newNo ?? line.oldNo ?? 0)
  return { first: numbers[0], last: numbers[numbers.length - 1] }
}

// A row above or below a hunk that asks for more context. Its look is in styles.css, which the CSS fixer owns.
function ExpandRow({ onExpand, label }: { onExpand: () => void; label: string }) {
  return (
    <div className="hunk-expand">
      <button className="hunk-expand-btn" title="Show more context" aria-label={label} onClick={onExpand}>
        <Icon name="unfold" />
      </button>
    </div>
  )
}

export interface IndexedLine {
  line: DiffLine
  index: number
  // A conflict split cell names its line in the preview, on either side.
  number?: number | null
}

export interface SplitRow {
  left: IndexedLine | null
  right: IndexedLine | null
  // Projection may put a later source line on the left; controls still belong to the block's first source row.
  controlIndex?: number
}

// Pairs removed and added lines side by side. Context lines appear on both sides. A run of removals
// followed by additions is paired row by row, and the shorter side is left blank.
export function toRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type !== 'add' && line.type !== 'del') {
      rows.push({ left: { line, index: i }, right: { line, index: i } })
      i++
      continue
    }
    const dels: IndexedLine[] = []
    const adds: IndexedLine[] = []
    while (i < lines.length && lines[i].type === 'del') { dels.push({ line: lines[i], index: i }); i++ }
    while (i < lines.length && lines[i].type === 'add') { adds.push({ line: lines[i], index: i }); i++ }
    const count = Math.max(dels.length, adds.length)
    for (let k = 0; k < count; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return rows
}

export function SplitCell({ cell, side, segments, changed, label, anchor, source, className }: {
  cell: IndexedLine | null
  side: 'old' | 'new'
  segments?: Segment[]
  changed?: Span[]
  label?: string
  anchor?: string
  source?: string
  className?: string
}) {
  if (!cell) return <div className="split-cell empty" aria-hidden="true" />
  const { line } = cell
  const number = cell.number !== undefined ? cell.number : side === 'old' ? line.oldNo : line.newNo
  return (
    <div className={`split-cell ${line.type}${label ? ' moved' : ''}${className ? ` ${className}` : ''}`} data-move-id={anchor} data-source-row={source}>
      <span className="gutter">{number ?? ''}</span>
      <Code text={line.text} segments={segments} changed={label ? undefined : changed} />
    </div>
  )
}

interface MarkdownHunkProps {
  lines: DiffLine[]
  changes: Map<number, Span[]>
  layout: DiffLayout
  prefix: string
  labels: Map<string, string>
  anchors: Map<string, string>
}

// Formatting parses both whole sides of a hunk, its context included, so a hunk past these sizes shows the source diff
// instead. They are a conservative bound on that work, not a measured threshold, and are counted before any source is built.
const MARKDOWN_MAX_ROWS = 5_000
const MARKDOWN_MAX_CHARS = 200_000

function fitsMarkdown(lines: DiffLine[]) {
  if (lines.length > MARKDOWN_MAX_ROWS) return false
  let chars = 0
  // Each row's UTF-16 length plus the line break that joins it to the next.
  for (const line of lines) if ((chars += line.text.length + 1) > MARKDOWN_MAX_CHARS) return false
  return true
}

// The plan is built here, so only hunks of open files are parsed. A collapsed file parses when it is opened.
function MarkdownHunkView({ lines, changes, layout, prefix, labels, anchors }: MarkdownHunkProps) {
  const plan = useMemo(() => markdownHunk(lines, changes, toRows(lines).map(row => [row.left?.index ?? null, row.right?.index ?? null]),
    new Set(lines.flatMap((_, index) => labels.has(`${prefix}:${index}`) ? [index] : []))), [lines, changes, prefix, labels])
  return (
    <div className={`md-hunk md-${layout}`}>
      {lines.length > 0 && <div className="md-fragment-note">Visible Markdown fragment. Source gutters identify original lines.</div>}
      {plan.groups.map(group => {
        const indices = Array.from({ length: group.end - group.start + 1 }, (_, index) => group.start + index)
        const before = indices.filter(index => lines[index].type !== 'add')
        const after = indices.filter(index => lines[index].type !== 'del')
        const paired = group.rows
        const pane = (side: 'old' | 'new', slots: Array<number | null>) => {
          const nodes = side === 'old' ? group.old : group.new
          const parsed: MarkdownSide = side === 'old' ? plan.old : plan.new
          if (!slots.some(index => index !== null)) return <div className="split-cell empty md-empty-block" aria-hidden="true" />
          return (
            <div className={`md-diff-block${!group.unchanged ? ` md-${side === 'old' ? 'before' : 'after'}` : ''}`} role={group.unchanged ? undefined : 'group'} aria-label={group.unchanged ? undefined : side === 'old' ? 'Previous Markdown source' : 'Current Markdown source'}>
              <div className="md-source-rail">
                {slots.map((index, slot) => {
                  if (index === null) return <div key={`gap-${slot}`} className="split-cell empty md-source-gap" aria-hidden="true" />
                  const line = lines[index]
                  const source = `${prefix}:${index}`
                  const move = labels.get(source)
                  return (
                    <div key={index} className={`md-source-row ${line.type}${move ? ' moved' : ''}`} data-move-id={anchors.get(source)} data-source-row={source} data-source-side={group.unchanged && layout === 'unified' ? 'both' : side} title={move ?? `Source line ${line.oldNo ?? line.newNo ?? 'note'}. Gutters map source lines to this formatted block.`}>
                      {layout === 'unified' && <span className="lane" aria-hidden="true" />}
                      {layout === 'unified' ? <><span className="gutter">{line.oldNo ?? ''}</span><span className="gutter">{line.newNo ?? ''}</span></> : <span className="gutter">{(side === 'old' ? line.oldNo : line.newNo) ?? ''}</span>}
                      <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                    </div>
                  )
                })}
              </div>
              <div className="md-content">
                {slots.flatMap(index => index !== null && labels.has(`${prefix}:${index}`) ? [<div key={index} className="move-note">{labels.get(`${prefix}:${index}`)}</div>] : [])}
                <MarkdownContent nodes={nodes} side={parsed} />
                {slots.flatMap(index => index !== null && lines[index].type === 'note' ? [<p key={index} className="md-note">{lines[index].text}</p>] : [])}
              </div>
            </div>
          )
        }
        return <Fragment key={group.start}>{layout === 'split'
          ? <div className="split-row md-block-pair">{pane('old', paired.map(row => row[0]))}{pane('new', paired.map(row => row[1]))}</div>
          : group.unchanged ? pane('new', after)
            : <>{before.length > 0 && pane('old', before)}{after.length > 0 && pane('new', after)}</>}</Fragment>
      })}
    </div>
  )
}

// The sticky header for one file: optional stage checkbox, collapse toggle, status, name with its folder,
// and how many lines were added and removed.
function FileHeader({ file, stat, open, onToggle, stage, actions }: {
  file: DiffFile
  stat: { adds: number; dels: number }
  open: boolean
  onToggle: () => void
  stage?: Props['stage']
  actions?: ReactNode
}) {
  const path = pathOf(file)
  const { name, dir } = splitPath(path)
  const editor = useContext(EditorContext)
  return (
    <header>
      {stage && (
        <span className="diff-file-stage">
          <input
            type="checkbox"
            checked={stage.staged}
            aria-label={`Stage ${path}`}
            disabled={stage.disabled}
            onChange={() => stage.onToggle(path, !stage.staged)}
          />
        </span>
      )}
      <button className="diff-file-toggle" aria-expanded={open} aria-label={open ? toggleLabel(`${path}: expanded`, 'collapse it') : toggleLabel(`${path}: collapsed`, 'expand it')}
        title={open ? 'Expanded — click to collapse' : 'Collapsed — click to expand'} onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevron'} />
      </button>
      <span className={`kind kind-${file.status}`}>{STATUS_LETTER[file.status]}</span>
      <span className="path">
        <span className="path-name">{name}</span>
        {dir && <span className="path-dir">{dir}</span>}
      </span>
      <span className="stat" aria-label={`${stat.adds} added, ${stat.dels} removed`}>
        <span className="add">+{stat.adds}</span>
        <span className="del">−{stat.dels}</span>
      </span>
      {actions}
      {editor && <OpenInEditorButton file={file} bridge={editor} />}
    </header>
  )
}

// Opens the file's working copy in the chosen editor. A deleted status does not say whether the file exists now (a staged
// or past deletion may have been recreated), so the main process checks it and reports a missing one.
function OpenInEditorButton({ file, bridge }: { file: DiffFile; bridge: EditorBridge }) {
  const path = pathOf(file)
  const { label } = EDITORS[bridge.editor]
  const { busy, open } = useEditorLaunch(() => bridge.openFile(path), bridge.onError)
  const commit = bridge.source === 'commit'
  const target = commit ? `working copy of ${path}` : path
  // The wrapper stops the click before it reaches any ancestor that might collapse or select the file.
  return (
    <span className="diff-file-open" onClick={(event) => event.stopPropagation()}>
      <IconButton
        icon="externalLink"
        label={busy ? `Opening ${target} in ${label}…` : `Open ${target} in ${label}`}
        busy={busy}
        onClick={open}
      />
    </span>
  )
}

// One letter per file status, matching the badges in the file list.
const STATUS_LETTER: Record<DiffFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' }

// Lock files churn without being read, and very large diffs bury the rest of the list, so both start collapsed.
const LARGE_DIFF_LINES = 400
const GENERATED_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml'])

function startsCollapsed(file: DiffFile, changed: number) {
  const { name } = splitPath(pathOf(file))
  // `.lock` covers bun.lock and yarn.lock.
  return name.endsWith('.lock') || GENERATED_NAMES.has(name) || changed > LARGE_DIFF_LINES
}

function pathOf(file: DiffFile) {
  return file.newPath ?? file.oldPath ?? ''
}

export function countLines(file: DiffFile) {
  const lines = file.hunks.flatMap((hunk) => hunk.lines)
  return {
    adds: lines.filter((line) => line.type === 'add').length,
    dels: lines.filter((line) => line.type === 'del').length,
  }
}

function key(file: number, hunk: number, line: number) {
  return `${file}:${hunk}:${line}`
}

// Labels and anchors for the first line of each side of every moved block. Within one file the label gives a
// line number; across files it names the other file. Anchors are the ids the arrow overlay measures.
function indexMoves(files: DiffFile[], moves: MovedBlock[]) {
  const labels = new Map<string, string>()
  const anchors = new Map<string, string>()
  const name = (ref: LineRef) => files[ref.file].newPath ?? files[ref.file].oldPath ?? '?'
  const lineOf = (ref: LineRef) => files[ref.file].hunks[ref.hunk].lines[ref.line]
  moves.forEach((move, index) => {
    const from = move.from[0]
    const to = move.to[0]
    const sameFile = from.file === to.file
    labels.set(
      key(from.file, from.hunk, from.line),
      sameFile ? `moved to line ${lineOf(to).newNo}` : `moved to ${name(to)}`,
    )
    labels.set(
      key(to.file, to.hunk, to.line),
      sameFile ? `moved from line ${lineOf(from).oldNo}` : `moved from ${name(from)}`,
    )
    anchors.set(key(from.file, from.hunk, from.line), `${index}-from`)
    anchors.set(key(to.file, to.hunk, to.line), `${index}-to`)
  })
  return { labels, anchors }
}
