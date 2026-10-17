import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

  test('unstaging a staged rename restores its original path literally and leaves other staged files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-rename-'))
    try {
      await git(dir, ['init', '-q'])
      await git(dir, ['config', 'user.email', 'test@example.com'])
      await git(dir, ['config', 'user.name', 'Test'])
      // The original name is also a glob matching a.txt, whose staged edit must stay staged.
      writeFileSync(path.join(dir, '[ab].txt'), 'renamed content\n')
      writeFileSync(path.join(dir, 'a.txt'), 'base\n')
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-qm', 'base'])
      writeFileSync(path.join(dir, 'a.txt'), 'staged edit\n')
      await git(dir, ['add', '--', 'a.txt'])
      await git(dir, ['mv', '[ab].txt', 'new.txt'])
      expect((await readStatus(dir)).changes).toContainEqual(expect.objectContaining({ path: 'new.txt', originalPath: '[ab].txt', kind: 'renamed', staged: true }))
      const mode = statSync(path.join(dir, 'new.txt')).mode
      await unstagePaths(dir, ['new.txt'], true)
      expect((await git(dir, ['diff', '--cached', '--name-status'])).trim()).toBe('M\ta.txt')
      expect(readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('renamed content\n')
      expect(statSync(path.join(dir, 'new.txt')).mode).toBe(mode)
      expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('staged edit\n')
    } finally {
      cleanup(dir)
    }
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

  test('new branch names with leftover upstream settings are refused without touching the settings', async () => {
    const { dir, base } = await fixture()
    for (const name of ['orphan-topic', 'topic']) {
      await git(dir, ['config', `branch.${name}.remote`, 'origin'])
      await git(dir, ['config', `branch.${name}.merge`, 'refs/heads/topic'])
    }
    await expect(createBranch(dir, 'orphan-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('upstream settings')
    await expect(branchFromCommit(dir, 'orphan-topic', base)).rejects.toThrow('upstream settings')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('upstream settings')
    expect((await readStatus(dir)).head).toBe('main')
    expect((await readBranches(dir)).some((entry) => !entry.remote && ['orphan-topic', 'topic'].includes(entry.name))).toBe(false)
    expect((await git(dir, ['config', '--get-regexp', '^branch\\.(orphan-topic|topic)\\.'])).trim().split('\n')).toEqual([
      'branch.orphan-topic.remote origin', 'branch.orphan-topic.merge refs/heads/topic',
      'branch.topic.remote origin', 'branch.topic.merge refs/heads/topic',
    ])
  })

  test('upstream settings that only apply once the new branch is checked out are refused before creating it', async () => {
    const { dir, base } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    const upstream = (name: string) => `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/topic\n`
    write('orphan.config', upstream('orphan-topic'))
    write('topic.config', '[includeIf "onbranch:topic"]\n\tpath = topic-mid.config\n')
    write('topic-mid.config', `[includeIf "gitdir:${gitDir}"]\n\tpath = topic-upstream.config\n`)
    write('topic-upstream.config', upstream('topic'))
    write('plain.config', '[core]\n\tabbrev = 12\n')
    await git(dir, ['config', 'includeIf.onbranch:orphan-*.path', 'orphan.config'])
    await git(dir, ['config', 'includeIf.onbranch:topic.path', 'topic.config'])
    await git(dir, ['config', 'includeIf.onbranch:plain.path', 'plain.config'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirty\n')
    await git(dir, ['add', 'file.txt'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirtier\n')
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(gitDir, 'config'), 'utf8'), readFileSync(path.join(dir, 'file.txt'), 'utf8'),
    ]
    const before = await snapshot()
    await expect(createBranch(dir, 'orphan-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('upstream settings')
    await expect(branchFromCommit(dir, 'orphan-topic', base)).rejects.toThrow('upstream settings')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('upstream settings')
    expect(await snapshot()).toEqual(before)
    await createBranch(dir, 'plain', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'plain', upstreamRef: null })
    // An onbranch include that cannot be read fails closed instead of counting as absent.
    write('broken.config', '[branch "broken\n')
    await git(dir, ['config', 'includeIf.onbranch:broken-*.path', 'broken.config'])
    await expect(createBranch(dir, 'broken-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('Could not read')
    expect((await readStatus(dir)).head).toBe('plain')
  })

  test('upstream settings behind a nested condition that needs the whole repository config are refused before creating it', async () => {
    const { dir, base } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    // hasconfig only sees the remote URLs in .git/config when Git reads the whole repository config.
    write('context.config', `[includeIf "hasconfig:remote.*.url:${dir}"]\n\tpath = context-upstream.config\n`)
    write('context-upstream.config', ['topic', 'context-topic'].map((name) => `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/topic\n`).join(''))
    await git(dir, ['config', 'includeIf.onbranch:*topic.path', 'context.config'])
    // Git ignores a missing include file, so it does not block other names.
    await git(dir, ['config', 'includeIf.gitdir:/nowhere/.path', 'missing.config'])
    // Git allows a remote URL alongside a hasconfig include when only plain include.path reaches it.
    write('plain-url.config', '[remote "plain"]\n\turl = https://plain.example.invalid/repo.git\n')
    await git(dir, ['config', 'include.path', 'plain-url.config'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirty\n')
    await git(dir, ['add', 'file.txt'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirtier\n')
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(dir, 'file.txt'), 'utf8'),
      ...['config', 'context.config', 'context-upstream.config'].map((file) => readFileSync(path.join(gitDir, file), 'utf8')),
    ]
    const before = await snapshot()
    await expect(createBranch(dir, 'context-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('upstream settings')
    await expect(branchFromCommit(dir, 'context-topic', base)).rejects.toThrow('upstream settings')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('upstream settings')
    expect(await snapshot()).toEqual(before)
    await createBranch(dir, 'context-free', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'context-free', upstreamRef: null })
    // Git exits 1 with only a warning for an include file it cannot open, which must not count as absent.
    write('locked.config', '')
    chmodSync(path.join(gitDir, 'locked.config'), 0o000)
    await git(dir, ['config', '--add', 'includeIf.gitdir:/nowhere/.path', 'locked.config'])
    await expect(createBranch(dir, 'locked', { fullRef: 'HEAD', hash: base })).rejects.toThrow('Could not read')
    expect((await readStatus(dir)).head).toBe('context-free')
  })

  test('include paths are read as Git opens them, through symlinked folders and literal names', async () => {
    const { dir, base } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const external = mkdtempSync(path.join(tmpdir(), 'bettergit-include-'))
    repos.push(external)
    mkdirSync(path.join(external, 'child'))
    symlinkSync(path.join(external, 'child'), path.join(gitDir, 'link'))
    const upstream = (name: string) => `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/topic\n`
    // The kernel follows link before applying .., so Git reads the external file, not .git/upstream.config.
    writeFileSync(path.join(external, 'upstream.config'), upstream('symlink-topic') + upstream('topic'))
    // Git does not apply :(optional) to include paths, so this names a file literally.
    writeFileSync(path.join(gitDir, ':(optional)literal.config'), upstream('literal-topic'))
    await git(dir, ['config', 'includeIf.onbranch:*topic.path', 'link/../upstream.config'])
    await git(dir, ['config', '--add', 'includeIf.onbranch:*topic.path', ':(optional)literal.config'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirty\n')
    await git(dir, ['add', 'file.txt'])
    writeFileSync(path.join(dir, 'file.txt'), 'dirtier\n')
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(dir, 'file.txt'), 'utf8'),
      ...[path.join(gitDir, 'config'), path.join(external, 'upstream.config'), path.join(gitDir, ':(optional)literal.config')]
        .map((file) => readFileSync(file, 'utf8')),
    ]
    const before = await snapshot()
    await expect(createBranch(dir, 'symlink-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('upstream settings')
    await expect(branchFromCommit(dir, 'symlink-topic', base)).rejects.toThrow('upstream settings')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('upstream settings')
    await expect(createBranch(dir, 'literal-topic', { fullRef: 'HEAD', hash: base })).rejects.toThrow('upstream settings')
    expect(await snapshot()).toEqual(before)
    await createBranch(dir, 'symlink-free', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'symlink-free', upstreamRef: null })
  })

  test('a remote URL behind a gitdir include for another repository does not block creation beside a hasconfig include', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    write('harmless.config', '[core]\n\tabbrev = 12\n')
    write('other-urls.config', '[remote "other"]\n\turl = https://other.example.invalid/repo.git\n')
    await git(dir, ['config', 'includeIf.hasconfig:remote.*.url:**.path', 'harmless.config'])
    await git(dir, ['config', `includeIf.gitdir:${dir}-other/.git.path`, 'other-urls.config'])
    await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
    await git(dir, ['switch', 'main'])
    await branchFromCommit(dir, 'from-commit', tip)
    expect(await sha(dir, 'refs/heads/from-commit')).toBe(tip)
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'topic', upstreamRef: 'refs/remotes/origin/topic' })
    // Git reads the config without error and applies the hasconfig include, but not the other repository's URL.
    expect((await git(dir, ['config', 'core.abbrev'])).trim()).toBe('12')
    expect(await git(dir, ['config', '--includes', '--list'])).not.toContain('other.example.invalid')
    // A gitdir include for this repository still counts once a hasconfig include applies after the switch.
    await git(dir, ['config', '--unset', 'includeIf.hasconfig:remote.*.url:**.path'])
    write('later.config', '[includeIf "hasconfig:remote.*.url:**"]\n\tpath = harmless.config\n')
    await git(dir, ['config', 'includeIf.onbranch:refused*.path', 'later.config'])
    await git(dir, ['config', `includeIf.gitdir:${gitDir}.path`, 'other-urls.config'])
    expect(await git(dir, ['config', '--includes', '--list'])).toContain('other.example.invalid')
    await expect(createBranch(dir, 'refused', { fullRef: 'HEAD', hash: base })).rejects.toThrow('Could not read')
    expect((await readBranches(dir)).some((entry) => entry.name === 'refused')).toBe(false)
    // Git itself writes that branch and then fails on its config.
    await git(dir, ['switch', '-q', '-c', 'refused-native'])
    await expect(git(dir, ['config', '--includes', '--list'])).rejects.toThrow('remote URLs cannot be configured')
  })

  test('a plain include of the same file does not make an inactive gitdir include count', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    write('harmless.config', '[core]\n\tabbrev = 12\n')
    write('urls.config', '[remote "extra"]\n\turl = https://extra.example.invalid/repo.git\n')
    await git(dir, ['config', 'includeIf.hasconfig:remote.*.url:**.path', 'harmless.config'])
    await git(dir, ['config', `includeIf.gitdir:${dir}-other/.git.path`, 'urls.config'])
    await git(dir, ['config', 'include.path', 'urls.config'])
    expect(await git(dir, ['config', '--includes', '--list'])).toContain('extra.example.invalid')
    await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
    await git(dir, ['switch', 'main'])
    await branchFromCommit(dir, 'from-commit', tip)
    expect(await sha(dir, 'refs/heads/from-commit')).toBe(tip)
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'topic', upstreamRef: 'refs/remotes/origin/topic' })
    expect((await git(dir, ['config', 'core.abbrev'])).trim()).toBe('12')
    expect(await git(dir, ['config', '--includes', '--list'])).toContain('extra.example.invalid')
  })

  test('an inactive gitdir include of its own file or of a file Git would fail on does not block creation', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    write('harmless.config', '[core]\n\tabbrev = 12\n')
    // Git never reads a file behind a gitdir include for another repository, even this config file itself.
    await git(dir, ['config', `includeIf.gitdir:${dir}-other/.git.path`, 'config'])
    await git(dir, ['config', 'remote.extra.url', 'https://extra.example.invalid/repo.git'])
    await git(dir, ['config', 'includeIf.hasconfig:remote.*.url:**.path', 'harmless.config'])
    expect(await git(dir, ['config', '--includes', '--list'])).toContain('extra.example.invalid')
    await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
    await git(dir, ['switch', 'main'])
    await branchFromCommit(dir, 'from-commit', tip)
    expect(await sha(dir, 'refs/heads/from-commit')).toBe(tip)
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'topic', upstreamRef: 'refs/remotes/origin/topic' })
    expect((await git(dir, ['config', 'core.abbrev'])).trim()).toBe('12')
    expect(await git(dir, ['config', '--includes', '--list'])).toContain('extra.example.invalid')
    // A valueless include in such a file is never read either.
    write('valueless.config', '[include]\n\tpath\n')
    await git(dir, ['config', `includeIf.gitdir:${dir}-elsewhere/.git.path`, 'valueless.config'])
    await git(dir, ['config', '--includes', '--list'])
    await branchFromCommit(dir, 'valueless-free', base)
    expect(await sha(dir, 'refs/heads/valueless-free')).toBe(base)
    // A self include that applies to this repository once the new branch is checked out makes Git fail, so it is refused.
    write('later.config', `[includeIf "gitdir:${gitDir}"]\n\tpath = later.config\n`)
    await git(dir, ['config', 'includeIf.onbranch:refused*.path', 'later.config'])
    await git(dir, ['update-ref', 'refs/remotes/origin/refused', tip])
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(gitDir, 'config'), 'utf8'),
    ]
    const before = await snapshot()
    await expect(createBranch(dir, 'refused', { fullRef: 'HEAD', hash: base })).rejects.toThrow('Could not read')
    await expect(branchFromCommit(dir, 'refused', base)).rejects.toThrow('Could not read')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/refused'))).rejects.toThrow('Could not read')
    expect(await snapshot()).toEqual(before)
    await git(dir, ['switch', '-q', '-c', 'refused-native'])
    await expect(git(dir, ['config', '--includes', '--list'])).rejects.toThrow('maximum include depth')
  })

  test('upstream settings behind a gitdir include for another repository do not block creation unless the file is also on an applying path', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const upstream = (name: string) => `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/unrelated\n`
    writeFileSync(path.join(gitDir, 'other-upstream.config'), ['independent', 'from-commit', 'topic', 'later-topic', 'mine'].map(upstream).join(''))
    await git(dir, ['config', `includeIf.gitdir:${dir}-other/.git.path`, 'other-upstream.config'])
    await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
    await git(dir, ['switch', 'main'])
    await branchFromCommit(dir, 'from-commit', tip)
    expect((await readBranches(dir)).find((entry) => entry.name === 'from-commit')).toMatchObject({ hash: tip, upstreamRef: null })
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'topic', upstreamRef: 'refs/remotes/origin/topic' })
    expect(await git(dir, ['config', '--get-all', 'branch.topic.merge'])).toBe('refs/heads/topic\n')
    // The same file still blocks a name once it is reached through a path that applies after the switch, or already does.
    await git(dir, ['config', 'includeIf.onbranch:later-*.path', 'other-upstream.config'])
    await git(dir, ['update-ref', 'refs/remotes/origin/later-topic', tip])
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(gitDir, 'config'), 'utf8'),
    ]
    const before = await snapshot()
    await expect(createBranch(dir, 'later-topic', { fullRef: 'HEAD', hash: tip })).rejects.toThrow('upstream settings')
    await expect(branchFromCommit(dir, 'later-topic', base)).rejects.toThrow('upstream settings')
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/later-topic'))).rejects.toThrow('upstream settings')
    expect(await snapshot()).toEqual(before)
    await git(dir, ['config', `includeIf.gitdir:${gitDir}.path`, 'other-upstream.config'])
    await expect(branchFromCommit(dir, 'mine', base)).rejects.toThrow('upstream settings')
    expect((await readBranches(dir)).some((entry) => entry.name === 'mine')).toBe(false)
  })

  test('tracking creation is refused before writing when the remote fetch mapping depends on an include that can change with the branch', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const write = (file: string, text: string) => writeFileSync(path.join(gitDir, file), text)
    // Another remote's settings in such an include do not block tracking through origin.
    write('other-remote.config', `[remote "other"]\n\turl = ${dir}\n\tfetch = +refs/heads/*:refs/remotes/other/*\n`)
    await git(dir, ['config', 'includeIf.onbranch:main.path', 'other-remote.config'])
    await switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'topic', upstreamRef: 'refs/remotes/origin/topic' })
    await git(dir, ['switch', 'main'])
    // Origin's mapping only applies while main is checked out.
    await git(dir, ['config', '--unset-all', 'remote.origin.fetch'])
    write('main-remote.config', '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
    await git(dir, ['config', '--add', 'includeIf.onbranch:main.path', 'main-remote.config'])
    await git(dir, ['update-ref', 'refs/remotes/origin/later', tip])
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(gitDir, 'config'), 'utf8'),
    ]
    const before = await snapshot()
    const later = await select(dir, 'refs/remotes/origin/later')
    await expect(switchBranch(dir, later)).rejects.toThrow('remote.origin.fetch')
    expect(await snapshot()).toEqual(before)
    // Git itself creates the branch, but its upstream stops resolving once main is no longer checked out.
    await git(dir, ['switch', '-q', '--no-guess', '--no-overwrite-ignore', '--track=direct', '-c', 'later', later.fullRef, '--'])
    await expect(git(dir, ['rev-parse', '--symbolic-full-name', 'later@{upstream}'])).rejects.toThrow('upstream')
    // Back on main the mapping applies again, so the existing tracker is reused, and creation without tracking still works.
    await git(dir, ['switch', 'main'])
    await switchBranch(dir, later)
    expect((await readStatus(dir)).head).toBe('later')
    await git(dir, ['switch', 'main'])
    await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
    await branchFromCommit(dir, 'from-commit', tip)
    expect((await readBranches(dir)).find((entry) => entry.name === 'from-commit')).toMatchObject({ hash: tip, upstreamRef: null })
  })

  const invalidIncludes: Record<string, Record<string, string>> = {
    // Each pass of this self-include grows its path until Git fails on an 11th nested include.
    loop: { 'loop.config': '[include]\n\tpath = ./loop.config\n' },
    // Git fails on an include with no value.
    valueless: { 'valueless.config': '[include]\n\tpath\n' },
    // Once a hasconfig include applies, Git fails on a remote URL in any file it reached through includeIf.
    'remote-url': {
      'remote-url.config': '[includeIf "hasconfig:remote.*.url:**"]\n\tpath = urls.config\n',
      'urls.config': '[remote "extra"]\n\turl = https://extra.example.invalid/repo.git\n',
    },
  }
  for (const [name, files] of Object.entries(invalidIncludes)) {
    test(`a ${name} include that Git would fail on after the switch is refused before writing the branch`, async () => {
      const { dir, base } = await fixture()
      const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
      const write = (file: string, content: string) => writeFileSync(path.join(gitDir, file), content)
      for (const [file, content] of Object.entries(files)) write(file, content)
      await git(dir, ['config', `includeIf.onbranch:${name}.path`, `${name}.config`])
      writeFileSync(path.join(dir, 'file.txt'), 'dirty\n')
      await git(dir, ['add', 'file.txt'])
      writeFileSync(path.join(dir, 'file.txt'), 'dirtier\n')
      const snapshot = async () => [
        await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
        await git(dir, ['status', '--porcelain=v2']), readFileSync(path.join(dir, 'file.txt'), 'utf8'),
        ...['config', ...Object.keys(files)].map((file) => readFileSync(path.join(gitDir, file), 'utf8')),
      ]
      const before = await snapshot()
      await expect(createBranch(dir, name, { fullRef: 'HEAD', hash: base })).rejects.toThrow('Could not read')
      await expect(branchFromCommit(dir, name, base)).rejects.toThrow('Could not read')
      await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/topic'))).rejects.toThrow('Could not read')
      expect(await snapshot()).toEqual(before)
      // Pointing the same include at a valid chain of exactly 10 nested includes, Git's limit, lets the same creation through.
      for (let level = 1; level < 10; level++) write(`deep${level}.config`, `[include]\n\tpath = deep${level + 1}.config\n`)
      write('deep10.config', '[core]\n\tabbrev = 12\n')
      await git(dir, ['config', `includeIf.onbranch:${name}.path`, 'deep1.config'])
      await createBranch(dir, name, { fullRef: 'HEAD', hash: base })
      expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name, upstreamRef: null })
      expect((await git(dir, ['config', 'core.abbrev'])).trim()).toBe('12')
    })
  }

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
