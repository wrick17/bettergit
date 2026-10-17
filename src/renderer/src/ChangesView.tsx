import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileChange, RepoStatus } from '../../main/git/status'
import type { DiffFile, MovedBlock } from '../../main/git/diff'
import { DiffView } from './DiffView'
import { FileIcon, FolderIcon } from './FileIcon'
import { Icon, IconButton } from './Icons'
import { splitPath } from './paths'
import { CONTEXT_OPTIONS, useContextLines, useIgnoreWhitespace } from './prefs'
import { useResizable } from './Splitter'
import { GUTTER, STRIP_WIDTH, useFolded, useFoldHold } from './fold'
import { blockedReason, REPO_WORKING_LABELS, runRepoWrite, useRepoBusy } from './repo-busy'
import { loadSession, savePlace, useScrollMemory } from './session'
import { swapFile } from './widen'
import { ConflictView } from './ConflictView'
import type { Choice, ConflictDocument, ConflictFingerprint, ConflictSave } from '../../shared/conflict'

const api = window.bettergit

interface Props {
  repo: string
  status: RepoStatus
  revision: number
  listOpen: boolean
  detailOpen: boolean
  onChanged: () => void
  onError: (error: unknown) => void
}

type Working = { files: DiffFile[]; moves: MovedBlock[] }
type Stats = { add: number; del: number }
type Section = 'staged' | 'unstaged'
type View = 'list' | 'tree'
interface Selection {
  path: string
  staged: boolean
}

// The conflict on screen. Its choices belong to the model they were made on, so a new model starts them over.
interface ConflictState {
  path: string
  model: ConflictDocument
  choices: Choice[]
}

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
}

const VIEW_KEY = 'bettergit.changesView'

export function ChangesView({ repo, status, revision, listOpen, detailOpen, onChanged, onError }: Props) {
  const [selection, setSelection] = useState<Selection | null>(() => savedSelection(repo, status))
  const busy = useRepoBusy(repo)
  // The draft is kept in the session, so a reload keeps what was typed.
  const [message, setMessage] = useState(() => loadSession().places[repo]?.draft ?? '')
  const messageRef = useRef(message)
  const paneRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The file picked last. The pane scrolls to it once its diff loads. A restored scroll position takes its place, so nothing is revealed at launch.
  const revealRef = useRef<string | null>(null)
  const [diff, setDiff] = useState<Working | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  // Both sections load on every refresh. The file rows need their +/- counts, and the empty-selection pane shows them all.
  const [all, setAll] = useState<{ staged: Working; unstaged: Working } | null>(null)
  // Context level of each widened file, keyed by levelKey. Kept across refreshes and read by the loaders.
  const [extra, setExtra] = useState<Record<string, number>>(() => loadSession().places[repo]?.widened ?? {})
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadSession().places[repo]?.collapsed ?? []))
  const context = useContextLines()
  const ignoreWhitespace = useIgnoreWhitespace()
  const { size: listWidth, handle: listHandle } = useResizable('bettergit.changesListWidth', 340, 220, 1100)
  // The file list folds beside the diff. A held list grows in flow, so the diff shifts. A clean tree stays open, so its empty space stays in use.
  // Unfiltered status, not the whitespace-filtered diff: a whitespace-only change is still a change.
  const clean = status.changes.length === 0
  const list = useFoldHold<HTMLDivElement>(useFolded('list') && detailOpen && !clean, '.changes-view-toggle button')
  const onListScroll = useScrollMemory(listRef, `${repo}|changes-list`, 'list', true)
  const onDiffScroll = useScrollMemory(paneRef, `${repo}|changes-diff`, selection ? `${selection.staged}:${selection.path}` : 'all', selection ? diff !== null : all !== null)
  const errorRef = useRef(onError)
  errorRef.current = onError
  const extraRef = useRef(extra)
  extraRef.current = extra
  // The repo on screen, so a reply for a repo the pane has left is dropped.
  const repoRef = useRef(repo)
  repoRef.current = repo

  const staged = useMemo(() => status.changes.filter((change) => change.staged), [status])
  const unstaged = useMemo(() => status.changes.filter((change) => change.unstaged && !change.conflicted), [status])
  const conflicted = useMemo(() => status.changes.filter((change) => change.conflicted), [status])
  // An unstaged conflicted row opens the resolver. Its diff is not loaded, because git prints combined diffs for it.
  const conflictSelected = !!selection && !selection.staged && conflicted.some((change) => change.path === selection.path)
  const stats = useMemo(() => countStats(all), [all])
  const List = view === 'tree' ? Tree : Group

  // A widen belongs to this load and source file, even if the same path is selected again later.
  // Loaders publish here before setState so replies in one React batch see the newest file.
  const request = useMemo(() => ({}), [repo, revision, status, selection, conflictSelected, context, ignoreWhitespace])
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
  useEffect(() => {
    setSelection((current) => {
      if (!current) return current
      const inSection = (isStaged: boolean) => status.changes.some((change) => change.path === current.path
        && (isStaged ? change.staged : change.unstaged || change.conflicted))
      if (inSection(current.staged)) return current
      return inSection(!current.staged) ? { path: current.path, staged: !current.staged } : null
    })
  }, [status])

  useEffect(() => {
    let stale = false
    Promise.all([api.working(repo, true, context, undefined, ignoreWhitespace), api.working(repo, false, context, undefined, ignoreWhitespace)]).then(async ([stagedDiff, unstagedDiff]: Working[]) => {
      const [nextStaged, nextUnstaged] = await Promise.all([
        widen(repo, stagedDiff, true, extraRef.current),
        widen(repo, unstagedDiff, false, extraRef.current),
      ])
      if (!stale) {
        const next = { staged: nextStaged, unstaged: nextUnstaged }
        if (currentRequest.current) currentRequest.current.all = next
        setAll(next)
      }
    }).catch((failure: unknown) => { if (!stale) errorRef.current(failure) })
    return () => { stale = true }
  }, [repo, status, revision, context, ignoreWhitespace])

  useEffect(() => {
    if (!selection || conflictSelected) {
      setDiff(null)
      return
    }
    let stale = false
    api.working(repo, selection.staged, context, undefined, ignoreWhitespace)
      .then((next: Working) => widen(repo, next, selection.staged, extraRef.current))
      .then((next) => {
        if (!stale) {
          if (currentRequest.current) currentRequest.current.diff = next
          setDiff(next)
        }
      })
      .catch((failure: unknown) => { if (!stale) errorRef.current(failure) })
    return () => { stale = true }
  }, [repo, status, selection, conflictSelected, revision, context, ignoreWhitespace])

  // The resolver loads the file and its stage IDs together. A reload that finds the same fingerprint keeps the choices.
  useEffect(() => {
    if (!selection || !conflictSelected) return
    let stale = false
    const path = selection.path
    api.conflictLoad(repo, path)
      .then((model: ConflictDocument) => {
        if (!stale) setConflict((prev) => ({ path, model, choices: prev?.path === path && sameModel(prev.model, model) ? prev.choices : [] }))
      })
      .catch((failure: unknown) => { if (!stale) errorRef.current(failure) })
    return () => { stale = true }
  }, [repo, selection, conflictSelected, revision])

  // Picking a file keeps the continuous diff and scrolls the file's header into view once its diff loads.
  useEffect(() => {
    const path = revealRef.current
    if (!path || !diff) return
    revealRef.current = null
    // Files skipped by content-visibility use their estimated height until a frame has laid them out, so scroll after two frames.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      Array.from(paneRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
        .find((element) => element.dataset.path === path)?.scrollIntoView({ block: 'start' })
    }))
  }, [diff])

  // Git writes take the repo's single slot. The reload runs only after a successful write, so a failed reload cannot fail it.
  const write = (key: string, action: () => Promise<unknown>) => runRepoWrite(repo, key, action, {
    onError: (failure) => errorRef.current(failure),
    reload: onChanged,
  })

  // The checkboxes and the diff header share this. A click during another Git action is ignored, so stages do not race on the index.
  const togglePath = (path: string, stage: boolean) => {
    if (busy) return
    void write(stage ? 'stage' : 'unstage', () => (stage ? api.stage(repo, [path]) : api.unstage(repo, [path])))
  }

  const toggle = (change: FileChange, stage: boolean) => togglePath(change.path, stage)

  // Each choice copies the list, since the list belongs to the model on screen and that model is replaced on reload.
  const chooseConflict = (index: number, choice: Choice) => setConflict((prev) => {
    if (!prev) return prev
    const choices = [...prev.choices]
    choices[index] = choice
    return { ...prev, choices }
  })

  // Save sends the fingerprint the file had at load, with the choices. The write takes the repo's single write slot.
  const saveConflictFile = (save: ConflictSave) => {
    if (!conflict) return
    const path = conflict.path
    void write('resolve', () => api.conflictSave(repo, path, save))
  }

  // Bulk actions take only the listed paths. Conflicts are not in either list, so their markers are never staged here.
  const togglePaths = (paths: string[], stage: boolean) => {
    if (busy || !paths.length) return
    void write(stage ? 'stage:all' : 'unstage:all', () => (stage ? api.stage(repo, paths) : api.unstage(repo, paths)))
  }

  const choose = (change: FileChange, isStaged: boolean) => {
    revealRef.current = change.path
    setSelection({ path: change.path, staged: isStaged })
  }

  const discard = (change: FileChange) => {
    if (busy || !window.confirm(`Discard unstaged changes to ${change.path}? This cannot be undone.`)) return
    void write(`discard:${change.path}`, () => api.discard(repo, [change.path]))
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
      setExtra((prev) => ({ ...prev, [key]: next }))
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
    messageRef.current = text
    setMessage(text)
    savePlace(repo, { draft: text || undefined })
  }

  const canCommit = staged.length > 0 && message.trim().length > 0

  // The commit button says why it cannot run. Its own run shows a spinner and is not blocked by a reason.
  const commitBlocked = busy === null || busy === 'commit' ? undefined : blockedReason(busy)

  const commit = () => {
    if (busy || !canCommit) return
    void write('commit', async () => {
      await api.commitChanges(repo, message, false)
      // A draft typed while the commit ran was not committed, so it stays.
      if (messageRef.current === message) editMessage('')
      setSelection(null)
    })
  }

  // Reloads each widened file at its own level, so a global reload does not undo an expansion.
  async function widen(repoPath: string, working: Working, isStaged: boolean, levels: Record<string, number>): Promise<Working> {
    const prefix = levelKey(isStaged, '')
    let next = working
    for (const [key, level] of Object.entries(levels)) {
      if (!key.startsWith(prefix)) continue
      const path = key.slice(prefix.length)
      const fresh: Working = await api.working(repoPath, isStaged, level, path, ignoreWhitespace)
      if (fresh.files[0]) next = replaceFile(next, path, fresh.files[0])
    }
    return next
  }

  return (
    <div className="changes" style={{ gridTemplateColumns: listOpen && detailOpen ? `${list.collapsed ? STRIP_WIDTH : listWidth}px ${list.collapsed ? 0 : GUTTER}px minmax(0, 1fr)` : 'minmax(0, 1fr)' }}>
      {/* Clicking empty space in the list clears the file selection, so the right pane shows every change again. */}
      {listOpen && (
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
            <button ref={list.strip} type="button" className="fold-strip" aria-label="Show file list" onClick={list.activate}>
              <Icon name="chevron" />
              <span className="fold-label">{selection ? splitPath(selection.path).name : `${staged.length} staged · ${unstaged.length} unstaged`}</span>
            </button>
          )}
          <div className="changes-view-toggle">
            <IconButton icon="listFlat" label="List view" active={view === 'list'} onClick={() => chooseView('list')} />
            <IconButton icon="listTree" label="Tree view" active={view === 'tree'} onClick={() => chooseView('tree')} />
          </div>
          <div className="file-scroll" ref={listRef} onScroll={onListScroll}>
            <List
              title="Staged"
              changes={staged}
              staged
              selection={selection}
              stats={stats}
              collapsed={collapsed}
              onToggleFolder={toggleFolder}
              onSelect={(change) => choose(change, true)}
              onToggle={(change) => toggle(change, false)}
              onToggleAll={() => togglePaths(staged.map((change) => change.path), false)}
              busy={busy}
            />
            <List
              title="Unstaged"
              changes={unstaged}
              staged={false}
              selection={selection}
              stats={stats}
              collapsed={collapsed}
              onToggleFolder={toggleFolder}
              onSelect={(change) => choose(change, false)}
              onToggle={(change) => toggle(change, true)}
              onDiscard={discard}
              onToggleAll={() => togglePaths(unstaged.map((change) => change.path), true)}
              busy={busy}
            />
            {conflicted.length > 0 && (
              <List
                title="Conflicts"
                changes={conflicted}
                staged={false}
                selection={selection}
                stats={stats}
                collapsed={collapsed}
                onToggleFolder={toggleFolder}
                onSelect={(change) => choose(change, false)}
                onToggle={(change) => toggle(change, true)}
                busy={busy}
              />
            )}
          </div>
          <div className="commit-box">
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
      )}
      {listOpen && detailOpen && <div className={`splitter${list.collapsed ? ' off' : ''}`} {...listHandle} {...list.splitterHandlers} />}
      {detailOpen && (
        <div className="diff-pane" ref={paneRef} onScroll={onDiffScroll}>
          {!selection && status.changes.length === 0 && <p className="hint">Working tree clean</p>}
          {!selection && all && status.changes.length > 0 && (
            <>
              <h2 className="diff-section">Staged <span className="count">{all.staged.files.length}</span></h2>
              {/* With the whitespace option on, a section whose changes are all hidden still mounts its DiffView, so the toolbar stays usable. */}
              {(all.staged.files.length > 0 || (ignoreWhitespace && staged.length > 0)) && (
                <DiffView
                  files={all.staged.files}
                  moves={all.staged.moves}
                  stage={{ staged: true, disabled: !!busy, onToggle: togglePath }}
                  onExpand={(file) => expandFile('staged', file)}
                  persist={{ id: `${repo}|changes-staged`, key: 'all' }}
                />
              )}
              <h2 className="diff-section">Unstaged <span className="count">{all.unstaged.files.length}</span></h2>
              {(all.unstaged.files.length > 0 || (ignoreWhitespace && unstaged.length > 0)) && (
                <DiffView
                  files={all.unstaged.files}
                  moves={all.unstaged.moves}
                  stage={{ staged: false, disabled: !!busy, onToggle: togglePath }}
                  onExpand={(file) => expandFile('unstaged', file)}
                  persist={{ id: `${repo}|changes-unstaged`, key: 'all' }}
                />
              )}
            </>
          )}
          {selection && conflictSelected && (conflict?.path === selection.path
            ? <ConflictView path={selection.path} model={conflict.model} choices={conflict.choices} onChoose={chooseConflict} onSave={saveConflictFile} saving={busy === 'resolve'} />
            : <p className="hint">Loading conflict…</p>)}
          {selection && !conflictSelected && diff && (
            <DiffView
              files={diff.files}
              moves={diff.moves}
              stage={{ staged: selection.staged, disabled: !!busy, onToggle: togglePath }}
              onExpand={(file) => expandFile(selection.staged ? 'staged' : 'unstaged', file, true)}
              persist={{ id: `${repo}|changes-selected`, key: 'selection' }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// Two loads describe the same file and merge state when their fingerprints match. An unsupported file never matches.
function sameModel(a: ConflictDocument, b: ConflictDocument): boolean {
  return a.supported && b.supported && sameFingerprint(a.fingerprint, b.fingerprint)
}

function sameFingerprint(a: ConflictFingerprint, b: ConflictFingerprint): boolean {
  return a.working === b.working && a.stages === b.stages
}

// The file open last time, if it is still in the changes. A file that is gone opens with no selection.
function savedSelection(repo: string, status: RepoStatus): Selection | null {
  const place = loadSession().places[repo]
  if (!place?.file || !status.changes.some((change) => change.path === place.file)) return null
  return { path: place.file, staged: !!place.staged }
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

function Group({ title, changes, staged, selection, stats, onSelect, onToggle, onDiscard, onToggleAll, busy }: SectionProps) {
  if (!changes.length) return null
  return (
    <section className="group">
      <SectionHeader title={title} count={changes.length} staged={staged} onToggleAll={onToggleAll} busy={busy} />
      <ul>
        {changes.map((change) => {
          const active = selection?.path === change.path && selection.staged === staged
          return (
            <li key={`${staged}-${change.path}`} className={active ? 'active' : ''}>
              <FileRow change={change} staged={staged} stats={stats} showDir onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} busy={busy} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Same structure as the repo sidebar: folder rows with a chevron, nested groups with guide lines.
function Tree({ title, changes, staged, selection, stats, collapsed, onToggleFolder, onSelect, onToggle, onDiscard, onToggleAll, busy }: SectionProps) {
  const folder = useMemo(() => buildTree(changes), [changes])
  if (!changes.length) return null
  const renderFile = (change: FileChange) => {
    const active = selection?.path === change.path && selection.staged === staged
    return (
      <div key={change.path} role="treeitem" aria-selected={active}>
        <div className={`tree-row${active ? ' selected' : ''}`}>
          <FileRow change={change} staged={staged} stats={stats} showDir={false} onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} busy={busy} />
        </div>
      </div>
    )
  }
  return (
    <section className="group">
      <SectionHeader title={title} count={changes.length} staged={staged} onToggleAll={onToggleAll} busy={busy} />
      <div className="tree" role="tree">
        <TreeLevel folder={folder} section={title} collapsed={collapsed} onToggleFolder={onToggleFolder} renderFile={renderFile} />
      </div>
    </section>
  )
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
            icon={staged ? 'undo' : 'plus'}
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

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  files: FileChange[]
  // Changed files beneath this folder, so a collapsed folder still shows how many there are.
  count: number
}

function buildTree(changes: FileChange[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], count: 0 }
  for (const change of changes) {
    let folder = root
    root.count += 1
    for (const part of change.path.split('/').slice(0, -1)) {
      let child = folder.folders.get(part)
      if (!child) {
        child = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [], count: 0 }
        folder.folders.set(part, child)
      }
      folder = child
      folder.count += 1
    }
    folder.files.push(change)
  }
  return root
}

// Folders first, then files, each alphabetical. A collapsed folder's contents are not rendered.
function TreeLevel({ folder, section, collapsed, onToggleFolder, renderFile }: {
  folder: Folder
  section: string
  collapsed: Set<string>
  onToggleFolder: (key: string) => void
  renderFile: (change: FileChange) => ReactNode
}) {
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
  const files = [...folder.files].sort((a, b) => splitPath(a.path).name.localeCompare(splitPath(b.path).name))
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

// The checkbox, name, counts, and status shared by both views. Tree rows drop the folder part of the path.
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
  const discardKey = `discard:${change.path}`
  const counts = stats.get(`${staged ? 'staged' : 'unstaged'}:${change.path}`)
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={staged}
          aria-label={`Stage ${change.path}`}
          disabled={!!busy}
          onChange={() => onToggle(change)}
        />
      </label>
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
      <span className={`kind kind-${change.kind}`} title={change.kind}>{badge(change.kind)}</span>
    </>
  )
}

// The status flag on the right of each row, the same letters the extension uses.
function badge(kind: FileChange['kind']): string {
  return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechanged: 'T', unmerged: '!', untracked: 'U' }[kind]
}
