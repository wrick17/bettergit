import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DiffFile, MovedBlock } from '../main/git/diff'
import type { HunkAction, HunkRequest } from '../main/git/hunks'
import type { Branch, BranchSelection, Stash, Tag, Worktree } from '../main/git/ops'
import type { FetchMode, PullMode, PushMode } from '../main/git/ops'
import type { RepoLockSnapshot } from '../main/repo-lock'
import type { UpdateState } from '../main/update'
import type { AppKind, InstalledApp } from '../shared/editors'
import type { ColorTheme, ExtensionDetails, ExtensionMetadata, ExtensionResult, IconTheme, InstalledExtension } from '../shared/themes'
import type { ConflictDocument, ConflictPreview, ConflictReset, ConflictResetResult, ConflictSave, ConflictSaved } from '../shared/conflict'

// The renderer gets named functions only. It never sees ipcRenderer or Node APIs.
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api = {
  getConfig: () => invoke('config:get'),
  updateConfig: (patch: unknown) => invoke('config:update', patch),
  getTree: () => invoke('sources:tree'),
  // Counts one repo's changes and commits to push and pull again, for a sidebar Refresh on that repo.
  refreshRepo: (repo: string) => invoke('repo:refresh', repo) as Promise<void>,
  pickSources: () => invoke('sources:pick'),
  pickFolder: () => invoke('folder:pick') as Promise<string | null>,
  addSources: (paths: string[]) => invoke('sources:add', paths),
  removeSource: (path: string) => invoke('sources:remove', path),
  repoLocks: () => invoke('repo:locks') as Promise<RepoLockSnapshot>,
  // BetterGit's own updates. Main picks the release and the install path; the renderer only asks.
  updateState: () => invoke('update:state') as Promise<UpdateState>,
  checkForUpdates: () => invoke('update:check') as Promise<void>,
  downloadUpdate: () => invoke('update:download') as Promise<void>,
  // Null when the app is quitting to install; otherwise why it cannot restart now.
  installUpdate: () => invoke('update:install') as Promise<string | null>,
  openUpdatePage: () => invoke('update:page') as Promise<void>,
  status: (repo: string) => invoke('repo:status', repo),
  // `hidden` lists branches hidden in the app, by full ref. History walks from every other branch.
  history: (repo: string, skip: number, limit: number, authors: string[] = [], hidden: string[] = []) => invoke('repo:history', repo, skip, limit, authors, hidden),
  searchHistory: (repo: string, query: string, authors: string[] = [], hidden: string[] = []) => invoke('repo:search', repo, query, authors, hidden),
  authors: (repo: string) => invoke('repo:authors', repo) as Promise<{ name: string; count: number }[]>,
  // An author's picture as a PNG data URL, or null when there is none or it could not be loaded.
  avatar: (email: string) => invoke('avatar:get', email) as Promise<string | null>,
  commit: (repo: string, hash: string, context: number, ignoreWhitespace = false) => invoke('repo:commit', repo, hash, context, ignoreWhitespace),
  // The branches and tags at a commit now. Read on each refresh, since refs move while the hash stays.
  commitRefs: (repo: string, hash: string) => invoke('repo:commit-refs', repo, hash) as Promise<{ branches: string[]; remotes: string[]; tags: string[] }>,
  working: (repo: string, staged: boolean, context: number, path?: string, ignoreWhitespace = false) =>
    invoke('repo:working', repo, staged, context, path, ignoreWhitespace),
  stage: (repo: string, paths: string[]) => invoke('repo:stage', repo, paths),
  unstage: (repo: string, paths: string[]) => invoke('repo:unstage', repo, paths),
  discard: (repo: string, paths: string[]) => invoke('repo:discard', repo, paths),
  deleteUntracked: (repo: string, path: string) => invoke('repo:delete-untracked', repo, path) as Promise<void>,
  // Main re-reads the diff and applies the hunk only if it still matches what was shown.
  applyHunk: (repo: string, action: HunkAction, request: HunkRequest) => invoke('repo:hunk', repo, action, request) as Promise<void>,
  commitChanges: (repo: string, message: string, amend: boolean) => invoke('repo:commit-changes', repo, message, amend),
  branches: (repo: string) => invoke('repo:branches', repo) as Promise<Branch[]>,
  switchBranch: (repo: string, selection: BranchSelection) => invoke('repo:switch', repo, selection) as Promise<void>,
  createBranch: (repo: string, name: string, base: BranchSelection) => invoke('repo:create-branch', repo, name, base) as Promise<void>,
  deleteBranch: (repo: string, branch: BranchSelection) => invoke('repo:delete-branch', repo, branch) as Promise<void>,
  renameBranch: (repo: string, branch: BranchSelection, name: string) => invoke('repo:rename-branch', repo, branch, name) as Promise<void>,
  setUpstream: (repo: string, branch: BranchSelection, upstream: BranchSelection) => invoke('repo:set-upstream', repo, branch, upstream) as Promise<void>,
  unsetUpstream: (repo: string, branch: BranchSelection) => invoke('repo:unset-upstream', repo, branch) as Promise<void>,
  fetch: (repo: string, mode?: FetchMode) => invoke('repo:fetch', repo, mode),
  pull: (repo: string, mode?: PullMode) => invoke('repo:pull', repo, mode),
  pullFrom: (repo: string, remote: string, branch: string) => invoke('repo:pull-from', repo, remote, branch),
  remotes: (repo: string) => invoke('repo:remotes', repo) as Promise<{ name: string; url: string }[]>,
  resetToUpstream: (repo: string) => invoke('repo:reset-upstream', repo) as Promise<string>,
  checkoutDetached: (repo: string, hash: string) => invoke('repo:checkout-detached', repo, hash),
  branchFromCommit: (repo: string, name: string, hash: string) => invoke('repo:branch-from', repo, name, hash),
  tagFromCommit: (repo: string, name: string, hash: string) => invoke('repo:tag-from', repo, name, hash),
  cherryPick: (repo: string, hash: string) => invoke('repo:cherry-pick', repo, hash) as Promise<string>,
  revertCommit: (repo: string, hash: string) => invoke('repo:revert', repo, hash) as Promise<string>,
  amendMessage: (repo: string, message: string, expectedHash: string) => invoke('repo:amend-message', repo, message, expectedHash),
  mergeBase: (repo: string, a: string, b: string) => invoke('repo:merge-base', repo, a, b) as Promise<string>,
  compare: (repo: string, from: string, to: string, ignoreWhitespace = false) =>
    invoke('repo:compare', repo, from, to, ignoreWhitespace) as Promise<{ files: DiffFile[]; moves: MovedBlock[] }>,
  openExternal: (url: string) => invoke('system:open-url', url),
  // Force modes need the branch and upstream the user confirmed; main refuses them if either has changed.
  push: (repo: string, mode?: PushMode, confirmed?: { branch: string; upstream: string }) => invoke('repo:push', repo, mode, confirmed),
  stashes: (repo: string) => invoke('repo:stashes', repo) as Promise<Stash[]>,
  tags: (repo: string) => invoke('repo:tags', repo) as Promise<Tag[]>,
  worktrees: (repo: string) => invoke('repo:worktrees', repo) as Promise<Worktree[]>,
  stash: (repo: string, message: string) => invoke('repo:stash', repo, message),
  stashAction: (repo: string, action: string, ref: string) => invoke('repo:stash-action', repo, action, ref),
  backup: (repo: string, label: string) => invoke('repo:backup', repo, label),
  restore: (repo: string, ref: string) => invoke('repo:restore', repo, ref),
  clone: (url: string, parent: string) => invoke('clone', url, parent),
  reveal: (repo: string) => invoke('repo:reveal', repo),
  openInEditor: (repo: string, path?: string) => invoke('repo:open-in-editor', repo, path) as Promise<void>,
  openInTerminal: (repoPath: string) => invoke('repo:open-in-terminal', repoPath) as Promise<void>,
  // Editors and terminals for Settings. Icons are PNG data URLs, null when macOS has none.
  listApps: (kind: AppKind) => invoke('apps:list', kind) as Promise<InstalledApp[]>,
  appIcon: (appPath: string) => invoke('apps:icon', appPath) as Promise<string | null>,
  pickApp: (kind: AppKind) => invoke('apps:pick', kind) as Promise<InstalledApp | null>,
  // VS Code extensions, for their colour and file icon themes. Main validates every id and ref; the .vsix file is picked in main.
  listExtensions: () => invoke('extensions:list') as Promise<InstalledExtension[]>,
  searchExtensions: (query: string) => invoke('extensions:search', query) as Promise<ExtensionResult[]>,
  extensionMetadata: (namespace: string, name: string) => invoke('extensions:metadata', namespace, name) as Promise<ExtensionMetadata>,
  extensionDetails: (namespace: string, name: string) => invoke('extensions:details', namespace, name) as Promise<ExtensionDetails>,
  extensionImage: (url: string) => invoke('extensions:image', url) as Promise<string | null>,
  installExtension: (namespace: string, name: string) => invoke('extensions:install', namespace, name) as Promise<InstalledExtension>,
  installExtensionFile: () => invoke('extensions:install-file') as Promise<InstalledExtension | null>,
  removeExtension: (id: string) => invoke('extensions:remove', id) as Promise<void>,
  colorTheme: (ref: string) => invoke('themes:color', ref) as Promise<ColorTheme | null>,
  iconTheme: (ref: string) => invoke('themes:icons', ref) as Promise<IconTheme | null>,
  // Conflict resolution. The save sends back the fingerprint from load, never a fresh one, and no file text.
  conflictLoad: (repo: string, file: string) => invoke('repo:conflict-load', repo, file) as Promise<ConflictDocument>,
  conflictPreview: (repo: string, file: string, save: ConflictSave) =>
    invoke('repo:conflict-preview', repo, file, save) as Promise<ConflictPreview>,
  conflictSave: (repo: string, file: string, save: ConflictSave) =>
    invoke('repo:conflict-save', repo, file, save) as Promise<ConflictSaved>,
  conflictReset: (repo: string, file: string, request: ConflictReset) =>
    invoke('repo:conflict-reset', repo, file, request) as Promise<ConflictResetResult>,
  // The inline editor. The write sends back the text it loaded, so the main process can refuse a file changed since.
  readFile: (repo: string, file: string) => invoke('repo:file-read', repo, file) as Promise<string>,
  writeFile: (repo: string, file: string, expected: string, text: string) =>
    invoke('repo:file-write', repo, file, expected, text) as Promise<void>,
  // Drag-and-drop gives a File; webUtils turns it into a real path without exposing fs to the page.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  fetchNow: () => invoke('fetch:now'),
  // Main-process events (file changes, background fetch reports) arrive here; returns an unsubscribe.
  onEvent: (channel: 'repo:locks' | 'repos:changed' | 'repos:dirty' | 'fetch:report' | 'menu:action' | 'app:error' | 'update:state', listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  },
}

contextBridge.exposeInMainWorld('bettergit', api)
export type BetterGitApi = typeof api
