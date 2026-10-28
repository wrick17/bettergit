import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { IconButton } from '../src/renderer/src/Icons'
import {
  applyRepoLockSnapshot, blockedReason, busyKey, connectRepoLocks, describeFailure, REPO_WORKING_LABELS, runRepoAction, runRepoWrite,
  subscribeRepoBusy, workingLabel, type RepoLockSnapshot,
} from '../src/renderer/src/repo-busy'

// Snapshots from main carry a rising sequence number. Each test takes fresh numbers, since the store keeps the newest.
let sequence = 0
const seq = () => ++sequence

// A write that stays in flight until the test settles it.
function deferred() {
  let resolve!: () => void
  let reject!: (failure: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const noop = () => undefined

test('a second write to the same repo does not start while one is in flight', async () => {
  const first = deferred()
  const seen: Array<string | null> = []
  const off = subscribeRepoBusy(() => seen.push(busyKey('/repo-a')))
  const pull = runRepoAction('/repo-a', 'pull-merge', () => first.promise, noop)

  let secondStarted = false
  const second = await runRepoAction('/repo-a', 'push', async () => { secondStarted = true }, noop)
  expect(second).toBe(false)
  expect(secondStarted).toBe(false)
  expect(busyKey('/repo-a')).toBe('pull-merge')

  first.resolve()
  expect(await pull).toBe(true)
  off()
  expect(seen).toEqual(['pull-merge', null])
  expect(busyKey('/repo-a')).toBeNull()
})

test('a failed write reports its error once, unlocks the repo, and the next write runs', async () => {
  const first = deferred()
  const errors: unknown[] = []
  const push = runRepoAction('/repo-b', 'push', () => first.promise, (failure) => errors.push(failure))

  first.reject(new Error("Error invoking remote method 'repo:push': Error: rejected by remote"))
  expect(await push).toBe(false)
  expect(errors).toHaveLength(1)
  // The error names the action and repo for the notification hub, and keeps the bare reason for inline messages.
  expect(errors[0]).toMatchObject({ action: 'Pushing in repo-b', repo: '/repo-b', message: 'rejected by remote' })
  expect(busyKey('/repo-b')).toBeNull()

  expect(await runRepoAction('/repo-b', 'fetch', async () => undefined, noop)).toBe(true)
  expect(busyKey('/repo-b')).toBeNull()
})

test('a write in one repo does not block a write in another repo', async () => {
  const hold = deferred()
  const first = runRepoAction('/repo-c/a', 'fetch', () => hold.promise, noop)

  expect(await runRepoAction('/repo-c/b', 'push', async () => undefined, noop)).toBe(true)
  expect(busyKey('/repo-c/a')).toBe('fetch')

  hold.resolve()
  expect(await first).toBe(true)
})

test('a reload runs only after a successful write, and a failed reload is reported without failing the write', async () => {
  const errors: string[] = []
  let reloads = 0
  const onError = (failure: unknown) => errors.push((failure as Error).message)

  expect(await runRepoWrite('/repo-e', 'push', async () => { throw new Error('rejected') }, { onError, reload: () => { reloads++ } })).toBe(false)
  expect(reloads).toBe(0)

  expect(await runRepoWrite('/repo-e', 'push', async () => undefined, {
    onError,
    reload: () => { throw new Error('status failed') },
  })).toBe(true)
  expect(errors).toEqual(['rejected', 'status failed'])
})

test('a busy key names its operation, and a blocked control says what is running', () => {
  expect(workingLabel('discard:/src/a.ts')).toBe('Discarding…')
  expect(blockedReason(null)).toBeUndefined()
  expect(blockedReason('push')).toBe('Another action is running: Pushing…')
})

test('a write main reports blocks the repo before click, with a friendly reason', async () => {
  applyRepoLockSnapshot({ seq: seq(), holders: { '/remote-a': 'background-fetch' } })
  expect(busyKey('/remote-a')).toBe('background-fetch')
  expect(blockedReason('background-fetch')).toBe('Another action is running: Fetching…')

  let started = false
  expect(await runRepoAction('/remote-a', 'stage', async () => { started = true }, noop)).toBe(false)
  expect(started).toBe(false)
})

test('a local write keeps its repo busy after main reports the repo free', async () => {
  const hold = deferred()
  const local = runRepoAction('/remote-b', 'push', () => hold.promise, noop)
  applyRepoLockSnapshot({ seq: seq(), holders: {} })
  expect(busyKey('/remote-b')).toBe('push')

  hold.resolve()
  expect(await local).toBe(true)
  expect(busyKey('/remote-b')).toBeNull()
})

test('an older snapshot does not overwrite a newer one', () => {
  const older = seq()
  const newer = seq()
  applyRepoLockSnapshot({ seq: newer, holders: { '/remote-c': 'repo:push' } })
  applyRepoLockSnapshot({ seq: older, holders: {} })
  expect(busyKey('/remote-c')).toBe('push')
})

test('an event that lands before the first read is not undone by that read', async () => {
  const readSeq = seq()
  const eventSeq = seq()
  let listener!: (snapshot: RepoLockSnapshot) => void
  let answerRead!: (snapshot: RepoLockSnapshot) => void
  let unsubscribed = false
  const off = connectRepoLocks({
    subscribe: (next) => { listener = next; return () => { unsubscribed = true } },
    snapshot: () => new Promise((resolve) => { answerRead = resolve }),
  }, noop)

  listener({ seq: eventSeq, holders: { '/remote-d': 'repo:stage' } })
  answerRead({ seq: readSeq, holders: {} })
  await Promise.resolve()
  expect(busyKey('/remote-d')).toBe('stage')

  off()
  expect(unsubscribed).toBe(true)
})

test('every repo action key has a working label that ends in an ellipsis', () => {
  for (const key of ['fetch', 'pull-merge', 'pull-rebase', 'pull', 'push', 'switch', 'reset', 'stash', 'pop', 'apply', 'delete', 'delete-untracked']) {
    expect(REPO_WORKING_LABELS[key]).toMatch(/…$/)
  }
})

test('a busy IconButton keeps its label, sets aria-busy, and swaps in the spinner', () => {
  const busy = renderToStaticMarkup(createElement(IconButton, { icon: 'push', label: 'Pushing…', busy: true, onClick: noop }))
  expect(busy).toContain('aria-label="Pushing…"')
  expect(busy).toContain('aria-busy="true"')
  expect(busy).toContain('action-spin')

  const idle = renderToStaticMarkup(createElement(IconButton, { icon: 'push', label: 'Push', onClick: noop }))
  expect(idle).not.toContain('aria-busy')
  expect(idle).not.toContain('action-spin')
})


test('an alias displays canonical background busy state and ignores an older identity map', async () => {
  const older = seq()
  applyRepoLockSnapshot({
    seq: seq(), holders: { '/canonical-alias-a': 'background-fetch' },
    identities: { '/selected-alias-a': '/canonical-alias-a' },
  })
  applyRepoLockSnapshot({ seq: older, holders: {}, identities: {} })
  expect(busyKey('/selected-alias-a')).toBe('background-fetch')
  expect(blockedReason(busyKey('/selected-alias-a'))).toBe('Another action is running: Fetching…')
  let started = false
  expect(await runRepoAction('/selected-alias-a', 'stage', async () => { started = true }, noop)).toBe(false)
  expect(started).toBe(false)
  applyRepoLockSnapshot({ seq: seq(), holders: {}, identities: { '/selected-alias-a': '/canonical-alias-a' } })
  expect(busyKey('/selected-alias-a')).toBeNull()
})

test('local alias claims take precedence across aliases until their own cleanup after a main release', async () => {
  const identities = { '/selected-alias-b': '/canonical-alias-b', '/other-alias-b': '/canonical-alias-b' }
  applyRepoLockSnapshot({ seq: seq(), holders: {}, identities })
  const hold = deferred()
  const errors: unknown[] = []
  const local = runRepoAction('/selected-alias-b', 'pull-rebase', () => hold.promise, (error) => errors.push(error))
  applyRepoLockSnapshot({ seq: seq(), holders: { '/canonical-alias-b': 'repo:pull' }, identities })
  expect(busyKey('/canonical-alias-b')).toBe('pull-rebase')
  expect(busyKey('/other-alias-b')).toBe('pull-rebase')
  expect(await runRepoAction('/canonical-alias-b', 'push', async () => {}, noop)).toBe(false)
  applyRepoLockSnapshot({ seq: seq(), holders: {}, identities })
  expect(busyKey('/other-alias-b')).toBe('pull-rebase')
  hold.reject(new Error('pull failed'))
  expect(await local).toBe(false)
  expect(errors).toHaveLength(1)
  for (const repo of ['/selected-alias-b', '/canonical-alias-b', '/other-alias-b']) expect(busyKey(repo)).toBeNull()
})

// Git's raw text, as fetch and pull fail with it, reads as a plain summary. Only what the text shows is claimed, and an
// unknown failure keeps its own first line.
test('Git failures are summarised by what their text shows', () => {
  const summary = (reason: string) => describeFailure(reason).summary
  expect(summary('ERROR: Repository not found.\nfatal: Could not read from remote repository.')).toBe('The remote repository was not found, or this account cannot access it.')
  expect(summary("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).toBe('The remote repository was not found, or this account cannot access it.')
  expect(summary('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('The remote refused this SSH key.')
  expect(summary('Host key verification failed.\nfatal: Could not read from remote repository.')).toBe("The remote's SSH host key is not trusted on this Mac.")
  expect(summary("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('The remote did not accept your credentials.')
  expect(summary("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe('Could not reach the remote.')
  expect(summary('git fetch timed out after 120 seconds without progress. Check your connection and Git credentials, then try again.')).toBe('Could not reach the remote.')
  expect(summary("fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.")).toBe("This repository's remote is not set up correctly.")
  expect(summary('kex_exchange_identification: read: Connection reset by peer\nfatal: Could not read from remote repository.')).toBe('Could not reach the remote.')
  expect(summary('fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights')).toBe('Could not read from the remote repository.')
  expect(summary('fatal: Not possible to fast-forward, aborting.\nhint: Diverging branches')).toBe('Not possible to fast-forward, aborting.')
  expect(describeFailure('main has no upstream branch to pull from.')).toEqual({ summary: 'main has no upstream branch to pull from.' })
})
