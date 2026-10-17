import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { layoutGraph, type GraphRow } from '../../main/git/graph'
import type { Commit } from '../../main/git/history'
import type { DiffFile, MovedBlock } from '../../main/git/diff'
import { CommitDialogs, commitItems, remoteWebBase, type CommitInput, type Prompt } from './CommitMenu'
import { CommitStat } from './CommitStat'
import { DiffView, countLines } from './DiffView'
import { Icon } from './Icons'
import { ActionMenu } from './OverflowBar'
import { useContextLines } from './prefs'
import { useResizable } from './Splitter'
import { loadSession, savePlace } from './session'

const api = window.bettergit
const PAGE = 300
// Geometry and colors match better-source-control's graph, so the two read the same.
const LANE_WIDTH = 11
const ROW_HEIGHT = 28
const MID = ROW_HEIGHT / 2
const TOP = Math.round(ROW_HEIGHT * 0.27)
const LOW = ROW_HEIGHT - TOP
const MAX_LANES = 10
const COLORS = ['#4daafc', '#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF']

interface Props {
  repo: string
  head: string | null
  revision: number
  listOpen: boolean
  detailOpen: boolean
  onError: (error: unknown) => void
  onChanged?: () => void
}

export function HistoryView({ repo, head, revision, listOpen, detailOpen, onError, onChanged }: Props) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(() => loadSession().places[repo]?.commit ?? null)
  const [detail, setDetail] = useState<{ hash: string; files: DiffFile[]; moves: MovedBlock[]; details: { body: string } } | null>(null)
  const [compare, setCompare] = useState<{ label: string; files: DiffFile[]; moves: MovedBlock[] } | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  // The commit context menu: the commit it is for, and the point it opened at.
  const [menu, setMenu] = useState<{ hash: string; x: number; y: number } | null>(null)
  const [upstream, setUpstream] = useState<string | null>(null)
  const [webBase, setWebBase] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const context = useContextLines()
  const { size: historyWidth, handle: historyHandle } = useResizable('bettergit.historyListWidth', 400, 280, 1100)
  const { size: detailWidth, handle: detailHandle } = useResizable('bettergit.commitDetailsWidth', 320, 240, 640)
  const diffRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const selectedRef = useRef(selected)
  // Each list (repo, search, or refresh) has a generation. Replies from an older one are dropped.
  const generation = useRef(0)
  // One page request at a time within the current generation.
  const pageBusy = useRef(false)
  const errorRef = useRef(onError)
  errorRef.current = onError

  useEffect(() => {
    const gen = ++generation.current
    pageBusy.current = true
    setExhausted(false)
    const load = query.trim()
      ? api.searchHistory(repo, query.trim())
      : api.history(repo, 0, PAGE)
    load.then((rows: Commit[]) => {
      // A reply for an older query, repo, or refresh must not overwrite the current list.
      if (gen !== generation.current) return
      setCommits(rows)
      setExhausted(rows.length < PAGE)
    }).catch((failure: unknown) => {
      if (gen === generation.current) errorRef.current(failure)
    }).finally(() => {
      if (gen === generation.current) pageBusy.current = false
    })
  }, [repo, query, revision])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let stale = false
    api.commit(repo, selected, context).then((next) => {
      // Tagged with its hash, so a reply that lands after the selection moved is never shown.
      if (!stale) setDetail({ hash: selected, ...next })
    }).catch((failure: unknown) => {
      // A saved commit that no longer exists (rebased away, for example) must not leave the detail on "Loading…".
      if (stale) return
      setSelected(null)
      onError(failure)
    })
    return () => { stale = true }
  }, [repo, selected, context, onError])

  // Remembers the open commit per repo, so a reload returns to it.
  useEffect(() => {
    savePlace(repo, { commit: selected ?? undefined })
  }, [repo, selected])

  // The remote link and the upstream feed the commit menu. Both follow the repository, so they reload with it.
  useEffect(() => {
    let stale = false
    Promise.all([api.status(repo), api.remotes(repo)]).then(([status, remotes]) => {
      if (stale) return
      setUpstream(status.upstream)
      setWebBase(remoteWebBase(remotes))
    }).catch(onError)
    return () => { stale = true }
  }, [repo, revision, onError])

  // A compare, prompt, or notice belongs to the commit it was started from. Moving to another commit clears it.
  useEffect(() => {
    selectedRef.current = selected
    setCompare(null)
    setPrompt(null)
    setNotice(null)
    // A right-click selects its commit and opens the menu for it, so the menu survives only for the selected commit.
    setMenu((current) => (current?.hash === selected ? current : null))
  }, [selected])

  // The commit menu closes on an outside press or Escape, like the other popovers. Escape returns focus to the list.
  const menuOpen = menu !== null
  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.commit-menu')) setMenu(null)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null)
        listRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const compareWith = (label: string, ref: string) => {
    const hash = selected
    if (!hash) return
    api.compare(repo, hash, ref).then((result: { files: DiffFile[]; moves: MovedBlock[] }) => {
      // A slow result must not land on a commit the user has already left.
      if (selectedRef.current === hash) setCompare({ label, ...result })
    }).catch(onError)
  }

  const rows = useMemo(() => layoutGraph(commits), [commits])
  // One fixed graph column for every row, so the commit text lines up down the list.
  const laneCount = Math.min(MAX_LANES, Math.max(1, ...rows.map((row) => row.laneCount)))
  const graphWidth = LANE_WIDTH * (laneCount + 1)
  const picked = commits.find((commit) => commit.hash === selected) ?? null
  // Detail for another commit is not shown, so moving the selection clears it until its own reply arrives.
  const current = detail && detail.hash === selected ? detail : null
  // The heading already shows the subject, so the body under it leaves the subject out.
  const body = current ? bodyBelow(current.details.body, picked?.subject ?? '') : ''
  // A repo with no commits gets its own message in place of the selection hint.
  const empty = exhausted && !commits.length && !query.trim()
  const totals = compare ? totalLines(compare.files) : null
  // The commit actions need the selected commit's body, so they wait for its detail.
  const commitInput: CommitInput | null = picked && current ? {
    repo,
    commit: picked,
    message: current.details.body.trim(),
    head,
    upstream,
    webBase,
    onOpenChanges: () => diffRef.current?.scrollTo({ top: 0 }),
    onCompare: compareWith,
    onChanged,
    onError,
  } : null

  useEffect(() => {
    if (selected) document.querySelector(`[data-hash="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // One page request at a time per generation. A reply for a replaced list is dropped, and rows already shown are skipped.
  const loadMore = () => {
    if (pageBusy.current) return
    const gen = generation.current
    pageBusy.current = true
    api.history(repo, commits.length, PAGE).then((more: Commit[]) => {
      if (gen !== generation.current) return
      setCommits((shown) => {
        const seen = new Set(shown.map((commit) => commit.hash))
        return [...shown, ...more.filter((commit) => !seen.has(commit.hash))]
      })
      setExhausted(more.length < PAGE)
    }).catch((failure: unknown) => {
      if (gen === generation.current) errorRef.current(failure)
    }).finally(() => {
      if (gen === generation.current) pageBusy.current = false
    })
  }

  // Up and down step through the commits. Near the end of what is loaded, the next page loads first.
  const step = (delta: number) => {
    if (!rows.length) return
    const index = rows.findIndex((row) => row.commit.hash === selected)
    const next = Math.min(rows.length - 1, Math.max(0, index < 0 ? 0 : index + delta))
    setSelected(rows[next].commit.hash)
    if (!exhausted && !query.trim() && next >= rows.length - 5) void loadMore()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(event.key === 'ArrowDown' ? 1 : -1)
    } else if (selected && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      // The keyboard route to the commit menu. It opens beside the selected row.
      event.preventDefault()
      const box = document.getElementById(optionId(selected))?.getBoundingClientRect()
      if (box) setMenu({ hash: selected, x: box.left + 24, y: box.bottom })
    }
  }

  return (
    <div className="history" style={{ gridTemplateColumns: listOpen && detailOpen ? `min(${historyWidth}px, 35%) 9px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
      {listOpen && (
        <div className="history-list">
          <div className="search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search commit messages"
              aria-label="Search commit messages"
            />
          </div>
          <ul
            ref={listRef}
            className="commits"
            role="listbox"
            tabIndex={0}
            aria-label="Commit list"
            aria-activedescendant={picked ? optionId(picked.hash) : undefined}
            onKeyDown={onKeyDown}
          >
            {rows.map((row) => (
              <CommitRow
                key={row.commit.hash}
                row={row}
                graphWidth={graphWidth}
                active={selected === row.commit.hash}
                isHead={row.commit.hash === head}
                onSelect={() => setSelected(row.commit.hash)}
                onMenu={(x, y) => {
                  setSelected(row.commit.hash)
                  setMenu({ hash: row.commit.hash, x, y })
                }}
              />
            ))}
          </ul>
          {!exhausted && !query.trim() && <button className="more" onClick={loadMore}>Load more</button>}
          {!rows.length && !empty && <p className="hint">No commits to show.</p>}
        </div>
      )}
      {listOpen && detailOpen && <div className="splitter" {...historyHandle} />}
      {detailOpen && (
        <div className={`commit-detail${selected && current ? ' has-commit' : ''}`} style={selected && current ? { gridTemplateColumns: `min(${detailWidth}px, 40%) 9px minmax(0, 1fr)` } : undefined}>
          {!selected && (empty
            ? <p className="hint">This repository has no commits yet.</p>
            : <p className="hint">Select a commit. Use the up and down arrows to move between commits.</p>)}
          {selected && !current && <p className="hint">Loading…</p>}
          {selected && current && (
            <>
              <div className="commit-info">
                <header className="commit-head">
                  {picked && (
                    <div className="commit-title">
                      <h2 className="commit-subject">{picked.subject}</h2>
                      {notice && <p className="commit-notice" role="status">{notice}</p>}
                      {commitInput && <CommitDialogs input={commitInput} prompt={prompt} onClose={() => setPrompt(null)} setPending={setPending} />}
                    </div>
                  )}
                  {picked && (
                    <div className="commit-meta-line">
                      <span className="avatar" aria-hidden="true">{picked.author.charAt(0).toUpperCase()}</span>
                      <span>{picked.author}</span>
                      <span className="dot-sep" aria-hidden="true" />
                      <span>{new Date(picked.date * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      <span className="dot-sep" aria-hidden="true" />
                      <code className="hash">{picked.hash.slice(0, 7)}</code>
                    </div>
                  )}
                  {body && <pre className="commit-body">{body}</pre>}
                </header>
                <CommitStat files={compare?.files ?? current.files} onSelect={(path) => {
                  Array.from(diffRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
                    .find((element) => element.dataset.path === path)?.scrollIntoView({ block: 'start' })
                }} />
              </div>
              <div className="splitter" aria-label="Commit details width" {...detailHandle} />
              <div className="diff-pane" ref={diffRef}>
                {compare && totals && (
                  <div className="compare-bar">
                    <span>
                      Comparing <code className="hash">{selected.slice(0, 7)}</code> with {compare.label}. Diff has {totals.files} files, +{totals.adds} −{totals.dels}. Stats at left are for this comparison.
                    </span>
                    <button className="ghost" onClick={() => setCompare(null)}>Exit comparison</button>
                  </div>
                )}
                <DiffView files={compare?.files ?? current.files} moves={compare?.moves ?? current.moves} />
              </div>
            </>
          )}
        </div>
      )}
      {menu && commitInput && menu.hash === selected && createPortal(
        <ActionMenu
          className="context-menu commit-menu"
          at={menu}
          items={commitItems(commitInput, { setPrompt, setNotice, pending, setPending })}
          onPick={(item) => { setMenu(null); item.onClick() }}
          onDismiss={() => setMenu(null)}
        />,
        document.body,
      )}
    </div>
  )
}

interface Segment {
  d: string
  color: string
}

// Ported from better-source-control's graphSvg: rounded lane shifts, straight pass-through lanes,
// and merge curves that leave the commit dot toward each extra parent. Every y value scales with the row height.
function graphSegments(row: GraphRow<Commit>): Segment[] {
  const { commit } = row
  const x = (lane: number) => LANE_WIDTH * (lane + 1)
  const color = (index: number) => COLORS[index % COLORS.length]
  const segments: Segment[] = []
  let outputIndex = 0
  row.input.forEach((input, index) => {
    if (input.hash === commit.hash) {
      if (index !== row.lane) {
        segments.push({ d: `M${x(index)} 0V${TOP}Q${x(index)} ${MID} ${x(index) - 5} ${MID}H${x(row.lane)}`, color: color(input.color) })
      } else {
        outputIndex++
      }
    } else if (row.output[outputIndex]?.hash === input.hash) {
      const to = outputIndex++
      segments.push({
        d: index === to
          ? `M${x(index)} 0V${ROW_HEIGHT}`
          : `M${x(index)} 0V${TOP}Q${x(index)} ${MID} ${x(index) - 5} ${MID}H${x(to) + 5}Q${x(to)} ${MID} ${x(to)} ${LOW}V${ROW_HEIGHT}`,
        color: color(input.color),
      })
    }
  })
  for (let index = 1; index < commit.parents.length; index++) {
    let parentIndex = -1
    for (let lane = row.output.length - 1; lane >= 0; lane--) {
      if (row.output[lane].hash === commit.parents[index]) {
        parentIndex = lane
        break
      }
    }
    if (parentIndex !== -1) {
      segments.push({
        d: `M${x(row.lane)} ${MID}H${x(parentIndex) - 11}Q${x(parentIndex)} ${MID} ${x(parentIndex)} ${ROW_HEIGHT}`,
        color: color(row.output[parentIndex].color),
      })
    }
  }
  const input = row.input[row.lane]
  if (input?.hash === commit.hash) segments.push({ d: `M${x(row.lane)} 0V${MID}`, color: color(input.color) })
  if (commit.parents.length) segments.push({ d: `M${x(row.lane)} ${MID}V${ROW_HEIGHT}`, color: color(row.color) })
  return segments
}

// The DOM id of a commit row. The list points aria-activedescendant at the selected one.
const optionId = (hash: string) => `commit-${hash}`

// The message without its subject line and the blank line after it. A message that does not start with the subject is shown whole.
function bodyBelow(message: string, subject: string) {
  const rest = message.slice(subject.length)
  return message.startsWith(subject) && (rest === '' || rest.startsWith('\n')) ? rest.trim() : message
}

// Compact DD/MM keeps the subject readable in a narrow list. The full local timestamp is in the tooltip.
function formatListDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })
}

// Adds and removes across a diff, with its file count, for the compare bar.
function totalLines(files: DiffFile[]) {
  const counts = files.map(countLines)
  return {
    files: files.length,
    adds: counts.reduce((sum, count) => sum + count.adds, 0),
    dels: counts.reduce((sum, count) => sum + count.dels, 0),
  }
}

function CommitRow({ row, graphWidth, active, isHead, onSelect, onMenu }: {
  row: GraphRow<Commit>
  graphWidth: number
  active: boolean
  isHead: boolean
  onSelect: () => void
  onMenu: (x: number, y: number) => void
}) {
  const { commit } = row
  const x = LANE_WIDTH * (row.lane + 1)
  const radius = isHead ? 4.5 : commit.parents.length > 1 ? 3.5 : 3
  const nodeColor = COLORS[row.color % COLORS.length]
  const refs = commit.refs.map((ref) => ref.replace('HEAD -> ', ''))
  return (
    <li id={optionId(commit.hash)} className={`commit${active ? ' active' : ''}`} role="option" aria-selected={active} data-hash={commit.hash} onClick={onSelect} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY) }}>
      <svg className="lanes" width={graphWidth} height={ROW_HEIGHT} aria-hidden="true">
        {graphSegments(row).map((segment, index) => (
          <path key={index} d={segment.d} stroke={segment.color} strokeWidth={1.25} fill="none" strokeLinecap="round" />
        ))}
        <circle
          cx={x}
          cy={MID}
          r={radius}
          fill={isHead ? 'var(--content)' : nodeColor}
          stroke={nodeColor}
          strokeWidth={isHead ? 2 : 1}
        />
      </svg>
      <span className="text">
        {refs.length > 0 && <span className="ref" title={refs.join(', ')}>{refs[0]}</span>}
        {refs.length > 1 && <span className="ref" title={refs.join(', ')}>+{refs.length - 1}</span>}
        {isHead && <span className="ref head">HEAD</span>}
        <span className="subject">{commit.subject}</span>
      </span>
      <span className="commit-meta date" title={new Date(commit.date * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>{formatListDate(commit.date)}</span>
      <code className="commit-meta hash">{commit.hash.slice(0, 7)}</code>
    </li>
  )
}
