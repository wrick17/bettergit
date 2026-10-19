import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DiffFile, MovedBlock } from '../main/git/diff'
import type { Branch, BranchSelection, Stash, Tag, Worktree } from '../main/git/ops'
import type { RepoLockSnapshot } from '../main/repo-lock'
import type { AppKind, InstalledApp } from '../shared/editors'
import type { ColorTheme, ExtensionResult, IconTheme, InstalledExtension } from '../shared/themes'
import type { ConflictDocument, ConflictPreview, ConflictReset, ConflictResetResult, ConflictSave, ConflictSaved } from '../shared/conflict'

// The renderer gets named functions only. It never sees ipcRenderer or Node APIs.
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api = {
  getConfig: () => invoke('config:get'),
  updateConfig: (patch: unknown) => invoke('config:update', patch),
  getTree: () => invoke('sources:tree'),
  pickSources: () => invoke('sources:pick'),
  pickFolder: () => invoke('folder:pick') as Promise<string | null>,
  addSources: (paths: string[]) => invoke('sources:add', paths),
  removeSource: (path: string) => invoke('sources:remove', path),
  repoLocks: () => invoke('repo:locks') as Promise<RepoLockSnapshot>,
  status: (repo: string) => invoke('repo:status', repo),
  history: (repo: string, skip: number, limit: number, authors: string[] = []) => invoke('repo:history', repo, skip, limit, authors),
  searchHistory: (repo: string, query: string, authors: string[] = []) => invoke('repo:search', repo, query, authors),
  authors: (repo: string) => invoke('repo:authors', repo) as Promise<{ name: string; count: number }[]>,
  commit: (repo: string, hash: string, context: number, ignoreWhitespace = false) => invoke('repo:commit', repo, hash, context, ignoreWhitespace),
  working: (repo: string, staged: boolean, context: number, path?: string, ignoreWhitespace = false) =>
    invoke('repo:working', repo, staged, context, path, ignoreWhitespace),
  stage: (repo: string, paths: string[]) => invoke('repo:stage', repo, paths),
  unstage: (repo: string, paths: string[]) => invoke('repo:unstage', repo, paths),
  discard: (repo: string, paths: string[]) => invoke('repo:discard', repo, paths),
  commitChanges: (repo: string, message: string, amend: boolean) => invoke('repo:commit-changes', repo, message, amend),
  branches: (repo: string) => invoke('repo:branches', repo) as Promise<Branch[]>,
  switchBranch: (repo: string, selection: BranchSelection) => invoke('repo:switch', repo, selection) as Promise<void>,
  createBranch: (repo: string, name: string, base: BranchSelection) => invoke('repo:create-branch', repo, name, base) as Promise<void>,
  fetch: (repo: string) => invoke('repo:fetch', repo),
  pull: (repo: string, mode?: 'merge' | 'rebase') => invoke('repo:pull', repo, mode),
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
  push: (repo: string) => invoke('repo:push', repo),
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
  onEvent: (channel: 'repo:locks' | 'repos:changed' | 'repos:dirty' | 'fetch:report' | 'menu:action', listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => { ipcRenderer.removeListener(channel, handler) }
  },
}

contextBridge.exposeInMainWorld('bettergit', api)
export type BetterGitApi = typeof api
