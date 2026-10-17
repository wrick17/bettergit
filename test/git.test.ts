import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { git } from '../src/main/git/exec'
import { loadConflict, previewConflict, saveConflict } from '../src/main/git/conflict'
import { commitDiff, detectMoves, workingDiff } from '../src/main/git/diff'
import { DirtyCounter } from '../src/main/git/dirty'
import { readHistory, fileHistory } from '../src/main/git/history'
import { readStatus } from '../src/main/git/status'
import { readBranches, readStashes, createBackupRef, restoreBackup, stagePaths, unstagePaths, commit, readWorktrees } from '../src/main/git/ops'
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
