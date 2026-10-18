import { afterEach, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as configModule from '../src/main/config'
import * as editors from '../src/shared/editors'
import * as editorLaunch from '../src/renderer/src/editor-launch'
import * as repoBusy from '../src/renderer/src/repo-busy'
import * as repoLocks from '../src/main/repo-lock'
import { IconButton } from '../src/renderer/src/Icons'
import type { BetterGitApi } from '../src/preload'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../src/main/config'
import { openCommand, readWorkingFile, resolveFileTarget, resolveRepoTarget, writeWorkingFile } from '../src/main/editor'
import type { EditorId } from '../src/shared/editors'
import { git } from '../src/main/git/exec'
import { workingDiff } from '../src/main/git/diff'
import { originalText } from '../src/renderer/src/DiffEditor'

// Tests stop at the native process boundary. No test starts an editor.
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function sandbox() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bettergit-editor-')))
  dirs.push(root)
  const repo = path.join(root, 'repo')
  await fs.mkdir(path.join(repo, 'src'), { recursive: true })
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'export {}\n')
  await fs.writeFile(path.join(root, 'secret.txt'), 'outside the repo\n')
  return { root, repo }
}

test('opens the real file path with the VS Code bundle ID and no shell', async () => {
  const { repo } = await sandbox()
  const target = await resolveFileTarget(repo, 'src/app.ts')
  expect(target).toBe(path.join(await fs.realpath(repo), 'src', 'app.ts'))
  expect(openCommand('vscode', target)).toEqual({ file: '/usr/bin/open', args: ['-b', 'com.microsoft.VSCode', target] })
  expect(() => openCommand('vscode', 'src/app.ts')).toThrow('absolute')
  expect(() => openCommand('nano' as EditorId, target)).toThrow('Unknown editor')
})

test('rejects paths that leave the repository', async () => {
  const { repo } = await sandbox()
  await expect(resolveFileTarget(repo, '../secret.txt')).rejects.toThrow('leaves the repository')
  await expect(resolveFileTarget(repo, 'src/../../secret.txt')).rejects.toThrow('leaves the repository')
  await expect(resolveFileTarget(repo, '/etc/hosts')).rejects.toThrow('relative')
  await expect(resolveFileTarget(repo, 'src/a\0b.ts')).rejects.toThrow('Invalid file path')
})

test('rejects a symlink that points outside the repository', async () => {
  const { root, repo } = await sandbox()
  await fs.symlink(path.join(root, 'secret.txt'), path.join(repo, 'link.txt'))
  await expect(resolveFileTarget(repo, 'link.txt')).rejects.toThrow('leaves the repository')
})

test('reports a missing file and never creates it', async () => {
  const { repo } = await sandbox()
  await expect(resolveFileTarget(repo, 'src/deleted.ts')).rejects.toThrow('Not in the working copy')
  expect(await fs.stat(path.join(repo, 'src', 'deleted.ts')).catch(() => null)).toBeNull()
})

test('the inline editor saves only a file unchanged since it was loaded, inside the repository', async () => {
  const { root, repo } = await sandbox()
  const file = path.join(repo, 'src', 'app.ts')
  const loaded = await readWorkingFile(repo, 'src/app.ts')
  await writeWorkingFile(repo, 'src/app.ts', loaded, 'export const a = 1\r\n')
  expect(await fs.readFile(file, 'utf8')).toBe('export const a = 1\r\n')
  // The file on disk no longer matches what was loaded, so a second save from the old text is refused.
  await expect(writeWorkingFile(repo, 'src/app.ts', loaded, 'lost\n')).rejects.toThrow('changed on disk')
  expect(await fs.readFile(file, 'utf8')).toBe('export const a = 1\r\n')
  await expect(writeWorkingFile(repo, '../secret.txt', 'outside the repo\n', 'x')).rejects.toThrow('leaves the repository')
  expect(await fs.readFile(path.join(root, 'secret.txt'), 'utf8')).toBe('outside the repo\n')
  await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0x66, 0x00, 0x67]))
  await expect(readWorkingFile(repo, 'blob.bin')).rejects.toThrow('binary')
  // An in-repo symlink is refused both ways, so its target is never written through it.
  await fs.symlink('app.ts', path.join(repo, 'src', 'alias.ts'))
  await expect(readWorkingFile(repo, 'src/alias.ts')).rejects.toThrow('symbolic link')
  await expect(writeWorkingFile(repo, 'src/alias.ts', 'export const a = 1\r\n', 'x')).rejects.toThrow('symbolic link')
  expect(await fs.readFile(file, 'utf8')).toBe('export const a = 1\r\n')
})

// The diff's editor holds the whole working file and rebuilds the old side from it and the hunks, so lines folded
// between hunks must come back unchanged. Git's own index copy is the expected old side.
test('the diff editor rebuilds the old file from the working file and its hunks, folded lines included', async () => {
  const { repo } = await sandbox()
  await git(repo, ['init', '-q'])
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  await fs.writeFile(path.join(repo, 'list.txt'), `${lines.join('\n')}\n`)
  await git(repo, ['add', 'list.txt'])
  const edited = [...lines]
  edited[4] = 'line 5 changed'
  edited.splice(19, 2)
  edited.splice(33, 0, 'new A', 'new B')
  edited[0] = '  line 1'
  const current = `${edited.join('\n')}\n`
  await fs.writeFile(path.join(repo, 'list.txt'), current)
  const index = await git(repo, ['show', ':list.txt'])
  const [file] = await workingDiff(repo, false)
  expect(file.hunks.length).toBeGreaterThan(1)
  expect(originalText(current, file.hunks)).toBe(index)
  // With whitespace hidden, a whitespace-only change stays hidden: that line keeps its current text.
  const [quiet] = await workingDiff(repo, false, 3, undefined, true)
  expect(originalText(current, quiet.hunks)).toBe(index.replace('line 1\n', '  line 1\n'))
  // An untracked file is all added lines, so its old side is empty.
  await fs.writeFile(path.join(repo, 'new.txt'), 'a\nb\n')
  const untracked = (await workingDiff(repo, false)).find((entry) => entry.newPath === 'new.txt')!
  expect(originalText('a\nb\n', untracked.hunks)).toBe('')
  // A diff that no longer matches the file is refused, so the editor never shows a wrong old side.
  expect(originalText(current.replace('new A', 'other'), file.hunks)).toBeNull()
})

test('file and folder targets must match their kind', async () => {
  const { repo } = await sandbox()
  await expect(resolveFileTarget(repo, 'src')).rejects.toThrow('Not a regular file')
  await expect(resolveRepoTarget(path.join(repo, 'src', 'app.ts'))).rejects.toThrow('Not a folder')
  expect(await resolveRepoTarget(repo)).toBe(await fs.realpath(repo))
})

test('an unknown editor in config falls back to VS Code', () => {
  expect(normalizeConfig({ settings: { editor: 'vscode' } }).settings.editor).toBe('vscode')
  expect(normalizeConfig({ settings: { editor: 'nano' } }).settings.editor).toBe('vscode')
  expect(normalizeConfig({}).settings.editor).toBe('vscode')
})

// Like the repo-lock bridge test, execute the real entry points in memory. No app or output files are built.
async function loadEntry(file: string, imports: Record<string, unknown>, after = '', globals: Record<string, unknown> = {}): Promise<any> {
  const compiled = await Bun.build({
    entrypoints: [new URL(file, import.meta.url).pathname],
    format: 'cjs', target: 'node', external: ['*'],
  })
  expect(compiled.success).toBe(true)
  const module = { exports: {} }
  runInNewContext(await compiled.outputs[0].text() + after, {
    ...globals, module, exports: module.exports,
    require: (id: string) => imports[id] ?? {},
  })
  return module.exports
}

test('main and preload reject escaped repos but open allowed aliases during Git writes and persist a valid editor', async () => {
  const { root, repo } = await sandbox()
  await fs.mkdir(path.join(repo, '.git'))
  const outside = path.join(root, 'outside')
  await fs.mkdir(path.join(outside, '.git'), { recursive: true })
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside the configured sources\n')
  const escape = path.join(repo, 'escape')
  await fs.symlink(outside, escape, 'dir')
  await fs.symlink(path.join(outside, 'outside.txt'), path.join(repo, 'outside-link.txt'))
  const repoAlias = path.join(repo, 'alias')
  const sourceAlias = path.join(root, 'source-alias')
  await fs.symlink(repo, repoAlias, 'dir')
  await fs.symlink(repo, sourceAlias, 'dir')
  const sources = [repo, sourceAlias]
  const staged: string[] = []
  const commands: Array<{ file: string; args: string[] }> = []
  // Only the native process boundary is replaced. Real target validation and command construction still run.
  const editor = await loadEntry('../src/main/editor.ts', {
    'node:child_process': { execFile: (file: string, args: string[], _options: unknown, done: (error: null, stdout: string, stderr: string) => void) => {
      commands.push({ file, args })
      done(null, '', '')
    } },
    'node:fs': { promises: fs }, 'node:path': path, 'node:util': { promisify }, '../shared/editors': editors,
  })
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const app = Object.assign(new EventEmitter(), {
    setName: () => {}, getPath: () => root, whenReady: () => new Promise<void>(() => {}),
  })
  await loadEntry('../src/main/index.ts', {
    electron: {
      app, ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
      BrowserWindow: { getAllWindows: () => [] }, Menu: { setApplicationMenu: () => {} }, nativeTheme: {},
    },
    'node:path': path, 'node:fs': { statSync }, './config': configModule, './editor': editor,
    './repo-lock': repoLocks,
    './git/ops': { stagePaths: async (repo: string) => { staged.push(repo) } },
    './git/dirty': { DirtyCounter: class {} },
    './watch': { SourceWatcher: class { async watch() {} } },
    './background': { BackgroundFetcher: class { start() {} stop() {} } },
    './menu': { buildMenu: () => [] },
  }, '\nconfig = testConfig; registerIpc()', { testConfig: normalizeConfig({ sources }) })
  let api!: BetterGitApi
  await loadEntry('../src/preload/index.ts', {
    electron: {
      contextBridge: { exposeInMainWorld: (_name: string, value: BetterGitApi) => { api = value } },
      ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) },
    },
  })
  try {
    const refused = `Not a repository in the sidebar: ${escape}`
    await expect(api.openInEditor(escape)).rejects.toThrow(refused)
    expect(commands).toEqual([])
    await expect(api.openInEditor(escape, 'outside.txt')).rejects.toThrow(refused)
    expect(commands).toEqual([])
    await expect(api.stage(escape, ['outside.txt'])).rejects.toThrow(refused)
    expect(staged).toEqual([])
    await expect(api.openInEditor(repo, 'outside-link.txt')).rejects.toThrow('Path leaves the repository')
    expect(commands).toEqual([])
    await repoLocks.withRepoLock(repo, 'repo:push', async () => {
      for (const selected of [repo, repoAlias, sourceAlias]) {
        await api.openInEditor(selected)
        await api.openInEditor(selected, 'src/app.ts')
      }
      await expect(api.stage(repoAlias, ['src/app.ts'])).rejects.toThrow('Another action is running')
      await expect(api.openInEditor(root)).rejects.toThrow('Not a repository in the sidebar')
      await expect(api.openInEditor(repo, '')).rejects.toThrow('Invalid file path')
      await expect(api.openInEditor(repo, 'src/deleted.ts')).rejects.toThrow('Not in the working copy')
    })
    expect(commands).toEqual([repo, repoAlias, sourceAlias].flatMap(() => [
      openCommand('vscode', repo), openCommand('vscode', path.join(repo, 'src/app.ts')),
    ]))
    expect(await fs.stat(path.join(repo, 'src/deleted.ts')).catch(() => null)).toBeNull()
    const updated = await api.updateConfig({ settings: { editor: 'unregistered' } })
    expect(updated.settings.editor).toBe('vscode')
    expect((await configModule.loadConfig(path.join(root, 'config.json'))).settings.editor).toBe('vscode')
    expect((await api.getConfig()).sources).toEqual(sources)
  } finally {
    app.emit('will-quit')
  }
})

test('JP3 background fetch spins only Fetch through canonical and alias busy state, preserving local precedence', async () => {
  const busy = await loadEntry('../src/renderer/src/repo-busy.ts', { react: React }) as typeof repoBusy
  const menu = await loadEntry('../src/renderer/src/RepoMenu.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './repo-busy': busy,
  }, '', { window: { bettergit: {} } }) as typeof import('../src/renderer/src/RepoMenu')
  const repo = '/jp3-canonical', alias = '/jp3-alias'
  const identities = { [alias]: repo }
  let seq = 0, opened = 0
  const noop = () => {}
  const itemsFor = (selected: string) => menu.repoItems({
    repo: selected, status: null, busy: busy.busyKey(selected), run: async () => true,
    onTab: noop, onNote: noop, onError: noop, onDialog: noop,
    editor: { label: 'VS Code', busy: false, onOpen: () => { opened++ } },
  })
  const fetchMarkup = (selected: string) => {
    const item = itemsFor(selected).find((item) => item.key === 'fetch')!
    return renderToStaticMarkup(React.createElement(IconButton, {
      icon: item.icon, label: item.label, busy: item.busy, blocked: item.blocked, onClick: item.onClick,
    }))
  }

  busy.applyRepoLockSnapshot({ seq: ++seq, holders: { [repo]: 'background-fetch' }, identities })
  for (const selected of [repo, alias]) {
    const items = itemsFor(selected)
    expect(items.find((item) => item.key === 'fetch')).toMatchObject({ label: 'Fetching…', busy: true, blocked: undefined })
    expect(fetchMarkup(selected)).toContain('aria-busy="true"')
    expect(fetchMarkup(selected)).toContain('action-spin')
    expect(items.filter((item) => item.busy).map((item) => item.key)).toEqual(['fetch'])
    for (const key of ['pullMerge', 'pullRebase', 'pullFrom', 'push', 'reset', 'stash', 'applyStash', 'popStash', 'popLatest']) {
      const item = items.find((item) => item.key === key)!
      expect(item.busy).not.toBe(true)
      expect(item.blocked).toBe('Another action is running: Fetching…')
    }
    const editor = items.find((item) => item.key === 'openEditor')!
    expect(editor.busy).toBe(false)
    expect(editor.blocked).toBeUndefined()
    expect(editor.disabled).not.toBe(true)
    editor.onClick()
    expect(items.find((item) => item.key === 'stashList')!.blocked).toBeUndefined()
  }
  expect(opened).toBe(2)
  busy.applyRepoLockSnapshot({ seq: ++seq, holders: {}, identities })
  expect(itemsFor(alias).find((item) => item.key === 'fetch')).toMatchObject({ label: 'Fetch', busy: false, blocked: undefined })
  expect(fetchMarkup(alias)).not.toContain('action-spin')
  expect(fetchMarkup(alias)).not.toContain('aria-busy')

  let release!: () => void
  const local = busy.runRepoAction(alias, 'pull-rebase', () => new Promise<void>((done) => { release = done }), noop)
  try {
    busy.applyRepoLockSnapshot({ seq: ++seq, holders: { [repo]: 'background-fetch' }, identities })
    for (const selected of [repo, alias]) {
      const items = itemsFor(selected)
      expect(items.filter((item) => item.busy).map((item) => item.key)).toEqual(['pullRebase'])
      expect(items.find((item) => item.key === 'pullRebase')!.label).toBe('Pulling…')
      expect(items.find((item) => item.key === 'fetch')).toMatchObject({ label: 'Fetch', busy: false, blocked: 'Another action is running: Pulling…' })
      expect(fetchMarkup(selected)).not.toContain('action-spin')
    }
    busy.applyRepoLockSnapshot({ seq: ++seq, holders: {}, identities })
    expect(itemsFor(repo).find((item) => item.key === 'pullRebase')!.busy).toBe(true)
  } finally {
    release()
    expect(await local).toBe(true)
  }
  for (const selected of [repo, alias]) {
    expect(busy.busyKey(selected)).toBeNull()
    expect(itemsFor(selected).find((item) => item.key === 'fetch')).toMatchObject({ label: 'Fetch', busy: false, blocked: undefined })
  }
  for (const [holder, label] of [['repo:conflict-save', 'Saving resolution…'], ['repo:conflict-reset', 'Resetting resolution…'], ['repo:create-branch', 'Creating branch…'], ['repo:branch-from', 'Creating branch…']]) {
    busy.applyRepoLockSnapshot({ seq: ++seq, holders: { [repo]: holder }, identities })
    expect(busy.workingLabel(busy.busyKey(alias)!)).toBe(label)
    expect(itemsFor(alias).find((item) => item.key === 'fetch')!.blocked).toBe(`Another action is running: ${label}`)
    expect(itemsFor(alias).filter((item) => item.busy)).toEqual([])
  }
  busy.applyRepoLockSnapshot({ seq: ++seq, holders: {}, identities })
})

test('App supplies the working-copy editor bridge and a repo launch independent of Git busy state', async () => {
  const launches: Array<[string, string?]> = []
  const api = { openInEditor: async (repo: string, file?: string) => { launches.push([repo, file]) } }
  const menu = await loadEntry('../src/renderer/src/RepoMenu.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './repo-busy': repoBusy,
  }, '', { window: { bettergit: api } })
  // RepoMenu reads the bridge at module load, so give it the same isolated window as App.
  let bridge: editorLaunch.EditorBridge | null = null
  let items: import('../src/renderer/src/OverflowBar').BarItem[] = []
  const History = () => { bridge = React.useContext(editorLaunch.EditorContext); return null }
  const imports = {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, 'react-dom': { createPortal: (node: React.ReactNode) => node },
    '../../shared/editors': editors, './editor-launch': editorLaunch,
    './RepoMenu': { ...menu, RepoDialogs: () => null },
    './OverflowBar': { OverflowBar: (props: { items: typeof items }) => { items = props.items; return null } },
    './HistoryView': { HistoryView: History },
    './Icons': { Icon: History, IconButton: () => null },
    './repo-busy': { ...repoBusy, useRepoBusy: () => 'push' },
  }
  const app = await loadEntry('../src/renderer/src/App.tsx', imports, '\nmodule.exports.RepoPane = RepoPane', { window: { bettergit: api } })
  const props = {
    titlebar: {}, repo: { kind: 'repo', name: 'repo', path: '/repo' }, editor: 'vscode', tab: 'history',
    onTab: () => {}, sidebarOpen: true, onToggleSidebar: () => {}, listOpen: true, onToggleList: () => {},
    detailOpen: true, onToggleDetail: () => {}, revision: 0, onChanged: () => {}, onError: () => {}, onCleanChange: () => {},
  }
  renderToStaticMarkup(React.createElement(app.RepoPane, props))
  expect(bridge).not.toBeNull()
  const current = bridge as unknown as editorLaunch.EditorBridge
  expect(current.editor).toBe('vscode')
  expect(current.source).toBe('commit')
  expect(current.onError).toBe(props.onError)
  await current.openFile('src/app.ts')
  const item = items.find((item) => item.key === 'openEditor')!
  expect(item.label).toBe('Open in VS Code')
  expect(item.blocked).toBeUndefined()
  expect(item.busy).toBe(false)
  item.onClick?.()
  item.onClick?.()
  expect(launches).toEqual([['/repo', 'src/app.ts'], ['/repo', undefined]])
  renderToStaticMarkup(React.createElement(app.RepoPane, { ...props, tab: 'changes' }))
  expect((bridge as unknown as editorLaunch.EditorBridge).source).toBe('working')
})
