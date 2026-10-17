import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import path from 'node:path'
import { statSync } from 'node:fs'
import { loadConfig, saveConfig, saveConfigSync, type AppConfig, type WindowState } from './config'
import { flattenRepos, isRepo, repoNode, scanFolder, type TreeNode } from './scan'
import { SourceWatcher } from './watch'
import { buildMenu } from './menu'
import { BackgroundFetcher, type FetchReport } from './background'
import { canonicalRepoPath, registerRepoLockPaths, repoLockSnapshot, subscribeRepoLocks, withRepoLock } from './repo-lock'
import { commitDiff, compare, detectMoves, workingDiff } from './git/diff'
import { readHistory, commitDetails, searchHistory } from './git/history'
import { readStatus } from './git/status'
import { DirtyCounter } from './git/dirty'
import * as ops from './git/ops'

// Dev runs use the Electron binary, so the menu and userData need the product name set explicitly.
app.setName('BetterGit')

const configFile = () => path.join(app.getPath('userData'), 'config.json')
let config: AppConfig
let fetcher: BackgroundFetcher | null = null
const dirty = new DirtyCounter((repo, count) => sendToRenderer('repos:dirty', { path: repo, count }))
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

// Restarts the watcher and the background fetcher whenever sources or settings change.
async function applyRuntime() {
  await watcher.watch(config.sources)
  fetcher?.stop()
  fetcher = new BackgroundFetcher({
    enabled: config.settings.backgroundFetch,
    intervalMinutes: config.settings.fetchIntervalMinutes,
    idleThresholdSeconds: config.settings.idleThresholdSeconds,
    repos: allRepoPaths,
    onReport: (report: FetchReport) => sendToRenderer('fetch:report', report),
  })
  fetcher.start()
}

// The native menu mirrors config (the Appearance radio), so it is rebuilt on every change.
function installMenu() {
  Menu.setApplicationMenu(buildMenu({
    send: (action) => sendToRenderer('menu:action', action),
    setTheme: (theme) => persist({ ...config, settings: { ...config.settings, theme } }),
    currentTheme: () => config.settings.theme,
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
    return withRepoLock(repo, channel, (canonical) => handler(event, canonical, ...args), path.resolve(repoPath))
  })
}

function registerIpc() {
  ipcMain.handle('repo:locks', () => repoLockSnapshot())
  const offLocks = subscribeRepoLocks((snapshot) => sendToRenderer('repo:locks', snapshot))
  app.once('will-quit', offLocks)
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:update', async (_event, patch: Partial<AppConfig>) => {
    await persist({ ...config, ...patch, settings: { ...config.settings, ...(patch.settings ?? {}) } })
    return config
  })
  ipcMain.handle('sources:tree', async () => {
    const tree = await buildTree()
    // Hidden repos are counted too, so their count is ready when they are shown again.
    dirty.request(tree.flatMap(flattenRepos).map((repo) => repo.path))
    return tree
  })
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
  ipcMain.handle('repo:history', (_event, repoPath: string, skip: number, limit: number) =>
    readHistory(assertKnownRepo(repoPath), skip, limit))
  ipcMain.handle('repo:commit', async (_event, repoPath: string, hash: string, context: number) => {
    const repo = assertKnownRepo(repoPath)
    const files = await commitDiff(repo, hash, context)
    return { files, moves: detectMoves(files), details: await commitDetails(repo, hash) }
  })
  ipcMain.handle('repo:working', async (_event, repoPath: string, staged: boolean, context: number, path?: string) => {
    const files = await workingDiff(assertKnownRepo(repoPath), staged, context, path)
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
  handleWrite('repo:switch', (_event, repoPath: string, name: string) => ops.switchBranch(repoPath, name))
  handleWrite('repo:fetch', (_event, repoPath: string) => ops.fetchAll(repoPath))
  handleWrite('repo:pull', (_event, repoPath: string, mode?: 'merge' | 'rebase') => ops.pull(repoPath, mode))
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
  ipcMain.handle('repo:compare', async (_event, repoPath: string, from: string, to: string) => {
    const repo = assertKnownRepo(repoPath)
    return compare(repo, await ops.resolveCommit(repo, from), await ops.resolveCommit(repo, to))
  })
  ipcMain.handle('system:open-url', (_event, url: string) => {
    // Only https links leave the app; file:, javascript:, and custom schemes stay closed.
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error(`Refusing to open non-https link: ${url}`)
    return shell.openExternal(parsed.href)
  })
  handleWrite('repo:push', async (_event, repoPath: string) => {
    const repo = repoPath
    const status = await readStatus(repo)
    if (!status.head) throw new Error('Push needs a branch, not a detached HEAD.')
    await ops.push(repo, status.upstream !== null, status.head)
  })
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
  ipcMain.handle('repo:search', (_event, repoPath: string, query: string) => searchHistory(assertKnownRepo(repoPath), query))
  ipcMain.handle('repo:reveal', (_event, repoPath: string) => shell.showItemInFolder(assertKnownRepo(repoPath)))
  ipcMain.handle('clone', async (_event, url: string, parent: string) => {
    const destination = path.join(parent, path.basename(url.replace(/\.git$/, '')))
    await ops.clone(url, destination)
    await addSource(destination)
    await persist({ ...config, lastCloneDirectory: parent })
    return destination
  })
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
    // A transparent window lets the native vibrancy show through the translucent panels.
    transparent: true,
    // Under-window material gives the glass panels a blurred desktop behind them.
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // Without a usable saved position, center on launch: the default position may be off-screen.
  if (!saved) window.center()
  if (saved?.maximized) window.maximize()
  const save = () => saveWindowState(window)
  window.on('move', save).on('resize', save).on('maximize', save).on('unmaximize', save)
  window.on('close', () => flushWindowState(window))
  // Text size is a page zoom, so every row, gutter, and divider scales together and stays aligned.
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(config.settings.textZoom))
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  config = await loadConfig(configFile())
  nativeTheme.themeSource = config.settings.theme
  registerIpc()
  nativeTheme.themeSource = config.settings.theme
  installMenu()
  await applyRuntime()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void watcher.stop()
  fetcher?.stop()
  app.quit()
})
