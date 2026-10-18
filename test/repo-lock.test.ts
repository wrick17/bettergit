import { afterAll, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { cleanup } from './helpers'
import { git } from '../scripts/create-sample-workspace'
import * as locks from '../src/main/repo-lock'
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

test('a throwing subscriber neither leaks the holder, changes the result, nor starves other subscribers', async () => {
  // A plain folder is enough: the lock only resolves the path.
  const repo = path.join(lockRoot, 'lock-throwing-subscriber')
  mkdirSync(repo, { recursive: true })
  const quiet = spyOn(console, 'error').mockImplementation(() => {})
  const offBroken = subscribeRepoLocks(() => { throw new Error('snapshot transport failed') })
  const seen: (string | null)[] = []
  const off = subscribeRepoLocks((snapshot) => seen.push(snapshot.holders[repo] ?? null))
  try {
    expect(await withRepoLock(repo, 'repo:stage', async () => 'staged')).toBe('staged')
    await expect(withRepoLock(repo, 'repo:commit-changes', async () => { throw new Error('nothing to commit') }))
      .rejects.toThrow('nothing to commit')
  } finally {
    offBroken()
    off()
    quiet.mockRestore()
  }
  expect(seen).toEqual(['repo:stage', null, 'repo:commit-changes', null])
  expect(repoLockHolder(repo)).toBeNull()
  expect(await withRepoLock(repo, 'repo:push', async () => 'pushed')).toBe('pushed')
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
