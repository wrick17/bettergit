import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import * as configModule from '../src/main/config'
import * as appsModule from '../src/main/apps'
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
import { appCommand, openCommand, readWorkingFile, resolveFileTarget, resolveRepoTarget, writeWorkingFile } from '../src/main/editor'
import type { EditorId } from '../src/shared/editors'
import { git } from '../src/main/git/exec'
import { workingDiff } from '../src/main/git/diff'
import { originalText } from '../src/renderer/src/original-text'

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

test('detects known apps once each, merges custom apps by path, and accepts only real .app bundles', async () => {
  const { root } = await sandbox()
  const first = path.join(root, 'Applications'), second = path.join(root, 'Utilities')
  for (const bundle of [path.join(first, 'Visual Studio Code.app'), path.join(first, 'kitty.app'), path.join(first, 'Unknown.app'), path.join(second, 'kitty.app')]) {
    await fs.mkdir(path.join(bundle, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), '')
  }
  const found = await appsModule.detectApps([first, path.join(root, 'missing'), second])
  expect(found.map((entry) => [entry.id, entry.path])).toEqual([['vscode', path.join(first, 'Visual Studio Code.app')], ['kitty', path.join(first, 'kitty.app')]])
  await expect(appsModule.customApp('editor', path.join(root, 'missing.app'))).rejects.toThrow('.app')
  await expect(appsModule.customApp('editor', 'Relative.app')).rejects.toThrow('.app')
  const custom = await appsModule.customApp('editor', path.join(first, 'Unknown.app'))
  expect(custom).toEqual({ id: `custom:editor:${path.join(first, 'Unknown.app')}`, name: 'Unknown', path: path.join(first, 'Unknown.app'), kind: 'editor', custom: true })
  const duplicate = { ...custom, id: 'custom:editor:dup', path: found[0].path }
  expect(appsModule.mergeApps(found, [custom, duplicate], 'editor').map((entry) => entry.name)).toEqual(['Unknown', 'VS Code'])
  // Config keeps only custom apps whose id matches their kind and path, so a hand-edited entry cannot alias another app.
  expect(normalizeConfig({ settings: { customApps: [custom, duplicate, { ...custom, path: '/bin/sh' }] } }).settings.customApps).toEqual([custom])
  expect(normalizeConfig({ settings: { editor: 'vscode' } }).settings.editorApp).toBe('vscode')
  // Terminals that ignore a folder from `open -a` get their working-directory flag. Others open by path, never through a shell.
  expect(appCommand(found[1], root)).toEqual({ file: '/usr/bin/open', args: ['-na', found[1].path, '--args', '--directory', root] })
  expect(appCommand(custom, root)).toEqual({ file: '/usr/bin/open', args: ['-a', custom.path, root] })
  expect(appCommand(found[0], root)).toEqual(openCommand('vscode', root))
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
  const customPath = path.join(root, 'Custom.app')
  const custom = { id: `custom:editor:${customPath}`, name: 'Custom', path: customPath, kind: 'editor' as const, custom: true }
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
    'node:path': path, 'node:fs': { statSync }, './config': configModule, './editor': editor, './apps': appsModule,
    '../shared/editors': editors,
    './repo-lock': repoLocks,
    './git/ops': { stagePaths: async (repo: string) => { staged.push(repo) } },
    './git/dirty': { DirtyCounter: class {} },
    './watch': { SourceWatcher: class { async watch() {} } },
    './background': { BackgroundFetcher: class { start() {} stop() {} } },
    './menu': { buildMenu: () => [] },
  }, '\nconfig = testConfig; registerIpc()', { testConfig: normalizeConfig({ sources, settings: { customApps: [custom] } }) })
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
    // Settings patches carry only their changes. Choosing an app right after the picker saved a custom one keeps it, and
    // quick changes to different fields both land.
    await Promise.all([api.updateConfig({ settings: { editorApp: custom.id } }), api.updateConfig({ settings: { theme: 'dark' } }), api.updateConfig({ settings: { appearance: { codeFontSize: 15 } } })])
    const merged = (await api.getConfig()).settings
    expect([merged.editorApp, merged.theme, merged.appearance, merged.customApps]).toEqual([custom.id, 'dark', { codeFontSize: 15 }, [custom]])
    // Appearance patches merge field by field: a one-field patch keeps the other saved fields.
    await api.updateConfig({ settings: { appearance: { darkTheme: 'publisher.theme/dark.json', density: 'compact' } } })
    expect((await api.updateConfig({ settings: { appearance: { uiFontSize: 16 } } })).settings.appearance)
      .toEqual({ codeFontSize: 15, darkTheme: 'publisher.theme/dark.json', density: 'compact', uiFontSize: 16 })
    // An update can drop custom apps but never add one: only the picker does.
    const injected = { ...custom, id: 'custom:editor:/Applications/Other.app', path: '/Applications/Other.app' }
    expect((await api.updateConfig({ settings: { customApps: [custom, injected] } })).settings.customApps).toEqual([custom])
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
  let seq = 0
  const noop = () => {}
  const itemsFor = (selected: string) => menu.repoItems({
    repo: selected, status: null, busy: busy.busyKey(selected), run: async () => true,
    onTab: noop, onNote: noop, onError: noop, onDialog: noop,
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
    expect(items.find((item) => item.key === 'stashList')!.blocked).toBeUndefined()
  }
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

test('title-bar Actions menu keeps the sync icons and lists every repo action with groups, danger, and shortcuts', async () => {
  const menu = await loadEntry('../src/renderer/src/RepoMenu.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './repo-busy': repoBusy,
  }, '', { window: { bettergit: {} } }) as typeof import('../src/renderer/src/RepoMenu')
  const bar = await loadEntry('../src/renderer/src/OverflowBar.tsx', {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './Icons': await import('../src/renderer/src/Icons'),
  }) as typeof import('../src/renderer/src/OverflowBar')
  const noop = () => {}
  const items = menu.repoItems({
    repo: '/repo', status: { head: 'main', upstream: 'origin/main' } as never, busy: null, run: async () => true,
    onTab: noop, onNote: noop, onError: noop, onDialog: noop,
  })

  const toolbar = renderToStaticMarkup(React.createElement(bar.ActionsMenu, { items }))
  expect(toolbar).toContain('aria-haspopup="menu"')
  expect(toolbar).toContain('aria-expanded="false"')
  expect(toolbar).toContain('>Actions<')
  expect([...toolbar.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])).toEqual(['Fetch', 'Pull and Merge', 'Push'])

  const list = renderToStaticMarkup(React.createElement(bar.ActionMenu, { items, onPick: noop, label: 'Repository actions' }))
  expect(list).toContain('role="menu" aria-label="Repository actions"')
  expect(list.match(/role="menuitem"/g)).toHaveLength(items.length)
  expect(list.match(/role="separator"/g)).toHaveLength(new Set(items.map((item) => item.group)).size - 1)
  expect(list.match(/class="danger"/g)).toHaveLength(1)
  expect([...list.matchAll(/<kbd class="menu-shortcut">([^<]+)<\/kbd>/g)].map((match) => match[1])).toEqual(['⇧⌘F', '⇧⌘L', '⇧⌘P', '⇧⌘H'])
})

test('App supplies the working-copy editor bridge and Open in buttons independent of Git busy state', async () => {
  const launches: Array<[string, string?]> = []
  const api = { openInEditor: async (repo: string, file?: string) => { launches.push([repo, file]) } }
  const menu = await loadEntry('../src/renderer/src/RepoMenu.tsx', {
    'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './repo-busy': repoBusy,
  }, '', { window: { bettergit: api } })
  // RepoMenu reads the bridge at module load, so give it the same isolated window as App.
  let bridge: editorLaunch.EditorBridge | null = null
  let items: import('../src/renderer/src/OverflowBar').BarItem[] = []
  const openButtons: Array<Record<string, unknown>> = []
  const History = () => { bridge = React.useContext(editorLaunch.EditorContext); return null }
  const imports = {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, 'react-dom': { createPortal: (node: React.ReactNode) => node },
    '../../shared/editors': editors, './editor-launch': editorLaunch,
    './RepoMenu': { ...menu, RepoDialogs: () => null },
    './OverflowBar': { ActionsMenu: (props: { items: typeof items }) => { items = props.items; return null } },
    './HistoryView': { HistoryView: History },
    './Icons': { Icon: History, IconButton: () => null, toggleLabel: (state: string, action: string) => `${state} — click to ${action}` },
    './repo-busy': { ...repoBusy, useRepoBusy: () => 'push' },
    './OpenInAppButton': {
      OpenInAppButton: (props: Record<string, unknown>) => { openButtons.push(props); return null },
      useSelectedApp: (kind: string, appId?: string) => ({ name: `${kind}:${appId}`, icon: null }),
    },
  }
  const app = await loadEntry('../src/renderer/src/App.tsx', imports, '\nmodule.exports.RepoPane = RepoPane', { window: { bettergit: api } })
  const props = {
    titlebar: {}, repo: { kind: 'repo', name: 'repo', path: '/repo' }, editorApp: 'cursor', tab: 'history',
    onTab: () => {}, sidebarOpen: true, onToggleSidebar: () => {}, listOpen: true, onToggleList: () => {},
    detailOpen: true, onToggleDetail: () => {}, revision: 0, onChanged: () => {}, onError: () => {}, onCleanChange: () => {},
  }
  renderToStaticMarkup(React.createElement(app.RepoPane, props))
  expect(bridge).not.toBeNull()
  const current = bridge as unknown as editorLaunch.EditorBridge
  // File open buttons name the app chosen in Settings, the same one the toolbar shows.
  expect(current.app).toEqual({ name: 'editor:cursor', icon: null })
  expect(current.source).toBe('commit')
  expect(current.onError).toBe(props.onError)
  await current.openFile('src/app.ts')
  expect(launches).toEqual([['/repo', 'src/app.ts']])
  expect(items.some((item) => item.key === 'openEditor')).toBe(false)
  expect(openButtons.map(({ kind, app, repoPath }) => ({ kind, app, repoPath }))).toEqual([
    { kind: 'editor', app: current.app, repoPath: '/repo' },
    { kind: 'terminal', app: { name: 'terminal:undefined', icon: null }, repoPath: '/repo' },
  ])

  // Before the app list and icon load, the button names the default app and shows the generic glyph at its final size.
  const button = await loadEntry('../src/renderer/src/OpenInAppButton.tsx', {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, './editor-launch': editorLaunch,
    './Icons': { Icon: () => null, useTooltip: () => ({ handlers: {}, tooltip: null }) },
    './app-icons': { cachedAppIcon: () => undefined, loadAppIcon: async () => null, cachedApps: () => undefined, subscribeApps: () => () => {}, fetchApps: async () => [] },
  }, '', { window: { bettergit: {} } })
  const Button = ({ kind, repoPath }: { kind: string; repoPath: string | null }) =>
    React.createElement(button.OpenInAppButton, { kind, app: button.useSelectedApp(kind, undefined, () => {}), repoPath, onError: () => {} })
  const markup = (kind: string, repoPath: string | null) => renderToStaticMarkup(React.createElement(Button, { kind, repoPath }))
  expect(markup('editor', '/repo')).toContain('aria-label="Open in VS Code"')
  expect(markup('terminal', '/repo')).toContain('aria-label="Open in Terminal"')
  expect(markup('terminal', null)).toContain('disabled')
  renderToStaticMarkup(React.createElement(app.RepoPane, { ...props, tab: 'changes' }))
  expect((bridge as unknown as editorLaunch.EditorBridge).source).toBe('working')
})

describe('custom apps and terminal folders', () => {
  test('a custom app is stored by its real path and rejected once its bundle is gone or replaced', async () => {
    const { root } = await sandbox()
    const real = path.join(root, 'Real.app'), link = path.join(root, 'Link.app'), bare = path.join(root, 'Bare.app')
    await fs.mkdir(path.join(real, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(real, 'Contents', 'Info.plist'), '')
    await fs.mkdir(bare)
    await fs.symlink(real, link)
    const custom = await appsModule.customApp('terminal', link)
    expect(custom.path).toBe(real)
    expect(custom.id).toBe(`custom:terminal:${real}`)
    await expect(appsModule.customApp('terminal', bare)).rejects.toThrow('.app')
    expect(await appsModule.isAppBundle(real)).toBe(true)
    expect(await appsModule.isAppBundle(link)).toBe(false)
    // Retargeting the approved path at another file fails the check made before each icon or launch.
    await fs.rm(real, { recursive: true })
    await fs.writeFile(path.join(root, 'other.txt'), '')
    await fs.symlink(path.join(root, 'other.txt'), real)
    expect(await appsModule.isAppBundle(real)).toBe(false)
    expect((await appsModule.resolveApp('terminal', custom.id, [custom])).id).not.toBe(custom.id)
  })

  test('Tabby opens the folder through its open command', () => {
    const tabby = { id: 'tabby', name: 'Tabby', path: '/Applications/Tabby.app', kind: 'terminal' as const }
    expect(appCommand(tabby, '/repo')).toEqual({ file: '/usr/bin/open', args: ['-na', tabby.path, '--args', 'open', '/repo'] })
  })
})
