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
import * as repoBusy from '../src/renderer/src/repo-busy'
import * as repoLocks from '../src/main/repo-lock'
import { IconButton } from '../src/renderer/src/Icons'
import type { BetterGitApi } from '../src/preload'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../src/main/config'
import { openCommand, resolveFileTarget, resolveRepoTarget } from '../src/main/editor'
import type { EditorId } from '../src/shared/editors'

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
