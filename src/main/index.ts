import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell } from 'electron'
import path from 'node:path'
import { statSync } from 'node:fs'
import { loadConfig, normalizeConfig, saveConfig, saveConfigSync, type AppConfig, type WindowState } from './config'
import { openFileInApp, openRepoInApp, readWorkingFile, writeWorkingFile } from './editor'
import { customApp, installedApps, isAppBundle, mergeApps, resolveApp } from './apps'
import { flattenRepos, isRepo, repoNode, scanFolder, type TreeNode } from './scan'
import { SourceWatcher } from './watch'
import { buildMenu } from './menu'
import { commandLogPath, logAction, openCommandLog } from './command-log'
import { createUpdater } from './updater'
import { BackgroundFetcher, type FetchReport } from './background'
import { canonicalRepoPath, registerRepoLockPaths, repoLockSnapshot, subscribeRepoLocks, withCloneActivity, withRepoLock } from './repo-lock'
import { commitDiff, compare, detectMoves, workingDiff } from './git/diff'
import { readHistory, commitDetails, commitRefs, searchHistory, readAuthors } from './git/history'
import { avatars } from './avatar'
import { readStatus } from './git/status'
import { DirtyCounter } from './git/dirty'
import * as ops from './git/ops'
import { applyHunk, parseHunk } from './git/hunks'
import { loadConflict, previewConflict, resetConflict, saveConflict, takeConflictSide } from './git/conflict'
import { parseConflictReset, parseConflictSave, parseConflictTake } from '../shared/conflict'
import { isAppKind } from '../shared/editors'
import { extensionDetails, extensionImage, extensionMetadata, installFromOpenVsx, installVsixFile, listExtensions, loadColorTheme, loadIconTheme, removeExtension, searchOpenVsx } from './extensions'

// Dev runs use the Electron binary, so the menu and userData need the product name set explicitly.
app.setName('BetterGit')

const configFile = () => path.join(app.getPath('userData'), 'config.json')
let config: AppConfig
let fetcher: BackgroundFetcher | null = null
let mainWindow: BrowserWindow | null = null
const updater = createUpdater((state) => sendToRenderer('update:state', state))
const dirty = new DirtyCounter((repo, counts) => sendToRenderer('repos:dirty', { path: repo, ...counts }))
const watcher = new SourceWatcher((event) => {
  sendToRenderer('repos:changed', event)
  if (event.repos.length) dirty.invalidate(event.repos)
})

function sendToRenderer(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload)
}

async function allRepoPaths(): Promise<string[]> {
  return flattenRepos({ kind: 'folder', path: '', name: '', children: await buildTree() })
    .map((repo) => repo.path)
    .filter((repoPath) => !config.hidden.includes(repoPath))
}

let fetchSchedule = ''

// Restarts the watcher whenever config changes. The background fetcher restarts only when its own settings change:
// sidebar writes such as collapsing a folder would otherwise push the next fetch back every time.
async function applyRuntime() {
  await watcher.watch(config.sources)
  const { backgroundFetch, fetchIntervalMinutes, idleThresholdSeconds } = config.settings
  const schedule = JSON.stringify([backgroundFetch, fetchIntervalMinutes, idleThresholdSeconds])
  if (fetcher && schedule === fetchSchedule) return
  fetchSchedule = schedule
  fetcher?.stop()
  fetcher = new BackgroundFetcher({
    enabled: backgroundFetch,
    intervalMinutes: fetchIntervalMinutes,
    idleThresholdSeconds,
    repos: allRepoPaths,
    onReport: (report: FetchReport) => {
      // Every fetched repo gets fresh ahead and behind counts in the sidebar, not only the open one.
      dirty.invalidate(report.fetched)
      sendToRenderer('fetch:report', report)
    },
  })
  fetcher.start()
}

// The native menu mirrors config (the Appearance radio), so it is rebuilt on every change.
function installMenu() {
  Menu.setApplicationMenu(buildMenu({
    send: (action) => sendToRenderer('menu:action', action),
    // A menu click has no caller to reject to, so a failed save goes to the renderer's error popup.
    setTheme: (theme) => persist({ ...config, settings: { ...config.settings, theme } }).catch((failure: unknown) =>
      sendToRenderer('app:error', { action: 'Changing the appearance', reason: failure instanceof Error ? failure.message : String(failure) })),
    currentTheme: () => config.settings.theme,
    checkForUpdates: () => void updater.check(true),
    // Opens in the Mac's default viewer for .log files, Console, which follows new lines while commands run.
    showCommandLog: () => {
      const file = commandLogPath()
      if (!file) return sendToRenderer('app:error', { action: 'Opening the command log', reason: 'The command log could not be created.' })
      void shell.openPath(file).then((reason) => { if (reason) sendToRenderer('app:error', { action: 'Opening the command log', reason }) })
    },
  }))
}

async function persist(next: AppConfig) {
  config = next
  await saveConfig(configFile(), config)
  for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(config.settings.textZoom)
  nativeTheme.themeSource = config.settings.theme
  installMenu()
  await applyRuntime()
}

async function addSource(target: string): Promise<AppConfig> {
  const resolved = path.resolve(target)
  if (config.sources.includes(resolved)) return config
  await persist({ ...config, sources: [...config.sources, resolved] })
  return config
}

async function buildTree(): Promise<TreeNode[]> {
  const nodes: TreeNode[] = []
  for (const source of config.sources) {
    if (await isRepo(source)) {
      nodes.push(await repoNode(source))
      continue
    }
    const scanned = await scanFolder(source)
    nodes.push(scanned ?? { kind: 'folder', path: source, name: path.basename(source), children: [] })
  }
  registerRepoLockPaths(nodes.flatMap(flattenRepos).map((repo) => repo.path))
  return nodes
}

// Renderer requests carry paths; the main process checks them against the sidebar before running git.
function assertKnownRepo(repoPath: string) {
  const resolved = path.resolve(repoPath)
  const known = config.sources.some((source) => resolved === source || resolved.startsWith(source + path.sep))
  if (!known) throw new Error(`Not a repository in the sidebar: ${repoPath}`)
  return resolved
}

// An author filter from the renderer: plain names only. Anything else is dropped, so a bad argument cannot reach git.
function authorList(authors: unknown): string[] {
  return Array.isArray(authors) ? authors.filter((name): name is string => typeof name === 'string' && name !== '' && !/[\n<>]/.test(name)) : []
}

// Branches hidden in the renderer, by full ref. History only compares them with Git's own ref list, so a bad entry hides nothing.
function refList(refs: unknown): string[] {
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string' && /^refs\/(heads|remotes)\//.test(ref)) : []
}

// Validate both the selected path and its destination before opening or locking a repo.
function assertKnownWriteRepo(repoPath: string): string {
  const resolved = assertKnownRepo(repoPath)
  const canonical = canonicalRepoPath(resolved)
  const trusted = config.sources.some((source) => {
    try {
      const root = canonicalRepoPath(source)
      return canonical === root || canonical.startsWith(root + path.sep)
    } catch {
      return false
    }
  })
  const marker = statSync(path.join(canonical, '.git'), { throwIfNoEntry: false })
  if (!trusted || !(marker?.isDirectory() || marker?.isFile())) {
    throw new Error(`Not a repository in the sidebar: ${repoPath}`)
  }
  return canonical
}

// Git writes to one repo collide on its index lock, so a write is refused while another one holds the repo.
function handleWrite(channel: string, handler: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, repoPath: string, ...args: unknown[]) => {
    const repo = assertKnownWriteRepo(repoPath)
    return logAction(channel, repo, () => withRepoLock(repo, channel, (canonical) => handler(event, canonical, ...args), path.resolve(repoPath)))
  })
}

const appIcons = new Map<string, Promise<string | null>>()

const extensionsDir = () => path.join(app.getPath('userData'), 'extensions')
// Loaded themes by kind and ref. Installs and removals clear it, since either can change what a ref points at.
const themes = new Map<string, Promise<unknown>>()
function loadTheme(kind: 'color' | 'icons', ref: unknown) {
  const key = `${kind}:${String(ref)}`
  if (!themes.has(key)) {
    const load = kind === 'color' ? loadColorTheme(extensionsDir(), ref) : loadIconTheme(extensionsDir(), ref)
    themes.set(key, load.catch((error) => { themes.delete(key); throw error }))
  }
  return themes.get(key)
}
const changingExtensions = <T>(change: Promise<T>) => change.finally(() => themes.clear())

function assertMainFrame(event: Electron.IpcMainInvokeEvent) {
  const window = mainWindow
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Extension data must be requested from the BetterGit main window.')
  }
}

function registerIpc() {
  ipcMain.handle('repo:locks', () => repoLockSnapshot())
  ipcMain.handle('update:state', () => updater.state())
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:download', () => updater.update())
  ipcMain.handle('update:install', () => updater.install())
  ipcMain.handle('update:page', () => updater.openPage())
  const offLocks = subscribeRepoLocks((snapshot) => sendToRenderer('repo:locks', snapshot))
  app.once('will-quit', offLocks)
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:update', async (_event, patch: Partial<AppConfig>) => {
    // Custom apps come only from the picker, so an update can drop entries but never add or edit one.
    const kept = patch.settings?.customApps
    const customApps = Array.isArray(kept)
      ? config.settings.customApps?.filter((entry) => kept.some((other) => other?.path === entry.path))
      : config.settings.customApps
    // Appearance merges too, so a one-field patch keeps the other saved fields. normalizeConfig validates each field.
    const appearance = { ...config.settings.appearance, ...(patch.settings?.appearance ?? {}) }
    await persist(normalizeConfig({ ...config, ...patch, settings: { ...config.settings, ...(patch.settings ?? {}), customApps, appearance } }))
    return config
  })
  ipcMain.handle('sources:tree', async () => {
    const tree = await buildTree()
    // Hidden repos are counted too, so their count is ready when they are shown again.
    dirty.request(tree.flatMap(flattenRepos).map((repo) => repo.path))
    return tree
  })
  // Rejects when Git cannot read the repo, so a sidebar Refresh can name it.
  ipcMain.handle('repo:refresh', (_event, repoPath: string) => dirty.recount(assertKnownRepo(repoPath)))
  ipcMain.handle('folder:pick', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return picked.canceled ? null : picked.filePaths[0]
  })
  ipcMain.handle('fetch:now', () => fetcher?.runOnce() ?? null)
  ipcMain.handle('sources:pick', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'multiSelections'] })
    for (const folder of picked.canceled ? [] : picked.filePaths) await addSource(folder)
    return config
  })
  ipcMain.handle('sources:add', async (_event, paths: string[]) => {
    for (const folder of paths) await addSource(folder)
    return config
  })
  ipcMain.handle('sources:remove', async (_event, sourcePath: string) => {
    // Removing from the sidebar never touches files on disk.
    await persist({ ...config, sources: config.sources.filter((source) => source !== sourcePath) })
    return config
  })
  ipcMain.handle('repo:status', async (_event, repoPath: string) => readStatus(assertKnownRepo(repoPath)))
  ipcMain.handle('repo:history', (_event, repoPath: string, skip: number, limit: number, authors?: unknown, hidden?: unknown) =>
    readHistory(assertKnownRepo(repoPath), skip, limit, authorList(authors), refList(hidden)))
  ipcMain.handle('repo:authors', (_event, repoPath: string) => readAuthors(assertKnownRepo(repoPath)))
  // The picture is decoded and re-encoded here, so only an image that macOS can read ever reaches the renderer.
  const avatarFor = avatars((data) => {
    const image = nativeImage.createFromBuffer(data)
    return image.isEmpty() ? null : image.resize({ width: 64, height: 64, quality: 'best' }).toDataURL()
  })
  ipcMain.handle('avatar:get', (_event, email: unknown) => avatarFor(email))
  ipcMain.handle('repo:commit-refs', (_event, repoPath: string, hash: string) => commitRefs(assertKnownRepo(repoPath), hash))
  // The whitespace flag is strict: only a literal true turns it on, so a malformed IPC argument cannot change the diff.
  ipcMain.handle('repo:commit', async (_event, repoPath: string, hash: string, context: number, ignoreWhitespace?: boolean) => {
    const repo = assertKnownRepo(repoPath)
    const files = await commitDiff(repo, hash, context, ignoreWhitespace === true)
    return { files, moves: detectMoves(files), details: await commitDetails(repo, hash) }
  })
  ipcMain.handle('repo:working', async (_event, repoPath: string, staged: boolean, context: number, path?: string, ignoreWhitespace?: boolean) => {
    const files = await workingDiff(assertKnownRepo(repoPath), staged, context, path, ignoreWhitespace === true)
    return { files, moves: detectMoves(files) }
  })
  handleWrite('repo:stage', (_event, repoPath: string, paths: string[]) => ops.stagePaths(repoPath, paths))
  handleWrite('repo:unstage', async (_event, repoPath: string, paths: string[]) => {
    const repo = repoPath
    const hasHead = (await readStatus(repo)).headHash !== null
    return ops.unstagePaths(repo, paths, hasHead)
  })
  handleWrite('repo:commit-changes', (_event, repoPath: string, message: string, amend: boolean) =>
    ops.commit(repoPath, message, amend))
  ipcMain.handle('repo:branches', async (_event, repoPath: string) => ops.readBranches(assertKnownRepo(repoPath)))
  handleWrite('repo:switch', (_event, repoPath: string, selection: ops.BranchSelection) => ops.switchBranch(repoPath, selection))
  handleWrite('repo:create-branch', (_event, repoPath: string, name: string, base: ops.BranchSelection) =>
    ops.createBranch(repoPath, name, base))
  // The branch menu. Each names its branch by the exact ref and commit the picker showed; main refuses stale ones.
  handleWrite('repo:delete-branch', (_event, repoPath: string, selection: ops.BranchSelection) => ops.deleteBranch(repoPath, selection))
  handleWrite('repo:rename-branch', (_event, repoPath: string, selection: ops.BranchSelection, name: string) =>
    ops.renameBranch(repoPath, selection, name))
  handleWrite('repo:set-upstream', (_event, repoPath: string, selection: ops.BranchSelection, upstream: ops.BranchSelection) =>
    ops.setUpstream(repoPath, selection, upstream))
  handleWrite('repo:unset-upstream', (_event, repoPath: string, selection: ops.BranchSelection) => ops.unsetUpstream(repoPath, selection))
  handleWrite('repo:fetch', async (_event, repoPath: string, mode?: ops.FetchMode) => {
    try {
      await ops.fetchAll(repoPath, mode)
    } finally {
      // Linked worktrees can update refs outside watched sources; recount each display alias even after a partial fetch.
      dirty.invalidate(Object.entries(repoLockSnapshot().identities ?? {})
        .filter(([, canonical]) => canonical === repoPath).map(([display]) => display))
    }
  })
  handleWrite('repo:pull', (_event, repoPath: string, mode?: ops.PullMode) => ops.pull(repoPath, mode))
  handleWrite('repo:pull-from', (_event, repoPath: string, remote: string, branch: string) =>
    ops.pullFrom(repoPath, remote, branch))
  ipcMain.handle('repo:remotes', (_event, repoPath: string) => ops.readRemotes(assertKnownRepo(repoPath)))
  handleWrite('repo:reset-upstream', (_event, repoPath: string) => ops.resetToUpstream(repoPath))
  handleWrite('repo:checkout-detached', (_event, repoPath: string, hash: string) =>
    ops.checkoutDetached(repoPath, hash))
  handleWrite('repo:branch-from', (_event, repoPath: string, name: string, hash: string) =>
    ops.branchFromCommit(repoPath, name, hash))
  handleWrite('repo:tag-from', (_event, repoPath: string, name: string, hash: string) =>
    ops.tagFromCommit(repoPath, name, hash))
  handleWrite('repo:cherry-pick', (_event, repoPath: string, hash: string) => ops.cherryPick(repoPath, hash))
  handleWrite('repo:revert', (_event, repoPath: string, hash: string) => ops.revertCommit(repoPath, hash))
  handleWrite('repo:amend-message', (_event, repoPath: string, message: string, expectedHash: string) =>
    ops.amendMessage(repoPath, message, expectedHash))
  ipcMain.handle('repo:merge-base', (_event, repoPath: string, a: string, b: string) =>
    ops.mergeBase(assertKnownRepo(repoPath), a, b))
  ipcMain.handle('repo:compare', async (_event, repoPath: string, from: string, to: string, ignoreWhitespace?: boolean) => {
    const repo = assertKnownRepo(repoPath)
    return compare(repo, await ops.resolveCommit(repo, from), await ops.resolveCommit(repo, to), ignoreWhitespace === true)
  })
  ipcMain.handle('system:open-url', (_event, url: string) => {
    // Only web links leave the app; file:, javascript:, credentials and custom schemes stay closed.
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Refusing to open an unsafe web link.')
    return shell.openExternal(parsed.href)
  })
  handleWrite('repo:push', async (_event, repoPath: string, mode?: ops.PushMode, confirmed?: { branch?: unknown; upstream?: unknown }) => {
    const repo = repoPath
    const status = await readStatus(repo)
    if (!status.head) throw new Error('Push needs a branch, not a detached HEAD.')
    // A force push only goes ahead for the branch and upstream the user confirmed, in case either changed since.
    if ((mode === 'force' || mode === 'force-with-lease') && (confirmed?.branch !== status.head || confirmed?.upstream !== status.upstream)) {
      throw new Error('The branch or its upstream changed since you confirmed. Nothing was pushed.')
    }
    await ops.push(repo, status.upstream !== null, status.head, mode)
  })
  ipcMain.handle('repo:tags', (_event, repoPath: string) => ops.readTags(assertKnownRepo(repoPath)))
  ipcMain.handle('repo:worktrees', (_event, repoPath: string) => ops.readWorktrees(assertKnownRepo(repoPath)))
  ipcMain.handle('repo:stashes', async (_event, repoPath: string) => ops.readStashes(assertKnownRepo(repoPath)))
  handleWrite('repo:stash', (_event, repoPath: string, message: string) =>
    ops.stashPush(repoPath, message, true))
  handleWrite('repo:stash-action', (_event, repoPath: string, action: 'pop' | 'apply' | 'drop', ref: string) =>
    ops.stashAction(repoPath, action, ref))
  handleWrite('repo:backup', (_event, repoPath: string, label: string) =>
    ops.createBackupRef(repoPath, label))
  handleWrite('repo:restore', (_event, repoPath: string, ref: string) =>
    ops.restoreBackup(repoPath, ref))
  handleWrite('repo:discard', (_event, repoPath: string, paths: string[]) => ops.discardPaths(repoPath, paths))
  // One untracked file. Main checks again that it is still untracked before removing it.
  handleWrite('repo:delete-untracked', (_event, repoPath: string, filePath: string) => ops.deleteUntracked(repoPath, filePath))
  // One hunk of one file. Main validates the request and cuts the patch from its own fresh diff.
  handleWrite('repo:hunk', (_event, repoPath: string, action: unknown, request: unknown) => applyHunk(repoPath, ...parseHunk(action, request)))
  ipcMain.handle('repo:search', (_event, repoPath: string, query: string, authors?: unknown, hidden?: unknown) =>
    searchHistory(assertKnownRepo(repoPath), query, authorList(authors), refList(hidden)))
  // Reads take no lock. The save runs under the repo lock, and it checks the fingerprint the renderer got at load.
  ipcMain.handle('repo:conflict-load', (_event, repoPath: string, filePath: string) => loadConflict(assertKnownRepo(repoPath), filePath))
  ipcMain.handle('repo:conflict-preview', (_event, repoPath: string, filePath: string, save: unknown) =>
    previewConflict(assertKnownRepo(repoPath), filePath, parseConflictSave(save)))
  handleWrite('repo:conflict-save', (_event, repoPath: string, filePath: string, save: unknown) =>
    saveConflict(repoPath, filePath, parseConflictSave(save)))
  handleWrite('repo:conflict-reset', (_event, repoPath: string, filePath: string, request: unknown) =>
    resetConflict(repoPath, filePath, parseConflictReset(request)))
  handleWrite('repo:conflict-take', (_event, repoPath: string, filePath: string, request: unknown) =>
    takeConflictSide(repoPath, filePath, parseConflictTake(request)))
  // The diff's inline editor. The write holds the repo lock, so it never lands in the middle of a Git write.
  // The read takes no lock, but it checks the repo's real path against the sources, as the write does through handleWrite.
  ipcMain.handle('repo:file-read', (_event, repoPath: string, filePath: string) => readWorkingFile(assertKnownWriteRepo(repoPath), filePath))
  handleWrite('repo:file-write', (_event, repoPath: string, filePath: string, expected: string, text: string) =>
    writeWorkingFile(repoPath, filePath, expected, text))
  // Launching an app does not write Git state, so it stays available while the repo is busy.
  ipcMain.handle('repo:open-in-editor', async (_event, repoPath: string, filePath?: string) => {
    const repo = assertKnownWriteRepo(repoPath)
    const editor = await resolveApp('editor', config.settings.editorApp, config.settings.customApps ?? [])
    return filePath === undefined ? openRepoInApp(editor, repo) : openFileInApp(editor, repo, filePath)
  })
  ipcMain.handle('repo:open-in-terminal', async (_event, repoPath: string) => {
    const repo = assertKnownWriteRepo(repoPath)
    return openRepoInApp(await resolveApp('terminal', config.settings.terminalApp, config.settings.customApps ?? []), repo)
  })
  // Listing rescans the app folders, so apps installed since the last list show up. It is a few directory reads.
  ipcMain.handle('apps:list', async (_event, kind: unknown) => {
    if (!isAppKind(kind)) throw new Error('Unknown app kind.')
    return mergeApps(await installedApps(true), config.settings.customApps ?? [], kind)
  })
  // Icons are served only for listed apps, so the renderer cannot probe arbitrary paths.
  ipcMain.handle('apps:icon', async (_event, appPath: unknown) => {
    const listed = [...await installedApps(), ...(config.settings.customApps ?? [])].find((entry) => entry.path === appPath)
    if (typeof appPath !== 'string' || !listed) return null
    // A custom path is checked again on each request, so a bundle replaced since it was picked is never thumbnailed.
    if (listed.custom && !appIcons.has(appPath) && !await isAppBundle(appPath)) return null
    // getFileIcon gives every .app the same blank document icon on macOS. The Quick Look thumbnail is the real app icon.
    // Only icons are kept. A failed or empty thumbnail is dropped, so the next request asks Quick Look again.
    if (!appIcons.has(appPath)) {
      const icon = nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 })
        .then((image) => (image.isEmpty() ? null : image.toDataURL()), () => null)
      appIcons.set(appPath, icon)
      icon.then((url) => { if (!url) appIcons.delete(appPath) })
    }
    return appIcons.get(appPath)
  })
  ipcMain.handle('apps:pick', async (event, kind: unknown) => {
    if (!isAppKind(kind)) throw new Error('Unknown app kind.')
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, {
      defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: 'Applications', extensions: ['app'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const chosen = await customApp(kind, picked.filePaths[0])
    const listed = mergeApps(await installedApps(), config.settings.customApps ?? [], kind).find((entry) => entry.path === chosen.path)
    if (listed) return listed
    await persist({ ...config, settings: { ...config.settings, customApps: [...(config.settings.customApps ?? []), chosen] } })
    return chosen
  })
  ipcMain.handle('extensions:list', () => listExtensions(extensionsDir(), (id, reason) =>
    sendToRenderer('app:error', { action: `Reading installed extension ${id}`, reason })))
  ipcMain.handle('extensions:search', (_event, query: unknown) => searchOpenVsx(query))
  ipcMain.handle('extensions:metadata', (event, namespace: unknown, name: unknown) => {
    assertMainFrame(event)
    return extensionMetadata(namespace, name)
  })
  ipcMain.handle('extensions:details', (event, namespace: unknown, name: unknown) => {
    assertMainFrame(event)
    return extensionDetails(namespace, name)
  })
  ipcMain.handle('extensions:image', (event, url: unknown) => {
    assertMainFrame(event)
    return extensionImage(url)
  })
  ipcMain.handle('extensions:install', (_event, namespace: unknown, name: unknown) =>
    changingExtensions(installFromOpenVsx(extensionsDir(), namespace, name)))
  // The file comes from the open panel here, never from the renderer, so the page cannot make main read a path it chose.
  ipcMain.handle('extensions:install-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'VS Code extension', extensions: ['vsix'] }] })
    if (picked.canceled || !picked.filePaths[0]) return null
    return changingExtensions(installVsixFile(extensionsDir(), picked.filePaths[0]))
  })
  ipcMain.handle('extensions:remove', (_event, id: unknown) => changingExtensions(removeExtension(extensionsDir(), id)))
  ipcMain.handle('themes:color', (_event, ref: unknown) => loadTheme('color', ref))
  ipcMain.handle('themes:icons', (_event, ref: unknown) => loadTheme('icons', ref))
  ipcMain.handle('repo:reveal', (_event, repoPath: string) => shell.showItemInFolder(assertKnownRepo(repoPath)))
  ipcMain.handle('clone', (_event, url: string, parent: string) => withCloneActivity(async () => {
    const destination = path.join(parent, path.basename(url.replace(/\.git$/, '')))
    await ops.clone(url, destination)
    await addSource(destination)
    await persist({ ...config, lastCloneDirectory: parent })
    return destination
  }))
}

// A saved position can point at a display that was unplugged since the last launch.
function isOnScreen({ x, y, width, height }: WindowState) {
  return screen.getAllDisplays().some(({ workArea }) =>
    x < workArea.x + workArea.width && x + width > workArea.x &&
    y < workArea.y + workArea.height && y + height > workArea.y)
}

let windowSaveTimer: ReturnType<typeof setTimeout> | undefined

function windowState(window: BrowserWindow): WindowState {
  const maximized = window.isMaximized()
  // Normal bounds are the restored size, so a maximized window comes back at its normal size.
  return { ...(maximized ? window.getNormalBounds() : window.getBounds()), maximized }
}

// Debounced so a drag writes once, not on every move event.
function saveWindowState(window: BrowserWindow) {
  // Events can arrive before config loads.
  if (!config) return
  clearTimeout(windowSaveTimer)
  // Read the bounds now: the window may be gone by the time the timer fires.
  const state = windowState(window)
  windowSaveTimer = setTimeout(async () => {
    config.window = state
    try {
      await saveConfig(configFile(), config)
    } catch (error) {
      console.error('Could not save window state:', error)
    }
  }, 500)
}

// On close the app may quit before an async write finishes, so this one writes synchronously and atomically.
function flushWindowState(window: BrowserWindow) {
  if (!config) return
  clearTimeout(windowSaveTimer)
  config.window = windowState(window)
  saveConfigSync(configFile(), config)
}

function createWindow() {
  const saved = config.window && isOnScreen(config.window) ? config.window : undefined
  const window = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 560,
    title: 'BetterGit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    // Opaque native backing in the built-in --window color; the page still paints its own opaque --window behind the glass panels.
    // No native vibrancy: with the under-window material, swiping between Spaces lagged on an external display.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d23' : '#e6e8ee',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow = window
  // Without a usable saved position, center on launch: the default position may be off-screen.
  if (!saved) window.center()
  if (saved?.maximized) window.maximize()
  const save = () => saveWindowState(window)
  window.on('move', save).on('resize', save).on('maximize', save).on('unmaximize', save)
  window.on('close', () => flushWindowState(window))
  window.once('closed', () => { mainWindow = null })
  updater.watch(window.webContents)
  // Text size is a page zoom, so every row, gutter, and divider scales together and stays aligned.
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(config.settings.textZoom))
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  try {
    openCommandLog(path.join(app.getPath('logs'), 'git-commands.log'))
  } catch (error) {
    console.error('Could not open the command log:', error)
  }
  config = await loadConfig(configFile())
  nativeTheme.themeSource = config.settings.theme
  // The renderer waits for the icon theme before its first frame, so its files start loading now, alongside the window.
  if (config.settings.appearance?.iconTheme) loadTheme('icons', config.settings.appearance.iconTheme)?.catch(() => {})
  registerIpc()
  nativeTheme.themeSource = config.settings.theme
  installMenu()
  await applyRuntime()
  createWindow()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void watcher.stop()
  fetcher?.stop()
  app.quit()
})
