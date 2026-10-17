import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { cleanup } from './helpers'
import { git } from '../scripts/create-sample-workspace'
import * as locks from '../src/main/repo-lock'
import * as scan from '../src/main/scan'
import * as configModule from '../src/main/config'
import * as conflict from '../src/shared/conflict'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import type { BetterGitApi } from '../src/preload'
import {
  describeOperation, repoLockHolder, repoLockSnapshot, RepoBusyError, subscribeRepoLocks, withRepoLock, type RepoLockSnapshot,
} from '../src/main/repo-lock'


const lockRoot = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'bettergit-lock-')))
afterAll(() => cleanup(lockRoot))

function lockPath(name: string): string {
  const repo = path.join(lockRoot, name)
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-q'])
  }
  return repo
}

async function load(file: string, imports: Record<string, unknown>, after = '', globals: Record<string, unknown> = {}) {
    const compiled = await Bun.build({
      entrypoints: [new URL(file, import.meta.url).pathname],
      // No outdir keeps compiled code in memory.
      format: 'cjs', target: 'node', external: ['*'],
    })
    expect(compiled.success).toBe(true)
    const module = { exports: {} }
    runInNewContext(await compiled.outputs[0].text() + after, {
      Error, ...globals, module, exports: module.exports,
      require: (id: string) => imports[id] ?? {},
    })
    return module.exports
  }


function deferred() {
  let resolve!: () => void
  let reject!: (failure: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('a second operation is refused while one holds the repo, and the holder is visible at once', async () => {
  const first = deferred()
  const running = withRepoLock(lockPath('/lock-a'), 'push', () => first.promise)
  expect(repoLockHolder(lockPath('/lock-a'))).toBe('push')

  let secondStarted = false
  const refused = withRepoLock(lockPath('/lock-a'), 'pull-merge', async () => { secondStarted = true })
  await expect(refused).rejects.toBeInstanceOf(RepoBusyError)
  await expect(refused).rejects.toThrow('Another action is running in lock-a: Another Git action.')
  expect(secondStarted).toBe(false)

  first.resolve()
  await running
  expect(repoLockHolder(lockPath('/lock-a'))).toBeNull()
})

test('a failed operation releases the repo, so the next one runs', async () => {
  const failing = deferred()
  const first = withRepoLock(lockPath('/lock-b'), 'stash', () => failing.promise)
  failing.reject(new Error('index.lock exists'))
  await expect(first).rejects.toThrow('index.lock exists')
  expect(repoLockHolder(lockPath('/lock-b'))).toBeNull()

  expect(await withRepoLock(lockPath('/lock-b'), 'fetch', async () => 'ok')).toBe('ok')
})

test('a refusal names the running action in words, and the holder ID stays for logic', async () => {
  const hold = deferred()
  const first = withRepoLock(lockPath('/lock-d'), 'repo:push', () => hold.promise)
  const refused = withRepoLock(lockPath('/lock-d'), 'repo:stage', async () => undefined)

  await expect(refused).rejects.toThrow('Another action is running in lock-d: Pushing. Try again when it finishes.')
  expect(repoLockHolder(lockPath('/lock-d'))).toBe('repo:push')
  expect(describeOperation('background-fetch')).toBe('Fetching in the background')
  expect(new RepoBusyError(lockPath('/lock-resolution'), 'repo:conflict-save').message).toBe('Another action is running in lock-resolution: Saving resolution. Try again when it finishes.')
  expect(describeOperation('repo:conflict-reset')).toBe('Resetting resolution')
  expect(describeOperation('repo:unknown')).toBe('Another Git action')

  hold.resolve()
  await first
})

test('subscribers see each claim and release, and the snapshot reflects the holder', async () => {
  const seen: RepoLockSnapshot[] = []
  const off = subscribeRepoLocks((snapshot) => seen.push(snapshot))
  const hold = deferred()
  const running = withRepoLock(lockPath('/lock-e'), 'background-fetch', () => hold.promise)
  expect(repoLockSnapshot().holders[lockPath('/lock-e')]).toBe('background-fetch')

  hold.resolve()
  await running
  off()
  expect(seen.map((snapshot): string | null => snapshot.holders[lockPath('/lock-e')] ?? null)).toEqual(['background-fetch', null])
  expect(seen[1].seq).toBeGreaterThan(seen[0].seq)
  expect(repoLockSnapshot().holders[lockPath('/lock-e')]).toBeUndefined()
})

test('an operation in one repo does not hold another repo', async () => {
  const hold = deferred()
  const first = withRepoLock(lockPath('/lock-c/a'), 'fetch', () => hold.promise)
  expect(await withRepoLock(lockPath('/lock-c/b'), 'push', async () => 'pushed')).toBe('pushed')
  expect(repoLockHolder(lockPath('/lock-c/a'))).toBe('fetch')
  hold.resolve()
  await first
})

// Execute the real entry points with an in-memory Electron transport, without starting the app.
test('the IPC bridge publishes claims before work, releases failures, and cleans up both subscriptions', async () => {

  const handlers = new Map<string, (...args: any[]) => unknown>()
  const events = new EventEmitter()
  const app = Object.assign(new EventEmitter(), {
    setName: () => {},
    whenReady: () => new Promise<void>(() => {}),
  })
  let sent = 0
  const window = { webContents: { send: (channel: string, payload: unknown) => {
    sent++
    events.emit(channel, {}, payload)
  } } }
  await load('../src/main/index.ts', {
    electron: {
      app,
      ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
      BrowserWindow: { getAllWindows: () => [window] },
    },
    './repo-lock': locks,
    './git/dirty': { DirtyCounter: class {} },
    './watch': { SourceWatcher: class {} },
  }, '\nregisterIpc()')

  let api!: BetterGitApi
  await load('../src/preload/index.ts', {
    electron: {
      contextBridge: { exposeInMainWorld: (_name: string, value: BetterGitApi) => { api = value } },
      ipcRenderer: Object.assign(events, {
        invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
      }),
    },
  })
  const busy = await load('../src/renderer/src/repo-busy.ts', {}) as typeof import('../src/renderer/src/repo-busy')
  const errors: unknown[] = []
  const off = busy.connectRepoLocks({
    snapshot: () => api.repoLocks(),
    subscribe: (listener) => api.onEvent('repo:locks', (payload) => listener(payload as RepoLockSnapshot)),
  }, (failure) => errors.push(failure))
  const repo = lockPath('/bridge-background')
  const hold = deferred()
  const work = withRepoLock(repo, 'background-fetch', () => {
    expect(busy.busyKey(repo)).toBe('background-fetch')
    return hold.promise
  })
  // The initial empty reply lands after the claim event and must not clear it.
  await Promise.resolve()
  expect(busy.busyKey(repo)).toBe('background-fetch')
  expect(busy.blockedReason(busy.busyKey(repo))).toContain('Fetching')
  let staged = false
  expect(await busy.runRepoAction(repo, 'stage', async () => { staged = true }, () => {})).toBe(false)
  expect(staged).toBe(false)

  hold.reject(new Error('fetch failed'))
  await expect(work).rejects.toThrow('fetch failed')
  expect(busy.busyKey(repo)).toBeNull()
  expect(await busy.runRepoAction(repo, 'stage', async () => { staged = true }, () => {})).toBe(true)
  expect(staged).toBe(true)
  expect(errors).toEqual([])
  expect(busy.workingLabel('conflict-save')).toBe('Saving resolution…')
  expect(busy.workingLabel('conflict-reset')).toBe('Resetting resolution…')
  expect(await api.repoLocks()).toEqual(repoLockSnapshot())

  off()
  expect(events.listenerCount('repo:locks')).toBe(0)
  app.emit('will-quit')
  const before = sent
  await withRepoLock(repo, 'repo:stage', async () => {})
  expect(sent).toBe(before)
})


test('real repository and filesystem symlink claims exclude each other synchronously and release on failure', async () => {
  const repo = lockPath('alias-lock/repo')
  const alias = path.join(lockRoot, 'alias-lock/alias')
  symlinkSync(repo, alias, 'dir')
  for (const [first, second] of [[repo, alias], [alias, repo]]) {
    const hold = deferred()
    const running = withRepoLock(first, 'repo:conflict-save', (canonical) => {
      expect(canonical).toBe(repo)
      return hold.promise
    })
    expect(repoLockHolder(second)).toBe('repo:conflict-save')
    expect(repoLockSnapshot().holders[repo]).toBe('repo:conflict-save')
    expect(repoLockSnapshot().holders[alias]).toBeUndefined()
    let started = false
    const refused = withRepoLock(second, 'repo:stage', () => { started = true })
    expect(started).toBe(false)
    await expect(refused).rejects.toBeInstanceOf(RepoBusyError)
    hold.reject(new Error('resolution failed'))
    await expect(running).rejects.toThrow('resolution failed')
    expect(repoLockHolder(repo)).toBeNull()
    expect(repoLockHolder(alias)).toBeNull()
    expect(await withRepoLock(second, 'repo:stage', (canonical) => canonical)).toBe(repo)
  }
})

test('linked worktrees sharing a common Git directory keep separate working-root locks', async () => {
  const repo = lockPath('worktree-lock/main')
  git(repo, ['commit', '--allow-empty', '-qm', 'fixture'])
  const worktree = path.join(lockRoot, 'worktree-lock/linked')
  git(repo, ['worktree', 'add', '-q', '-b', 'linked', worktree])
  expect(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    .toBe(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const hold = deferred()
  const first = withRepoLock(repo, 'repo:stage', () => hold.promise)
  try {
    expect(await withRepoLock(worktree, 'repo:stage', (canonical) => canonical)).toBe(worktree)
    expect(repoLockHolder(repo)).toBe('repo:stage')
    expect(repoLockHolder(worktree)).toBeNull()
  } finally {
    hold.resolve()
    await first
  }
})

test('discovered aliases share foreground, conflict-save, background and renderer busy state without changing selection', async () => {
  const source = path.join(lockRoot, 'integration/source')
  const repo = lockPath('integration/source/repo')
  const alias = path.join(lockRoot, 'integration/selected-alias')
  symlinkSync(repo, alias, 'dir')
  const outside = lockPath('integration/outside')
  const escape = path.join(source, 'escape')
  symlinkSync(outside, escape, 'dir')
  const nonRepo = path.join(source, 'notes')
  mkdirSync(nonRepo)
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const events = new EventEmitter()
  const app = Object.assign(new EventEmitter(), {
    setName: () => {}, whenReady: () => new Promise<void>(() => {}),
  })
  let stageHold: ReturnType<typeof deferred> | null = null
  let resolutionHold: ReturnType<typeof deferred> | null = null
  let resetHold: ReturnType<typeof deferred> | null = null
  const written: string[] = []
  let branchHold: ReturnType<typeof deferred> | null = null
  const branchCalls: unknown[][] = []
  await load('../src/main/index.ts', {
    electron: {
      app, ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
      BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => events.emit(channel, {}, payload) } }] },
    },
    'node:path': path, 'node:fs': { statSync }, './repo-lock': locks, './scan': scan,
    './git/dirty': { DirtyCounter: class { request() {} } }, './watch': { SourceWatcher: class {} },
    './git/ops': {
      stagePaths: (canonical: string) => { written.push(canonical); return stageHold?.promise },
      createBranch: (...args: unknown[]) => { branchCalls.push(args); return branchHold?.promise },
      switchBranch: (...args: unknown[]) => { branchCalls.push(args); return branchHold?.promise },
    },
    './git/conflict': { saveConflict: (canonical: string) => { written.push(canonical); return resolutionHold?.promise },
      resetConflict: (canonical: string) => { written.push(canonical); return resetHold?.promise } },
    '../shared/conflict': conflict,
  }, '\nconfig = testConfig; registerIpc()', {
    testConfig: configModule.normalizeConfig({ sources: [source, alias], groups: [{ id: 'selected', name: 'Selected', repos: [alias] }] }),
  })
  let api!: BetterGitApi
  await load('../src/preload/index.ts', {
    electron: {
      contextBridge: { exposeInMainWorld: (_name: string, value: BetterGitApi) => { api = value } },
      ipcRenderer: Object.assign(events, { invoke: async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) }),
    },
  })
  const busy = await load('../src/renderer/src/repo-busy.ts', {}) as typeof import('../src/renderer/src/repo-busy')
  const errors: unknown[] = []
  const off = busy.connectRepoLocks({
    snapshot: () => api.repoLocks(),
    subscribe: (listener) => api.onEvent('repo:locks', (snapshot) => listener(snapshot as RepoLockSnapshot)),
  }, (failure) => errors.push(failure))
  const fetchHold = deferred()
  const fetchStarted = deferred()
  const fetched: string[] = []
  const { BackgroundFetcher } = await load('../src/main/background.ts', {
    electron: { powerMonitor: { getSystemIdleTime: () => 0 } }, './repo-lock': locks,
    './git/status': { readStatus: async () => ({ upstream: 'origin/main' }) },
    './git/ops': { fetchAll: (canonical: string) => { fetched.push(canonical); fetchStarted.resolve(); return fetchHold.promise } },
  }) as typeof import('../src/main/background')
  const background = new BackgroundFetcher({
    enabled: false, intervalMinutes: 10, idleThresholdSeconds: 60,
    repos: async () => [repo], onReport: () => {},
  })
  try {
    const tree = await api.getTree() as scan.TreeNode[]
    expect(tree.flatMap(scan.flattenRepos).map((node) => node.path).sort()).toEqual([repo, alias].sort())
    expect((await api.repoLocks()).identities?.[alias]).toBe(repo)
    expect((await api.getConfig()).groups[0].repos).toEqual([alias])
    expect((await api.getConfig()).sources).toEqual([source, alias])

    // Every registered Git-write route refuses an alias before running or parsing its arguments.
    const writeChannels = [
      'stage', 'unstage', 'commit-changes', 'switch', 'create-branch', 'fetch', 'pull', 'pull-from', 'reset-upstream',
      'checkout-detached', 'branch-from', 'tag-from', 'cherry-pick', 'revert', 'amend-message', 'push',
      'stash', 'stash-action', 'backup', 'restore', 'discard', 'conflict-save', 'conflict-reset',
    ]
    expect(writeChannels).toHaveLength(23)
    await withRepoLock(repo, 'repo:push', async () => {
      expect(busy.busyKey(alias)).toBe('push')
      for (const channel of writeChannels) {
        await expect(Promise.resolve(handlers.get(`repo:${channel}`)!({}, alias))).rejects.toBeInstanceOf(RepoBusyError)
      }
      for (const unknown of [outside, escape, nonRepo, path.join(source, '../outside')]) {
        await expect(api.stage(unknown, [])).rejects.toThrow('Not a repository in the sidebar')
      }
      expect(written).toEqual([])
    })

    stageHold = deferred()
    const stage = api.stage(alias, ['file.txt'])
    expect(repoLockHolder(repo)).toBe('repo:stage')
    expect(busy.busyKey(alias)).toBe('stage')
    expect(await background.runOnce()).toEqual({ fetched: [], skipped: [{ repo, reason: 'busy' }], failed: [] })
    expect(fetched).toEqual([])
    stageHold.reject(new Error('stage failed'))
    await expect(stage).rejects.toThrow('stage failed')
    expect(repoLockHolder(repo)).toBeNull()
    expect(busy.busyKey(alias)).toBeNull()

    const fetch = background.runOnce()
    await fetchStarted.promise
    expect(repoLockHolder(alias)).toBe('background-fetch')
    expect(busy.busyKey(alias)).toBe('background-fetch')
    expect(busy.blockedReason(busy.busyKey(alias))).toContain('Fetching')
    await expect(api.stage(alias, [])).rejects.toBeInstanceOf(RepoBusyError)
    fetchHold.reject(new Error('fetch failed'))
    expect(await fetch).toEqual({ fetched: [], skipped: [], failed: [{ repo, reason: 'fetch failed' }] })
    expect(busy.busyKey(alias)).toBeNull()
    expect(fetched).toEqual([repo])

    // A conflict-save also receives the canonical root and releases it on failure.
    resolutionHold = deferred()
    const resolution = handlers.get('repo:conflict-save')!({}, alias, 'file.txt', {
      fingerprint: { working: 'a'.repeat(64), stages: 'b'.repeat(64) }, choices: ['current'],
    }) as Promise<unknown>
    expect(repoLockHolder(repo)).toBe('repo:conflict-save')
    await expect(api.stage(repo, [])).rejects.toBeInstanceOf(RepoBusyError)
    resolutionHold.reject(new Error('save failed'))
    await expect(resolution).rejects.toThrow('save failed')
    expect(repoLockHolder(alias)).toBeNull()

    // A conflict-reset takes the same canonical lock, refuses a request with anything but the fingerprint, and releases on failure.
    const fingerprint = { working: 'a'.repeat(64), stages: 'b'.repeat(64) }
    await expect(Promise.resolve(handlers.get('repo:conflict-reset')!({}, alias, 'file.txt', { fingerprint, text: 'replacement' })))
      .rejects.toThrow('unexpected fields')
    expect(repoLockHolder(repo)).toBeNull()
    resetHold = deferred()
    const reset = handlers.get('repo:conflict-reset')!({}, alias, 'file.txt', { fingerprint }) as Promise<unknown>
    expect(repoLockHolder(repo)).toBe('repo:conflict-reset')
    expect(busy.busyKey(alias)).toBe('conflict-reset')
    await expect(api.stage(repo, [])).rejects.toBeInstanceOf(RepoBusyError)
    resetHold.reject(new Error('reset failed'))
    await expect(reset).rejects.toThrow('reset failed')
    expect(repoLockHolder(alias)).toBeNull()
    stageHold = null
    await api.stage(alias, [])
    expect(written).toEqual([repo, repo, repo, repo])

    const selection = { fullRef: 'refs/remotes/origin/topic', hash: 'a'.repeat(40) }
    branchHold = deferred()
    const creation = api.createBranch(alias, 'draft-branch', selection)
    expect(repoLockHolder(repo)).toBe('repo:create-branch')
    expect(busy.workingLabel(busy.busyKey(alias)!)).toBe('Creating branch…')
    expect(describeOperation('repo:create-branch')).toBe('Creating branch')
    await expect(api.switchBranch(repo, selection)).rejects.toBeInstanceOf(RepoBusyError)
    expect(branchCalls).toEqual([[repo, 'draft-branch', selection]])
    branchHold.reject(new Error('selected branch changed'))
    await expect(creation).rejects.toThrow('selected branch changed')
    expect(repoLockHolder(alias)).toBeNull()
    branchHold = deferred()
    const switching = api.switchBranch(alias, selection)
    expect(repoLockHolder(repo)).toBe('repo:switch')
    await expect(api.createBranch(repo, 'other', selection)).rejects.toBeInstanceOf(RepoBusyError)
    branchHold.resolve()
    await switching
    expect(branchCalls).toEqual([[repo, 'draft-branch', selection], [repo, selection]])
    expect(busy.busyKey(alias)).toBeNull()
    expect(errors).toEqual([])
  } finally {
    off()
    app.emit('will-quit')
    expect(events.listenerCount('repo:locks')).toBe(0)
  }
})
