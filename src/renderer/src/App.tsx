import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { applyAppearance } from './appearance'
import { applyMode, useThemesReady } from './themes'
import { createPortal } from 'react-dom'
import type { AppConfig, ConfigPatch } from '../../main/config'
import { EditorContext } from './editor-launch'
import { OpenInAppButton, useSelectedApp } from './OpenInAppButton'
import type { TreeNode, RepoNode } from '../../main/scan'
import type { RepoStatus } from '../../main/git/status'
import type { Branch } from '../../main/git/ops'
import { Icon, IconButton, toggleLabel } from './Icons'
import { Sidebar } from './Sidebar'
import type { MenuAction } from '../../main/menu'
import { ChangesView } from './ChangesView'
import { HistoryView } from './HistoryView'
import { ActionsMenu } from './OverflowBar'
import { RepoDialogs, repoItems, type RepoDialog } from './RepoMenu'
import { CloneDialog, SettingsDialog } from './Dialogs'
import { BranchPicker } from './BranchPicker'
import { useResizable } from './Splitter'
import { GUTTER, SIDEBAR_STRIP_WIDTH, useFolded, useFoldHold } from './fold'
import { blockedReason, busyKey, connectRepoLocks, runRepoWrite, useRepoBusy, type RepoLockSnapshot } from './repo-busy'
import { setLanguageOverrides } from './prefs'
import { loadSession, saveSession } from './session'
import { FindBar } from './FindBar'

const api = window.bettergit
// The repo pane's tab panels fill the pane height, as the grid inside them expects.
const PANEL_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }

export function App() {
  const [initial] = useState(loadSession)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const themesReady = useThemesReady()
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selected, setSelected] = useState<string | null>(initial.selected)
  const [tab, setTab] = useState<'changes' | 'history'>(initial.tab)
  const [error, setError] = useState<string | null>(null)
  // Uncommitted-file counts by repo path. The main process fills these in the background.
  const [dirty, setDirty] = useState<Record<string, number>>({})
  const [revision, setRevision] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen)
  const [listOpen, setListOpen] = useState(initial.listOpen)
  const [detailOpen, setDetailOpen] = useState(initial.detailOpen)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The find bar, and a counter bumped by each ⌘F so an open bar takes focus again.
  const [find, setFind] = useState({ open: false, focus: 0 })
  const openFind = () => setFind((prev) => ({ open: true, focus: prev.focus + 1 }))
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind
  // The titlebar band's element. The repo toolbar is portalled into it.
  const [titlebar, setTitlebar] = useState<HTMLElement | null>(null)
  // True while the open repo is clean on the Changes tab. The sidebar then stays open instead of folding.
  const [repoClean, setRepoClean] = useState(false)
  const { size: sidebarWidth, handle: sidebarHandle } = useResizable('bettergit.sidebarWidth', 264, 200, 420)
  const sidebarFold = useFoldHold<HTMLElement>(useFolded('sidebar') && !repoClean, '[role="treeitem"][tabindex="0"]')

  const refreshTree = useCallback(async () => setTree(await api.getTree()), [])
  const reportError = (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure))
  const reportErrorRef = useRef(reportError)
  reportErrorRef.current = reportError

  // The banner clears itself, so an old failure does not stay over the pane.
  useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => setError(null), 8000)
    return () => window.clearTimeout(timer)
  }, [error])

  useEffect(() => {
    saveSession({ selected, tab, sidebarOpen, listOpen, detailOpen })
  }, [selected, tab, sidebarOpen, listOpen, detailOpen])

  useEffect(() => connectRepoLocks({
    snapshot: () => api.repoLocks(),
    subscribe: (listener) => api.onEvent('repo:locks', (payload) => listener(payload as RepoLockSnapshot)),
  }, reportError), [])

  useEffect(() => {
    api.getConfig().then(setConfig).then(refreshTree).catch(reportError)
  }, [refreshTree])

  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected
  useEffect(() => {
    // Live file changes and background fetch results both mean "the open repo may have new data".
    const offChanged = api.onEvent('repos:changed', (payload) => {
      const event = payload as { repos: string[]; tree: boolean }
      if (event.tree) refreshTree().catch(reportError)
      // A path is a repo root, or a sources root when a working file changed, so it covers the repos under it.
      const repo = selectedRef.current
      if (event.tree || (repo && event.repos.some((root) => repo === root || repo.startsWith(root + '/')))) setRevision((value) => value + 1)
    })
    const offFetch = api.onEvent('fetch:report', () => setRevision((value) => value + 1))
    const offDirty = api.onEvent('repos:dirty', (payload) => {
      const { path, count } = payload as { path: string; count: number }
      setDirty((prev) => prev[path] === count ? prev : { ...prev, [path]: count })
    })
    return () => { offChanged(); offFetch(); offDirty() }
  }, [refreshTree])

  // Menu commands that need the open repo or the sidebar are handled here, where that state lives.
  useEffect(() => {
    const off = api.onEvent('menu:action', (payload) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const repo = selectedRef.current
      // Menu writes take the same repo slot as the toolbar. A refused write says what is running instead of starting.
      const runRepo = (key: string, action: () => Promise<unknown>) => {
        if (!repo) return setError('Select a repository first.')
        const reason = blockedReason(busyKey(repo))
        if (reason) return reportErrorRef.current(new Error(reason))
        return void runRepoWrite(repo, key, action, { onError: reportErrorRef.current, reload: () => setRevision((value) => value + 1) })
      }
      switch (payload as MenuAction) {
        case 'add-folder': return void api.pickSources().then(async (next: AppConfig) => { setConfig(next); await refreshTree() }).catch(reportErrorRef.current)
        case 'clone': return setCloneOpen(true)
        case 'open-settings': return setSettingsOpen(true)
        case 'refresh': return void refreshTree().then(() => setRevision((value) => value + 1))
        case 'fetch': return void runRepo('fetch', () => api.fetch(repo!))
        case 'pull': return void runRepo('pull-merge', () => api.pull(repo!))
        case 'push': return void runRepo('push', () => api.push(repo!))
        case 'stash': return void runRepo('stash', () => api.stash(repo!, 'BetterGit stash'))
        case 'show-changes': return setTab('changes')
        case 'show-history': return setTab('history')
        case 'find': return openFindRef.current()
        case 'search-history': setTab('history'); return requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="Search commit messages"]')?.focus())
        case 'toggle-sidebar': return setSidebarOpen((open) => !open)
        case 'reveal-repo': return repo ? void api.reveal(repo) : undefined
        case 'fetch-all': return void (async () => {
          // Each repo is fetched on its own. A busy repo is skipped and named, and every failure is reported with its repo.
          const failures: string[] = []
          const skipped: string[] = []
          for (const node of flatten(await api.getTree())) {
            if (busyKey(node.path)) {
              skipped.push(node.name)
              continue
            }
            await runRepoWrite(node.path, 'fetch', () => api.fetch(node.path), {
              onError: (failure) => failures.push(`${node.name}: ${failure instanceof Error ? failure.message : String(failure)}`),
              reload: () => undefined,
            })
          }
          setRevision((value) => value + 1)
          const problems = [...failures, ...(skipped.length ? [`skipped while busy: ${skipped.join(', ')}`] : [])]
          if (problems.length) reportErrorRef.current(new Error(`Fetch All: ${problems.join('; ')}`))
        })()
      }
    })
    return off
  }, [refreshTree])

  // Keep the page in step with macOS light/dark when the setting is "system". Until the config arrives, the mode restored
  // at launch stays.
  const themeMode = config?.settings.theme
  useLayoutEffect(() => {
    if (!themeMode) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => applyMode(themeMode)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [themeMode])

  // Before paint, so the first frame with the config already has the chosen fonts, themes and density. While Settings is
  // open it applies its own changes, and the config echo of a quick change can arrive after a newer one, so it is skipped.
  const settingsOpenRef = useRef(settingsOpen)
  settingsOpenRef.current = settingsOpen
  useLayoutEffect(() => {
    if (config && !settingsOpenRef.current) applyAppearance(config.settings.appearance)
  }, [config?.settings.appearance])

  useEffect(() => {
    // Selections dim when the window is not key, as they do in Finder. The CSS reads this attribute.
    const root = document.documentElement
    const setWindowState = (state: 'active' | 'inactive') => { root.dataset.window = state }
    setWindowState(document.hasFocus() ? 'active' : 'inactive')
    const onFocus = () => setWindowState('active')
    const onBlur = () => setWindowState('inactive')
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    setLanguageOverrides(config?.settings.languages ?? {})
  }, [config?.settings.languages])

  const repos = useMemo(() => flatten(tree), [tree])
  const repo = repos.find((node) => node.path === selected) ?? null

  // Clean state belongs to the open repo, so it resets when no repo is open.
  useEffect(() => {
    if (!repo) setRepoClean(false)
  }, [repo])

  const update = async (patch: ConfigPatch) => {
    setConfig(await api.updateConfig(patch))
  }

  const addPaths = async (paths: string[]) => {
    setConfig(await api.addSources(paths))
    await refreshTree()
  }

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files).map((file) => api.pathForFile(file)).filter(Boolean)
    if (paths.length) await addPaths(paths).catch(reportError)
  }

  // ⌘F also opens find from the page, which matters where the app menu is absent (such as a test harness). Opening is
  // idempotent, so the menu accelerator firing as well does no harm.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      openFindRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!config || !themesReady) return <div className="boot">Loading…</div>

  return (
    <div
      className="shell"
      style={{
        gridTemplateColumns: sidebarOpen
          ? `${sidebarFold.collapsed ? SIDEBAR_STRIP_WIDTH : sidebarWidth}px ${sidebarFold.collapsed ? 0 : GUTTER}px minmax(0, 1fr)`
          : 'minmax(0, 1fr)',
        '--sidebar-width': `${sidebarWidth}px`,
      } as CSSProperties}
    >
      <header className="titlebar" ref={setTitlebar} />
      <FindBar open={find.open} focusKey={find.focus} onClose={() => setFind((prev) => ({ ...prev, open: false }))} />
      {sidebarOpen && (
        <Sidebar
          fold={sidebarFold}
          tree={tree}
          dirty={dirty}
          config={config}
          selected={selected}
          onSelect={(path) => { setSelected(path); setTab('changes') }}
          onToggleCollapsed={(path) => update({
            collapsed: config.collapsed.includes(path)
              ? config.collapsed.filter((item) => item !== path)
              : [...config.collapsed, path],
          }).catch(reportError)}
          onToggleHidden={(path) => update({
            hidden: config.hidden.includes(path)
              ? config.hidden.filter((item) => item !== path)
              : [...config.hidden, path],
          }).catch(reportError)}
          onAddFolder={() => api.pickSources().then((next: AppConfig) => { setConfig(next); return refreshTree() }).catch(reportError)}
          onClone={() => setCloneOpen(true)}
          onReveal={(path) => api.reveal(path).catch(reportError)}
          onRemoveSource={(path) => api.removeSource(path).then(async (next: AppConfig) => {
            setConfig(next)
            if (selected === path) setSelected(null)
            await refreshTree()
          }).catch(reportError)}
          onDrop={handleDrop}
          onSettings={() => setSettingsOpen(true)}
          stripLabel={repo?.name ?? 'Repositories'}
        />
      )}
      {sidebarOpen && (
        <div className={`splitter gap${sidebarFold.collapsed ? ' off' : ''}`} {...sidebarHandle} {...sidebarFold.splitterHandlers} />
      )}
      <main className="pane">
        {error && (
          <div className="banner" role="alert">
            {error}
            <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {!repo && (
          <Empty
            hasSources={config.sources.length > 0}
            onAddFolder={() => api.pickSources().then((next: AppConfig) => { setConfig(next); return refreshTree() }).catch(reportError)}
            onClone={() => setCloneOpen(true)}
          />
        )}
        {repo && (
          <RepoPane
            key={repo.path}
            titlebar={titlebar}
            repo={repo}
            editorApp={config.settings.editorApp}
            terminalApp={config.settings.terminalApp}
            tab={tab}
            onTab={setTab}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            listOpen={listOpen}
            onToggleList={() => setListOpen((open) => !open)}
            detailOpen={detailOpen}
            onToggleDetail={() => setDetailOpen((open) => !open)}
            revision={revision}
            onChanged={() => setRevision((value) => value + 1)}
            onError={reportError}
            onCleanChange={setRepoClean}
          />
        )}
      </main>
      {cloneOpen && (
        <CloneDialog
          defaultParent={config.lastCloneDirectory ?? config.sources[0] ?? ''}
          onClose={() => setCloneOpen(false)}
          onCloned={async (destination) => {
            setCloneOpen(false)
            setSelected(destination)
            await refreshTree()
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog config={config} onUpdate={(patch) => update(patch).catch(reportError)} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function Empty({ hasSources, onAddFolder, onClone }: {
  hasSources: boolean
  onAddFolder: () => void
  onClone: () => void
}) {
  return (
    <div className="empty">
      <Icon name="brand" className="empty-mark" />
      <h1>BetterGit</h1>
      <p>{hasSources ? 'Select a repository in the sidebar to see its changes and history.' : 'Add a folder of projects, or drop one into the sidebar.'}</p>
      <div className="empty-actions">
        <button className="primary" onClick={onAddFolder}>Add folder…</button>
        <button onClick={onClone}>Clone from URL…</button>
      </div>
    </div>
  )
}

function RepoPane({ titlebar, repo, editorApp, terminalApp, tab, onTab, sidebarOpen, onToggleSidebar, listOpen, onToggleList, detailOpen, onToggleDetail, revision, onChanged, onError, onCleanChange }: {
  titlebar: HTMLElement | null
  repo: RepoNode
  // The Open in … apps chosen in Settings (InstalledApp ids). Unset means the default.
  editorApp?: string
  terminalApp?: string
  tab: 'changes' | 'history'
  onTab: (tab: 'changes' | 'history') => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
  listOpen: boolean
  onToggleList: () => void
  detailOpen: boolean
  onToggleDetail: () => void
  revision: number
  onChanged: () => void
  onError: (error: unknown) => void
  onCleanChange: (clean: boolean) => void
}) {
  // Resolved once here, so the toolbar and every file's open button name the same app with the same icon.
  const editor = useSelectedApp('editor', editorApp, onError)
  const terminal = useSelectedApp('terminal', terminalApp, onError)
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  // The write running in this repo, from any surface. It is held in the repo-busy store, not in this pane.
  const busy = useRepoBusy(repo.path)
  const [note, setNote] = useState<string | null>(null)
  const [dialog, setDialog] = useState<RepoDialog | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)

  // The revision the status on screen was read for. Changes reloads on it, after the status, so its rows and diffs land together.
  const [statusRevision, setStatusRevision] = useState(revision)
  const load = useCallback(async (loading: number) => {
    try {
      const [nextStatus, nextBranches] = await Promise.all([api.status(repo.path), api.branches(repo.path)])
      // An unchanged answer keeps the old object, so the views under it do not reload for nothing.
      setStatus((prev) => JSON.stringify(prev) === JSON.stringify(nextStatus) ? prev : nextStatus)
      setBranches((prev) => JSON.stringify(prev) === JSON.stringify(nextBranches) ? prev : nextBranches)
    } finally {
      setStatusRevision((prev) => Math.max(prev, loading))
    }
  }, [repo.path])

  useEffect(() => {
    load(revision).catch(onError)
  }, [load, revision])

  // A clean repo opens on History, and Changes hands over to History when its last change goes (after a commit, say).
  // A user who picks Changes on a clean repo stays there: only the first status and a dirty-to-clean change switch.
  const changeCount = useRef<number | null>(null)
  useEffect(() => {
    if (!status) return
    const before = changeCount.current
    changeCount.current = status.changes.length
    if (status.changes.length === 0 && before !== 0) onTab('history')
  }, [status, onTab])

  // Only a loaded status counts, so switching repos keeps the last answer until the new status arrives.
  useEffect(() => {
    if (status) onCleanChange(tab === 'changes' && status.changes.length === 0)
  }, [status, tab, onCleanChange])

  // Resolves to whether the write succeeded, so dialogs can stay open on failure. The reload runs only after a success.
  const run = (label: string, action: () => Promise<unknown>): Promise<boolean> => {
    const reason = blockedReason(busyKey(repo.path))
    if (reason) {
      onError(new Error(reason))
      return Promise.resolve(false)
    }
    return runRepoWrite(repo.path, label, action, { onError, reload: onChanged })
  }

  const headLabel = status ? (status.head ?? (status.headHash ? `detached at ${status.headHash.slice(0, 7)}` : 'no commits yet')) : '…'

  return (
    <EditorContext.Provider value={{
      app: editor,
      openFile: (path) => api.openInEditor(repo.path, path),
      onError,
      source: tab === 'history' ? 'commit' : 'working',
    }}>
      {/* The toolbar lives in the titlebar band beside the traffic lights, not in the pane below it. */}
      {titlebar && createPortal(
        <header className="toolbar">
          <div className="repo-title">
            <h1 className="repo-name">{repo.name}</h1>
            <button type="button" className="branch-pill" title={blockedReason(busy) ?? 'Switch or create branch'}
              aria-label="Switch or create branch" aria-haspopup="dialog" aria-expanded={branchPickerOpen}
              aria-busy={busy === 'switch' || busy === 'create-branch' || undefined}
              disabled={busy !== null || !status} onClick={() => setBranchPickerOpen(true)}>
              <Icon name={busy === 'switch' || busy === 'create-branch' ? 'loader' : 'branch'} className={busy === 'switch' || busy === 'create-branch' ? 'action-spin' : undefined} />
              <span>{headLabel}</span>
              <Icon name="chevronDown" className="chevron-down" />
            </button>
            {status?.upstream && (
              <span className="sync" title={`Ahead/behind ${status.upstream}`}>
                <span><b>{status.ahead}</b> ahead</span>
                <span><b>{status.behind}</b> behind</span>
              </span>
            )}
          </div>
          <div className="toolbar-actions">
            <ActionsMenu items={repoItems({
              repo: repo.path, status, busy, run, onTab, onNote: setNote, onError, onDialog: setDialog,
            })} />
            {/* Read-only launches, so they stay usable while a Git write runs. */}
            <span className="toolbar-divider" aria-hidden="true" />
            <OpenInAppButton kind="editor" app={editor} repoPath={repo.path} onError={onError} />
            <OpenInAppButton kind="terminal" app={terminal} repoPath={repo.path} onError={onError} />
            <RepoDialogs
              repo={repo.path}
              branch={status?.head ?? ''}
              dialog={dialog}
              run={run}
              onError={onError}
              onClose={() => setDialog(null)}
            />
          </div>
        </header>,
        titlebar,
      )}
      {branchPickerOpen && <BranchPicker repo={repo.path} branches={branches} headHash={status?.headHash ?? null}
        onRefresh={() => load(revision)} onChanged={onChanged} onClose={() => setBranchPickerOpen(false)} />}
      {note && <p className="repo-note" role="status" onClick={() => setNote(null)}>{note}</p>}
      <div className="tab-row">
        <nav
          className="tabs"
          role="tablist"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const next = tab === 'changes' ? 'history' : 'changes'
            onTab(next)
            document.getElementById(`tab-${next}`)?.focus()
          }}
        >
          <button id="tab-changes" role="tab" tabIndex={tab === 'changes' ? 0 : -1} aria-selected={tab === 'changes'} aria-controls={tab === 'changes' ? 'panel-changes' : undefined} onClick={() => onTab('changes')}>
            Changes
            {status && status.changes.length > 0 && <span className="tab-count">{status.changes.length}</span>}
          </button>
          <button id="tab-history" role="tab" tabIndex={tab === 'history' ? 0 : -1} aria-selected={tab === 'history'} aria-controls={tab === 'history' ? 'panel-history' : undefined} onClick={() => onTab('history')}>History</button>
        </nav>
        <div className="pane-toggles">
          <IconButton icon="panelLeft" label={paneLabel('Sidebar', sidebarOpen)} active={sidebarOpen} onClick={onToggleSidebar} />
          <IconButton icon="paneList" label={paneLabel(tab === 'changes' ? 'File list' : 'Commit list', listOpen)} active={listOpen} onClick={onToggleList} />
          <IconButton icon="panelRight" label={paneLabel(tab === 'changes' ? 'Diff' : 'Commit details', detailOpen)} active={detailOpen} onClick={onToggleDetail} />
        </div>
      </div>
      {tab === 'changes' && (
        <div id="panel-changes" role="tabpanel" aria-labelledby="tab-changes" style={PANEL_STYLE}>
          {status && <ChangesView repo={repo.path} status={status} revision={statusRevision} listOpen={listOpen} detailOpen={detailOpen} onChanged={onChanged} onError={onError} />}
        </div>
      )}
      {tab === 'history' && (
        <div id="panel-history" role="tabpanel" aria-labelledby="tab-history" style={PANEL_STYLE}>
          <HistoryView repo={repo.path} head={status?.headHash ?? null} revision={revision} listOpen={listOpen} detailOpen={detailOpen} onError={onError} onChanged={onChanged} />
        </div>
      )}
    </EditorContext.Provider>
  )
}

// A pane toggle's label: whether the pane shows now, and what a click does.
function paneLabel(pane: string, shown: boolean) {
  return toggleLabel(`${pane}: ${shown ? 'shown' : 'hidden'}`, shown ? 'hide it' : 'show it')
}

function flatten(nodes: TreeNode[]): RepoNode[] {
  return nodes.flatMap((node) => (node.kind === 'repo' ? [node] : flatten(node.children)))
}
