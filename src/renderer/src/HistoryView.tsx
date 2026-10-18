import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type UIEvent } from 'react'
import { createPortal } from 'react-dom'
import { layoutGraph, type GraphRow } from '../../main/git/graph'
import type { Commit } from '../../main/git/history'
import type { DiffFile, MovedBlock } from '../../main/git/diff'
import { CommitDialogs, commitItems, remoteWebBase, type CommitInput, type Prompt } from './CommitMenu'
import { CommitStat } from './CommitStat'
import { DiffView, countLines } from './DiffView'
import { Icon } from './Icons'
import { ActionMenu } from './OverflowBar'
import { useContextLines, useIgnoreWhitespace } from './prefs'
import { useRepoBusy } from './repo-busy'
import { useResizable } from './Splitter'
import { GUTTER, STRIP_WIDTH, useFolded, useFoldHold } from './fold'
import { loadSession, rememberScroll, savePlace, savedView, saveView, useScrollMemory } from './session'

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
  const [query, setQuery] = useState(() => loadSession().places[repo]?.query ?? '')
  const [selected, setSelected] = useState<string | null>(() => loadSession().places[repo]?.commit ?? null)
  const [detail, setDetail] = useState<{ hash: string; ignoreWhitespace: boolean; files: DiffFile[]; moves: MovedBlock[]; details: { body: string } } | null>(null)
  // The load key of a failed reload of the commit on screen. Its diff shows the failure until a load succeeds.
  const [failed, setFailed] = useState<string | null>(null)
  // The compare the user asked for: the commit, and the ref it compares with. Its diff is fetched with the whitespace option on screen.
  const [target, setTarget] = useState<{ hash: string; label: string; ref: string; quiet?: boolean } | null>(null)
  // The last fetched compare, with the option it was fetched with. It is shown only while that option and target are current.
  const [loaded, setLoaded] = useState<{ hash: string; label: string; ref: string; ignoreWhitespace: boolean; files: DiffFile[]; moves: MovedBlock[] } | null>(null)
  // The compare that was open for the commit at launch. It is read once, and returns when that commit's detail shows.
  const [savedCompare] = useState(() => {
    const saved = selected ? savedView<{ label: string; ref: string } | null>(`${repo}|compare`, selected, null) : null
    return saved && selected ? { hash: selected, ...saved } : null
  })
  const restoredCompare = useRef(false)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The write running in this repo, from any surface. The commit actions wait for it.
  const pending = useRepoBusy(repo)
  // The commit context menu: the commit it is for, and the point it opened at.
  const [menu, setMenu] = useState<{ hash: string; x: number; y: number } | null>(null)
  const [upstream, setUpstream] = useState<string | null>(null)
  const [webBase, setWebBase] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const context = useContextLines()
  const ignoreWhitespace = useIgnoreWhitespace()
  // A detail load asks for a commit with the context and whitespace option on screen.
  const detailKey = JSON.stringify([selected, context, ignoreWhitespace])
  // Shown only for the target and option on screen. While a new fetch runs, the commit's own diff is shown.
  const compare = loaded && target && target.hash === selected && loaded.hash === target.hash && loaded.ref === target.ref && loaded.ignoreWhitespace === ignoreWhitespace ? loaded : null
  const { track: historyWidth, handle: historyHandle } = useResizable('bettergit.historyListWidth', 400, 280, 1100, 35)
  const { track: detailWidth, handle: detailHandle } = useResizable('bettergit.commitDetailsWidth', 320, 240, 640, 40)
  // A pane folds only beside its neighbour. A held pane grows in flow, so the layout beside it shifts.
  const list = useFoldHold<HTMLDivElement>(useFolded('list') && detailOpen, 'ul.commits')
  const details = useFoldHold<HTMLDivElement>(useFolded('details') && listOpen, '.commit-info button:not(.fold-strip)')
  const listTrack = list.collapsed ? `${STRIP_WIDTH}px` : historyWidth
  const detailTrack = details.collapsed ? `${STRIP_WIDTH}px` : detailWidth
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

  // Errors go through the ref, so a parent render with a new callback starts no reload that could fail again.
  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let stale = false
    const key = detailKey
    // The commit is already on screen, so this load is a reload for another option or context.
    const reload = detail?.hash === selected
    setFailed(null)
    api.commit(repo, selected, context, ignoreWhitespace).then((next) => {
      // Tagged with its hash, so a reply that lands after the selection moved is never shown, and with its option,
      // so its hunks are never shown under the other one.
      if (!stale) setDetail({ hash: selected, ignoreWhitespace, ...next })
    }).catch((failure: unknown) => {
      if (stale) return
      // A saved commit that no longer exists (rebased away, for example) must not leave the detail on "Loading…".
      // A failed reload keeps the commit, its compare and the toolbar. The failure stays after the error banner clears.
      if (reload) setFailed(key)
      else setSelected(null)
      errorRef.current(failure)
    })
    return () => { stale = true }
  }, [repo, selected, context, ignoreWhitespace])

  // Remembers the open commit and the search per repo, so a reload returns to them.
  useEffect(() => {
    savePlace(repo, { commit: selected ?? undefined })
  }, [repo, selected])

  useEffect(() => {
    savePlace(repo, { query: query || undefined })
  }, [repo, query])

  // The remote link and the upstream feed the commit menu. Both follow the repository, so they reload with it.
  useEffect(() => {
    let stale = false
    Promise.all([api.status(repo), api.remotes(repo)]).then(([status, remotes]) => {
      if (stale) return
      setUpstream(status.upstream)
      setWebBase(remoteWebBase(remotes))
    }).catch((failure: unknown) => {
      if (!stale) onError(failure)
    })
    return () => { stale = true }
  }, [repo, revision, onError])

  // A compare, prompt, or notice belongs to the commit it was started from. Moving to another commit clears it.
  useEffect(() => {
    selectedRef.current = selected
    // The launch compare is spent once the selection leaves its commit, even before that commit's detail arrived.
    if (selected !== savedCompare?.hash) restoredCompare.current = true
    setTarget(null)
    setLoaded(null)
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

  // A merge-base lookup answers later, so a reply for a commit no longer selected is dropped.
  const compareWith = (label: string, ref: string) => {
    if (selected && selected === selectedRef.current) setTarget({ hash: selected, label, ref })
  }

  const rows = useMemo(() => layoutGraph(commits), [commits])
  // One fixed graph column for every row, so the commit text lines up down the list.
  const laneCount = Math.min(MAX_LANES, Math.max(1, ...rows.map((row) => row.laneCount)))
  const graphWidth = LANE_WIDTH * (laneCount + 1)
  const picked = commits.find((commit) => commit.hash === selected) ?? null
  // Detail for another commit is not shown, so moving the selection clears it until its own reply arrives.
  const current = detail && detail.hash === selected ? detail : null
  // The list and the open commit's diff return to their saved scroll. A diff only returns for the commit it was saved with.
  // The diff's file collapse map has its own id: a scroll write replaces whatever is stored under the scroll's id.
  const onListScroll = useScrollMemory(list.pane, `${repo}|history-list`, 'list', rows.length > 0)
  // The diff on screen: the compare, or else the commit's own diff, each only for the whitespace option it was fetched with.
  // After a toggle the heading and toolbar stay, and the diff shows loading until its reply.
  const patch = compare ?? (current?.ignoreWhitespace === ignoreWhitespace ? current : null)
  const onDiffScroll = useScrollMemory(diffRef, `${repo}|history-diff`, selected ?? '', patch !== null)
  // The diff's last scroll position for the commit on screen, and the view it was in: the commit's own diff or a compare.
  // A whitespace reload shows no hunks, so the pane clamps to the top. The position waits for the reply with the same view,
  // and scroll events until then are not saved, so the clamp and a shorter fallback diff never replace it.
  const view = compare ? `compare ${compare.ref}` : 'own'
  const wanted = target && target.hash === selected ? `compare ${target.ref}` : 'own'
  const diffTop = useRef<{ hash: string; view: string; top: number } | null>(null)
  const waiting = useRef<{ hash: string; view: string; top: number } | null>(null)
  const onDiffPaneScroll = (event: UIEvent<HTMLDivElement>) => {
    if (!patch || !selected || (waiting.current && waiting.current.view !== view)) return
    diffTop.current = { hash: selected, view, top: event.currentTarget.scrollTop }
    onDiffScroll(event)
  }
  useEffect(() => {
    if (!patch) {
      waiting.current = current && diffTop.current?.hash === selected ? diffTop.current : null
      return
    }
    const saved = waiting.current
    // A different view on the way to the one asked for, such as the commit's diff before its compare, keeps the wait.
    if (saved && saved.view !== view && saved.view === wanted && saved.hash === selected) return
    waiting.current = null
    const element = diffRef.current
    if (!element || !selected) return
    if (saved?.hash === selected && saved.view === view) {
      // Rows lay out a frame after their data arrives, so the position is set after two frames, unless the commit or pane changed.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (selectedRef.current === saved.hash && diffRef.current === element) element.scrollTop = saved.top
      }))
    } else if (diffTop.current?.hash !== selected || diffTop.current.view !== view) {
      // Otherwise the diff on screen owns the position it has now. Entering or leaving a compare can keep scrollTop
      // without a scroll event, so the view is recorded here too. A wait that ends this way saved no scroll while it
      // lasted, so the position is saved as well.
      diffTop.current = { hash: selected, view, top: element.scrollTop }
      if (saved) rememberScroll(`${repo}|history-diff`, selected, element.scrollTop)
    }
  }, [repo, patch, current, selected, view, wanted])

  // The compare that was open comes back once its commit shows. A ref that no longer resolves opens the commit without it.
  useEffect(() => {
    if (restoredCompare.current || !savedCompare || !current || selected !== savedCompare.hash) return
    restoredCompare.current = true
    setTarget({ ...savedCompare, quiet: true })
  }, [savedCompare, current, selected])

  // Fetches the target with the option on screen. A new target or option cancels the older fetch, so its reply cannot land.
  // Toggling the option refetches the same target, so the diff is never left unfiltered under a pressed option.
  useEffect(() => {
    if (!target || target.hash !== selected) return
    let stale = false
    api.compare(repo, target.hash, target.ref, ignoreWhitespace).then((result: { files: DiffFile[]; moves: MovedBlock[] }) => {
      if (!stale) setLoaded({ hash: target.hash, label: target.label, ref: target.ref, ignoreWhitespace, ...result })
    }).catch((failure: unknown) => {
      if (stale) return
      // A restored compare that no longer resolves is dropped without a message. A requested one reports its error.
      setTarget(null)
      if (!target.quiet) onError(failure)
    })
    return () => { stale = true }
  }, [repo, selected, target, ignoreWhitespace, onError])

  // The compare that is requested is saved with its commit, so a reload asks for it again.
  // A saved compare stays saved until it returns, so a remount before its commit shows still restores it.
  useEffect(() => {
    if (!restoredCompare.current && savedCompare?.hash === selected) return
    saveView(`${repo}|compare`, selected ?? '', target && target.hash === selected ? { label: target.label, ref: target.ref } : null)
  }, [repo, selected, target, savedCompare])
  // The heading already shows the subject, so the body under it leaves the subject out.
  const body = current ? bodyBelow(current.details.body, picked?.subject ?? '') : ''
  // A repo with no commits gets its own message in place of the selection hint.
  const empty = exhausted && !commits.length && !query.trim()
  const totals = compare ? totalLines(compare.files) : null
  // With no diff to show, the pane is loading, unless the commit's own diff failed to reload and no compare is on its way.
  const emptyHint = patch ? undefined : failed === detailKey && wanted === 'own' ? 'Could not load this diff.' : 'Loading…'
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
    <div
      className="history"
      style={{
        gridTemplateColumns: listOpen && detailOpen ? `${listTrack} ${list.collapsed ? 0 : GUTTER}px minmax(0, 1fr)` : 'minmax(0, 1fr)',
      } as CSSProperties}
    >
      {listOpen && (
        <div
          className={`history-list${list.folded ? ' folded' : ''}${list.held ? ' held' : ''}`}
          ref={list.pane}
          {...list.paneHandlers}
          onScroll={onListScroll}
        >
          {list.folded && (
            <button ref={list.strip} type="button" className="fold-strip" aria-label="Show commit list" onClick={list.activate}>
              <Icon name="chevron" />
              <span className="fold-label">{picked ? <><code>{picked.hash.slice(0, 7)}</code> {picked.subject}</> : 'Commits'}</span>
            </button>
          )}
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
      {listOpen && detailOpen && <div className={`splitter${list.collapsed ? ' off' : ''}`} {...historyHandle} {...list.splitterHandlers} />}
      {detailOpen && (
        <div
          className={`commit-detail${selected && current ? ' has-commit' : ''}`}
          style={selected && current ? { gridTemplateColumns: `${detailTrack} ${details.collapsed ? 0 : GUTTER}px minmax(0, 1fr)` } as CSSProperties : undefined}
        >
          {!selected && (empty
            ? <p className="hint">This repository has no commits yet.</p>
            : <p className="hint">Select a commit. Use the up and down arrows to move between commits.</p>)}
          {selected && !current && <p className="hint">Loading…</p>}
          {selected && current && (
            <>
              <div
                className={`commit-info${details.folded ? ' folded' : ''}${details.held ? ' held' : ''}`}
                ref={details.pane}
                {...details.paneHandlers}
              >
                {details.folded && (
                  <button ref={details.strip} type="button" className="fold-strip" aria-label="Show commit details" onClick={details.activate}>
                    <Icon name="chevron" />
                    <span className="fold-label"><code>{picked?.hash.slice(0, 7)}</code> {current.files.length} files</span>
                  </button>
                )}
                <header className="commit-head" tabIndex={-1}>
                  {picked && (
                    <div className="commit-title">
                      <h2 className="commit-subject">{picked.subject}</h2>
                      {notice && <p className="commit-notice" role="status">{notice}</p>}
                      {commitInput && <CommitDialogs input={commitInput} prompt={prompt} onClose={() => setPrompt(null)} />}
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
                <CommitStat files={patch?.files ?? []} onSelect={(path) => {
                  Array.from(diffRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
                    .find((element) => element.dataset.path === path)?.scrollIntoView({ block: 'start' })
                }} />
              </div>
              <div className={`splitter${details.collapsed ? ' off' : ''}`} aria-label="Commit details width" {...detailHandle} {...details.splitterHandlers} />
              <div className="diff-pane" ref={diffRef} onScroll={onDiffPaneScroll}>
                {compare && totals && (
                  <div className="compare-bar">
                    <span>
                      Comparing <code className="hash">{selected.slice(0, 7)}</code> with {compare.label}. Diff has {totals.files} files, +{totals.adds} −{totals.dels}. Stats at left are for this comparison.
                    </span>
                    <button className="ghost" onClick={() => setTarget(null)}>Exit comparison</button>
                  </div>
                )}
                <DiffView files={patch?.files ?? []} moves={patch?.moves ?? []} persist={{ id: `${repo}|history-files`, key: selected ?? '' }} emptyHint={emptyHint} />
              </div>
            </>
          )}
        </div>
      )}
      {menu && commitInput && menu.hash === selected && createPortal(
        <ActionMenu
          className="context-menu commit-menu"
          at={menu}
          items={commitItems(commitInput, { setPrompt, setNotice, pending })}
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
