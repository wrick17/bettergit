import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { cleanup } from './helpers'
import { git } from '../scripts/create-sample-workspace'
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

test('an operation in one repo does not hold another repo', async () => {
  const hold = deferred()
  const first = withRepoLock(lockPath('/lock-c/a'), 'fetch', () => hold.promise)
  expect(await withRepoLock(lockPath('/lock-c/b'), 'push', async () => 'pushed')).toBe('pushed')
  expect(repoLockHolder(lockPath('/lock-c/a'))).toBe('fetch')
  hold.resolve()
  await first
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
