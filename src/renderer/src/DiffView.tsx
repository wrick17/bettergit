import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { DiffFile, DiffLine, LineRef, MovedBlock } from '../../main/git/diff'
import { Icon, IconButton } from './Icons'
import { splitPath } from './paths'
import { CONTEXT_OPTIONS, setContextLines, useContextLines, useLanguageOverrides } from './prefs'
import { highlightFile, type Segment } from './highlight'
import { savedView, saveView } from './session'

interface Props {
  files: DiffFile[]
  moves: MovedBlock[]
  // Set in the Changes view. Each file header then shows a checkbox. Checked = staged. Disabled while a repository change runs.
  stage?: { staged: boolean; disabled?: boolean; onToggle: (path: string, stage: boolean) => void }
  // Set in the Changes view. Each hunk gets an expand row above and below to show more context for that file.
  onExpand?: (file: DiffFile) => void
  // Where the open and closed choices of each file are saved. The choices come back only for the same key, such as a commit.
  persist?: { id: string; key: string }
}

export type DiffLayout = 'unified' | 'split'

// One layout choice shared by every diff on screen. Kept in the renderer, so it needs no restart.
const LAYOUT_KEY = 'bettergit.diffLayout'
const listeners = new Set<() => void>()
let layout: DiffLayout = localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'

export function setDiffLayout(next: DiffLayout) {
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
export const DiffView = memo(function DiffView({ files, moves, stage, onExpand, persist }: Props) {
  const { labels, anchors } = useMemo(() => indexMoves(files, moves), [files, moves])
  const stats = useMemo(() => files.map(countLines), [files])
  const current = useDiffLayout()
  const context = useContextLines()
  const tokens = useTokens(files, useLanguageOverrides())
  const containerRef = useRef<HTMLDivElement>(null)
  const [arrows, setArrows] = useState<Arrow[]>([])
  const [height, setHeight] = useState(0)
  // The user's open or closed choice per file path. Files without a choice use the default.
  const persistId = persist?.id
  const persistKey = persist?.key
  const [choices, setChoices] = useState<Record<string, boolean>>(() => (persistId !== undefined && persistKey !== undefined ? savedView(persistId, persistKey, {}) : {}))
  useEffect(() => {
    if (persistId !== undefined && persistKey !== undefined) saveView(persistId, persistKey, choices)
  }, [persistId, persistKey, choices])

  // Each moved block gets a curve from its old place to its new one. Positions are measured from the
  // rendered cells, so the arrows follow the layout and survive window resizes.
  useLayoutEffect(() => {
    const container = containerRef.current
    // Arrows only make sense side by side: the old side is on the left, the new side on the right.
    if (!container || !moves.length || current !== 'split') {
      setArrows([])
      return
    }
    const measure = () => {
      const box = container.getBoundingClientRect()
      const place = (id: string) => {
        const element = container.querySelector<HTMLElement>(`[data-move-id="${id}"]`)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { left: rect.left - box.left, right: rect.right - box.left, y: rect.top - box.top + rect.height / 2 }
      }
      const next: Arrow[] = []
      moves.forEach((_, index) => {
        const from = place(`${index}-from`)
        const to = place(`${index}-to`)
        if (!from || !to) return
        // From the right edge of the old-side cell to a 2px gap before the new-side cell, through the channel
        // between the columns. Each arrow bends at its own depth so crossing arrows stay readable.
        const x1 = from.right
        const x2 = to.left - 2
        const depth = x1 + (x2 - x1) * (0.3 + (index % 4) * 0.13)
        next.push({ d: `M ${x1} ${from.y} C ${depth} ${from.y}, ${depth} ${to.y}, ${x2} ${to.y}` })
      })
      setArrows(next)
      setHeight(container.offsetHeight)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [files, moves, current, choices])

  if (!files.length) return <p className="hint">No changes in this view.</p>

  return (
    <div className="diff" ref={containerRef}>
      {arrows.length > 0 && (
        <svg className="move-arrows" width="100%" height={height} aria-hidden="true">
          {arrows.map((arrow, index) => (
            <path key={index} d={arrow.d} fill="none" stroke="var(--move)" strokeWidth={1.5} strokeOpacity={0.9} />
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
                {CONTEXT_OPTIONS.map((value) => (
                  <button
                    key={value}
                    className={context === value ? 'on' : ''}
                    aria-label={`${value === 100000 ? 'All' : value} lines of context`}
                    aria-pressed={context === value}
                    onClick={() => setContextLines(value)}
                  >
                    {value === 100000 ? 'All' : value}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="diff-layout-toggle" role="group" aria-label="Diff layout">
            <IconButton icon="rows" label="Unified diff" active={current === 'unified'} onClick={() => setDiffLayout('unified')} />
            <IconButton icon="columns" label="Split diff" active={current === 'split'} onClick={() => setDiffLayout('split')} />
          </div>
        </div>
      </div>
      {files.map((file, fileIndex) => {
        const path = pathOf(file)
        const stat = stats[fileIndex]
        const changed = stat.adds + stat.dels
        const open = choices[path] ?? !startsCollapsed(file, changed)
        const toggle = () => setChoices((prev) => ({ ...prev, [path]: !open }))
        return (
          <section key={`${fileIndex}-${path}`} className="diff-file" data-path={path}>
            <FileHeader file={file} stat={stat} open={open} onToggle={toggle} stage={stage} />
            {file.binary && <p className="hint">Binary file.</p>}
            {!open && file.hunks.length > 0 && (
              <div className="collapsed-note">
                <span>{changed} changed line{changed === 1 ? '' : 's'} hidden</span>
                <button onClick={toggle}>Show diff</button>
              </div>
            )}
            {open && file.hunks.map((hunk, hunkIndex) => (
              <Fragment key={hunkIndex}>
                {onExpand && <ExpandRow label={`Show more context above line ${edgeLines(hunk.lines).first}`} onExpand={() => onExpand(file)} />}
                <div className="hunk">
                  <div className="hunk-header">{hunk.header}</div>
                  {current === 'unified'
                    ? hunk.lines.map((line, lineIndex) => (
                      <UnifiedLine
                        key={lineIndex}
                        line={line}
                        segments={tokens[fileIndex]?.[hunkIndex]?.[lineIndex]}
                        label={labels.get(key(fileIndex, hunkIndex, lineIndex))}
                        anchor={anchors.get(key(fileIndex, hunkIndex, lineIndex))}
                      />
                    ))
                    : toRows(hunk.lines).map((row, rowIndex) => {
                      const leftLabel = row.left ? labels.get(key(fileIndex, hunkIndex, row.left.index)) : undefined
                      const rightLabel = row.right ? labels.get(key(fileIndex, hunkIndex, row.right.index)) : undefined
                      return (
                        <Fragment key={rowIndex}>
                          {(leftLabel || rightLabel) && (
                            <div className="split-row">
                              {leftLabel ? <div className="move-note">{leftLabel}</div> : <div />}
                              {rightLabel ? <div className="move-note">{rightLabel}</div> : <div />}
                            </div>
                          )}
                          <div className="split-row">
                            <SplitCell
                              cell={row.left}
                              side="old"
                              segments={row.left ? tokens[fileIndex]?.[hunkIndex]?.[row.left.index] : undefined}
                              label={leftLabel}
                              anchor={row.left ? anchors.get(key(fileIndex, hunkIndex, row.left.index)) : undefined}
                            />
                            <SplitCell
                              cell={row.right}
                              side="new"
                              segments={row.right ? tokens[fileIndex]?.[hunkIndex]?.[row.right.index] : undefined}
                              label={rightLabel}
                              anchor={row.right ? anchors.get(key(fileIndex, hunkIndex, row.right.index)) : undefined}
                            />
                          </div>
                        </Fragment>
                      )
                    })}
                </div>
                {onExpand && <ExpandRow label={`Show more context below line ${edgeLines(hunk.lines).last}`} onExpand={() => onExpand(file)} />}
              </Fragment>
            ))}
          </section>
        )
      })}
    </div>
  )
})

interface Arrow {
  d: string
}

// Colours every file once per change. Until the colours arrive, lines render as plain text.
function useTokens(files: DiffFile[], overrides: Record<string, string>): Segment[][][][] {
  const [tokens, setTokens] = useState<Segment[][][][]>([])
  useEffect(() => {
    let stale = false
    Promise.all(files.map((file) => highlightFile(file, overrides))).then((next) => {
      if (!stale) setTokens(next)
    })
    return () => { stale = true }
  }, [files, overrides])
  return tokens
}

function Code({ text, segments }: { text: string; segments?: Segment[] }) {
  if (!segments) return <code>{text}</code>
  return (
    <code>
      {segments.map((segment, index) => (segment.light || segment.dark
        ? <span key={index} className="tok" style={{ '--tok-light': segment.light, '--tok-dark': segment.dark } as CSSProperties}>{segment.text}</span>
        : <span key={index}>{segment.text}</span>))}
    </code>
  )
}

// The label gets its own line above the moved line, so it never takes code width or covers code.
function UnifiedLine({ line, segments, label, anchor }: { line: DiffLine; segments?: Segment[]; label?: string; anchor?: string }) {
  return (
    <>
      {label && <div className="move-note">{label}</div>}
      <div className={`line ${line.type}${label ? ' moved' : ''}`} data-move-id={anchor}>
        <span className="gutter">{line.oldNo ?? ''}</span>
        <span className="gutter">{line.newNo ?? ''}</span>
        <span className="sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
        <Code text={line.text} segments={segments} />
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

interface IndexedLine {
  line: DiffLine
  index: number
}

interface SplitRow {
  left: IndexedLine | null
  right: IndexedLine | null
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

function SplitCell({ cell, side, segments, label, anchor }: {
  cell: IndexedLine | null
  side: 'old' | 'new'
  segments?: Segment[]
  label?: string
  anchor?: string
}) {
  if (!cell) return <div className="split-cell empty" aria-hidden="true" />
  const { line } = cell
  const number = side === 'old' ? line.oldNo : line.newNo
  return (
    <div className={`split-cell ${line.type}${label ? ' moved' : ''}`} data-move-id={anchor}>
      <span className="gutter">{number ?? ''}</span>
      <Code text={line.text} segments={segments} />
    </div>
  )
}

// The sticky header for one file: optional stage checkbox, collapse toggle, status, name with its folder,
// and how many lines were added and removed.
function FileHeader({ file, stat, open, onToggle, stage }: {
  file: DiffFile
  stat: { adds: number; dels: number }
  open: boolean
  onToggle: () => void
  stage?: Props['stage']
}) {
  const path = pathOf(file)
  const { name, dir } = splitPath(path)
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
      <button className="diff-file-toggle" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${path}`} onClick={onToggle}>
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
    </header>
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
