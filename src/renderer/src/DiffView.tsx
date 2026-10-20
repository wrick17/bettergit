import { Fragment, memo, startTransition, useCallback, useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { DiffFile, DiffHunk, DiffLine, LineRef, MovedBlock } from '../../main/git/diff'
import type { HunkAction } from '../../main/git/hunks'
import { EditorContext, useEditorLaunch, type EditorBridge } from './editor-launch'
import { Icon, IconButton, TextToggle, toggleLabel, type IconName } from './Icons'
import { splitPath } from './paths'
import { CONTEXT_OPTIONS, setContextLines, setFormatMarkdown, setIgnoreWhitespace, setWordWrap, useContextLines, useFormatMarkdown, useIgnoreWhitespace, useLanguageOverrides, useWordWrap } from './prefs'
import { charWidth, columns, hscrollOf, useCodeMetrics } from './hscroll'
import { cachedFileTokens, highlightFile, languageFor, warmColours, type Segment } from './highlight'
import { emphasize, intralineSpans, type Piece, type Span } from './intraline'
import { savedView, saveView } from './session'
import { isMarkdownPath, MarkdownContent, markdownHunk, type MarkdownSide } from './MarkdownLine'
import { DraftActions, EditableDiff, prepareSource, useUnsaved, type EditBridge } from './DiffEditor'
import { blockedReason, workingLabel } from './repo-busy'
import { useFindSource } from './find'
import { chunked, range, RowChunk } from './row-chunk'
import { holdPlace, suspendHold } from './scroll-anchor'
import './intraline.css'

interface Props {
  files: DiffFile[]
  moves: MovedBlock[]
  // Set in the Changes view. Each file header then shows Stage or Unstage, and Discard for a tracked unstaged file.
  // `busy` is the write running in the repo: the button that started it spins, the others say why they wait.
  // `onHunk`, when set, adds the same actions to each hunk of a modified text file.
  stage?: {
    staged: boolean
    busy?: string | null
    onToggle: (path: string, stage: boolean) => void
    onDiscard?: (path: string) => void
    onHunk?: (path: string, hunk: DiffHunk, action: HunkAction) => void
  }
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
  // False when the caller shows the layout controls itself, as the conflict resolver does in each file's bar.
  toolbar?: boolean
  // The view the files belong to, set where files change by refresh, not by the user's hand. While it stays the same, a
  // refresh waits briefly for the colours of new or changed files, so they paint coloured instead of plain then coloured.
  refreshOf?: string
  // Called once the files passed in are the ones on screen, after the deferred render and any refresh wait.
  onShown?: (files: DiffFile[]) => void
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
export const DiffView = memo(function DiffView({ files: nextFiles, moves: nextMoves, stage, onExpand, persist, conflict, emptyHint, edit, toolbar = true, refreshOf, onShown }: Props) {
  const layoutNow = useDiffLayout()
  const context = useContextLines()
  const ignoreWhitespace = useIgnoreWhitespace()
  const formatNow = useFormatMarkdown()
  const wrap = useWordWrap()
  const overrides = useLanguageOverrides()
  const { files, moves } = useColouredFirst(nextFiles, nextMoves, refreshOf, overrides, edit)
  // The toolbar shows a toggle at once. The diff under it re-renders from these deferred copies, in the background and
  // interruptibly, so a click, scroll or second toggle never waits for a large diff to rebuild.
  const shown = useDeferredValue(useMemo(() => ({ files, moves, layout: layoutNow, format: formatNow }), [files, moves, layoutNow, formatNow]))
  const onShownRef = useRef(onShown)
  onShownRef.current = onShown
  useLayoutEffect(() => {
    if (shown.files === nextFiles) onShownRef.current?.(nextFiles)
  }, [shown.files, nextFiles])
  const current = shown.layout
  const formatMarkdown = shown.format
  const { labels, anchors } = useMemo(() => indexMoves(shown.files, shown.moves), [shown])
  const stats = useMemo(() => shown.files.map(countLines), [shown])
  // Conflict markers are source, so a conflicted file is never formatted.
  const formatted = formatMarkdown && !conflict
  useTokens(shown.files, overrides)
  usePreparedMarkdown(shown.files, labels, formatted || !!conflict)
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
  const stageFor = useMemo(() => stage && {
    staged: stage.staged,
    busy: stage.busy,
    onToggle: (path: string, next: boolean) => latest.current.stage?.onToggle(path, next),
    onDiscard: stage.onDiscard && ((path: string) => latest.current.stage?.onDiscard?.(path)),
    onHunk: stage.onHunk && ((path: string, hunk: DiffHunk, action: HunkAction) => latest.current.stage?.onHunk?.(path, hunk, action)),
  }, [!!stage, stage?.staged, stage?.busy, !!stage?.onDiscard, !!stage?.onHunk])
  const expand = useMemo(() => onExpand && ((file: DiffFile) => latest.current.onExpand?.(file)), [!!onExpand])
  const editFor = useMemo<EditBridge | undefined>(() => edit && {
    repo: edit.repo,
    disabled: edit.disabled,
    load: (path) => latest.current.edit!.load(path),
    save: (path, loaded, text) => latest.current.edit!.save(path, loaded, text),
    onError: (error) => latest.current.edit!.onError(error),
  }, [!!edit, edit?.repo, edit?.disabled])

  useSourceAnchor(containerRef, current, formatMarkdown, shown.files, wrap)
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
    <div className={`diff${wrap ? '' : ' nowrap'}`} ref={containerRef}>
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
      {toolbar && <div className="diff-toolbar">
        <span className="moves">
          {moves.length > 0 ? `${moves.length} moved block${moves.length === 1 ? '' : 's'} detected` : ''}
        </span>
        <div className="diff-toolbar-controls">
          {!onExpand && (
            // Each option's tooltip names the group, since the options are what the pointer rests on.
            <div className="context-toggle" role="group" aria-label="Lines of unchanged context around each change">
              {CONTEXT_OPTIONS.map((value) => {
                const lines = value === 100000 ? 'All lines' : `${value} lines`
                return (
                  <TextToggle
                    key={value}
                    text={value === 100000 ? 'All' : String(value)}
                    label={context === value
                      ? `${lines} of unchanged context around each change: on`
                      : toggleLabel(`${lines} of unchanged context around each change: off`, `show ${lines.toLowerCase()}`)}
                    active={context === value}
                    onClick={() => setContextLines(value)}
                  />
                )
              })}
            </div>
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
          <LayoutToggles />
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
      </div>}
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
            key={path}
            file={file}
            fileIndex={fileIndex}
            stat={stat}
            open={open}
            onToggle={toggleFile}
            layout={current}
            formatted={formatted}
            language={languageFor(path, overrides)}
            tokens={open ? fileTokens(file, overrides) : undefined}
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

// The layout and word wrap toggles. Both are app-wide, so every diff on screen follows them.
export function LayoutToggles() {
  const layoutNow = useDiffLayout()
  const wrap = useWordWrap()
  return (
    <>
      <div className="diff-layout-toggle" role="group" aria-label="Diff layout">
        <IconButton icon="rows" label={layoutNow === 'unified' ? 'Unified layout: on' : toggleLabel('Unified layout: off', 'show one column')} active={layoutNow === 'unified'} onClick={() => setDiffLayout('unified')} />
        <IconButton icon="columns" label={layoutNow === 'split' ? 'Split layout: on' : toggleLabel('Split layout: off', 'show side by side')} active={layoutNow === 'split'} onClick={() => setDiffLayout('split')} />
      </div>
      {/* Long lines wrap, or scroll sideways per file. Formatted Markdown is prose, so it always wraps. */}
      <div className="diff-layout-toggle" role="group" aria-label="Word wrap">
        <IconButton
          icon="wrap"
          label={wrap ? toggleLabel('Word wrap: on', 'scroll long lines') : toggleLabel('Word wrap: off', 'wrap long lines')}
          active={wrap}
          onClick={() => {
            captureSourceAnchors()
            setWordWrap(!wrap)
          }}
        />
      </div>
    </>
  )
}

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
  // Hunks of a modified text file change one at a time. Not while the file has unsaved edits, which the write could lose.
  const unsaved = useUnsaved(text, path)
  const hunkActions = stage?.onHunk && !conflict && file.status === 'modified' && !file.binary && !unsaved
    ? (hunk: DiffHunk) => <HunkActions path={path} hunk={hunk} stage={stage} />
    : undefined
  // Formatted Markdown is not source, so it stays read-only; the raw view edits it.
  const editor = text && !markdown ? text : undefined
  const sectionRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => (sectionRef.current ? holdPlace(sectionRef.current, true) : undefined), [])
  // Set on the element rather than in the markup, which stays free of style attributes.
  const estimate = estimateHeight(file, open, !!onExpand)
  useLayoutEffect(() => { sectionRef.current?.style.setProperty('--file-estimate', estimate) }, [estimate])
  // The widest line an editable file shows, which can be outside the diff's hunks once folds open.
  const [editorExtent, setEditorExtent] = useState(0)
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
      <UnifiedLine key={lineIndex} line={line} segments={row.segments} className={row.className} changed={spansOf(hunk).get(lineIndex)}
        label={labels.get(source)} anchor={anchors.get(source)} source={source} />
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
      body = <MarkdownHunkView hunk={hunk} layout={layout} prefix={`${fileIndex}:${hunkIndex}`} labels={labels} anchors={anchors} />
    } else if (layout === 'unified') {
      const controls = conflict ? controlsAt(hunk.lines.length, (index) => conflict.controls(hunk, index)) : NO_CONTROLS
      body = chunked(hunk.lines.length, (start, end) => {
        const lines = range(start, end)
        return (
          <Fragment key={start}>
            {controls.get(start)}
            <RowChunk rows={end - start} lines={`${fileIndex}:${hunkIndex}:${start}:${end - 1}`} pinned={pinned(lines)}
              render={() => lines.map((lineIndex) => unifiedRow(hunk, hunkIndex, lineIndex))} />
          </Fragment>
        )
      }, [...controls.keys()])
    } else {
      const rows = conflict ? conflict.splitRows(hunk) : toRows(hunk.lines)
      const controls = conflict ? controlsAt(rows.length, (index) => conflict.controls(hunk, rows[index].controlIndex ?? (rows[index].left ?? rows[index].right)!.index)) : NO_CONTROLS
      body = chunked(rows.length, (start, end) => {
        const slice = rows.slice(start, end)
        const lines = slice.flatMap((row) => [row.left?.index, row.right?.index].filter((index): index is number => index !== undefined))
        return (
          <Fragment key={start}>
            {controls.get(start)}
            <RowChunk rows={end - start} lines={`${fileIndex}:${hunkIndex}:${Math.min(...lines)}:${Math.max(...lines)}`} pinned={pinned(lines)}
              render={() => slice.map((row, offset) => splitRow(hunk, hunkIndex, row, start + offset))} />
          </Fragment>
        )
      }, [...controls.keys()])
    }
    return (
      <Fragment key={hunkIndex}>
        {onExpand && <ExpandRow label={`Show more context above line ${edgeLines(hunk.lines).first}`} onExpand={() => onExpand(file)} />}
        <div className="hunk">
          {hunkActions
            ? <div className="hunk-header with-actions"><span className="hunk-title">{hunk.header}</span>{hunkActions(hunk)}</div>
            : <div className="hunk-header">{hunk.header}</div>}
          {markdown && !format && <div className="md-fragment-note">Too large to format as Markdown. Showing the source diff.</div>}
          {body}
          {conflict?.controls(hunk, hunk.lines.length)}
        </div>
        {onExpand && <ExpandRow label={`Show more context below line ${edgeLines(hunk.lines).last}`} onExpand={() => onExpand(file)} />}
      </Fragment>
    )
  })
  return (
    <section ref={sectionRef} className={`diff-file${editor ? ' editable' : ''}`} data-path={path} data-file-index={fileIndex}>
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
        ? <EditableDiff edit={editor} path={path} hunks={file.hunks} layout={layout} language={language} fallback={hunks()} fileIndex={fileIndex} onExtent={setEditorExtent} hunkActions={hunkActions} />
        : hunks())}
      {open && !markdown && file.hunks.length > 0 && <HScrollBar file={file} extra={editor ? editorExtent : 0} />}
    </section>
  )
})

// A conflict's controls by the row they sit above. They stay mounted between the row chunks, so Tab reaches every
// conflict and a focused control is never unmounted by scrolling.
const NO_CONTROLS = new Map<number, ReactNode>()
function controlsAt(rows: number, at: (index: number) => ReactNode) {
  const found = new Map<number, ReactNode>()
  for (let index = 0; index < rows; index++) {
    const node = at(index)
    if (node) found.set(index, node)
  }
  return found
}

// Only the selected view restores its pane, even when staged and unstaged diffs share that pane.
// The pane keeps its existing scroll handler, so session persistence records the corrected position too.
function useSourceAnchor(containerRef: React.RefObject<HTMLDivElement | null>, layout: DiffLayout, formatted: boolean, files: DiffFile[], wrap: boolean) {
  const saved = useRef<{ source: string; side?: string; offset: number } | null>(null)
  const previous = useRef({ layout, formatted, files, wrap })
  useLayoutEffect(() => {
    const container = containerRef.current
    const pane = container?.closest<HTMLElement>('.diff-pane')
    if (!container || !pane) return
    const changed = previous.current.layout !== layout || previous.current.formatted !== formatted || previous.current.wrap !== wrap
    if (changed && previous.current.files === files && saved.current) {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-source-row]')].filter((element) => element.dataset.sourceRow === saved.current!.source)
      const row = rows.find(element => element.dataset.sourceSide === saved.current!.side) ?? rows.find(element => !element.dataset.sourceSide || element.dataset.sourceSide === 'both') ?? rows[0]
      if (row) {
        pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - saved.current.offset
        // The row is placed already, so chunks resizing in this switch do not move the pane again.
        suspendHold(pane)
      }
    }
    saved.current = null
    previous.current = { layout, formatted, files, wrap }
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
  }, [containerRef, layout, formatted, files, wrap])
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
// The last colours of each path's lines. A file reloaded after an edit paints its unchanged lines coloured while its own
// colours load. shortcut: cleared whole past 500 paths; an LRU is worth it only if a clear is ever seen.
const linesByPath = new Map<string, Map<string, Segment[]>>()

// The file's own colours, also when the same code was coloured before under another file object (a refresh).
function exactTokens(file: DiffFile, overrides: Record<string, string>) {
  const entry = colours.get(file)
  if (entry?.overrides === overrides) return entry.tokens
  const tokens = cachedFileTokens(file, overrides)
  if (tokens) keepColours(file, overrides, tokens)
  return tokens
}

function keepColours(file: DiffFile, overrides: Record<string, string>, tokens: Segment[][][]) {
  colours.set(file, { overrides, tokens })
  if (linesByPath.size > 500) linesByPath.clear()
  const lines = new Map<string, Segment[]>()
  file.hunks.forEach((hunk, hunkIndex) => hunk.lines.forEach((line, lineIndex) => lines.set(line.text, tokens[hunkIndex][lineIndex])))
  linesByPath.set(pathOf(file), lines)
}

// Until a file's own colours arrive, its lines borrow the colours they had in the path's last coloured version, also from
// before a theme or language change, so a re-colour swaps colours instead of flashing plain text.
function fileTokens(file: DiffFile, overrides: Record<string, string>) {
  const tokens = exactTokens(file, overrides)
  if (tokens) return tokens
  const last = linesByPath.get(pathOf(file))
  if (!last) return undefined
  return file.hunks.map((hunk) => hunk.lines.map((line) => last.get(line.text) ?? [{ text: line.text }]))
}

// The files to show. A refresh that keeps some of the paths on screen holds the shown files until the new or changed
// ones are coloured, and new editable files have their editor-look rows, for at most WARM_MS. Other changes (a first
// load, another view) show at once.
const WARM_MS = 150
function useColouredFirst(files: DiffFile[], moves: MovedBlock[], view: string | undefined, overrides: Record<string, string>, edit?: EditBridge) {
  const [settled, setSettled] = useState({ files, moves, view })
  const editRef = useRef(edit)
  editRef.current = edit
  const pending = useMemo(() => {
    if (view === undefined || settled.view !== view || settled.files === files) return null
    const shownPaths = new Set(settled.files.map(pathOf))
    if (!files.some((file) => shownPaths.has(pathOf(file)))) return null
    const uncoloured = files.filter((file) => !exactTokens(file, overrides))
    const added = edit ? files.filter((file) => !shownPaths.has(pathOf(file)) && !file.binary && file.status !== 'deleted') : []
    return uncoloured.length || added.length ? { uncoloured, added } : null
  }, [view, settled, files, overrides, !!edit])
  useEffect(() => {
    if (settled.files === files && settled.moves === moves && settled.view === view) return
    if (!pending) return setSettled({ files, moves, view })
    let stale = false
    const bridge = editRef.current
    const sources = bridge ? pending.added.map((file) => prepareSource(bridge, pathOf(file), file.hunks, languageFor(pathOf(file), overrides))) : []
    const ready = Promise.all([warmColours(pending.uncoloured, overrides, WARM_MS), ...sources])
    void Promise.race([ready, new Promise((resolve) => setTimeout(resolve, WARM_MS))]).then(() => { if (!stale) setSettled({ files, moves, view }) })
    return () => { stale = true }
  }, [files, moves, view, pending])
  return pending ? settled : { files, moves }
}

// Files are coloured one at a time in diff order, so the first files on screen get colours first. A new diff stops the
// old run between slices.
function useTokens(files: DiffFile[], overrides: Record<string, string>) {
  const [, setVersion] = useState(0)
  useEffect(() => {
    let stale = false
    void (async () => {
      for (const file of files) {
        if (exactTokens(file, overrides)) continue
        const tokens = await highlightFile(file, overrides, () => stale)
        if (stale) return
        keepColours(file, overrides, tokens)
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
// The inner `.sx` span carries the text: with word wrap off it is what slides sideways, so the row itself never lays out again.
export function Code({ text, segments, changed, changedClass = 'intra' }: { text: string; segments?: Segment[]; changed?: Span[]; changedClass?: string }) {
  if (!segments && !changed?.length) return <code><span className="sx">{text}</span></code>
  const pieces: Piece[] = changed?.length
    ? emphasize(text, segments ?? [{ text }], changed)
    : (segments ?? []).map((segment) => ({ ...segment, changed: false }))
  return (
    <code>
      <span className="sx">
        {pieces.map((piece, index) => (piece.light || piece.dark || piece.changed
          ? <span key={index} className={`${piece.light || piece.dark ? 'tok' : ''} ${piece.changed ? changedClass : ''}`.trim()} style={{ '--tok-light': piece.light, '--tok-dark': piece.dark } as CSSProperties}>{piece.text}</span>
          : <span key={index}>{piece.text}</span>))}
      </span>
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
  hunk: DiffHunk
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

// Parsed Markdown per hunk, kept with the hunk, so the formatted view built in idle time (or shown before) is ready at
// once. Keyed by the hunk's moved lines too, since the plan marks them.
const plans = new WeakMap<DiffLine[], { moved: string; plan: ReturnType<typeof markdownHunk> }>()
function planOf(hunk: DiffHunk, prefix: string, labels: Map<string, string>) {
  const { lines } = hunk
  const moved = lines.flatMap((_, index) => (labels.has(`${prefix}:${index}`) ? [index] : []))
  const key = moved.join(',')
  const cached = plans.get(lines)
  if (cached?.moved === key) return cached.plan
  const plan = markdownHunk(lines, spansOf(hunk), toRows(lines).map(row => [row.left?.index ?? null, row.right?.index ?? null]), new Set(moved))
  plans.set(lines, { moved: key, plan })
  return plan
}

// While raw Markdown shows, its formatted plans are built in idle time, one hunk per slice, so the first switch to
// formatted only renders. A new diff or switching formatting on stops the run.
function usePreparedMarkdown(files: DiffFile[], labels: Map<string, string>, active: boolean) {
  useEffect(() => {
    if (active || !window.requestIdleCallback) return
    const work: Array<() => void> = []
    files.forEach((file, fileIndex) => {
      if (!isMarkdownPath(pathOf(file))) return
      file.hunks.forEach((hunk, hunkIndex) => { if (fitsMarkdown(hunk.lines)) work.push(() => planOf(hunk, `${fileIndex}:${hunkIndex}`, labels)) })
    })
    let handle = 0
    const next = (deadline: IdleDeadline) => {
      while (work.length && deadline.timeRemaining() > 2) work.shift()!()
      if (work.length) handle = window.requestIdleCallback(next)
    }
    if (work.length) handle = window.requestIdleCallback(next)
    return () => window.cancelIdleCallback(handle)
  }, [files, labels, active])
}

// Formatted groups mount in chunks of about this many source lines, near the screen, like raw rows.
const MARKDOWN_CHUNK_LINES = 50

// The plan is built here (or comes from idle time), so only hunks of open files are parsed. A collapsed file parses when
// it is opened.
function MarkdownHunkView({ hunk, layout, prefix, labels, anchors }: MarkdownHunkProps) {
  const { lines } = hunk
  const plan = useMemo(() => planOf(hunk, prefix, labels), [hunk, prefix, labels])
  // Groups in chunks; a chunk holding a move's end stays mounted, so its connector has both ends.
  const parts = useMemo(() => {
    const out: Array<{ start: number; end: number; lines: number; pinned: boolean }> = []
    plan.groups.forEach((group, index) => {
      const last = out[out.length - 1]
      const size = group.end - group.start + 1
      const pinned = Array.from({ length: size }, (_, offset) => anchors.has(`${prefix}:${group.start + offset}`)).some(Boolean)
      if (last && last.lines < MARKDOWN_CHUNK_LINES) {
        last.end = index + 1
        last.lines += size
        last.pinned ||= pinned
      } else out.push({ start: index, end: index + 1, lines: size, pinned })
    })
    return out
  }, [plan, anchors, prefix])
  const renderGroup = (group: (typeof plan.groups)[number]) => {
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
  }
  return (
    <div className={`md-hunk md-${layout}`}>
      {lines.length > 0 && <div className="md-fragment-note">Visible Markdown fragment. Source gutters identify original lines.</div>}
      {parts.map((part) => (
        <RowChunk key={part.start} rows={part.lines} pinned={part.pinned} lines={`${prefix}:${plan.groups[part.start].start}:${plan.groups[part.end - 1].end}`}
          render={() => plan.groups.slice(part.start, part.end).map(renderGroup)} />
      ))}
    </div>
  )
}

// The sticky header for one file: collapse toggle, status, name with its folder, how many lines were added and
// removed, then its actions.
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
      {stage && <FileStageActions file={file} path={path} stage={stage} />}
    </header>
  )
}

// The busy keys of staging writes, shared with the Changes view, so the button that started a write is the one that spins.
export const fileKey = (action: HunkAction, path: string) => `${action}:${path}`
export const hunkKey = (action: HunkAction, path: string, header: string) => `hunk-${action}:${path}\n${header}`

function StageButton({ busy, running, ...button }: { busy: string | null; running: string; icon: IconName; text: string; label: string; className?: string; onClick: () => void }) {
  return <IconButton {...button} label={busy === running ? workingLabel(running) : button.label} busy={busy === running}
    blocked={busy !== null && busy !== running ? blockedReason(busy) : undefined} />
}

// Discard and Stage in an unstaged file's header, Unstage in a staged one. An untracked file has nothing to discard.
function FileStageActions({ file, path, stage }: { file: DiffFile; path: string; stage: NonNullable<Props['stage']> }) {
  const busy = stage.busy ?? null
  return (
    <span className="diff-file-actions">
      {stage.staged
        ? <StageButton busy={busy} running={fileKey('unstage', path)} icon="minus" text="Unstage" label={`Unstage ${path}`} onClick={() => stage.onToggle(path, false)} />
        : (
          <>
            {stage.onDiscard && file.status !== 'added' && (
              <StageButton busy={busy} running={fileKey('discard', path)} icon="trash" text="Discard" label={`Discard changes to ${path}`} className="discard" onClick={() => stage.onDiscard!(path)} />
            )}
            <StageButton busy={busy} running={fileKey('stage', path)} icon="plus" text="Stage" label={`Stage ${path}`} onClick={() => stage.onToggle(path, true)} />
          </>
        )}
    </span>
  )
}

// The same actions for one hunk, in its header row, or in the editable view's row above the hunk's first change.
function HunkActions({ path, hunk, stage }: { path: string; hunk: DiffHunk; stage: NonNullable<Props['stage']> }) {
  const busy = stage.busy ?? null
  const line = edgeLines(hunk.lines).first
  const button = (action: HunkAction, icon: IconName, text: string, className?: string) => (
    <StageButton busy={busy} running={hunkKey(action, path, hunk.header)} icon={icon} text={text} label={`${text} at line ${line} of ${path}`}
      className={className} onClick={() => stage.onHunk?.(path, hunk, action)} />
  )
  return (
    <span className="hunk-actions">
      {stage.staged ? button('unstage', 'minus', 'Unstage hunk') : <>{button('discard', 'trash', 'Discard hunk', 'discard')}{button('stage', 'plus', 'Stage hunk')}</>}
    </span>
  )
}

// Opens the file's working copy in the chosen editor. A deleted status does not say whether the file exists now (a staged
// or past deletion may have been recreated), so the main process checks it and reports a missing one.
function OpenInEditorButton({ file, bridge }: { file: DiffFile; bridge: EditorBridge }) {
  const path = pathOf(file)
  const label = bridge.app.name
  const { busy, open } = useEditorLaunch(() => bridge.openFile(path), bridge.onError)
  const commit = bridge.source === 'commit'
  const target = commit ? `working copy of ${path}` : path
  // The wrapper stops the click before it reaches any ancestor that might collapse or select the file.
  return (
    <span className="diff-file-open" onClick={(event) => event.stopPropagation()}>
      <IconButton
        icon="externalLink"
        image={bridge.app.icon}
        label={busy ? `Opening ${target} in ${label}…` : `Open ${target} in ${label}`}
        busy={busy}
        onClick={open}
      />
    </span>
  )
}

// A file's sideways scrollbar while word wrap is off. It sticks to the bottom of the pane while the file is on screen.
// Its range is the widest line (from the diff text, so rows not mounted count) less the code column's width.
function HScrollBar({ file, extra }: { file: DiffFile; extra: number }) {
  const wrap = useWordWrap()
  const ref = useRef<HTMLDivElement>(null)
  const spacer = useRef<HTMLDivElement>(null)
  // Only measured while lines scroll sideways.
  const extent = useMemo(() => (wrap ? 0 : columns(file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)), 8)), [file, wrap])
  const metrics = useCodeMetrics()
  useLayoutEffect(() => {
    const bar = ref.current
    const section = bar?.parentElement
    if (wrap || !bar || !section) return
    const controller = hscrollOf(section)
    const size = () => {
      const code = section.querySelector<HTMLElement>('.line > code, .split-cell > code, .ed-line > code, .cm-content')
      const width = code?.clientWidth ?? 0
      // Code pads 20px on the right; editor-look rows pad more on the left, which `extra` already counts.
      const widest = Math.max(extent * charWidth() + 20, extra)
      const range = Math.max(0, Math.ceil(widest - width))
      bar.hidden = false
      spacer.current!.style.width = `${bar.clientWidth + range}px`
      // Hidden with nothing to scroll, so it never sits over the last row.
      bar.hidden = range === 0
      bar.scrollLeft = controller.x
    }
    size()
    const observer = new ResizeObserver(size)
    observer.observe(section)
    const onScroll = () => controller.set(bar.scrollLeft, bar)
    bar.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      bar.removeEventListener('scroll', onScroll)
    }
  }, [wrap, extent, extra, metrics])
  if (wrap) return null
  return <div className="hscroll" ref={ref} aria-hidden="true"><div ref={spacer} /></div>
}

// A file's height before it is laid out: its header, and while open each hunk's header, code-line rows and expand rows.
// A CSS length, so the browser follows a code size change without a render. Wrapped lines make the real one taller;
// the browser keeps the real height once the file has been on screen.
function estimateHeight(file: DiffFile, open: boolean, expandable: boolean) {
  if (!open || !file.hunks.length) return '80px'
  const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  return `calc(${41 + file.hunks.length * (28 + (expandable ? 40 : 0))}px + ${lines} * var(--code-line))`
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
