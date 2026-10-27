import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type RefObject, type UIEvent } from 'react'
import { createPortal } from 'react-dom'
import { layoutGraph, startGraph, type GraphRow, type GraphState } from '../../main/git/graph'
import type { Commit, CommitDetails } from '../../main/git/history'
import { Avatar } from './Avatar'
import type { DiffFile, MovedBlock } from '../../main/git/diff'
import { CommitDialogs, commitItems, remoteWebBase, type CommitInput, type Prompt } from './CommitMenu'
import { CommitStat, inListOrder, useFilesView } from './CommitStat'
import { DiffView, countLines } from './DiffView'
import { DiffRail } from './DiffRail'
import { Icon } from './Icons'
import { EmptyState } from './EmptyState'
import { ActionMenu } from './OverflowBar'
import { setHiddenBranches, useContextLines, useHiddenBranches, useIgnoreWhitespace } from './prefs'
import { useRepoBusy } from './repo-busy'
import { useResizable } from './Splitter'
import { graphWidth, laneX, LANE_STEP } from './graph-x'
import { GUTTER, STRIP_WIDTH, useFoldHold } from './fold'
import { useActiveFiles } from './active-file'
import { loadSession, rememberScroll, savePlace, savedView, saveView, useScrollMemory } from './session'

const api = window.bettergit
const PAGE = 300
// A HEAD older than the loaded rows is paged in up to this many commits, then left unselected.
const HEAD_REACH = 10_000
// Show current branch asks for HEAD on purpose, so it pages further, in larger pages, and says why when it cannot.
const SEEK_REACH = 50_000
const SEEK_PAGE = 2_000
const COMMIT_CACHE = 24
type CommitDetail = { files: DiffFile[]; moves: MovedBlock[]; details: CommitDetails }
type CommitRefs = { branches: string[]; remotes: string[]; tags: string[] }
// Colors match better-source-control's graph. Like Sublime Merge, lanes sit closer together further right (graph-x.ts),
// and each row's graph is as wide as the lanes in that row, with its text starting after them. A laid-out row never
// changes, so loading another page or any other reply never moves a row on screen, and every commit's marker is drawn on
// its own lane.
// A commit row holds two lines, the subject over the author and refs, so it is this many single rows tall.
const ROW_LINES = 1.65
// Rows scale --row-h-eff (styles.css: density plus a larger UI font). appearance.ts writes its inputs on :root, so the height
// is read once per :root change and cached, never per row or per render.
let rowHeightCache: number | undefined
const measureRowHeight = () => Math.round((parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h-eff')) || 28) * ROW_LINES)
const readRowHeight = () => (rowHeightCache ??= measureRowHeight())
function subscribeRowHeight(onChange: () => void) {
  const observer = new MutationObserver(() => {
    rowHeightCache = measureRowHeight()
    onChange()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-density'] })
  return () => {
    observer.disconnect()
    // Unwatched, the cache could go stale. The next list measures afresh.
    rowHeightCache = undefined
  }
}
// The list mounts only the rows near its viewport. The window moves in steps of rows, so scrolling re-renders it every
// few rows rather than every frame, and keeps this many rows mounted past each edge.
const WINDOW_STEP = 10
const OVERSCAN = 20
const FIRST_WINDOW = 60
const COLORS = ['#4daafc', '#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF']

interface Props {
  repo: string
  // HEAD's commit and the branch checked out (null when detached or not loaded yet). A change of either selects HEAD.
  head: string | null
  branch: string | null
  revision: number
  // Counts explicit Refresh commands. Only those, and a new repo or filter, lay the graph out from scratch.
  refreshes: number
  listOpen: boolean
  detailOpen: boolean
  // Whether the commit's code diff is pinned open. A file click expands its rail.
  diffOpen: boolean
  onShowDiff: () => void
  onError: (error: unknown) => void
  onChanged?: () => void
}

export function HistoryView({ repo, head, branch, revision, refreshes, listOpen, detailOpen, diffOpen, onShowDiff, onError, onChanged }: Props) {
  const [commits, setCommits] = useState<Commit[]>([])
  const [query, setQuery] = useState(() => loadSession().places[repo]?.query ?? '')
  // Author names the list is limited to. Empty shows every author.
  const [authors, setAuthors] = useState<string[]>([])
  // Branches hidden in this repo, shared with the branch picker. History walks from every other branch.
  const hidden = useHiddenBranches(repo)
  // Why Show current branch could not show HEAD.
  const [jump, setJump] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(() => loadSession().places[repo]?.commit ?? null)
  const [detail, setDetail] = useState<{ hash: string; ignoreWhitespace: boolean; files: DiffFile[]; moves: MovedBlock[]; details: CommitDetails } | null>(null)
  // The branches and tags at the selected commit, read again on each refresh, since refs move while a hash stays.
  const [refs, setRefs] = useState<{ hash: string; refs: CommitRefs } | null>(null)
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
  const list = useFoldHold<HTMLDivElement>(!listOpen, 'ul.commits')
  const details = useFoldHold<HTMLDivElement>(!detailOpen, '.commit-stat-row')
  const code = useFoldHold<HTMLDivElement>(!diffOpen, '.diff-toolbar button:not(:disabled)')
  const listTrack = list.collapsed ? `${STRIP_WIDTH}px` : historyWidth
  const detailTrack = details.collapsed ? `${STRIP_WIDTH}px` : code.collapsed ? 'minmax(0, 1fr)' : detailWidth
  const diffRef = useRef<HTMLDivElement>(null)
  // The file at the top of the code diff, marked in the commit's file list as the diff scrolls. A render can change the
  // files under a still pane (another commit, a compare), so each one reads the pane again.
  const activeFiles = useActiveFiles(diffRef)
  useEffect(() => activeFiles.probe())
  const listRef = useRef<HTMLUListElement>(null)
  const listScroll = useRef<HTMLDivElement>(null)
  const selectedRef = useRef(selected)
  // Each list (repo, search, or refresh) has a generation. Replies from an older one are dropped.
  const generation = useRef(0)
  // One page request at a time within the current generation.
  const pageBusy = useRef(false)
  const errorRef = useRef(onError)
  errorRef.current = onError
  // A commit's diff never changes for its hash, so each one loaded with a context and whitespace option is kept while
  // the view is open. Selecting it again or toggling back shows it at once. Loads in flight are shared.
  const commits_ = useRef({ pending: new Map<string, Promise<CommitDetail>>(), done: new Map<string, CommitDetail>() })
  const loadCommit = (hash: string, hideWhitespace: boolean) => {
    const { pending, done } = commits_.current
    const key = JSON.stringify([repo, hash, context, hideWhitespace])
    let load = pending.get(key)
    if (!load) {
      load = api.commit(repo, hash, context, hideWhitespace) as Promise<CommitDetail>
      load.then((next) => {
        done.set(key, next)
        // shortcut: keeps the newest COMMIT_CACHE loads by insertion order; enough for toggling and stepping back and forth.
        if (done.size > COMMIT_CACHE) {
          const oldest = done.keys().next().value!
          done.delete(oldest)
          pending.delete(oldest)
        }
      }, () => { pending.delete(key) })
      pending.set(key, load)
    }
    return load
  }
  const cached = selected ? commits_.current.done.get(JSON.stringify([repo, selected, context, ignoreWhitespace])) : undefined

  // A refresh of the same list reloads every row already shown, so paged rows stay and the scroll does not jump.
  const listKey = useRef('')
  const refreshed = useRef(refreshes)
  // Whether the list in the latest reply starts a fresh graph layout, rather than keeping the lanes already on screen.
  const relayout = useRef(true)
  // A new list or an explicit refresh asks for a fresh layout. The ask stands until a current reply is applied, so a
  // background refresh that replaces the request, or a reply that fails or is dropped, does not use it up.
  const freshPending = useRef(true)
  const shownCount = useRef(0)
  // The HEAD commit to select once it is in the list, and a count of list replies that lets that search look again.
  const headTarget = useRef<string | null>(null)
  // Whether that search came from Show current branch rather than from HEAD moving.
  const headAsked = useRef(false)
  const [listReplies, setListReplies] = useState(0)
  // Bumped to scroll the selected row into view again, as when HEAD is focused while already selected.
  const [reveal, setReveal] = useState(0)
  shownCount.current = commits.length
  useEffect(() => {
    const gen = ++generation.current
    pageBusy.current = true
    const key = JSON.stringify([repo, query, authors, hidden])
    const limit = key === listKey.current ? Math.max(PAGE, shownCount.current) : PAGE
    if (key !== listKey.current || refreshes !== refreshed.current) freshPending.current = true
    listKey.current = key
    refreshed.current = refreshes
    const load = query.trim()
      ? api.searchHistory(repo, query.trim(), authors, hidden)
      : api.history(repo, 0, limit, authors, hidden)
    load.then((rows: Commit[]) => {
      // A reply for an older query, repo, or refresh must not overwrite the current list.
      if (gen !== generation.current) return
      const fresh = freshPending.current
      freshPending.current = false
      // An unchanged list keeps its array, so the graph is not laid out again and no row re-renders. A fresh layout always
      // lays out again, so an explicit refresh drops lanes kept from earlier background refreshes.
      relayout.current = fresh
      setCommits((shown) => !fresh && JSON.stringify(shown) === JSON.stringify(rows) ? shown : rows)
      setExhausted(rows.length < limit)
    }).catch((failure: unknown) => {
      if (gen !== generation.current) return
      // A failed read ends a HEAD search, so it reports once instead of retrying on its own. A new HEAD, or the user, starts another.
      headTarget.current = null
      errorRef.current(failure)
    }).finally(() => {
      if (gen !== generation.current) return
      pageBusy.current = false
      // A HEAD search waiting on this reply looks again, even when the list came back unchanged.
      if (headTarget.current) setListReplies((count) => count + 1)
    })
  }, [repo, query, authors, hidden, revision, refreshes])

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
    loadCommit(selected, ignoreWhitespace).then((next) => {
      // Tagged with its hash, so a reply that lands after the selection moved is never shown, and with its option,
      // so its hunks are never shown under the other one.
      if (stale) return
      setDetail({ hash: selected, ignoreWhitespace, ...next })
      // The other whitespace option loads while the window is idle, so its toggle shows without waiting.
      window.requestIdleCallback?.(() => { if (!stale) loadCommit(selected, !ignoreWhitespace).catch(() => undefined) }, { timeout: 500 })
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

  // The list's decorations change when a ref moves, so they and every refresh ask again. A failed read only hides the refs.
  const listedRefs = commits.find((commit) => commit.hash === selected)?.refs.join('\0')
  useEffect(() => {
    if (!selected) return
    let stale = false
    api.commitRefs(repo, selected).then((next) => { if (!stale) setRefs({ hash: selected, refs: next }) }, () => { if (!stale) setRefs(null) })
    return () => { stale = true }
  }, [repo, selected, revision, refreshes, listedRefs])

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

  // Paging appends to the list, so only the new page is laid out, from where the last layout left off. A new repo, search,
  // filter or explicit refresh is laid out from the start, with HEAD's line kept in the first lane. A background refresh
  // is laid out against the rows on screen, so commits already shown keep their lanes and colors. HEAD comes from the
  // list's own decorations in its first page, never from the status reply, so the first layout is already final and a
  // page that brings HEAD in later lays out the same either way.
  const graph = useRef<Graph>(EMPTY_GRAPH)
  const rows = useMemo(() => {
    const last = graph.current
    const kept = last.commits.length
    const appended = kept > 0 && commits.length >= kept && commits[0] === last.commits[0] && commits[kept - 1] === last.commits[kept - 1]
    const base = appended ? last : EMPTY_GRAPH
    const state = appended ? { ...base.state } : startGraph(commits, commits.slice(0, PAGE).find(isHeadCommit)?.hash ?? null, relayout.current ? undefined : last)
    const added = layoutGraph(commits.slice(base.commits.length), state)
    graph.current = { commits, rows: base.rows.concat(added), state }
    return graph.current.rows
  }, [commits])
  const indexOf = useMemo(() => new Map(rows.map((row, index) => [row.commit.hash, index])), [rows])
  // A hidden branch also loses its label on commits a shown branch reaches. Git decorates a local branch by its name and a
  // remote one as remote/name.
  const hiddenNames = useMemo(() => new Set(hidden.map((ref) => ref.replace(/^refs\/(heads|remotes)\//, ''))), [hidden])
  // History opens on HEAD when nothing is selected, as the list's decorations mark it, or else on the newest commit. Only
  // once per open: a commit that fails to load is not picked again.
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || !rows.length) return
    opened.current = true
    if (!selected) setSelected((rows.find((row) => isHeadCommit(row.commit)) ?? rows[0]).commit.hash)
  }, [rows, selected])
  // A branch switch, commit or pull moves HEAD, and the list follows it: HEAD is selected and scrolled into view. The HEAD
  // last followed is saved, so a switch made while History was closed is followed when it opens, and an unchanged HEAD
  // keeps a saved selection. A fetch moves no HEAD, so it never moves the selection.
  const [savedHead] = useState(() => loadSession().places[repo]?.head ?? null)
  const seenHead = useRef(savedHead)
  useEffect(() => {
    if (!head) return
    const key = JSON.stringify([branch, head])
    const first = seenHead.current === null
    if (key === seenHead.current) return
    seenHead.current = key
    savePlace(repo, { head: key })
    if (first && selectedRef.current) return
    headTarget.current = head
    headAsked.current = false
    setListReplies((count) => count + 1)
  }, [branch, head])
  // Selects the HEAD asked for once it is listed. A HEAD older than the loaded rows pages in, up to HEAD_REACH commits.
  // A search lists only its matches and has no pages, so a HEAD outside it is dropped rather than paged for.
  useEffect(() => {
    const target = headTarget.current
    if (!target) return
    const asked = headAsked.current
    if (indexOf.has(target)) {
      headTarget.current = null
      setSelected(target)
      setReveal((count) => count + 1)
      if (asked) listRef.current?.focus({ preventScroll: true })
    } else if (query.trim() || exhausted || commits.length >= (asked ? SEEK_REACH : HEAD_REACH)) {
      if (pageBusy.current) return
      // The requested branch is already shown before paging. Lift an author filter only if HEAD is not under it.
      if (asked && exhausted && !query.trim()) {
        if (authors.length) return setAuthors([])
      }
      headTarget.current = null
      if (asked && !query.trim()) {
        const what = `${branch ? `${branch} (${target.slice(0, 7)})` : `The checked-out commit ${target.slice(0, 7)}`}`
        setJump(!exhausted ? `${what} is more than ${SEEK_REACH.toLocaleString()} commits down the graph.`
          : hidden.length ? `${what} is not on any shown branch. Show the hidden branches to look for it there.`
          : `${what} is not on any branch, so History does not list it.`)
      }
    } else loadMore(asked ? SEEK_PAGE : PAGE)
  }, [listReplies, indexOf, exhausted, query])
  // A commit the user picks replaces a HEAD still being looked for.
  const choose = useMemo(() => (hash: string) => {
    headTarget.current = null
    setJump(null)
    setSelected(hash)
  }, [])
  useEffect(() => setJump(null), [repo])
  // Show current branch: selects and reveals HEAD's commit, the branch's own commit and not its upstream's. A search that
  // left HEAD out is cleared and the current branch is shown before paging. Other filters are lifted only when paging
  // shows HEAD is not under them. Nothing in Git changes, so it runs while a write does too.
  const showHead = () => {
    setJump(null)
    if (!head) return setJump(`${branch ?? 'This repository'} has no commits yet, so there is nothing to show.`)
    if (query.trim() && !indexOf.has(head)) setQuery('')
    const own = branch ? `refs/heads/${branch}` : null
    if (own && hidden.includes(own)) setHiddenBranches(repo, hidden.filter((ref) => ref !== own))
    headTarget.current = head
    headAsked.current = true
    setListReplies((count) => count + 1)
  }
  const picked = commits.find((commit) => commit.hash === selected) ?? null
  // Detail for another commit is not shown, so moving the selection clears it until its own reply arrives.
  const current = detail && detail.hash === selected ? detail : null
  // The list and the open commit's diff return to their saved scroll. A diff only returns for the commit it was saved with.
  // The diff's file collapse map has its own id: a scroll write replaces whatever is stored under the scroll's id.
  const onListScroll = useScrollMemory(listScroll, `${repo}|history-list`, 'list', rows.length > 0)
  // The diff on screen: the compare, or else the commit's own diff, each only for the whitespace option it was fetched with.
  // After a toggle the heading and toolbar stay, and the diff shows loading until its reply.
  const patch = compare ?? (current?.ignoreWhitespace === ignoreWhitespace ? current : cached ?? null)
  // The file list and the diff share one order, so the file marked at the diff's top walks the list top to bottom.
  // Sorted once per patch and layout, never per scroll.
  const [filesView, setFilesView] = useFilesView()
  const shown = useMemo(() => patch && inListOrder(patch, filesView), [patch, filesView])
  const onDiffScroll = useScrollMemory(diffRef, `${repo}|history-diff`, selected ?? '', patch !== null)
  // The diff's last scroll position for the commit on screen, and the view it was in: the commit's own diff or a compare.
  // A whitespace reload shows no hunks, so the pane clamps to the top. The position waits for the reply with the same view,
  // and scroll events until then are not saved, so the clamp and a shorter fallback diff never replace it.
  const view = compare ? `compare ${compare.ref}` : 'own'
  const wanted = target && target.hash === selected ? `compare ${target.ref}` : 'own'
  const diffTop = useRef<{ hash: string; view: string; top: number } | null>(null)
  const waiting = useRef<{ hash: string; view: string; top: number } | null>(null)
  const onDiffPaneScroll = (event: UIEvent<HTMLDivElement>) => {
    activeFiles.probe()
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
  const empty = exhausted && !commits.length && !query.trim() && !authors.length
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
    onOpenChanges: () => (diffOpen ? diffRef.current?.scrollTo({ top: 0 }) : onShowDiff()),
    onCompare: compareWith,
    onChanged,
    onError,
  } : null

  // A file picked in the details scrolls the code diff to it. With the code diff hidden, it is shown first, and the file is
  // scrolled to once its rows lay out, after the pane's own scroll restore.
  const pendingFile = useRef<string | null>(null)
  const scrollToFile = (path: string) => {
    Array.from(diffRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
      .find((element) => element.dataset.path === path)?.scrollIntoView({ block: 'start' })
  }
  const showFile = (path: string) => {
    if (diffOpen) return scrollToFile(path)
    pendingFile.current = path
    onShowDiff()
  }
  useEffect(() => {
    const path = pendingFile.current
    pendingFile.current = null
    if (diffOpen && path) requestAnimationFrame(() => requestAnimationFrame(() => scrollToFile(path)))
  }, [diffOpen])

  // The file list also names the comparison, so its stats stay unambiguous while the diff is collapsed.
  const compareBar = compare && totals && selected ? (
    <div className="compare-bar">
      <span>
        Comparing <code className="hash">{selected.slice(0, 7)}</code> with {compare.label}. Diff has {totals.files} files, +{totals.adds} −{totals.dels}. {diffOpen ? 'Stats at left are' : 'Files below are'} for this comparison.
      </span>
      <button className="ghost" onClick={() => setTarget(null)}>Exit comparison</button>
    </div>
  ) : null

  // One page request at a time per generation. A reply for a replaced list is dropped, and rows already shown are skipped.
  const loadMore = (size = PAGE) => {
    if (pageBusy.current) return
    const gen = generation.current
    pageBusy.current = true
    api.history(repo, commits.length, size, authors, hidden).then((more: Commit[]) => {
      if (gen !== generation.current) return
      setCommits((shown) => {
        const seen = new Set(shown.map((commit) => commit.hash))
        return [...shown, ...more.filter((commit) => !seen.has(commit.hash))]
      })
      setExhausted(more.length < size)
    }).catch((failure: unknown) => {
      if (gen !== generation.current) return
      // As for the list: a failed page ends a HEAD search rather than asking for the same page again. Load more retries.
      headTarget.current = null
      errorRef.current(failure)
    }).finally(() => {
      if (gen !== generation.current) return
      pageBusy.current = false
      if (headTarget.current) setListReplies((count) => count + 1)
    })
  }

  // A right-click selects its commit and opens the menu for it. One function for every row, so a row re-renders only when its own props change.
  const openMenu = useMemo(() => (hash: string, x: number, y: number) => {
    choose(hash)
    setMenu({ hash, x, y })
  }, [])

  // Up and down step through the commits. Near the end of what is loaded, the next page loads first.
  const step = (delta: number) => {
    if (!rows.length) return
    const index = selected ? indexOf.get(selected) ?? -1 : -1
    const next = Math.min(rows.length - 1, Math.max(0, index < 0 ? 0 : index + delta))
    choose(rows[next].commit.hash)
    if (!exhausted && !query.trim() && next >= rows.length - 5) void loadMore()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(event.key === 'ArrowDown' ? 1 : -1)
    } else if (selected && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      // The keyboard route to the commit menu. It opens beside the selected row, or at the list's top when that row is
      // scrolled out of the mounted window.
      event.preventDefault()
      const box = (document.getElementById(optionId(selected)) ?? list.pane.current)?.getBoundingClientRect()
      if (box) setMenu({ hash: selected, x: box.left + 24, y: box.bottom })
    }
  }

  return (
    <div
      className="history"
      style={{
        gridTemplateColumns: `${listTrack} ${list.collapsed ? 0 : GUTTER}px minmax(0, 1fr)`,
      } as CSSProperties}
    >
        <div
          className={`history-list${list.folded ? ' folded' : ''}${list.held ? ' held' : ''}`}
          ref={list.pane}
          {...list.paneHandlers}
        >
          {list.folded && (
            <button ref={list.strip} type="button" className="fold-strip" aria-label="Show commit list" aria-expanded={!list.collapsed} onClick={list.activate}>
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
            {hidden.length > 0 && (
              <button type="button" className="icon-button search-action on" onClick={() => setHiddenBranches(repo, [])}
                aria-label={`${hiddenLabel(hidden.length)}. Show all branches`} title={`${hiddenLabel(hidden.length)} from History and the branch picker. Click to show all branches.`}>
                <Icon name="eyeOff" />
                <span className="author-count" aria-hidden="true">{hidden.length}</span>
              </button>
            )}
            <button type="button" className="icon-button search-action" onClick={showHead}
              aria-label={branch || !head ? 'Show current branch' : 'Show current checkout'}
              title={head ? `Show ${branch ?? 'the checked-out commit'} at ${head.slice(0, 7)} in the graph` : 'Show current branch'}>
              <Icon name="locate" />
            </button>
            <AuthorFilter repo={repo} authors={authors} onChange={setAuthors} onError={onError} />
          </div>
          {jump && (
            <p className="history-note" role="alert">
              {jump}
              {hidden.length > 0 && <button type="button" className="ghost" onClick={() => { setHiddenBranches(repo, []); showHead() }}>Show all branches</button>}
            </p>
          )}
          {/* The search sits above the scroller, not over it: the list's background is translucent, so rows scrolled
              under a sticky band would show through it. */}
          <div className="history-scroll" ref={listScroll} onScroll={onListScroll}>
            <CommitList
              listRef={listRef}
              rows={rows}
              indexOf={indexOf}
              selected={picked ? selected : null}
              onSelect={choose}
              onMenu={openMenu}
              hiddenNames={hiddenNames}
              reveal={reveal}
              onKeyDown={onKeyDown}
            />
            {!exhausted && !query.trim() && <button className="more" onClick={() => loadMore()}>Load more</button>}
            {!rows.length && !empty && exhausted && (
              <EmptyState compact icon="noResults" title="No matching commits" hint={authors.length ? 'Try another search, or clear the author filter.' : 'Try a different search.'} />
            )}
          </div>
        </div>
      <div className={`splitter${list.collapsed ? ' off' : ''}`} {...historyHandle} {...list.splitterHandlers} />
        <div
          className="commit-detail has-commit"
          style={{ gridTemplateColumns: `${detailTrack} ${details.collapsed ? 0 : GUTTER}px ${code.collapsed ? `${STRIP_WIDTH}px` : 'minmax(0, 1fr)'}` } as CSSProperties}
        >
              <div
                className={`commit-info${details.folded ? ' folded' : ''}${details.held ? ' held' : ''}`}
                ref={details.pane}
                {...details.paneHandlers}
              >
                {details.folded && (
                  <button ref={details.strip} type="button" className="fold-strip" aria-label="Show commit files" aria-expanded={!details.collapsed} onClick={details.activate}>
                    <Icon name="chevron" />
                    <span className="fold-label"><code>{picked?.hash.slice(0, 7)}</code> {patch?.files.length ?? 0} files</span>
                  </button>
                )}
                {!diffOpen && compareBar}
                <CommitStat files={shown?.files ?? []} view={filesView} onView={setFilesView} onSelect={showFile} activeFiles={activeFiles} />
                {!patch?.files.length && <p className="hint" tabIndex={-1}>{!selected ? 'Pick a commit to see its files.' : emptyHint ?? 'No changed files.'}</p>}
              </div>
              <div className={`splitter${details.collapsed || code.collapsed ? ' off' : ''}`} aria-label="Commit files width" {...detailHandle} {...details.splitterHandlers} />
              <DiffRail fold={code} label={picked?.subject ?? 'Commit details and code diff'}>
                <div className="diff-pane" ref={diffRef} onScroll={onDiffPaneScroll} tabIndex={-1}>
                  {!selected && (empty
                    ? <EmptyState icon="commit" title="No commits yet" hint="Make the first commit from the Changes tab and it shows up here." />
                    : <EmptyState icon="pick" title="No commit selected" hint="Pick a commit from the list. The up and down arrows move between commits." />)}
                  {selected && !current && <p className="hint">Loading…</p>}
                  {selected && current && <>
                    <header className="commit-head" tabIndex={-1}>
                  {picked && (
                    <div className="commit-title">
                      <h2 className="commit-subject">{picked.subject}</h2>
                      {notice && <p className="commit-notice" role="status">{notice}</p>}
                      {commitInput && <CommitDialogs input={commitInput} prompt={prompt} onClose={() => setPrompt(null)} />}
                    </div>
                  )}
                  {picked && <CommitFacts details={current.details} refs={refs?.hash === selected ? refs.refs : null} />}
                  {body && <pre className="commit-body">{body}</pre>}
                  </header>
                  {compareBar}
                  <DiffView files={shown?.files ?? []} moves={shown?.moves ?? []} persist={{ id: `${repo}|history-files`, key: selected ?? '' }} emptyHint={emptyHint} />
                  </>}
                </div>
              </DiffRail>
        </div>
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

// Lanes keep their slot, so most lines run straight through a row. A line that changes slot, and a line from the commit dot
// to a parent in another lane, runs to the row's middle, across, and on, with rounded corners. Every y value scales with
// the row height.
function graphSegments(row: GraphRow<Commit>, rowHeight: number): Segment[] {
  const { commit, lane } = row
  const MID = rowHeight / 2
  const x = laneX
  const color = (index: number) => COLORS[index % COLORS.length]
  const outputOf = (hash: string) => row.output.findIndex((slot) => slot?.hash === hash)
  const segments: Segment[] = []
  row.input.forEach((slot, index) => {
    if (!slot) return
    if (slot.hash === commit.hash) {
      segments.push({ d: index === lane ? `M${x(lane)} 0V${MID}` : elbow(x(index), 0, x(lane), MID, MID), color: color(slot.color) })
      return
    }
    const to = row.output[index]?.hash === slot.hash ? index : outputOf(slot.hash)
    if (to !== -1) segments.push({ d: to === index ? `M${x(index)} 0V${rowHeight}` : elbow(x(index), 0, x(to), rowHeight, MID), color: color(slot.color) })
  })
  for (const parent of commit.parents) {
    const to = outputOf(parent)
    if (to !== -1) segments.push({ d: to === lane ? `M${x(lane)} ${MID}V${rowHeight}` : elbow(x(lane), MID, x(to), rowHeight, MID), color: color(row.output[to]!.color) })
  }
  return segments
}

// A path from (x1, y1) to (x2, y2) that turns through the row's middle: down to it, across, and down again, rounding each
// turn by up to one full lane step. An end that sits on the middle line has no turn.
function elbow(x1: number, y1: number, x2: number, y2: number, mid: number) {
  const sign = Math.sign(x2 - x1)
  const turns = (y1 < mid ? 1 : 0) + (y2 > mid ? 1 : 0)
  const radius = Math.min(LANE_STEP, mid, Math.abs(x2 - x1) / Math.max(turns, 1))
  const enter = y1 < mid ? `V${mid - radius}Q${x1} ${mid} ${x1 + sign * radius} ${mid}` : ''
  const leave = y2 > mid ? `Q${x2} ${mid} ${x2} ${mid + radius}V${y2}` : ''
  return `M${x1} ${y1}${enter}H${y2 > mid ? x2 - sign * radius : x2}${leave}`
}

// The signature as git checked it. Only a bad signature reads as a failure; one git could not check is not called invalid.
const SIGNATURES: Record<NonNullable<CommitDetails['signature']>['code'], { text: string; className?: string }> = {
  G: { text: 'Good', className: 'sig-good' },
  B: { text: 'Bad', className: 'sig-bad' },
  U: { text: 'Good, from a key of unknown validity' },
  X: { text: 'Good, but the signature has expired' },
  Y: { text: 'Good, from an expired key' },
  R: { text: 'Good, from a revoked key' },
  E: { text: 'Cannot be checked, the key may be missing' },
  N: { text: 'Not signed' },
}

const FULL_DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

// The selected commit's identity, from its own detail: a compare or a whitespace filter never changes these.
function CommitFacts({ details, refs }: { details: CommitDetails; refs: CommitRefs | null }) {
  const person = (who: { name: string; email: string }) => `${who.name} <${who.email}>`
  const signature = details.signature && SIGNATURES[details.signature.code]
  const { stats } = details
  return (
    <dl className="commit-facts">
      <dt>Commit</dt><dd><code>{details.hash}</code></dd>
      <dt>Tree</dt><dd><code>{details.tree}</code></dd>
      <dt>Author</dt><dd><Avatar name={details.author.name} email={details.author.email} />{person(details.author)}</dd>
      <dt>Committer</dt><dd>{person(details.committer)}</dd>
      <dt>Date</dt><dd title={details.authorDate}>{Number.isNaN(Date.parse(details.authorDate)) ? details.authorDate : FULL_DATE.format(new Date(details.authorDate))}</dd>
      <dt>Parents</dt><dd>{details.parents.length ? details.parents.map((parent) => <code key={parent} title={parent}>{parent.slice(0, 8)}</code>) : 'None (root commit)'}</dd>
      <dt>Signature</dt>
      <dd className={signature?.className} title={details.signature?.signer || undefined}>
        {signature ? signature.text : 'Could not be checked'}{details.signature?.signer ? ` (${details.signature.signer})` : ''}
      </dd>
      {refs && refs.branches.length + refs.remotes.length > 0 && (
        <><dt>Branches</dt><dd>
          {refs.branches.map((name) => <span key={name} className="ref local">{name}</span>)}
          {refs.remotes.map((name) => <span key={name} className="ref remote">{name}</span>)}
        </dd></>
      )}
      {refs && refs.tags.length > 0 && <><dt>Tags</dt><dd>{refs.tags.map((name) => <span key={name} className="ref tag">{name}</span>)}</dd></>}
      <dt>Stats</dt>
      <dd>
        {stats ? (
          <>
            {stats.files} file{stats.files === 1 ? '' : 's'} changed
            <span className="stat-chip del" aria-label={`${stats.deletions} removed`}>−{stats.deletions}</span>
            <span className="stat-chip add" aria-label={`${stats.additions} added`}>+{stats.additions}</span>
          </>
        ) : 'Could not be read'}
      </dd>
    </dl>
  )
}

const hiddenLabel = (count: number) => `${count} branch${count === 1 ? ' is' : 'es are'} hidden`

// The DOM id of a commit row. The list points aria-activedescendant at the selected one.
const optionId = (hash: string) => `commit-${hash}`

// The message without its subject line and the blank line after it. A message that does not start with the subject is shown whole.
function bodyBelow(message: string, subject: string) {
  const rest = message.slice(subject.length)
  return message.startsWith(subject) && (rest === '' || rest.startsWith('\n')) ? rest.trim() : message
}

// Short times like Sublime Merge: the time today, the weekday and time this week, else the date. The full local timestamp
// is in the tooltip. The formatters are built once; building one per row would cost more than the row.
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const WEEKDAY_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
function formatListDate(seconds: number) {
  const date = new Date(seconds * 1000)
  const now = new Date()
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000)
  if (days === 0) return TIME.format(date)
  if (days > 0 && days < 7) return WEEKDAY_TIME.format(date)
  return (date.getFullYear() === now.getFullYear() ? DAY : DAY_YEAR).format(date)
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

type Graph = { commits: Commit[]; rows: GraphRow<Commit>[]; state: GraphState }
const EMPTY_GRAPH: Graph = { commits: [], rows: [], state: { lanes: [], nextColor: 0 } }
// The checked-out commit, as git log decorates it: "HEAD -> branch", or "HEAD" when detached.
const isHeadCommit = (commit: Commit) => commit.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> '))

// The commit listbox. Rows are a fixed height, so only the window near the pane's viewport mounts, with padding standing in
// for the rows above and below it. Each row draws its own slice of the graph, so lanes run on unbroken across the window.
function CommitList({ listRef, rows, indexOf, selected, onSelect, onMenu, hiddenNames, onKeyDown, reveal }: {
  listRef: RefObject<HTMLUListElement | null>
  rows: GraphRow<Commit>[]
  indexOf: Map<string, number>
  selected: string | null
  onSelect: (hash: string) => void
  onMenu: (hash: string, x: number, y: number) => void
  hiddenNames: ReadonlySet<string>
  onKeyDown: (event: KeyboardEvent<HTMLUListElement>) => void
  reveal: number
}) {
  const [span, setSpan] = useState({ first: 0, last: FIRST_WINDOW })
  const rowHeight = useSyncExternalStore(subscribeRowHeight, readRowHeight)
  const laidOut = useRef(rowHeight)
  // The window follows the scroll and size of the pane the list sits in. It is read before paint, so the first frame
  // already shows its rows. The pane is the list's parent: its own ref is not attached yet when this runs.
  useLayoutEffect(() => {
    const list = listRef.current
    const element = list?.parentElement
    if (!element || !list) return
    // A new row height keeps the same commit at the top of the pane instead of the same pixel offset.
    if (laidOut.current !== rowHeight) {
      const listTop = list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
      if (element.scrollTop > listTop) element.scrollTop = listTop + ((element.scrollTop - listTop) / laidOut.current) * rowHeight
      laidOut.current = rowHeight
    }
    const update = () => {
      const top = Math.max(0, element.getBoundingClientRect().top - list.getBoundingClientRect().top)
      const first = Math.max(0, Math.floor(top / rowHeight / WINDOW_STEP) * WINDOW_STEP - OVERSCAN)
      const last = Math.ceil((top + element.clientHeight) / rowHeight / WINDOW_STEP) * WINDOW_STEP + OVERSCAN
      setSpan((span) => (span.first === first && span.last === last ? span : { first, last }))
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    resize?.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      resize?.disconnect()
    }
  }, [listRef, rowHeight])
  // A new selection, or a reveal of the one already selected, scrolls its row into view, mounted or not.
  const index = selected ? indexOf.get(selected) : undefined
  useEffect(() => {
    const list = listRef.current
    const element = list?.parentElement
    if (!element || !list || index === undefined) return
    const top = list.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop + index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
  }, [selected, reveal])
  const first = Math.min(span.first, rows.length)
  const last = Math.min(span.last, rows.length)
  return (
    <ul
      ref={listRef}
      className="commits"
      role="listbox"
      tabIndex={0}
      aria-label="Commit list"
      // Only a mounted row can be the active descendant.
      aria-activedescendant={selected && index !== undefined && index >= first && index < last ? optionId(selected) : undefined}
      onKeyDown={onKeyDown}
      style={{ paddingTop: first * rowHeight, paddingBottom: (rows.length - last) * rowHeight }}
    >
      {rows.slice(first, last).map((row) => (
        <CommitRow
          key={row.commit.hash}
          row={row}
          rowHeight={rowHeight}
          active={selected === row.commit.hash}
          isHead={isHeadCommit(row.commit)}
          onSelect={onSelect}
          onMenu={onMenu}
          hiddenNames={hiddenNames}
        />
      ))}
    </ul>
  )
}

const CommitRow = memo(function CommitRow({ row, rowHeight, active, isHead, onSelect, onMenu, hiddenNames }: {
  row: GraphRow<Commit>
  rowHeight: number
  active: boolean
  isHead: boolean
  onSelect: (hash: string) => void
  onMenu: (hash: string, x: number, y: number) => void
  hiddenNames: ReadonlySet<string>
}) {
  const { commit } = row
  const x = laneX(row.lane)
  const nodeColor = COLORS[row.color % COLORS.length]
  const refs = commit.refs.filter((ref) => ref !== 'HEAD').map((ref) => ref.replace('HEAD -> ', '')).filter((ref) => !hiddenNames.has(ref))
  return (
    <li id={optionId(commit.hash)} className={`commit${active ? ' active' : ''}`} role="option" aria-selected={active} data-hash={commit.hash} style={{ height: rowHeight }} onClick={() => onSelect(commit.hash)} onContextMenu={(event) => { event.preventDefault(); onMenu(commit.hash, event.clientX, event.clientY) }}>
      <svg className="lanes" width={graphWidth(row.laneCount)} height={rowHeight} aria-hidden="true">
        {graphSegments(row, rowHeight).map((segment, index) => (
          <path key={index} d={segment.d} stroke={segment.color} strokeWidth={1.25} fill="none" strokeLinecap="round" />
        ))}
        <CommitMarker x={x} y={rowHeight / 2} color={nodeColor} merge={commit.parents.length > 1} tip={refs.length > 0} head={isHead} />
      </svg>
      {/* Two lines, like Sublime Merge: the subject, then the author with the refs at right, or the time when there are none. */}
      <span className="text">
        <span className="commit-line">
          <span className="subject">{commit.subject}</span>
          <code className="commit-meta hash">{commit.hash.slice(0, 7)}</code>
        </span>
        <span className="commit-line">
          <Avatar name={commit.author} email={commit.email} />
          <span className="author">{commit.author}</span>
          {isHead && <span className="ref head">HEAD</span>}
          {refs.length > 0 && <span className="ref" title={refs.join(', ')} style={{ borderLeftColor: nodeColor }}>{refs[0]}</span>}
          {refs.length > 1 && <span className="ref" title={refs.join(', ')}>+{refs.length - 1}</span>}
          {!isHead && !refs.length && (
            <span className="commit-meta date" title={new Date(commit.date * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>{formatListDate(commit.date)}</span>
          )}
        </span>
      </span>
    </li>
  )
})

// Sublime Merge's markers: a filled square for a commit, a hollow one for a merge. A branch tip is a size larger, and HEAD
// also gets a ring. Drawn after the lines, so no line covers it.
function CommitMarker({ x, y, color, merge, tip, head }: { x: number; y: number; color: string; merge: boolean; tip: boolean; head: boolean }) {
  const size = head || tip ? 9 : 8
  return (
    <>
      {head && <rect x={x - size / 2 - 2.5} y={y - size / 2 - 2.5} width={size + 5} height={size + 5} rx={3.5} fill="none" stroke="var(--text)" strokeWidth={1.25} />}
      <rect
        className="marker"
        x={x - size / 2}
        y={y - size / 2}
        width={size}
        height={size}
        rx={2}
        fill={merge ? 'var(--content)' : color}
        stroke={color}
        strokeWidth={merge ? 1.5 : 0}
      />
    </>
  )
}

// The author filter beside the search field: a button that opens a checklist of the repo's authors, and a chip per picked author.
function AuthorFilter({ repo, authors, onChange, onError }: {
  repo: string
  authors: string[]
  onChange: (authors: string[]) => void
  onError: (error: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<{ name: string; count: number }[] | null>(null)
  const [find, setFind] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  // The names are read on each open, so authors from a fetch since the last open are listed.
  useEffect(() => {
    if (!open) return
    let stale = false
    api.authors(repo).then((next) => { if (!stale) setChoices(next) }).catch((failure: unknown) => { if (!stale) onError(failure) })
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      stale = true
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, repo, onError])

  const toggle = (name: string) => onChange(authors.includes(name) ? authors.filter((item) => item !== name) : [...authors, name])
  const shown = choices?.filter((choice) => choice.name.toLowerCase().includes(find.trim().toLowerCase())) ?? []
  const label = authors.length ? `Authors: ${authors.join(', ')}` : 'Filter by author'

  return (
    <>
      <div className="author-anchor" ref={box}>
        <button
          ref={trigger}
          type="button"
          className={`icon-button author-trigger${authors.length || open ? ' on' : ''}`}
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="users" />
          {authors.length > 0 && <span className="author-count" aria-hidden="true">{authors.length}</span>}
        </button>
        {open && (
          <div className="popover author-popover" role="dialog" aria-label="Filter by author">
            <input
              type="search"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              placeholder="Find an author"
              aria-label="Find an author"
              autoFocus
              spellCheck={false}
            />
            <div className="author-options">
              {!choices && <p className="author-note">Loading…</p>}
              {choices && !shown.length && <p className="author-note">No matching authors</p>}
              {shown.map((choice) => (
                <label key={choice.name} className="author-option">
                  <input type="checkbox" checked={authors.includes(choice.name)} onChange={() => toggle(choice.name)} />
                  <span className="author-name">{choice.name}</span>
                  <span className="count">{choice.count}</span>
                </label>
              ))}
            </div>
            {authors.length > 0 && <button type="button" onClick={() => onChange([])}>Clear author filter</button>}
          </div>
        )}
      </div>
      {authors.length > 0 && (
        <div className="author-chips">
          {authors.map((name) => (
            <button key={name} type="button" className="author-chip" aria-label={`Remove author ${name}`} title={`Remove ${name}`} onClick={() => toggle(name)}>
              <span>{name}</span>
              <Icon name="close" />
            </button>
          ))}
        </div>
      )}
    </>
  )
}
