import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { git } from '../src/main/git/exec'
import { loadConflict, previewConflict, saveConflict } from '../src/main/git/conflict'
import { commitDiff, compare, detectMoves, workingDiff } from '../src/main/git/diff'
import { DirtyCounter } from '../src/main/git/dirty'
import { readHistory, fileHistory } from '../src/main/git/history'
import { readStatus } from '../src/main/git/status'
import { readBranches, switchBranch, createBranch, branchFromCommit, readStashes, createBackupRef, restoreBackup, stagePaths, unstagePaths, commit, readWorktrees } from '../src/main/git/ops'
import { DEFAULT_CONFIG, saveConfig } from '../src/main/config'
import { cleanup, freshSample } from './helpers'
import type { ConflictFingerprint } from '../src/shared/conflict'

let root: string
const repo = (...parts: string[]) => path.join(root, ...parts)

beforeAll(async () => {
  root = await freshSample()
})
afterAll(() => cleanup(root))

describe('status', () => {
  test('reports staged, unstaged, deleted, untracked, and paths with spaces', async () => {
    const status = await readStatus(repo('work/acme/web-app'))
    const summary = status.changes.map((change) => `${change.kind}:${change.staged ? 'S' : ''}${change.unstaged ? 'U' : ''}:${change.path}`)
    expect(summary).toContain('modified:S:src/app.ts')
    expect(summary).toContain('modified:U:src/app.ts')
    expect(summary).toContain('deleted:U:CHANGELOG.md')
    expect(summary).toContain('untracked:U:src/scratch.ts')
    expect(status.head).toBe('main')
  })

  test('reads ahead and behind counts against the upstream', async () => {
    const status = await readStatus(repo('work/acme/api-service'))
    expect(status.upstream).toBe('origin/main')
    expect([status.ahead, status.behind]).toEqual([2, 1])
  })

  test('marks merge conflicts and detached and unborn HEADs', async () => {
    const conflict = await readStatus(repo('work/acme/conflict-demo'))
    expect(conflict.changes.some((change) => change.conflicted && change.path === 'config.txt')).toBe(true)
    expect((await readStatus(repo('work/personal/detached-head'))).detached).toBe(true)
    const unborn = await readStatus(repo('work/personal/empty-repo'))
    expect(unborn.headHash).toBeNull()
  })
})

describe('history and diffs', () => {
  test('pages history and includes refs and merges', async () => {
    const first = await readHistory(repo('work/acme/web-app'), 0, 10)
    expect(first).toHaveLength(10)
    const merge = (await readHistory(repo('work/acme/web-app'), 0, 100)).find((commit) => commit.subject.startsWith('Merge branch'))
    expect(merge?.parents).toHaveLength(2)
    const second = await readHistory(repo('work/acme/web-app'), 10, 10)
    expect(second[0].hash).not.toBe(first[0].hash)
  })

  test('file history follows a rename', async () => {
    const commits = await fileHistory(repo('work/acme/web-app'), 'docs-readme.md')
    expect(commits.map((commit) => commit.subject)).toContain('docs: rename readme')
    expect(commits.map((commit) => commit.subject)).toContain('docs: fix typo in readme')
  })

  test('detects a block moved across files in one commit', async () => {
    const history = await readHistory(repo('work/acme/web-app'), 0, 5)
    const refactor = history.find((commit) => commit.subject === 'refactor: move formatTime into app')
    expect(refactor).toBeDefined()
    const moves = detectMoves(await commitDiff(repo('work/acme/web-app'), refactor!.hash))
    expect(moves.length).toBeGreaterThan(0)
    const [move] = moves
    const fromFile = move.from[0].file
    const toFile = move.to[0].file
    expect(fromFile).not.toBe(toFile)
  })

  test('detects an uncommitted move from app.ts to format.ts', async () => {
    const files = await workingDiff(repo('work/acme/web-app'), false)
    const moves = detectMoves(files)
    expect(moves.length).toBeGreaterThan(0)
  })

  test('commitDiff parses a root commit as additions only', async () => {
    const root0 = (await readHistory(repo('work/personal/detached-head'), 0, 10)).at(-1)!
    const files = await commitDiff(repo('work/personal/detached-head'), root0.hash)
    expect(files[0].status).toBe('added')
  })
})

describe('ignore whitespace', () => {
  let dir: string
  const names = (files: { newPath: string | null; oldPath: string | null }[]) => files.map((file) => file.newPath ?? file.oldPath)
  const sha = async (rev: string) => (await git(dir, ['rev-parse', rev])).trim()

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bettergit-ws-'))
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    const write = (name: string, text: string) => writeFileSync(path.join(dir, name), text)
    write('indent.ts', 'export const one = 1\nexport const two = 2\n')
    write('mixed.ts', 'export function run() {\n  return 1\n}\n')
    write('source.ts', 'export function a() {\n  return 1\n}\n\nexport function block() {\n  const x = compute(1)\n  const y = compute(2)\n  const z = compute(3)\n  return x + y + z\n}\n')
    write('target.ts', 'export const keep = true\n')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-qm', 'base'])
    // Whitespace-only reindent, a real edit beside a whitespace-only edit, and a block moved to another file with deeper indentation.
    write('indent.ts', '  export const one = 1\n  export const two = 2\n')
    write('mixed.ts', 'export function run(flag) {\n\treturn 1\n}\n')
    write('source.ts', 'export function a() {\n  return 1\n}\n')
    write('target.ts', 'export const keep = true\n\nexport function block() {\n    const x = compute(1)\n    const y = compute(2)\n    const z = compute(3)\n    return x + y + z\n}\n')
  })
  afterAll(() => cleanup(dir))

  test('working tree: whitespace-only files drop out, real lines stay with correct numbers, and moves still resolve', async () => {
    expect(names(await workingDiff(dir, false))).toEqual(['indent.ts', 'mixed.ts', 'source.ts', 'target.ts'])
    const on = await workingDiff(dir, false, 3, undefined, true)
    expect(names(on)).toEqual(['mixed.ts', 'source.ts', 'target.ts'])

    const mixed = on.find((file) => file.newPath === 'mixed.ts')!
    const lines = mixed.hunks.flatMap((hunk) => hunk.lines)
    expect(lines.filter((line) => line.type !== 'context').map((line) => `${line.type}:${line.text}`))
      .toEqual(['del:export function run() {', 'add:export function run(flag) {'])
    expect(lines.find((line) => line.text === '\treturn 1')).toMatchObject({ type: 'context', newNo: 2 })

    const moves = detectMoves(on)
    expect(moves).toHaveLength(1)
    const [move] = moves
    expect(on[move.from[0].file].newPath).toBe('source.ts')
    expect(on[move.to[0].file].newPath).toBe('target.ts')
    const fromLine = on[move.from[0].file].hunks[move.from[0].hunk].lines[move.from[0].line]
    expect(fromLine.text).toBe('export function block() {')
    expect(detectMoves(await workingDiff(dir, false))).toHaveLength(1)
  })

  test('staged: the same option hides a whitespace-only staged file', async () => {
    await git(dir, ['add', 'indent.ts'])
    expect(names(await workingDiff(dir, true))).toEqual(['indent.ts'])
    expect(await workingDiff(dir, true, 3, undefined, true)).toEqual([])
  })

  test('commit and compare apply the same option', async () => {
    await git(dir, ['commit', '-qm', 'real edits', '--', 'mixed.ts', 'source.ts', 'target.ts'])
    await git(dir, ['commit', '-qm', 'whitespace only', '--', 'indent.ts'])
    const real = await sha('HEAD~1')
    const whitespace = await sha('HEAD')
    expect(await commitDiff(dir, whitespace, 3, true)).toEqual([])
    expect(names(await commitDiff(dir, whitespace))).toEqual(['indent.ts'])
    expect(names(await commitDiff(dir, real, 3, true))).toEqual(['mixed.ts', 'source.ts', 'target.ts'])
    expect((await compare(dir, real, whitespace, true)).files).toEqual([])
    expect(names((await compare(dir, real, whitespace)).files)).toEqual(['indent.ts'])
  })
})

describe('operations', () => {
  test('stage, unstage, and commit a file', async () => {
    const dir = repo('work/personal/with-stash')
    writeFileSync(path.join(dir, 'new.ts'), 'export {}\n')
    await stagePaths(dir, ['new.ts'])
    expect((await readStatus(dir)).changes.some((change) => change.path === 'new.ts' && change.staged)).toBe(true)
    await unstagePaths(dir, ['new.ts'], true)
    expect((await readStatus(dir)).changes.some((change) => change.path === 'new.ts' && change.staged)).toBe(false)
    await stagePaths(dir, ['new.ts'])
    await commit(dir, 'feat: add new file\n\nBody text')
    expect((await readHistory(dir, 0, 1))[0].subject).toBe('feat: add new file')
  })

  test('lists branches with upstreams and stashes with messages', async () => {
    const branches = await readBranches(repo('work/acme/api-service'))
    expect(branches.find((branch) => branch.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main' })
    expect(branches.some((branch) => branch.name === 'origin/main' && branch.remote)).toBe(true)
    const stashes = await readStashes(repo('work/personal/with-stash'))
    expect(stashes.map((stash) => stash.message)).toEqual(expect.arrayContaining([expect.stringContaining('session draft'), expect.stringContaining('wip on login')]))
  })

  test('a backup ref restores HEAD after a history rewrite', async () => {
    const dir = repo('work/acme/api-service')
    const before = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const backup = await createBackupRef(dir, 'reset')
    await git(dir, ['reset', '-q', '--hard', 'HEAD~1'])
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).not.toBe(before)
    await restoreBackup(dir, backup)
    expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(before)
  })

  test('restoring a backup refuses to discard local edits', async () => {
    const dir = repo('work/acme/api-service')
    const backup = await createBackupRef(dir, 'guard')
    // Two commits back, so server.ts differs between HEAD and the backup and the edit would be overwritten.
    await git(dir, ['reset', '-q', '--hard', 'HEAD~2'])
    writeFileSync(path.join(dir, 'server.ts'), 'local edit\n')
    await expect(restoreBackup(dir, backup)).rejects.toThrow()
    expect(readFileSync(path.join(dir, 'server.ts'), 'utf8')).toBe('local edit\n')
  })

  test('lists linked worktrees', async () => {
    const worktrees = await readWorktrees(repo('work/acme/web-app'))
    expect(worktrees.map((entry) => entry.branch)).toEqual(expect.arrayContaining(['main', 'release/1.0']))
  })
})

describe('unmerged working marker safety', () => {
  let dir: string
  let indexRecords: string
  beforeAll(async () => {
    dir = repo('work/acme/conflict-demo')
    indexRecords = await git(dir, ['ls-files', '-u', '--', 'config.txt'])
    expect(indexRecords.trim().split('\n')).toHaveLength(3)
  })

  // Reuse the sample's real merge and restore its original stages so each regression is independent.
  const prepare = async () => {
    await git(dir, ['update-index', '--index-info'], { input: `0 ${'0'.repeat(40)}\tconfig.txt\n${indexRecords}` })
    writeFileSync(path.join(dir, '.gitattributes'), 'config.txt conflict-marker-size=7\n')
    await git(dir, ['checkout', '--conflict=merge', '--', 'config.txt'])
    const model = await loadConflict(dir, 'config.txt')
    if (!model.supported) throw new Error(model.message)
    return model.fingerprint
  }

  const assertRefused = async (fingerprint: ConflictFingerprint) => {
    const file = path.join(dir, 'config.txt')
    const before = readFileSync(file)
    const staging = await stagePaths(dir, ['config.txt']).then(() => null, (error: unknown) => error)
    expect(await git(dir, ['ls-files', '-u', '--', 'config.txt'])).toBe(indexRecords)
    expect(staging).toMatchObject({ message: expect.stringContaining('still has conflict markers') })
    expect(await loadConflict(dir, 'config.txt')).toMatchObject({ supported: false, message: expect.stringContaining('marker') })
    const save = { fingerprint: { ...fingerprint, working: createHash('sha256').update(before).digest('hex') }, choices: [] }
    await expect(previewConflict(dir, 'config.txt', save)).rejects.toThrow('marker')
    await expect(saveConflict(dir, 'config.txt', save)).rejects.toThrow('marker')
    expect(readFileSync(file)).toEqual(before)
    expect(await git(dir, ['ls-files', '-u', '--', 'config.txt'])).toBe(indexRecords)
  }

  test('orphan markers after deleting only the opening line cannot clear the unmerged index', async () => {
    const fingerprint = await prepare()
    const file = path.join(dir, 'config.txt')
    const marked = readFileSync(file, 'utf8')
    expect(marked).toContain('<<<<<<< ')
    writeFileSync(file, marked.replace(/^<<<<<<< .*\n/m, ''))
    await assertRefused(fingerprint)
  })

  test('unsupported marker bytes remain refused after the configured width changes back to seven', async () => {
    const fingerprint = await prepare()
    writeFileSync(path.join(dir, '.gitattributes'), 'config.txt conflict-marker-size=8\n')
    await git(dir, ['checkout', '--conflict=merge', '--', 'config.txt'])
    expect(readFileSync(path.join(dir, 'config.txt'), 'utf8')).toContain('<<<<<<<< ')
    writeFileSync(path.join(dir, '.gitattributes'), 'config.txt conflict-marker-size=7\n')
    await assertRefused(fingerprint)
  })

  test('a manual resolution containing ordinary Markdown separators can still be saved and staged', async () => {
    await prepare()
    const resolved = '﻿Title\r\n=======\r\n> quoted café 😀\r\nAnother title\r\n========\r\n'
    writeFileSync(path.join(dir, 'config.txt'), resolved)
    const model = await loadConflict(dir, 'config.txt')
    if (!model.supported) throw new Error(model.message)
    const save = { fingerprint: model.fingerprint, choices: [] }
    expect(await previewConflict(dir, 'config.txt', save)).toEqual({ text: resolved, unresolved: 0 })
    await saveConflict(dir, 'config.txt', save)
    expect(readFileSync(path.join(dir, 'config.txt'), 'utf8')).toBe(resolved)
    expect(await git(dir, ['ls-files', '-u', '--', 'config.txt'])).toBe(indexRecords)
    await stagePaths(dir, ['config.txt'])
    expect(await git(dir, ['ls-files', '-u', '--', 'config.txt'])).toBe('')
  })
})

describe('config saves', () => {
  test('overlapping saves all succeed, and the last one requested is on disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-config-'))
    try {
      const file = path.join(dir, 'config.json')
      const saves = Array.from({ length: 20 }, (_, i) => saveConfig(file, { ...DEFAULT_CONFIG, lastCloneDirectory: `/clone/${i}` }))
      await Promise.all(saves)
      expect(JSON.parse(readFileSync(file, 'utf8')).lastCloneDirectory).toBe('/clone/19')
    } finally {
      cleanup(dir)
    }
  })
})

describe('dirty counter', () => {
  test('counts every file in an untracked folder, and re-sends cached counts to a new window', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-dirty-'))
    try {
      await git(dir, ['init', '-q'])
      mkdirSync(path.join(dir, 'folder'))
      writeFileSync(path.join(dir, 'folder/a.txt'), 'a')
      writeFileSync(path.join(dir, 'folder/b.txt'), 'b')
      const counts: number[] = []
      const counter = new DirtyCounter((_path, count) => counts.push(count))
      counter.request([dir])
      while (counts.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(counts).toEqual([2])
      // A reloaded window asks again. The cached count is sent without running git.
      counter.request([dir])
      expect(counts).toEqual([2, 2])
    } finally {
      cleanup(dir)
    }
  })
})


describe('branch picker operations with real Git', () => {
  const repos: string[] = []
  afterAll(() => repos.forEach(cleanup))
  const sha = async (dir: string, ref = 'HEAD') => (await git(dir, ['rev-parse', ref])).trim()
  const select = async (dir: string, fullRef: string) => {
    const branch = (await readBranches(dir)).find((entry) => entry.fullRef === fullRef)
    expect(branch).toBeDefined()
    return { fullRef, hash: branch!.hash }
  }
  const fixture = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-branches-'))
    repos.push(dir)
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['config', 'user.name', 'Branch Test'])
    await git(dir, ['config', 'user.email', 'branch@example.com'])
    writeFileSync(path.join(dir, 'file.txt'), 'base\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-qm', 'base'])
    const base = await sha(dir)
    await git(dir, ['switch', '-q', '-c', 'local-base'])
    writeFileSync(path.join(dir, 'file.txt'), 'topic\n')
    writeFileSync(path.join(dir, 'new.txt'), 'tracked on topic\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-qm', 'topic'])
    const tip = await sha(dir)
    await git(dir, ['switch', '-q', 'main'])
    await git(dir, ['remote', 'add', 'origin', dir])
    await git(dir, ['update-ref', 'refs/remotes/origin/topic', tip])
    return { dir, base, tip }
  }

  test('keeps full identities and upstreams, skips symbolic remote aliases and keeps literal /HEAD names', async () => {
    const { dir, tip } = await fixture()
    await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic'])
    await git(dir, ['update-ref', 'refs/remotes/origin/review/HEAD', tip])
    await git(dir, ['branch', 'review/HEAD'])
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    const branches = await readBranches(dir)
    expect(branches.find((entry) => entry.current)).toMatchObject({ name: 'topic', fullRef: 'refs/heads/topic', upstreamRef: 'refs/remotes/origin/topic' })
    expect(branches.some((entry) => entry.fullRef === 'refs/remotes/origin/HEAD')).toBe(false)
    expect(branches.filter((entry) => entry.name.endsWith('/HEAD'))).toHaveLength(2)
  })

  test('creates tracking branches, then reuses a renamed ahead tracker without changing its tip or config', async () => {
    const { dir, tip } = await fixture()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await switchBranch(dir, remote)
    expect(await sha(dir)).toBe(tip)
    expect((await git(dir, ['config', 'branch.topic.remote'])).trim()).toBe('origin')
    await git(dir, ['branch', '-m', 'my-topic'])
    await git(dir, ['commit', '--allow-empty', '-qm', 'local only'])
    const ahead = await sha(dir)
    const config = await git(dir, ['config', '--get-regexp', '^branch\\.my-topic\\.'])
    await git(dir, ['switch', 'main'])
    await switchBranch(dir, remote)
    expect((await readStatus(dir)).head).toBe('my-topic')
    expect(await sha(dir)).toBe(ahead)
    expect(await git(dir, ['config', '--get-regexp', '^branch\\.my-topic\\.'])).toBe(config)
  })

  test('refuses multiple trackers and names the local choices', async () => {
    const { dir } = await fixture()
    await git(dir, ['branch', '--track=direct', 'one', 'refs/remotes/origin/topic'])
    await git(dir, ['branch', '--track=direct', 'two', 'refs/remotes/origin/topic'])
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('one, two')
    expect((await readStatus(dir)).head).toBe('main')
  })

  test('refuses existing names and ref-directory collisions without changing upstreams', async () => {
    const { dir, base } = await fixture()
    await git(dir, ['branch', 'topic'])
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await expect(switchBranch(dir, remote)).rejects.toThrow('Branch already exists')
    await expect(createBranch(dir, 'topic', remote)).rejects.toThrow('Branch already exists')
    await expect(createBranch(dir, 'topic/child', remote)).rejects.toThrow('name conflicts')
    expect(await sha(dir, 'refs/heads/topic')).toBe(base)
    expect((await readBranches(dir)).find((entry) => entry.name === 'topic')!.upstreamRef).toBeNull()
    await git(dir, ['branch', 'nested/child'])
    await expect(createBranch(dir, 'nested', remote)).rejects.toThrow('name conflicts')
  })

  test('two remotes with the same suffix stay explicit and a local collision never retargets tracking', async () => {
    const { dir, base, tip } = await fixture()
    await git(dir, ['remote', 'add', 'upstream', dir])
    await git(dir, ['update-ref', 'refs/remotes/upstream/topic', base])
    const origin = await select(dir, 'refs/remotes/origin/topic')
    const upstream = await select(dir, 'refs/remotes/upstream/topic')
    await switchBranch(dir, origin)
    expect(await sha(dir)).toBe(tip)
    await git(dir, ['switch', 'main'])
    await expect(switchBranch(dir, upstream)).rejects.toThrow('Branch already exists')
    await git(dir, ['branch', '-m', 'topic', 'origin-topic'])
    await switchBranch(dir, upstream)
    expect(await sha(dir)).toBe(base)
    expect((await readBranches(dir)).find((entry) => entry.current)!.upstreamRef).toBe(upstream.fullRef)
  })

  test('rejects ambiguous remote mappings before creating or attaching any branch', async () => {
    const { dir } = await fixture()
    await git(dir, ['remote', 'add', 'alias', dir])
    await git(dir, ['config', 'remote.alias.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('Ambiguous or unsupported')
    expect((await readBranches(dir)).some((entry) => entry.fullRef === 'refs/heads/topic')).toBe(false)
  })

  test('rejects literal invalid names including previous-checkout expansion at both creation boundaries', async () => {
    const { dir, base } = await fixture()
    const start = await select(dir, 'refs/heads/main')
    for (const name of ['@{-1}', '@', '-', '--force', 'topic~1', 'main...local-base', 'HEAD', 'bad name']) {
      await expect(createBranch(dir, name, start)).rejects.toThrow('Invalid branch name')
      await expect(branchFromCommit(dir, name, base)).rejects.toThrow('Invalid branch name')
    }
    await branchFromCommit(dir, 'commit-action', base)
    expect((await readStatus(dir)).head).toBe('main')
  })

  test('independent creation from local, remote and current HEAD bases never configures an upstream', async () => {
    const { dir, base, tip } = await fixture()
    await git(dir, ['config', 'branch.autoSetupMerge', 'always'])
    const choices = [
      ['from-local', await select(dir, 'refs/heads/local-base'), tip],
      ['from-remote', await select(dir, 'refs/remotes/origin/topic'), tip],
      ['from-current', { fullRef: 'HEAD', hash: base }, base],
    ] as const
    for (const [name, start, expected] of choices) {
      await git(dir, ['switch', 'main'])
      await createBranch(dir, name, start)
      expect(await sha(dir)).toBe(expected)
      expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name, upstreamRef: null })
    }
  })

  test('refuses moved or disappeared selected refs, changed HEAD and revision expressions', async () => {
    const { dir, base } = await fixture()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await git(dir, ['update-ref', remote.fullRef, base])
    await expect(switchBranch(dir, remote)).rejects.toThrow('disappeared or changed')
    await expect(createBranch(dir, 'stale', remote)).rejects.toThrow('disappeared or changed')
    const current = { fullRef: 'HEAD', hash: base }
    await git(dir, ['switch', 'local-base'])
    await expect(createBranch(dir, 'stale-head', current)).rejects.toThrow('HEAD changed')
    await git(dir, ['update-ref', '-d', remote.fullRef])
    await expect(switchBranch(dir, remote)).rejects.toThrow('disappeared or changed')
    await expect(switchBranch(dir, { fullRef: 'HEAD~1', hash: base })).rejects.toThrow('disappeared or changed')
  })

  test('preserves staged, unstaged and untracked work on checkout refusal without leaving a new branch', async () => {
    for (const dirty of ['staged', 'unstaged', 'untracked']) {
      const { dir, base } = await fixture()
      const file = dirty === 'untracked' ? 'new.txt' : 'file.txt'
      writeFileSync(path.join(dir, file), 'precious draft\n')
      if (dirty === 'staged') await git(dir, ['add', file])
      const before = await git(dir, ['status', '--porcelain=v1'])
      const remote = await select(dir, 'refs/remotes/origin/topic')
      await expect(createBranch(dir, 'new-branch', remote)).rejects.toThrow(/overwritten/)
      await expect(switchBranch(dir, remote)).rejects.toThrow(/overwritten/)
      expect(await git(dir, ['status', '--porcelain=v1'])).toBe(before)
      expect(readFileSync(path.join(dir, file), 'utf8')).toBe('precious draft\n')
      expect(await sha(dir)).toBe(base)
      expect((await readBranches(dir)).some((entry) => ['new-branch', 'topic'].includes(entry.name))).toBe(false)
    }
  })

  for (const checkout of ['local', 'tracking', 'create'] as const) {
    test(`ignored files survive ${checkout} checkout refusal without changing HEAD, status, index or refs`, async () => {
      const { dir } = await fixture()
      await git(dir, ['switch', 'local-base'])
      writeFileSync(path.join(dir, '.env'), 'FIXTURE_MODE=tracked-destination\n')
      await git(dir, ['add', '.env'])
      await git(dir, ['commit', '-qm', 'track dummy fixture configuration'])
      const destination = await sha(dir)
      await git(dir, ['update-ref', 'refs/remotes/origin/topic', destination])
      await git(dir, ['switch', 'main'])
      const exclude = path.join(dir, '.git/info/exclude')
      writeFileSync(exclude, readFileSync(exclude, 'utf8') + '\n.env\n')
      const ignored = path.join(dir, '.env')
      writeFileSync(ignored, 'FIXTURE_MODE=ignored-local\n')
      writeFileSync(path.join(dir, 'staged.txt'), 'unrelated staged fixture content\n')
      await git(dir, ['add', 'staged.txt'])
      expect((await git(dir, ['check-ignore', '.env'])).trim()).toBe('.env')
      const status = await git(dir, ['status', '--porcelain=v1'])
      expect(status).toContain('A  staged.txt')
      const head = await sha(dir)
      const branches = await readBranches(dir)
      const index = path.join(dir, '.git/index')
      const indexBytes = readFileSync(index)
      const ignoredBytes = readFileSync(ignored)
      const selection = await select(dir, checkout === 'local' ? 'refs/heads/local-base' : 'refs/remotes/origin/topic')
      const action = () => checkout === 'create'
        ? createBranch(dir, 'ignored-copy', selection)
        : switchBranch(dir, selection)
      await expect(action()).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('.env'), message: expect.stringContaining('would be overwritten'),
      })
      expect(readFileSync(ignored)).toEqual(ignoredBytes)
      expect(readFileSync(index)).toEqual(indexBytes)
      expect(await sha(dir)).toBe(head)
      expect(await git(dir, ['status', '--porcelain=v1'])).toBe(status)
      expect(await readBranches(dir)).toEqual(branches)

      // Removing only the dummy ignored collision lets the same checkout proceed with the staged work intact.
      unlinkSync(ignored)
      await action()
      expect(await sha(dir)).toBe(destination)
      expect(readFileSync(ignored, 'utf8')).toBe('FIXTURE_MODE=tracked-destination\n')
      expect(await git(dir, ['status', '--porcelain=v1'])).toBe(status)
      expect((await readBranches(dir)).find((branch) => branch.current)).toMatchObject({
        name: checkout === 'local' ? 'local-base' : checkout === 'tracking' ? 'topic' : 'ignored-copy',
        upstreamRef: checkout === 'tracking' ? 'refs/remotes/origin/topic' : null,
      })
    })
  }

  test('safe dirty switching succeeds and a branch checked out elsewhere retains Git refusal', async () => {
    const { dir } = await fixture()
    writeFileSync(path.join(dir, 'unrelated.txt'), 'keep\n')
    await switchBranch(dir, await select(dir, 'refs/heads/local-base'))
    expect(readFileSync(path.join(dir, 'unrelated.txt'), 'utf8')).toBe('keep\n')
    await git(dir, ['switch', 'main'])
    const linked = path.join(dir, 'linked')
    await git(dir, ['worktree', 'add', '-q', linked, 'local-base'])
    await expect(switchBranch(dir, await select(dir, 'refs/heads/local-base'))).rejects.toThrow(/already (used|checked out)/)
    expect((await readStatus(dir)).head).toBe('main')
  })
  test('an unborn current base refuses creation but an explicit fetched base works', async () => {
    const { dir: source, tip } = await fixture()
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-unborn-'))
    repos.push(dir)
    await git(dir, ['init', '-q', '-b', 'unborn'])
    await git(dir, ['remote', 'add', 'origin', source])
    await git(dir, ['fetch', '-q', 'origin', 'refs/heads/local-base:refs/remotes/origin/topic'])
    await expect(createBranch(dir, 'no-commit', { fullRef: 'HEAD', hash: '0'.repeat(40) })).rejects.toThrow('Create a commit first')
    await createBranch(dir, 'from-fetched', await select(dir, 'refs/remotes/origin/topic'))
    expect(await sha(dir)).toBe(tip)
    expect((await readBranches(dir)).find((entry) => entry.current)!.upstreamRef).toBeNull()
  })

  test('external index locks are retained and a failed branch write releases the application lock', async () => {
    const { withRepoLock, repoLockHolder } = await import('../src/main/repo-lock')
    const { dir } = await fixture()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    const lock = path.join(dir, '.git/index.lock')
    writeFileSync(lock, 'external lock owner')
    await expect(withRepoLock(dir, 'repo:create-branch', () => createBranch(dir, 'after-lock', remote))).rejects.toThrow('index.lock')
    expect(repoLockHolder(dir)).toBeNull()
    expect(readFileSync(lock, 'utf8')).toBe('external lock owner')
    expect((await readBranches(dir)).some((entry) => entry.name === 'after-lock')).toBe(false)
    unlinkSync(lock)
    await withRepoLock(dir, 'repo:create-branch', () => createBranch(dir, 'after-lock', remote))
    expect((await readStatus(dir)).head).toBe('after-lock')
  })

})
