import type { CommitIdentity } from '../../shared/identity'
import { IdentityDialog } from './IdentityDialog'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { flushSync } from 'react-dom'
import type { FileChange, RepoStatus } from '../../main/git/status'
import type { DiffFile, DiffHunk, MovedBlock } from '../../main/git/diff'
import type { HunkAction, HunkRequest } from '../../main/git/hunks'
import { DiffView, fileKey, hunkKey, type FileChoices } from './DiffView'
import { useActiveFile, useActiveFiles, useKeepInView, type ActiveFiles } from './active-file'
import { DiffRail } from './DiffRail'
import { confirmOverBlur } from './confirm'
import { confirmDropEdits, type EditBridge } from './DiffEditor'
import { adoptView, mountNear, suspendHold } from './scroll-anchor'
import { FileIcon, FolderIcon } from './FileIcon'
import { Icon, IconButton, toggleLabel } from './Icons'
import { EmptyState } from './EmptyState'
import { splitPath } from './paths'
import { buildTree, treeOrder, type Folder } from './commit-tree'
import { CONTEXT_OPTIONS, useContextLines, useIgnoreWhitespace } from './prefs'
import { useResizable } from './Splitter'
import { GUTTER, STRIP_WIDTH, useFoldHold } from './fold'
import { blockedReason, REPO_WORKING_LABELS, runRepoWrite, useRepoBusy } from './repo-busy'
import { loadSession, savedView, savePlace, saveView, useScrollMemory } from './session'
import { orderFiles, shareFiles, swapFile } from './widen'
import { ConflictView, type ConflictViewProps } from './ConflictView'
import type { Choice, ConflictDocument, ConflictFingerprint, ConflictSave } from '../../shared/conflict'

const api = window.bettergit

interface Props {
  repo: string
  status: RepoStatus
  revision: number
  listOpen: boolean
  detailOpen: boolean
  // The code diff beside the file list. Collapsed, its rail can be previewed or expanded by picking a file.
  diffOpen?: boolean
  onShowDiff?: () => void
  onChanged: () => void
  onError: (error: unknown) => void
}

type Working = { files: DiffFile[]; moves: MovedBlock[] }
// Loads of one status, revision, context and widening (`of`), keyed by loadKey.
interface Loads { of: unknown[]; pending: Map<string, Promise<Working>>; done: Map<string, Working> }
const loadKey = (staged: boolean, hideWhitespace: boolean) => `${staged} ${hideWhitespace}`
const NO_EXTRA: Record<string, number> = {}
// Context is the penultimate part of either load key. A context reload keeps the same file sections and editors.
function sameSource(before: string | null, after: string | null): boolean {
  if (!before || !after) return false
  const previous: unknown[] = JSON.parse(before)
  const next: unknown[] = JSON.parse(after)
  return previous.length === next.length && previous.every((value, index) => index === previous.length - 2 || value === next[index])
}
type Stats = { add: number; del: number }
type Section = 'staged' | 'unstaged'
type View = 'list' | 'tree'
interface Selection {
  path: string
  staged: boolean
}

// One conflicted file. Its choices belong to the model they were made on, so a new model starts them over.
interface ConflictState {
  model: ConflictDocument
  choices: Choice[]
}

// The loaded conflicts of one repo, by path.
interface Conflicts {
  repo: string
  files: Record<string, ConflictState>
}

// Conflicted files load a few at a time, each a handful of git reads in the main process.
const CONFLICT_LOADS = 4

interface SectionProps {
  title: string
  changes: FileChange[]
  staged: boolean
  selection: Selection | null
  stats: Map<string, Stats>
  // Folders are open unless their key is in this set.
  collapsed: Set<string>
  onToggleFolder: (key: string) => void
  onSelect: (change: FileChange) => void
  onToggle: (change: FileChange) => void
  onDiscard?: (change: FileChange) => void
  // Stages or unstages every file in this section. Omitted for the conflicts section.
  onToggleAll?: () => void
  // The write running in this repo, or null. Conflicting controls stay blocked until it settles.
  busy: string | null
  // The file at the top of the diff pane. Its row is marked, apart from the selection, and kept on screen.
  activeFiles: ActiveFiles
}

const VIEW_KEY = 'bettergit.changesView'

// Draft edits per repo. Module level, so a commit from an unmounted pane still sees edits made after a remount.
const draftEdits = new Map<string, number>()

// Whether the conflict resolver on screen holds choices not yet saved, which an update restart must not lose.
let unsavedChoices = false
export const hasUnsavedChoices = () => unsavedChoices

export function ChangesView({ repo, status, revision, listOpen, detailOpen: detailShown, diffOpen = true, onShowDiff, onChanged, onError }: Props) {
  const detailOpen = detailShown && diffOpen
  const [selection, setSelection] = useState<Selection | null>(() => savedSelection(repo, status))
  const busy = useRepoBusy(repo)
  const [identity, setIdentity] = useState<CommitIdentity | null>(null)
  const [identityOpen, setIdentityOpen] = useState(false)
  const identityLoad = useRef(0)
  useEffect(() => {
    let stale = false
    const load = () => {
      const request = ++identityLoad.current
      return api.commitIdentity(repo).then((next) => { if (!stale && request === identityLoad.current) setIdentity(next) })
        .catch((failure: unknown) => { if (!stale && request === identityLoad.current) onError(failure) })
    }
    void load()
    window.addEventListener('focus', load)
    return () => { stale = true; window.removeEventListener('focus', load) }
  }, [repo, revision])
  // The draft is kept in the session, so a reload keeps what was typed.
  const [message, setMessage] = useState(() => loadSession().places[repo]?.draft ?? '')
  const paneRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeFiles = useActiveFiles(paneRef)
  // A render can move the files under a still pane (a load, a stage, a view switch), so each one reads the pane again.
  useEffect(() => activeFiles.probe())
  // The file picked last. The pane scrolls to it once its diff loads. A file restored at launch is revealed only when it has no saved scroll position.
  const revealRef = useRef<{ path: string; from: string } | null>(null)
  const [diff, setDiff] = useState<Working | null>(null)
  const [conflicts, setConflicts] = useState<Conflicts>(() => ({ repo, files: {} }))
  // Both sections load on every refresh. The file rows need their +/- counts, and the empty-selection pane shows them all.
  // Each result keeps the status it was loaded for, so the file list and the diffs change in the same frame.
  const [all, setAll] = useState<{ staged: Working; unstaged: Working; status: RepoStatus } | null>(null)
  // Context level of each widened file, keyed by levelKey. Kept across refreshes and read by the loaders.
  const context = useContextLines()
  const [widened, setWidened] = useState(() => ({ context, levels: loadSession().places[repo]?.widened ?? NO_EXTRA }))
  const extra = widened.context === context ? widened.levels : NO_EXTRA
  useEffect(() => {
    if (widened.context !== context) setWidened({ context, levels: NO_EXTRA })
  }, [context])
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadSession().places[repo]?.collapsed ?? []))
  // Each file's open or closed choice by path, shared by every working diff (all, staged, unstaged and selected), so a
  // file keeps its choice when a stage, discard, delete or refresh moves it to another diff. Only this view saves it.
  const [choices, setChoices] = useState<Record<string, boolean>>(() => savedView(`${repo}|changes-files`, 'working', {}))
  useEffect(() => { saveView(`${repo}|changes-files`, 'working', choices) }, [repo, choices])
  const fileChoices = useMemo<FileChoices>(() => ({ choices, setChoices }), [choices])
  const ignoreWhitespace = useIgnoreWhitespace()
  const { size: listWidth, handle: listHandle } = useResizable('bettergit.changesListWidth', 340, 220, 1100)
  // The view and options each loaded result belongs to. Only a result loaded for the view on screen is ready for its scroll position.
  const allKey = JSON.stringify([repo, context, ignoreWhitespace])
  const allFor = useRef<string | null>(null)
  // The status on screen: the one the shown diffs were loaded for. A refresh changes rows and diffs together once its diffs land.
  const shownStatus = all && allFor.current === allKey ? all.status : status
  // App resolves responsive folding and explicit pins. A held rail expands in flow beside its neighbour.
  // Unfiltered status, not the whitespace-filtered diff: a whitespace-only change is still a change.
  const clean = shownStatus.changes.length === 0
  const list = useFoldHold<HTMLDivElement>(!listOpen, '.changes-view-toggle button')
  const code = useFoldHold<HTMLDivElement>(!detailOpen, '.diff-toolbar button:not(:disabled)')
  const onListScroll = useScrollMemory(listRef, `${repo}|changes-list`, 'list', true)
  // The selected view shows the selection's whole section, so its load and scroll memory depend on the section, not the
  // file. Picking another file in the same section only scrolls to it.
  const section = selection ? selection.staged : null
  const diffKey = section === null ? null : JSON.stringify([repo, section, context, ignoreWhitespace])
  const diffFor = useRef<string | null>(null)
  // The working diffs loaded for this status, revision, context and widening, by section and whitespace option. A refresh
  // or a widen starts a new set. Toggling whitespace back, or picking a file, reads a loaded diff at once instead of reloading.
  const loadsRef = useRef<Loads | null>(null)
  // The last result of each section and option, which a reload shares its unchanged files with.
  const lastWorking = useRef(new Map<string, Working>())
  const loadsFor = [repo, status, revision, context, extra]
  if (!loadsRef.current || loadsRef.current.of.some((value, index) => value !== loadsFor[index])) {
    loadsRef.current = { of: loadsFor, pending: new Map(), done: new Map() }
  }
  const loaded = (isStaged: boolean) => loadsRef.current!.done.get(loadKey(isStaged, ignoreWhitespace))
  // A result, or the failure of its load, shows only for the view and options it was loaded for. While a load for the
  // view on screen runs, its toolbar shows loading in place of hunks and counts from other options.
  const cachedAll = loaded(true) && loaded(false)
  const allShown = all && allFor.current === allKey ? all : cachedAll ? { staged: loaded(true)!, unstaged: loaded(false)! } : sameSource(allFor.current, allKey) ? all : null
  const diffShown = diff && diffFor.current === diffKey ? diff : section === null ? null : loaded(section) ?? (sameSource(diffFor.current, diffKey) ? diff : null)
  const contextPending = section === null ? allFor.current !== allKey && !cachedAll : diffFor.current !== diffKey && !loaded(section)
  const conflicted = useMemo(() => shownStatus.changes.filter((change) => change.conflicted), [shownStatus])
  // An unstaged conflicted row opens the resolver. Its diff is not loaded, because git prints combined diffs for it.
  const conflictSelected = !!selection && !selection.staged && conflicted.some((change) => change.path === selection.path)
  const conflictFiles = conflicts.repo === repo ? conflicts.files : NO_CONFLICTS
  // Only files still in conflict count; a saved file's old entry may linger until the next load.
  useEffect(() => {
    unsavedChoices = conflicted.some((change) => conflictOf(conflictFiles, change.path)?.choices.some((choice) => choice != null))
    return () => { unsavedChoices = false }
  }, [conflicted, conflictFiles])
  const conflictsReady = conflicted.every((change) => conflictOf(conflictFiles, change.path))
  const scrollKey = section === null ? 'all' : conflictSelected ? 'conflicts' : `${section}`
  const diffReady = conflictSelected ? conflictsReady
    : selection ? !!diffShown && diffShown !== LOAD_FAILED : !!allShown?.staged && allShown.staged !== LOAD_FAILED
  // The pane's last position for the view on screen. While a reload or a failure hides that view's hunks the pane clamps:
  // those scroll events are not saved, and the position returns once the view's own result lays out.
  const paneTop = useRef<{ key: string; top: number } | null>(null)
  const hiddenFor = useRef<string | null>(null)
  // A view still rendering in (onScreen, below) is not what the pane shows yet, so its scroll events are not its position.
  const onPaneScroll = (event: UIEvent<HTMLDivElement>) => {
    activeFiles.probe()
    if (!diffReady || !onScreen) return
    paneTop.current = { key: scrollKey, top: event.currentTarget.scrollTop }
    onDiffScroll(event)
  }
  const errorRef = useRef(onError)
  errorRef.current = onError
  const extraRef = useRef(extra)
  extraRef.current = extra
  // The repo on screen, so a reply for a repo the pane has left is dropped.
  const repoRef = useRef(repo)
  repoRef.current = repo

  const sections = useMemo(() => sectionsOf(shownStatus), [shownStatus])
  const { staged, unstaged, changes } = sections
  // Each section's paths in the order its file list shows them, so the diffs list their files the same way.
  const order = useMemo(() => {
    const paths = (list: FileChange[]) => (view === 'tree' ? treeOrder(changeTree(list)) : list).map((change) => change.path)
    return { staged: paths(staged), changes: paths(changes), conflicts: paths(conflicted) }
  }, [staged, changes, conflicted, view])
  const stagedShown = useMemo(() => allShown?.staged && orderFiles(allShown.staged, order.staged), [allShown?.staged, order])
  const unstagedShown = useMemo(() => allShown?.unstaged && orderFiles(allShown.unstaged, order.changes), [allShown?.unstaged, order])
  const selectedShown = useMemo(() => diffShown && (selection?.staged
    ? orderFiles(diffShown, order.staged)
    : orderFiles(diffShown, order.changes)), [diffShown, selection?.staged, order])
  // What each diff on the pane gets, and whether it mounts. The pane is placed once every one shows what it was given, so
  // a switch of view (the selected file moving to the other section, say) lands in one frame, not in steps.
  const stagedFiles = stagedShown?.files ?? NO_FILES.files
  const unstagedFiles = unstagedShown?.files ?? NO_FILES.files
  const selectedFiles = selectedShown?.files ?? NO_FILES.files
  const allView = !selection && shownStatus.changes.length > 0
  const showStaged = allView && ((stagedShown?.files.length ?? 0) > 0 || ((ignoreWhitespace || !stagedShown || stagedShown === LOAD_FAILED) && staged.length > 0))
  const showUnstaged = allView && ((unstagedShown?.files.length ?? 0) > 0 || ((ignoreWhitespace || !unstagedShown || unstagedShown === LOAD_FAILED) && changes.length > 0))
  const onScreenRef = useRef(new Map<string, DiffFile[]>())
  const [, setShownTick] = useState(0)
  const shownHandlers = useMemo(() => Object.fromEntries(['staged', 'unstaged', 'selection'].map((id) => [id, (files: DiffFile[]) => {
    if (onScreenRef.current.get(id) === files) return
    onScreenRef.current.set(id, files)
    setShownTick((tick) => tick + 1)
  }])), [])
  const onScreen = conflictSelected || (selection
    ? onScreenRef.current.get('selection') === selectedFiles
    : (!showStaged || onScreenRef.current.get('staged') === stagedFiles) && (!showUnstaged || onScreenRef.current.get('unstaged') === unstagedFiles))
  // A picked file places the pane itself, below.
  const onDiffScroll = useScrollMemory(paneRef, `${repo}|changes-diff`, scrollKey, diffReady && onScreen,
    selection ? (pane) => revealFile(pane, selection.path, false, true, true) : undefined, { onScreen: true, skip: !!revealRef.current })
  const stats = useMemo(() => countStats(allShown), [allShown])
  // From the status, never from a diff's added status: a tracked addition (git add -N) diffs the same way.
  const untrackedPaths = useMemo(() => new Set(shownStatus.changes.filter((change) => change.kind === 'untracked').map((change) => change.path)) as ReadonlySet<string>, [shownStatus])
  // The position returns before the frame that first shows the view's own result again, with the rows there mounted.
  useLayoutEffect(() => {
    if (!diffReady) {
      hiddenFor.current = paneTop.current?.key === scrollKey ? scrollKey : null
      return
    }
    if (!onScreen) return
    const saved = paneTop.current
    const element = paneRef.current
    const restore = hiddenFor.current === scrollKey && saved?.key === scrollKey
    hiddenFor.current = null
    if (!restore || !saved || !element) return
    adoptView(element)
    element.scrollTop = saved.top
    mountNear(element)
  }, [diffReady, scrollKey, onScreen])
  // The file list changes in the frame the pane shows the view it leads to. While that view is loaded but still rendering
  // (a few frames), the list keeps its rows, counts and highlight, so the list and the diff never disagree.
  const listShown = useRef({ status: shownStatus, selection, stats })
  if (!detailOpen || !diffReady || onScreen) listShown.current = { status: shownStatus, selection, stats }
  const listed = listShown.current
  const listChanges = useMemo(() => (listed.status === shownStatus ? sections : sectionsOf(listed.status)), [listed.status, shownStatus, sections])
  const List = view === 'tree' ? Tree : Group

  // A widen belongs to this load and source file, even if the same path is selected again later.
  // Loaders publish here before setState so replies in one React batch see the newest file.
  const request = useMemo(() => ({}), [repo, revision, status, section, conflictSelected, context, ignoreWhitespace])
  const snapshot = { request, diff, all }
  const currentRequest = useRef<typeof snapshot | null>(snapshot)
  currentRequest.current = snapshot
  useEffect(() => {
    currentRequest.current = snapshot
    return () => { currentRequest.current = null }
  }, [request])

  // Remembers the open file per repo, so a reload returns to it. The closed folders and the widened files are kept the same way.
  useEffect(() => {
    savePlace(repo, { file: selection?.path, staged: selection?.staged })
  }, [repo, selection])

  useEffect(() => {
    savePlace(repo, { collapsed: [...collapsed], widened: extra })
  }, [repo, collapsed, extra])

  // A selection survives a status change only while its file is still in the section it names. Otherwise it moves to the other section or clears.
  // It follows the status on screen, before paint, so the moved selection's diff is already loaded when it shows.
  useLayoutEffect(() => {
    setSelection((current) => {
      if (!current) return current
      const inSection = (isStaged: boolean) => shownStatus.changes.some((change) => change.path === current.path && (isStaged ? change.staged : change.unstaged || change.conflicted))
      if (inSection(current.staged)) return current
      return inSection(!current.staged) ? { path: current.path, staged: !current.staged } : null
    })
  }, [shownStatus])

  useEffect(() => {
    let stale = false
    const key = allKey
    const loads = loadsRef.current!
    const loadedFor = status
    Promise.all([loadWorking(loads, true, ignoreWhitespace), loadWorking(loads, false, ignoreWhitespace)]).then(([nextStaged, nextUnstaged]) => {
      if (!stale) {
        const next = { staged: nextStaged, unstaged: nextUnstaged, status: loadedFor }
        if (currentRequest.current) currentRequest.current.all = next
        allFor.current = key
        setAll(next)
        // The other whitespace option loads while the window is idle, so its toggle shows without waiting.
        window.requestIdleCallback?.(() => {
          if (loadsRef.current !== loads) return
          for (const isStaged of [true, false]) loadWorking(loads, isStaged, !ignoreWhitespace).catch(() => undefined)
        }, { timeout: 500 })
      }
    }).catch((failure: unknown) => {
      if (stale) return
      errorRef.current(failure)
      // A failed refresh keeps the result for the same view. A result for other options is hidden, so its hunks never show under these.
      if (allFor.current === key) return
      allFor.current = key
      // A first load that fails installs the failure too, so it stays on screen after the error banner clears.
      const hidden = { staged: LOAD_FAILED, unstaged: LOAD_FAILED, status: loadedFor }
      if (currentRequest.current) currentRequest.current.all = hidden
      setAll(hidden)
    })
    return () => { stale = true }
  }, [repo, status, revision, context, ignoreWhitespace])

  useEffect(() => {
    if (section === null || conflictSelected) {
      diffFor.current = null
      setDiff(null)
      return
    }
    let stale = false
    const key = diffKey
    const loads = loadsRef.current!
    // Lands with the other section's load, which the all loader shares, so a refresh that moves the selected file to the
    // other section switches the view in the same frame the file leaves this one.
    Promise.all([loadWorking(loads, section, ignoreWhitespace), loadWorking(loads, !section, ignoreWhitespace).catch(() => undefined)])
      .then(([next]) => {
        if (!stale) {
          if (currentRequest.current) currentRequest.current.diff = next
          diffFor.current = key
          setDiff(next)
        }
      })
      .catch(() => {
        // The all view's loader shares this load and reports its failure, so it is reported once.
        if (stale || diffFor.current === key) return
        diffFor.current = key
        if (currentRequest.current) currentRequest.current.diff = LOAD_FAILED
        setDiff(LOAD_FAILED)
      })
    return () => { stale = true }
  }, [repo, status, section, conflictSelected, revision, context, ignoreWhitespace])

  // Every conflicted file loads with each refresh, like the working diffs, so picking one only scrolls to it. The picked
  // file goes first, then the list's order. Each load reads the file and its stage IDs together, and a reload that finds
  // the same fingerprint keeps the choices. A file on screen keeps its model until its reload lands.
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const orderRef = useRef(order.conflicts)
  orderRef.current = order.conflicts
  const conflictKey = conflicted.map((change) => change.path).join('\0')
  useEffect(() => {
    if (!conflictKey) return
    let stale = false
    const picked = selectionRef.current?.path
    const queue = [...orderRef.current].sort((a, b) => Number(b === picked) - Number(a === picked))
    const loadNext = async (): Promise<void> => {
      const path = queue.shift()
      if (path === undefined || stale) return
      try {
        const model: ConflictDocument = await api.conflictLoad(repo, path)
        if (!stale) {
          setConflicts((prev) => {
            const files = prev.repo === repo ? prev.files : {}
            const kept = conflictOf(files, path)
            // The same file and merge state keeps its model and choices, so a refresh leaves the resolver as it is.
            if (kept && prev.repo === repo && (sameModel(kept.model, model) || JSON.stringify(kept.model) === JSON.stringify(model))) return prev
            return { repo, files: { ...files, [path]: { model, choices: [] } } }
          })
        }
      } catch (failure: unknown) {
        if (!stale) errorRef.current(failure)
      }
      return loadNext()
    }
    for (let worker = 0; worker < CONFLICT_LOADS; worker++) void loadNext()
    return () => { stale = true }
  }, [repo, revision, conflictKey])

  // Picking a file keeps the continuous diff and scrolls the file's header into view, at once when its section is on
  // screen, or once that section's diff loads and shows.
  useLayoutEffect(() => {
    const pick = revealRef.current
    if (!pick || !onScreen || (conflictSelected ? !conflictsReady : !diffShown || diffShown === LOAD_FAILED)) return
    revealRef.current = null
    // A pick in the section on screen glides there. Files skipped by content-visibility use their estimated height until
    // a frame has laid them out, so the glide starts after two frames.
    if (pick.from === scrollKey) {
      requestAnimationFrame(() => requestAnimationFrame(() => revealFile(paneRef.current, pick.path, true)))
      return
    }
    // A pick in another section swaps the whole pane, so it lands on the file in the frame the new section first shows.
    revealFile(paneRef.current, pick.path, true, false, true)
  }, [diffShown, selection, conflictSelected, conflictsReady, onScreen])

  // Git writes take the repo's single slot. The reload runs only after a successful write, so a failed reload cannot fail it.
  const write = (key: string, action: () => Promise<unknown>) => runRepoWrite(repo, key, action, {
    onError: (failure) => errorRef.current(failure),
    reload: onChanged,
  })

  // The file rows and the diff header share this. A click during another Git action is ignored, so stages do not race on the index.
  const togglePath = async (path: string, stage: boolean) => {
    if (busy || (stage && !(await confirmDropEdits(repo, [path])))) return
    void write(fileKey(stage ? 'stage' : 'unstage', path), () => (stage ? api.stage(repo, [path]) : api.unstage(repo, [path])))
  }

  // One hunk, at the context level its file shows, so main's fresh diff groups the same hunk. Main refuses a hunk that no
  // longer matches, and any failure reloads, so the next click works on the current diff. Hidden whitespace is never sent.
  const changeHunk = async (path: string, hunk: DiffHunk, action: HunkAction) => {
    if (busy || ignoreWhitespace) return
    if (action === 'discard' && !(await confirmOverBlur(`Discard this hunk of ${path}? This cannot be undone.`))) return
    if (action !== 'unstage' && !(await confirmDropEdits(repo, [path]))) return
    const staged = action === 'unstage'
    const request: HunkRequest = {
      path, staged, context: extra[levelKey(staged, path)] ?? context, header: hunk.header, lines: hunk.lines.map(({ type, text }) => ({ type, text })),
      id: hunk.id ?? '',
    }
    void runRepoWrite(repo, hunkKey(action, path, hunk.header), () => api.applyHunk(repo, action, request), {
      onError: (failure) => {
        errorRef.current(failure)
        onChanged()
      },
      reload: onChanged,
    })
  }
  const onHunk = ignoreWhitespace || contextPending ? undefined : changeHunk

  const toggle = (change: FileChange, stage: boolean) => togglePath(change.path, stage)

  // Working-tree diffs edit their files in place. A save takes the repo slot like any write, and the diff reloads after it.
  const edit: EditBridge = {
    repo,
    load: (path) => api.readFile(repo, path),
    save: (path, loaded, text) => write(`file-save:${path}`, () => api.writeFile(repo, path, loaded, text)),
    onError: (failure) => errorRef.current(failure),
    disabled: !!busy,
  }

  // Each choice copies the list, since the list belongs to the model on screen and that model is replaced on reload.
  const chooseConflict = (path: string, index: number, choice: Choice) => setConflicts((prev) => {
    const file = prev.repo === repo ? conflictOf(prev.files, path) : undefined
    if (!file) return prev
    const choices = [...file.choices]
    choices[index] = choice
    return { repo, files: { ...prev.files, [path]: { ...file, choices } } }
  })

  // Save sends the fingerprint the file had at load, with the choices. The write takes the repo's single write slot and
  // names its file, so only that file's bar shows it saving.
  const saveConflictFile = (path: string, save: ConflictSave) => {
    void write(`resolve:${path}`, () => api.conflictSave(repo, path, save))
  }

  // Reset rebuilds the file from Git's index after the user confirms. Its reply replaces only the model it was asked
  // for, and clears that model's choices even when the bytes come back the same.
  const resetConflictFile = async (path: string) => {
    const conflict = conflictOf(conflictFiles, path)
    if (busy || !conflict?.model.reset.available) return
    const { fingerprint } = conflict.model.reset
    if (!(await confirmOverBlur(`Reset resolution for "${path}"?\n\nThis replaces the whole working file with its conflicts recreated from Git's index, `
      + 'and discards saved edits and unsaved choices for this file. The conflict markers are rebuilt in diff3 style, '
      + 'so labels and layout can differ from the original. The file stays unmerged and unstaged. Other files are unchanged.'))) return
    void write(`conflict-reset:${path}`, async () => {
      const model = await api.conflictReset(repo, path, { fingerprint })
      if (repoRef.current !== repo) return
      setConflicts((prev) => {
        const file = prev.repo === repo ? conflictOf(prev.files, path) : undefined
        return file?.model.reset.available && sameFingerprint(file.model.reset.fingerprint, fingerprint)
          ? { repo, files: { ...prev.files, [path]: { model, choices: [] } } }
          : prev
      })
    })
  }

  // Taking a side replaces the whole file from Git's index after the user confirms. The reload that follows loads the
  // new file, whose fingerprint drops the old choices.
  const takeConflictFile = async (path: string, side: 'ours' | 'theirs') => {
    const model = conflictOf(conflictFiles, path)?.model
    const fingerprint = model?.supported ? model.fingerprint : model?.reset.available ? model.reset.fingerprint : null
    if (busy || !fingerprint) return
    const name = side === 'ours' ? 'ours, the current side' : 'theirs, the incoming side'
    if (!(await confirmOverBlur(`Resolve "${path}" using ${name}?\n\nThis replaces the whole working file with that side's version from Git's index, `
      + 'and discards saved edits and unsaved choices for this file, including changes from the other side that merged cleanly. '
      + 'The file stays unmerged until you stage it. Other files are unchanged.'))) return
    void write(`conflict-take:${side}:${path}`, () => api.conflictTake(repo, path, { fingerprint, side }))
  }

  // Each file's handlers keep their identity across renders and call the latest ones, so a choice re-renders only its file.
  const conflictActions = useRef({ chooseConflict, saveConflictFile, resetConflictFile, takeConflictFile, togglePath })
  conflictActions.current = { chooseConflict, saveConflictFile, resetConflictFile, takeConflictFile, togglePath }
  const handlersRef = useRef(new Map<string, ConflictHandlers>())
  const handlersFor = (path: string) => {
    let handlers = handlersRef.current.get(path)
    if (!handlers) {
      handlers = {
        onChoose: (index, choice) => conflictActions.current.chooseConflict(path, index, choice),
        onSave: (save) => conflictActions.current.saveConflictFile(path, save),
        onReset: () => conflictActions.current.resetConflictFile(path),
        onStage: () => void conflictActions.current.togglePath(path, true),
        onTake: (side) => void conflictActions.current.takeConflictFile(path, side),
      }
      handlersRef.current.set(path, handlers)
    }
    return handlers
  }

  // Bulk actions take only the listed paths. Conflicts are not in either list, so their markers are never staged here.
  const togglePaths = async (paths: string[], stage: boolean) => {
    if (busy || !paths.length || (stage && !(await confirmDropEdits(repo, paths)))) return
    void write(stage ? 'stage:all' : 'unstage:all', () => (stage ? api.stage(repo, paths) : api.unstage(repo, paths)))
  }

  const choose = (change: FileChange, isStaged: boolean) => {
    revealRef.current = { path: change.path, from: scrollKey }
    setSelection({ path: change.path, staged: isStaged })
    if (!detailOpen) onShowDiff?.()
  }

  const discardPath = async (path: string) => {
    if (busy || !(await confirmOverBlur(`Discard unstaged changes to ${path}? This cannot be undone.`)) || !(await confirmDropEdits(repo, [path]))) return
    void write(fileKey('discard', path), () => api.discard(repo, [path]))
  }
  const discard = (change: FileChange) => discardPath(change.path)

  // An untracked file is not in Git, so nothing can bring it back. Main checks again that it is still untracked.
  const deletePath = async (path: string) => {
    if (busy || !(await confirmOverBlur(`Delete ${path}? It is untracked, so Git cannot restore it.`)) || !(await confirmDropEdits(repo, [path]))) return
    void write(fileKey('delete', path), () => api.deleteUntracked(repo, path))
  }

  const toggleFolder = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const chooseView = (next: View) => {
    localStorage.setItem(VIEW_KEY, next)
    setView(next)
  }

  const expandChange = (file: DiffFile, inSelection = false) => expandFile('unstaged', file, inSelection)

  // Widens one file a step. Only that file is swapped in, so the rest of the section keeps its loaded hunks.
  const expandFile = (section: Section, file: DiffFile, inSelection = false) => {
    const path = pathOf(file)
    const key = levelKey(section === 'staged', path)
    const current = extra[key] ?? context
    const next = CONTEXT_OPTIONS.find((level) => level > current) ?? current
    const currentSource = () => {
      const latest = currentRequest.current
      const working = inSelection ? latest?.diff : latest?.all?.[section]
      return latest?.request === request && working?.files.includes(file) ? latest : null
    }
    api.working(repo, section === 'staged', next, path, ignoreWhitespace).then((fresh: Working) => {
      const latest = currentSource()
      const replacement = fresh.files[0]
      const working = inSelection ? latest?.diff : latest?.all?.[section]
      if (!latest || !replacement || !working) return
      const widened = replaceFile(working, path, replacement)
      setWidened((prev) => ({ context, levels: { ...(prev.context === context ? prev.levels : NO_EXTRA), [key]: next } }))
      if (inSelection) {
        latest.diff = widened
        setDiff(widened)
      } else if (latest.all) {
        latest.all = { ...latest.all, [section]: widened }
        setAll(latest.all)
      }
    }).catch((failure: unknown) => { if (currentSource()) errorRef.current(failure) })
  }

  // Empty text drops the draft, so clearing the box is how a draft is discarded.
  const editMessage = (text: string) => {
    draftEdits.set(repo, (draftEdits.get(repo) ?? 0) + 1)
    setMessage(text)
    savePlace(repo, { draft: text || undefined })
  }

  const canCommit = staged.length > 0 && message.trim().length > 0

  // The commit button says why it cannot run. Its own run shows a spinner and is not blocked by a reason.
  const commitBlocked = busy === null || busy === 'commit' ? undefined : blockedReason(busy)

  const commit = () => {
    if (busy || !canCommit) return
    const edit = draftEdits.get(repo)
    void write('commit', async () => {
      await api.commitChanges(repo, message, false)
      // A draft typed while the commit ran was not committed, so it stays, even if it was typed in a remounted pane.
      if (draftEdits.get(repo) === edit) editMessage('')
      setSelection(null)
    })
  }

  // One load per section and option in a set: the section view and the all view share it, and a failed load is retried.
  // Files a reload finds unchanged keep their loaded objects.
  function loadWorking(loads: Loads, isStaged: boolean, hideWhitespace: boolean): Promise<Working> {
    const key = loadKey(isStaged, hideWhitespace)
    let load = loads.pending.get(key)
    if (!load) {
      load = api.working(repo, isStaged, context, undefined, hideWhitespace)
        .then((next: Working) => widen(repo, next, isStaged, extraRef.current, hideWhitespace))
        .then((next) => {
          const shared = shareFiles(lastWorking.current.get(key), next)
          lastWorking.current.set(key, shared)
          return shared
        })
      load.then((next) => { loads.done.set(key, next) }, () => { loads.pending.delete(key) })
      loads.pending.set(key, load)
    }
    return load
  }

  // Reloads each widened file at its own level, so a global reload does not undo an expansion.
  async function widen(repoPath: string, working: Working, isStaged: boolean, levels: Record<string, number>, hideWhitespace: boolean): Promise<Working> {
    const prefix = levelKey(isStaged, '')
    let next = working
    for (const [key, level] of Object.entries(levels)) {
      if (!key.startsWith(prefix)) continue
      const path = key.slice(prefix.length)
      const fresh: Working = await api.working(repoPath, isStaged, level, path, hideWhitespace)
      if (fresh.files[0]) next = replaceFile(next, path, fresh.files[0])
    }
    return next
  }

  return (
    <div className="changes" style={{ gridTemplateColumns: `${list.collapsed ? `${STRIP_WIDTH}px` : code.collapsed ? 'minmax(0, 1fr)' : `${listWidth}px`} ${list.collapsed ? 0 : GUTTER}px ${code.collapsed ? `${STRIP_WIDTH}px` : 'minmax(0, 1fr)'}` }}>
      {/* Clicking empty space in the list clears the file selection, so the right pane shows every change again. */}
        <div
          className={`file-list${list.folded ? ' folded' : ''}${list.held ? ' held' : ''}`}
          ref={list.pane}
          {...list.paneHandlers}
          onClick={(event) => {
            // The strip is not a row, so a click on it keeps the selection.
            if (!(event.target as HTMLElement).closest('li, h3, .commit-box, .changes-view-toggle, .tree-row, .fold-strip')) setSelection(null)
          }}
        >
          {list.folded && (
            <button ref={list.strip} type="button" className="fold-strip" aria-label="Show file list" aria-expanded={!list.collapsed} onClick={list.activate}>
              <Icon name="chevron" />
              <span className="fold-label">{selection ? splitPath(selection.path).name : `${changes.length} changed · ${staged.length} staged`}</span>
            </button>
          )}
          <div className="file-list-head">
            <span className="file-list-title">Files</span>
            <div className="changes-view-toggle" role="group" aria-label="File list layout">
              <IconButton icon="listFlat" label={view === 'list' ? 'List view: on' : toggleLabel('List view: off', 'show files as a flat list')} active={view === 'list'} onClick={() => chooseView('list')} />
              <IconButton icon="listTree" label={view === 'tree' ? 'Tree view: on' : toggleLabel('Tree view: off', 'show files in folders')} active={view === 'tree'} onClick={() => chooseView('tree')} />
            </div>
          </div>
          <div className="file-scroll" ref={listRef} onScroll={onListScroll}>
            {clean && <p className="file-list-empty">No changed files</p>}
            {listChanges.conflicted.length > 0 && (
              <List
                title="Conflicts"
                changes={listChanges.conflicted}
                staged={false}
                selection={listed.selection}
                stats={listed.stats}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                onSelect={(change) => choose(change, false)}
                onToggle={(change) => toggle(change, true)}
                busy={busy}
                activeFiles={activeFiles}
              />
            )}
            {/* Only working-tree changes belong here; partially staged paths appear in both sections. */}
            <List
              title="Changes"
              changes={listChanges.changes}
              staged={false}
              selection={listed.selection}
              stats={listed.stats}
              collapsed={collapsed}
              onToggleFolder={toggleFolder}
              onSelect={(change) => choose(change, false)}
              onToggle={(change) => toggle(change, change.unstaged)}
              onDiscard={discard}
              onToggleAll={unstaged.length ? () => togglePaths(unstaged.map((change) => change.path), true) : undefined}
              busy={busy}
              activeFiles={activeFiles}
            />
            <List
              title="Staged"
              changes={listChanges.staged}
              staged
              selection={listed.selection}
              stats={listed.stats}
              collapsed={collapsed}
              onToggleFolder={toggleFolder}
              onSelect={(change) => choose(change, true)}
              onToggle={(change) => toggle(change, false)}
              onToggleAll={() => togglePaths(staged.map((change) => change.path), false)}
              busy={busy}
              activeFiles={activeFiles}
            />
          </div>
          <div className="commit-box">
            <button type="button" className="commit-identity" aria-label="Edit commit identity" disabled={!!busy} onClick={() => setIdentityOpen(true)}>
              {identity && !identity.error ? `${identity.name} <${identity.email}>` : identity?.error ? 'Set commit identity' : 'Commit identity…'}
            </button>
            {identityOpen && <IdentityDialog repo={repo} identity={identity} onSaved={(next) => { identityLoad.current++; setIdentity(next) }} onClose={() => setIdentityOpen(false)} />}
            <textarea
              value={message}
              onChange={(event) => editMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.metaKey && canCommit) {
                  event.preventDefault()
                  void commit()
                }
              }}
              placeholder="Commit message"
              aria-label="Commit message"
            />
            <button
              className="commit-action"
              disabled={!canCommit}
              aria-disabled={busy !== null || undefined}
              aria-busy={busy === 'commit' || undefined}
              title={commitBlocked}
              onClick={commit}
            >
              {busy === 'commit' && <Icon name="loader" className="action-spin" />}
              {busy === 'commit' ? REPO_WORKING_LABELS.commit : staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'}
              {canCommit && busy === null && <kbd aria-hidden="true">⌘↩</kbd>}
            </button>
          </div>
        </div>
      <div className={`splitter${list.collapsed || code.collapsed ? ' off' : ''}`} {...listHandle} {...list.splitterHandlers} />
      <DiffRail fold={code} label={selection ? splitPath(selection.path).name : 'Changes and staged diffs'}>
        <div className="diff-pane" ref={paneRef} onScroll={onPaneScroll} tabIndex={-1}>
          {!selection && shownStatus.changes.length === 0 && <EmptyState icon="clean" title="Working tree clean" hint="Nothing to commit. New edits show up here as you make them." />}
          {/* Every conflicted file, each in its own section, in the list's order. Picking one scrolls to it. */}
          {(!selection || conflictSelected) && order.conflicts.length > 0 && <h2 className="diff-section">Conflicts <span className="count">{order.conflicts.length}</span></h2>}
          {(!selection || conflictSelected) && order.conflicts.map((path) => {
            const file = conflictOf(conflictFiles, path)
            return file
              ? <ConflictFile key={path} path={path} model={file.model} choices={file.choices} {...handlersFor(path)} busy={fileBusy(busy, path)} />
              : (
                <section key={path} className="conflict" aria-label={`Conflict in ${path}`} data-path={path}>
                  <header className="conflict-bar"><span className="conflict-path" title={path}>{path}</span></header>
                  <p className="hint">Loading conflict…</p>
                </section>
              )
          })}
          {!selection && shownStatus.changes.length > 0 && (
            <>
              <h2 className="diff-section">Changes {unstagedShown && unstagedShown !== LOAD_FAILED && <span className="count">{unstagedShown.files.length}</span>}</h2>
              {showUnstaged && (
                <DiffView
                  files={unstagedFiles}
                  moves={unstagedShown?.moves ?? NO_FILES.moves}
                  stage={{ staged: false, busy, onToggle: togglePath, onDiscard: discardPath, onDelete: deletePath, untrackedPaths, onHunk }}
                  edit={edit}
                  onExpand={(file) => expandChange(file)}
                  contextFor={(file) => extra[levelKey(false, pathOf(file))] ?? context}
                  fileChoices={fileChoices}
                  section="unstaged"
                  refreshOf={`${repo} unstaged`}
                  onShown={shownHandlers.unstaged}
                  emptyHint={unstagedShown === LOAD_FAILED ? LOAD_FAILED_HINT : unstagedShown ? undefined : LOADING_HINT}
                />
              )}
              <h2 className="diff-section">Staged {stagedShown && stagedShown !== LOAD_FAILED && <span className="count">{stagedShown.files.length}</span>}</h2>
              {/* While it loads, with the whitespace option on, or after a failed load, a section with changes still mounts its DiffView, so the toolbar stays usable. */}
              {showStaged && (
                <DiffView
                  files={stagedFiles}
                  moves={stagedShown?.moves ?? NO_FILES.moves}
                  stage={{ staged: true, busy, onToggle: togglePath, onHunk }}
                  onExpand={(file) => expandFile('staged', file)}
                  contextFor={(file) => extra[levelKey(true, pathOf(file))] ?? context}
                  fileChoices={fileChoices}
                  section="staged"
                  refreshOf={`${repo} staged`}
                  onShown={shownHandlers.staged}
                  emptyHint={stagedShown === LOAD_FAILED ? LOAD_FAILED_HINT : stagedShown ? undefined : LOADING_HINT}
                />
              )}
            </>
          )}
          {/* Staging and editing follow the section on screen, so the files there keep their rows until the other section's show. */}
          {selection && !conflictSelected && (
            <DiffView
              files={selectedFiles}
              moves={selectedShown?.moves ?? NO_FILES.moves}
              stage={{ staged: listed.selection?.staged ?? selection.staged, busy, onToggle: togglePath, onDiscard: discardPath, onDelete: deletePath, untrackedPaths, onHunk }}
              edit={(listed.selection?.staged ?? selection.staged) ? undefined : edit}
              onExpand={(file) => (selection.staged ? expandFile('staged', file, true) : expandChange(file, true))}
              contextFor={(file) => extra[levelKey(selection.staged, pathOf(file))] ?? context}
              fileChoices={fileChoices}
              section={(listed.selection?.staged ?? selection.staged) ? 'staged' : 'unstaged'}
              refreshOf={`${repo} ${selection.staged ? 'staged' : 'unstaged'}`}
              onShown={shownHandlers.selection}
              emptyHint={diffShown === LOAD_FAILED ? LOAD_FAILED_HINT : diffShown ? undefined : LOADING_HINT}
            />
          )}
        </div>
      </DiffRail>
    </div>
  )
}

type ConflictHandlers = Pick<ConflictViewProps, 'onChoose' | 'onSave' | 'onReset' | 'onStage' | 'onTake'>

const NO_CONFLICTS: Record<string, ConflictState> = {}

// Paths are keys, and a file may be named `constructor` or `__proto__`, so only the object's own entries count.
function conflictOf(files: Record<string, ConflictState>, path: string): ConflictState | undefined {
  return Object.hasOwn(files, path) ? files[path] : undefined
}

// Memoised, so a choice, a save or a load in one file leaves the other files' diffs alone.
const ConflictFile = memo(ConflictView)

// The busy key as one file's bar reads it. Its own save or reset shows as running there. In any other file it only blocks.
function fileBusy(busy: string | null, path: string): string | null {
  if (busy === `resolve:${path}`) return 'resolve'
  if (busy === `conflict-reset:${path}`) return 'conflict-reset'
  if (busy === fileKey('stage', path)) return 'stage'
  for (const side of ['ours', 'theirs']) if (busy === `conflict-take:${side}:${path}`) return `conflict-take:${side}`
  return busy
}

// Two loads describe the same file and merge state when their fingerprints match. An unsupported file never matches.
function sameModel(a: ConflictDocument, b: ConflictDocument): boolean {
  return a.supported && b.supported && sameFingerprint(a.fingerprint, b.fingerprint)
}

function sameFingerprint(a: ConflictFingerprint, b: ConflictFingerprint): boolean {
  return a.working === b.working && a.stages === b.stages
}

// Git status supplies a separate entry per side for partially staged files.
function sectionsOf(status: RepoStatus) {
  const unstaged = status.changes.filter((change) => change.unstaged && !change.conflicted)
  return {
    staged: status.changes.filter((change) => change.staged && !change.conflicted),
    unstaged,
    changes: unstaged,
    conflicted: status.changes.filter((change) => change.conflicted),
  }
}

// The file open last time, if it is still in the changes. A file that is gone opens with no selection.
function savedSelection(repo: string, status: RepoStatus): Selection | null {
  const place = loadSession().places[repo]
  if (!place?.file || !status.changes.some((change) => change.path === place.file)) return null
  return { path: place.file, staged: !!place.staged }
}

// Shown in place of a result loaded for another view or options when the load for the current one fails. It stays until a load succeeds.
const LOAD_FAILED: Working = { files: [], moves: [] }
const LOAD_FAILED_HINT = 'Could not load these changes.'
// The diff a section's toolbar shows while the load for the view on screen runs. Shared, so DiffView keeps its memo.
const NO_FILES: Working = { files: [], moves: [] }
const LOADING_HINT = 'Loading…'

// A picked file glides to its header and its header flashes once, so the eye lands on it. Restores, and picks that swap
// the pane's section, jump without motion.
// `held` keeps the pane's hold on while it jumps, for a view just swapped in whose rows above still settle their heights.
function revealFile(pane: HTMLElement | null, path: string, picked = false, glide = true, held = false) {
  const find = () => Array.from(pane?.querySelectorAll<HTMLElement>('[data-path]') ?? []).find((element) => element.dataset.path === path)
  const section = find()
  if (!section || !pane) return
  const still = !picked || !glide || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (still && !held) suspendHold(pane)
  section.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' })
  if (still) mountNear(pane)
  void settleOn(pane, find)
  if (!picked) return
  section.classList.remove('revealed')
  void section.offsetWidth // Restarts the flash when the same file is picked again.
  section.classList.add('revealed')
}

// Rows above the file mount with their real heights while the pane moves, and files load their editor-look rows in idle
// time, which moves the file. So once the pane is at rest the file is put back at the top whenever it drifts, for a
// short while. Scrolling by the user ends it.
const SETTLE_MS = 1500
let settling = 0
async function settleOn(pane: HTMLElement, find: () => HTMLElement | undefined) {
  const run = ++settling
  let user = false
  const stop = () => { user = true }
  const events = ['wheel', 'pointerdown', 'keydown'] as const
  events.forEach((name) => pane.addEventListener?.(name, stop, { passive: true, once: true }))
  let last = Number.NaN
  let rested = 0
  const start = performance.now()
  while (run === settling && !user && performance.now() - start < 5000 && (!rested || performance.now() - rested < SETTLE_MS)) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    // Still gliding.
    if (!rested && pane.scrollTop !== last) {
      last = pane.scrollTop
      continue
    }
    rested ||= performance.now()
    const section = find()
    if (!section) break
    // Only a move is the pane's own, so the hold stays on for the frames the file is already in place.
    const from = pane.scrollTop
    section.scrollIntoView({ block: 'start' })
    if (pane.scrollTop === from) continue
    suspendHold(pane)
    // Outside React's commit, so the rows mount through flushSync to make this frame. Rows mounted above the file move it,
    // and the hold is off, so it is put back once more.
    flushSync(() => mountNear(pane))
    section.scrollIntoView({ block: 'start' })
  }
  events.forEach((name) => pane.removeEventListener?.(name, stop))
}

// The path a file is listed and matched by: its new name, or its old one for a deletion.
function pathOf(file: DiffFile): string {
  return file.newPath ?? file.oldPath ?? ''
}

function levelKey(staged: boolean, path: string): string {
  return `${staged ? 's' : 'u'}:${path}`
}

// Moves are re-anchored in the widened file, so their connectors stay drawn.
function replaceFile(working: Working, path: string, next: DiffFile): Working {
  const index = working.files.findIndex((file) => pathOf(file) === path)
  return index < 0 ? working : swapFile(working, index, next)
}

// Added and removed line counts for every file, keyed by section and path, so each row can show them.
function countStats(all: { staged: Working; unstaged: Working } | null): Map<string, Stats> {
  const map = new Map<string, Stats>()
  if (!all) return map
  for (const [section, working] of [['staged', all.staged], ['unstaged', all.unstaged]] as const) {
    for (const file of working.files) {
      const lines = file.hunks.flatMap((hunk) => hunk.lines)
      map.set(`${section}:${pathOf(file)}`, {
        add: lines.filter((line) => line.type === 'add').length,
        del: lines.filter((line) => line.type === 'del').length,
      })
    }
  }
  return map
}

function Group({ title, changes, staged, selection, stats, onSelect, onToggle, onDiscard, onToggleAll, busy, activeFiles }: SectionProps) {
  const sectionRef = useRef<HTMLElement>(null)
  const inView = useInView(activeFiles, staged)
  useKeepInView(sectionRef, inView)
  if (!changes.length) return null
  return (
    <section className="group" ref={sectionRef}>
      <SectionHeader title={title} count={changes.length} staged={staged} onToggleAll={onToggleAll} busy={busy} />
      <ul>
        {changes.map((change) => {
          const active = selection?.path === change.path && selection.staged === staged
          return (
            <li key={`${staged}-${change.path}`} className={`${active ? 'active' : ''}${inView === change.path ? ' in-view' : ''}`}>
              <FileRow change={change} staged={staged || !change.unstaged} stats={stats} showDir onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} busy={busy} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Same structure as the repo sidebar: folder rows with a chevron, nested groups with guide lines.
function Tree({ title, changes, staged, selection, stats, collapsed, onToggleFolder, onSelect, onToggle, onDiscard, onToggleAll, busy, activeFiles }: SectionProps) {
  const folder = useMemo(() => changeTree(changes), [changes])
  const sectionRef = useRef<HTMLElement>(null)
  const inView = useInView(activeFiles, staged)
  useKeepInView(sectionRef, inView)
  if (!changes.length) return null
  const renderFile = (change: FileChange) => {
    const active = selection?.path === change.path && selection.staged === staged
    return (
      <div key={change.path} role="treeitem" aria-selected={active}>
        <div className={`tree-row${active ? ' selected' : ''}${inView === change.path ? ' in-view' : ''}`}>
          <FileRow change={change} staged={staged || !change.unstaged} stats={stats} showDir={false} onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} busy={busy} />
        </div>
      </div>
    )
  }
  return (
    <section className="group" ref={sectionRef}>
      <SectionHeader title={title} count={changes.length} staged={staged} onToggleAll={onToggleAll} busy={busy} />
      <div className="tree" role="tree">
        <TreeLevel folder={folder} section={title} collapsed={collapsed} onToggleFolder={onToggleFolder} renderFile={renderFile} />
      </div>
    </section>
  )
}

// The path of the file at the top of the diff pane when it belongs to this list section, else null. A file with only
// staged changes is in the Changes diff, so it marks its Changes row, and a conflict marks its Conflicts row.
function useInView(activeFiles: ActiveFiles, staged: boolean): string | null {
  const active = useActiveFile(activeFiles)
  return active && (active.section === 'staged') === staged ? active.path : null
}

// The section title with its count. The header button stages every file in an unstaged section, or unstages a staged one.
function SectionHeader({ title, count, staged, onToggleAll, busy }: {
  title: string
  count: number
  staged: boolean
  onToggleAll?: () => void
  busy: string | null
}) {
  const key = staged ? 'unstage:all' : 'stage:all'
  return (
    <h3>
      {title} <span className="count">{count}</span>
      {onToggleAll && (
        <span style={{ marginLeft: 'auto' }}>
          <IconButton
            icon={staged ? 'minus' : 'plus'}
            label={staged ? 'Unstage all changes' : 'Stage all changes'}
            busy={busy === key}
            blocked={busy !== null && busy !== key ? blockedReason(busy) : undefined}
            onClick={onToggleAll}
          />
        </span>
      )}
    </h3>
  )
}

// Folders first, then files, each alphabetical, as History's tree. The file list draws this order and the diffs follow it.
const changeTree = (changes: FileChange[]) => buildTree(changes, (change) => change.path)

// In changeTree's order. A collapsed folder's contents are not rendered.
function TreeLevel({ folder, section, collapsed, onToggleFolder, renderFile }: {
  folder: Folder<FileChange>
  section: string
  collapsed: Set<string>
  onToggleFolder: (key: string) => void
  renderFile: (change: FileChange) => ReactNode
}) {
  const folders = [...folder.folders.values()]
  const files = folder.files
  return (
    <>
      {folders.map((child) => {
        const key = `${section}:${child.path}`
        const expanded = !collapsed.has(key)
        return (
          <div
            key={key}
            role="treeitem"
            aria-expanded={expanded}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
                event.preventDefault()
                onToggleFolder(key)
              }
            }}
          >
            <div className="tree-row folder" onClick={() => onToggleFolder(key)}>
              <span className={`chevron${expanded ? ' open' : ''}`}><Icon name="chevron" /></span>
              <span className="row-icon"><FolderIcon open={expanded} /></span>
              <span className="tree-label">{child.name}</span>
              <span className="folder-count">{child.count}</span>
            </div>
            {expanded && (
              <div role="group" className="tree-children">
                <TreeLevel folder={child} section={section} collapsed={collapsed} onToggleFolder={onToggleFolder} renderFile={renderFile} />
              </div>
            )}
          </div>
        )
      })}
      {files.map((change) => renderFile(change))}
    </>
  )
}

// The name, counts, and status (which doubles as the stage button) shared by both views. Tree rows drop the folder part of the path.
function FileRow({ change, staged, stats, showDir, onSelect, onToggle, onDiscard, busy }: {
  change: FileChange
  staged: boolean
  stats: Map<string, Stats>
  showDir: boolean
  onSelect: (change: FileChange) => void
  onToggle: (change: FileChange) => void
  onDiscard?: (change: FileChange) => void
  busy: string | null
}) {
  const { name, dir } = splitPath(change.path)
  const discardAction = !staged && change.kind !== 'untracked' && !change.conflicted ? onDiscard : undefined
  const discardKey = fileKey('discard', change.path)
  const stageKey = fileKey(staged ? 'unstage' : 'stage', change.path)
  const counts = stats.get(`${staged ? 'staged' : 'unstaged'}:${change.path}`)
  return (
    <>
      <span className={`file-with-action${discardAction ? ' has-row-action' : ''}`}>
        <button className="file" onClick={() => onSelect(change)}>
          <FileIcon name={name} />
          <span className="path" title={change.path}>
            <span className="path-name">{name}</span>
            {showDir && dir && <span className="path-dir">{dir}</span>}
          </span>
        </button>
        {discardAction && (
          <IconButton
            icon="trash"
            label={busy === discardKey ? `Discarding ${change.path}…` : `Discard changes to ${change.path}`}
            busy={busy === discardKey}
            blocked={busy !== null && busy !== discardKey ? blockedReason(busy) : undefined}
            className="discard"
            onClick={() => discardAction(change)}
          />
        )}
      </span>
      {counts && (counts.add > 0 || counts.del > 0) && (
        <span className="row-stat" aria-label={`${counts.add} added, ${counts.del} removed`}>
          <span className="add">+{counts.add}</span>
          <span className="del">−{counts.del}</span>
        </span>
      )}
      {/* The status badge turns into the stage (+) or unstage (−) button while the row is hovered or focused. */}
      <span className="kind-slot">
        <span className={`kind kind-${change.kind}`} title={change.kind}>{badge(change.kind)}</span>
        <IconButton
          icon={staged ? 'minus' : 'plus'}
          label={busy === stageKey ? `${staged ? 'Unstaging' : 'Staging'} ${change.path}…` : `${staged ? 'Unstage' : 'Stage'} ${change.path}`}
          busy={busy === stageKey}
          blocked={busy !== null && busy !== stageKey ? blockedReason(busy) : undefined}
          className="stage-toggle"
          onClick={() => onToggle(change)}
        />
      </span>
    </>
  )
}

// The status flag on the right of each row, the same letters the extension uses.
function badge(kind: FileChange['kind']): string {
  return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechanged: 'T', unmerged: '!', untracked: 'U' }[kind]
}
