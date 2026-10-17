import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileChange, RepoStatus } from '../../main/git/status'
import type { DiffFile, MovedBlock } from '../../main/git/diff'
import { DiffView } from './DiffView'
import { FileIcon, FolderIcon } from './FileIcon'
import { Icon, IconButton } from './Icons'
import { splitPath } from './paths'
import { CONTEXT_OPTIONS, useContextLines } from './prefs'
import { useResizable } from './Splitter'
import { GUTTER, STRIP_WIDTH, useFolded, useFoldHold } from './fold'
import { loadSession, savePlace, useScrollMemory } from './session'

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
// The commit, discard, or stage in flight. Conflicting actions stay disabled until it settles.
type Pending = { kind: 'commit' } | { kind: 'discard'; path: string } | { kind: 'stage' }

interface Selection {
  path: string
  staged: boolean
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
  pending: Pending | null
}

const VIEW_KEY = 'bettergit.changesView'

export function ChangesView({ repo, status, revision, listOpen, detailOpen, onChanged, onError }: Props) {
  const [selection, setSelection] = useState<Selection | null>(() => savedSelection(repo, status))
  const [pending, setPending] = useState<Pending | null>(null)
  // The draft is kept in the session, so a reload keeps what was typed.
  const [message, setMessage] = useState(() => loadSession().places[repo]?.draft ?? '')
  const messageRef = useRef(message)
  const paneRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The file picked last. The pane scrolls to it once its diff loads. A restored scroll position takes its place, so nothing is revealed at launch.
  const revealRef = useRef<string | null>(null)
  const [diff, setDiff] = useState<Working | null>(null)
  // Both sections load on every refresh. The file rows need their +/- counts, and the empty-selection pane shows them all.
  const [all, setAll] = useState<{ staged: Working; unstaged: Working } | null>(null)
  // Context level of each widened file, keyed by levelKey. Kept across refreshes and read by the loaders.
  const [extra, setExtra] = useState<Record<string, number>>(() => loadSession().places[repo]?.widened ?? {})
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'))
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadSession().places[repo]?.collapsed ?? []))
  const context = useContextLines()
  const { size: listWidth, handle: listHandle } = useResizable('bettergit.changesListWidth', 340, 220, 1100)
  const list = useFoldHold<HTMLDivElement>(useFolded('list') && detailOpen, '.changes-view-toggle button')
  const onListScroll = useScrollMemory(listRef, `${repo}|changes-list`, 'list', true)
  const onDiffScroll = useScrollMemory(paneRef, `${repo}|changes-diff`, selection ? `${selection.staged}:${selection.path}` : 'all', selection ? diff !== null : all !== null)
  const errorRef = useRef(onError)
  errorRef.current = onError
  const extraRef = useRef(extra)
  extraRef.current = extra

  const staged = useMemo(() => status.changes.filter((change) => change.staged), [status])
  const unstaged = useMemo(() => status.changes.filter((change) => change.unstaged && !change.conflicted), [status])
  const conflicted = useMemo(() => status.changes.filter((change) => change.conflicted), [status])
  const stats = useMemo(() => countStats(all), [all])
  const List = view === 'tree' ? Tree : Group

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
    Promise.all([api.working(repo, true, context), api.working(repo, false, context)]).then(async ([stagedDiff, unstagedDiff]: Working[]) => {
      const [nextStaged, nextUnstaged] = await Promise.all([
        widen(repo, stagedDiff, true, extraRef.current),
        widen(repo, unstagedDiff, false, extraRef.current),
      ])
      if (!stale) setAll({ staged: nextStaged, unstaged: nextUnstaged })
    }).catch((failure: unknown) => errorRef.current(failure))
    return () => { stale = true }
  }, [repo, revision, context])

  useEffect(() => {
    if (!selection) {
      setDiff(null)
      return
    }
    let stale = false
    api.working(repo, selection.staged, context)
      .then((next: Working) => widen(repo, next, selection.staged, extraRef.current))
      .then((next) => {
        if (!stale) setDiff(next)
      })
      .catch((failure: unknown) => errorRef.current(failure))
    return () => { stale = true }
  }, [repo, selection, revision, context])

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

  const act = async (action: () => Promise<unknown>) => {
    try {
      await action()
      onChanged()
    } catch (failure) {
      onError(failure)
    }
  }

  // The checkboxes and the diff header share this. A click during another Git action is ignored, so stages do not race on the index.
  const togglePath = (path: string, stage: boolean) => {
    if (pending) return
    setPending({ kind: 'stage' })
    void act(() => (stage
      ? api.stage(repo, [path])
      : api.unstage(repo, [path]))).finally(() => setPending(null))
  }

  const toggle = (change: FileChange, stage: boolean) => togglePath(change.path, stage)

  const choose = (change: FileChange, isStaged: boolean) => {
    revealRef.current = change.path
    setSelection({ path: change.path, staged: isStaged })
  }

  const discard = (change: FileChange) => {
    if (pending || !window.confirm(`Discard unstaged changes to ${change.path}? This cannot be undone.`)) return
    setPending({ kind: 'discard', path: change.path })
    void act(() => api.discard(repo, [change.path])).finally(() => setPending(null))
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
    api.working(repo, section === 'staged', next, path).then((fresh: Working) => {
      const replacement = fresh.files[0]
      if (!replacement) return
      setExtra((prev) => ({ ...prev, [key]: next }))
      if (inSelection) setDiff((prev) => prev && replaceFile(prev, path, replacement))
      else setAll((prev) => prev && { ...prev, [section]: replaceFile(prev[section], path, replacement) })
    }).catch((failure: unknown) => errorRef.current(failure))
  }

  // Empty text drops the draft, so clearing the box is how a draft is discarded.
  const editMessage = (text: string) => {
    messageRef.current = text
    setMessage(text)
    savePlace(repo, { draft: text || undefined })
  }

  const canCommit = staged.length > 0 && message.trim().length > 0

  const commit = () => {
    if (pending || !canCommit) return
    setPending({ kind: 'commit' })
    void act(async () => {
      await api.commitChanges(repo, message, false)
      // A draft typed while the commit ran was not committed, so it stays.
      if (messageRef.current === message) editMessage('')
      setSelection(null)
    }).finally(() => setPending(null))
  }

  // Reloads each widened file at its own level, so a global reload does not undo an expansion.
  async function widen(repoPath: string, working: Working, isStaged: boolean, levels: Record<string, number>): Promise<Working> {
    const prefix = levelKey(isStaged, '')
    let next = working
    for (const [key, level] of Object.entries(levels)) {
      if (!key.startsWith(prefix)) continue
      const path = key.slice(prefix.length)
      const fresh: Working = await api.working(repoPath, isStaged, level, path)
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
              pending={pending}
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
              pending={pending}
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
                pending={pending}
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
            <button className="commit-action" disabled={!canCommit || !!pending} onClick={commit}>
              {pending?.kind === 'commit' ? 'Committing…' : staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'}
              {canCommit && !pending && <kbd aria-hidden="true">⌘↩</kbd>}
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
              {all.staged.files.length > 0 && (
                <DiffView
                  files={all.staged.files}
                  moves={all.staged.moves}
                  stage={{ staged: true, disabled: !!pending, onToggle: togglePath }}
                  onExpand={(file) => expandFile('staged', file)}
                  persist={{ id: `${repo}|changes-staged`, key: 'all' }}
                />
              )}
              <h2 className="diff-section">Unstaged <span className="count">{all.unstaged.files.length}</span></h2>
              {all.unstaged.files.length > 0 && (
                <DiffView
                  files={all.unstaged.files}
                  moves={all.unstaged.moves}
                  stage={{ staged: false, disabled: !!pending, onToggle: togglePath }}
                  onExpand={(file) => expandFile('unstaged', file)}
                  persist={{ id: `${repo}|changes-unstaged`, key: 'all' }}
                />
              )}
            </>
          )}
          {selection && diff && (
            <DiffView
              files={diff.files}
              moves={diff.moves}
              stage={{ staged: selection.staged, disabled: !!pending, onToggle: togglePath }}
              onExpand={(file) => expandFile(selection.staged ? 'staged' : 'unstaged', file, true)}
              persist={{ id: `${repo}|changes-selected`, key: 'selection' }}
            />
          )}
        </div>
      )}
    </div>
  )
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

function replaceFile(working: Working, path: string, next: DiffFile): Working {
  return { ...working, files: working.files.map((file) => (pathOf(file) === path ? next : file)) }
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

function Group({ title, changes, staged, selection, stats, onSelect, onToggle, onDiscard, pending }: SectionProps) {
  if (!changes.length) return null
  return (
    <section className="group">
      <h3>{title} <span className="count">{changes.length}</span></h3>
      <ul>
        {changes.map((change) => {
          const active = selection?.path === change.path && selection.staged === staged
          return (
            <li key={`${staged}-${change.path}`} className={active ? 'active' : ''}>
              <FileRow change={change} staged={staged} stats={stats} showDir onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} pending={pending} />
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// Same structure as the repo sidebar: folder rows with a chevron, nested groups with guide lines.
function Tree({ title, changes, staged, selection, stats, collapsed, onToggleFolder, onSelect, onToggle, onDiscard, pending }: SectionProps) {
  const folder = useMemo(() => buildTree(changes), [changes])
  if (!changes.length) return null
  const renderFile = (change: FileChange) => {
    const active = selection?.path === change.path && selection.staged === staged
    return (
      <div key={change.path} role="treeitem" aria-selected={active}>
        <div className={`tree-row${active ? ' selected' : ''}`}>
          <FileRow change={change} staged={staged} stats={stats} showDir={false} onSelect={onSelect} onToggle={onToggle} onDiscard={onDiscard} pending={pending} />
        </div>
      </div>
    )
  }
  return (
    <section className="group">
      <h3>{title} <span className="count">{changes.length}</span></h3>
      <div className="tree" role="tree">
        <TreeLevel folder={folder} section={title} collapsed={collapsed} onToggleFolder={onToggleFolder} renderFile={renderFile} />
      </div>
    </section>
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
function FileRow({ change, staged, stats, showDir, onSelect, onToggle, onDiscard, pending }: {
  change: FileChange
  staged: boolean
  stats: Map<string, Stats>
  showDir: boolean
  onSelect: (change: FileChange) => void
  onToggle: (change: FileChange) => void
  onDiscard?: (change: FileChange) => void
  pending: Pending | null
}) {
  const { name, dir } = splitPath(change.path)
  const counts = stats.get(`${staged ? 'staged' : 'unstaged'}:${change.path}`)
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={staged}
          aria-label={`Stage ${change.path}`}
          disabled={!!pending}
          onChange={() => onToggle(change)}
        />
      </label>
      <button className="file" onClick={() => onSelect(change)}>
        <FileIcon name={name} />
        <span className="path" title={change.path}>
          <span className="path-name">{name}</span>
          {showDir && dir && <span className="path-dir">{dir}</span>}
        </span>
      </button>
      {counts && (counts.add > 0 || counts.del > 0) && (
        <span className="row-stat" aria-label={`${counts.add} added, ${counts.del} removed`}>
          <span className="add">+{counts.add}</span>
          <span className="del">−{counts.del}</span>
        </span>
      )}
      <span className={`kind kind-${change.kind}`} title={change.kind}>{badge(change.kind)}</span>
      {onDiscard && !staged && change.kind !== 'untracked' && (
        <IconButton
          icon="trash"
          label={pending?.kind === 'discard' && pending.path === change.path ? `Discarding ${change.path}…` : `Discard changes to ${change.path}`}
          className="discard"
          disabled={!!pending}
          onClick={() => onDiscard(change)}
        />
      )}
    </>
  )
}

// The status flag on the right of each row, the same letters the extension uses.
function badge(kind: FileChange['kind']): string {
  return { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechanged: 'T', unmerged: '!', untracked: 'U' }[kind]
}
