import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { git, gitRaw } from '../src/main/git/exec'
import { applyHunk, parseHunk, type HunkRequest } from '../src/main/git/hunks'
import { loadConflict, previewConflict, saveConflict } from '../src/main/git/conflict'
import { commitDiff, compare, detectMoves, workingDiff } from '../src/main/git/diff'
import { DirtyCounter } from '../src/main/git/dirty'
import { readHistory, fileHistory, readAuthors, searchHistory, commitDetails, commitRefs, parseNumstat } from '../src/main/git/history'
import { readStatus } from '../src/main/git/status'
import { readBranches, switchBranch, createBranch, branchFromCommit, readStashes, createBackupRef, restoreBackup, stagePaths, unstagePaths, commit, readWorktrees, checkoutDetached, pull, pullFrom, resetToUpstream, cherryPick, stashAction } from '../src/main/git/ops'
import { deleteUntracked, discardPaths, fetchAll, push } from '../src/main/git/ops'
import { deleteBranch, renameBranch, setUpstream, unsetUpstream } from '../src/main/git/ops'
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

  test('filters history by exact author names, with paging, search, and regex characters kept literal', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-authors-'))
    await git(dir, ['init', '-q', '-b', 'main'])
    for (const [name, subject] of [['Ann', 'fix: one'], ['JoAnn', 'fix: two'], ['A.n (x)', 'feat: three'], ['Ann', 'feat: four']]) {
      await git(dir, ['-c', `user.name=${name}`, '-c', 'user.email=a@example.com', '-c', 'grep.patternType=perl', 'commit', '-q', '--allow-empty', '-m', subject])
    }
    const subjects = (commits: { subject: string }[]) => commits.map((commit) => commit.subject)
    // "Ann" must not match "JoAnn", and "A.n" must not match "Ann" as a regex would.
    expect(subjects(await readHistory(dir, 0, 10, ['Ann']))).toEqual(['feat: four', 'fix: one'])
    expect(subjects(await readHistory(dir, 1, 10, ['Ann']))).toEqual(['fix: one'])
    expect(subjects(await readHistory(dir, 0, 10, ['A.n (x)', 'JoAnn']))).toEqual(['feat: three', 'fix: two'])
    expect(subjects(await searchHistory(dir, 'FIX', ['Ann', 'A.n (x)']))).toEqual(['fix: one'])
    expect(await readAuthors(dir)).toEqual([{ name: 'Ann', count: 2 }, { name: 'A.n (x)', count: 1 }, { name: 'JoAnn', count: 1 }])
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

  test('stage, unstage, discard and a widened diff act only on a file whose name is also a pattern', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-literal-'))
    const names = ['[ab].txt', 'a.txt', 'b.txt']
    const contents = () => names.map((name) => readFileSync(path.join(dir, name), 'utf8'))
    const cached = async () => (await git(dir, ['diff', '--cached', '--name-only'])).trim()
    try {
      await git(dir, ['init', '-q'])
      await git(dir, ['config', 'user.email', 'test@example.com'])
      await git(dir, ['config', 'user.name', 'Test'])
      for (const name of names) writeFileSync(path.join(dir, name), 'original\n')
      // Before the first commit, unstaging removes index entries.
      await git(dir, ['add', '-A'])
      await unstagePaths(dir, ['[ab].txt'], false)
      expect((await git(dir, ['ls-files'])).trim().split('\n')).toEqual(['a.txt', 'b.txt'])
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-qm', 'base'])
      for (const name of names) writeFileSync(path.join(dir, name), 'valuable edit\n')
      expect((await workingDiff(dir, false, 3, '[ab].txt')).map((file) => file.newPath)).toEqual(['[ab].txt'])
      await stagePaths(dir, ['[ab].txt'])
      expect(await cached()).toBe('[ab].txt')
      await git(dir, ['add', 'a.txt', 'b.txt'])
      await unstagePaths(dir, ['[ab].txt'], true)
      expect(await cached()).toBe('a.txt\nb.txt')
      await discardPaths(dir, ['[ab].txt'])
      expect(contents()).toEqual(['original\n', 'valuable edit\n', 'valuable edit\n'])
    } finally {
      cleanup(dir)
    }
  })

  test('delete removes only a file that is still untracked, never a tracked file, folder, ignored file or a path through a symlink', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'bettergit-delete-')))
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'bettergit-outside-')))
    try {
      await git(dir, ['init', '-q'])
      await git(dir, ['config', 'user.email', 'test@example.com'])
      await git(dir, ['config', 'user.name', 'Test'])
      writeFileSync(path.join(dir, 'tracked.txt'), 'kept\n')
      writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n')
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-qm', 'base'])
      mkdirSync(path.join(dir, 'sub'))
      writeFileSync(path.join(dir, 'sub', 'new [x].txt'), 'scratch\n')
      writeFileSync(path.join(dir, 'ignored.txt'), 'local\n')
      writeFileSync(path.join(outside, 'target.txt'), 'outside\n')
      symlinkSync(outside, path.join(dir, 'linked-dir'))
      symlinkSync(path.join(outside, 'target.txt'), path.join(dir, 'link.txt'))
      await deleteUntracked(dir, 'sub/new [x].txt')
      expect(existsSync(path.join(dir, 'sub', 'new [x].txt'))).toBe(false)
      expect(existsSync(path.join(dir, 'sub'))).toBe(true)
      // A symlink is removed itself, and its target stays.
      await deleteUntracked(dir, 'link.txt')
      expect(existsSync(path.join(dir, 'link.txt'))).toBe(false)
      expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside\n')
      for (const [file, reason] of [['tracked.txt', /no longer an untracked file/], ['ignored.txt', /no longer an untracked file/],
        ['sub', /no longer an untracked file/], ['linked-dir/target.txt', /untracked file|symbolic link/],
        ['../outside.txt', /inside this repository/], ['./tracked.txt', /inside this repository/], [path.join(dir, 'tracked.txt'), /Invalid file path/]] as const) {
        await expect(deleteUntracked(dir, file)).rejects.toThrow(reason)
      }
      expect(readFileSync(path.join(dir, 'tracked.txt'), 'utf8')).toBe('kept\n')
      expect(readFileSync(path.join(dir, 'ignored.txt'), 'utf8')).toBe('local\n')
      expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('outside\n')
    } finally {
      cleanup(dir)
      cleanup(outside)
    }
  })

  test('branches count commits to push and to pull from fetched refs, and mark a gone upstream', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-track-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await git(dir, ['config', 'user.email', 'test@example.com'])
      await git(dir, ['config', 'user.name', 'Test'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'base'])
      await git(dir, ['remote', 'add', 'origin', dir])
      await git(dir, ['switch', '-q', '-c', 'theirs'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'fetched'])
      await git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      await git(dir, ['update-ref', 'refs/remotes/origin/old', 'HEAD'])
      await git(dir, ['switch', '-q', 'main'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'local'])
      for (const [name, merge] of [['main', 'main'], ['old', 'old']]) {
        if (name !== 'main') await git(dir, ['branch', name])
        await git(dir, ['config', `branch.${name}.remote`, 'origin'])
        await git(dir, ['config', `branch.${name}.merge`, `refs/heads/${merge}`])
      }
      await git(dir, ['update-ref', '-d', 'refs/remotes/origin/old'])
      const track = (await readBranches(dir)).map(({ name, upstream, ahead, behind, gone }) => ({ name, upstream, ahead, behind, gone }))
      expect(track).toEqual([
        { name: 'main', upstream: 'origin/main', ahead: 1, behind: 1, gone: false },
        { name: 'old', upstream: 'origin/old', ahead: 0, behind: 0, gone: true },
        { name: 'theirs', upstream: null, ahead: 0, behind: 0, gone: false },
        { name: 'origin/main', upstream: null, ahead: 0, behind: 0, gone: false },
      ])
    } finally {
      cleanup(dir)
    }
  })

  test('lists branches with upstreams and stashes with messages', async () => {
    const branches = await readBranches(repo('work/acme/api-service'))
    expect(branches.find((branch) => branch.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main', ahead: 2, behind: 1, gone: false })
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
      const counter = new DirtyCounter((_path, { count }) => counts.push(count))
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

  test('reports commits to push and to pull, so a repo that is not open shows what a fetch brought', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-dirty-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await git(dir, ['config', 'user.name', 'Test'])
      await git(dir, ['config', 'user.email', 'test@example.com'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'base'])
      await git(dir, ['branch', 'upstream'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'local'])
      await git(dir, ['switch', '-q', 'upstream'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'remote 1'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'remote 2'])
      await git(dir, ['switch', '-q', 'main'])
      await git(dir, ['branch', '-q', '--set-upstream-to', 'upstream'])
      const reports: unknown[] = []
      new DirtyCounter((_path, counts) => reports.push(counts)).request([dir])
      while (reports.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reports).toEqual([{ count: 0, ahead: 1, behind: 2 }])
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

  test('a detached tag checkout refuses to overwrite an ignored local file the tag tracks', async () => {
    const { dir } = await fixture()
    await git(dir, ['switch', '-q', '-c', 'with-env'])
    writeFileSync(path.join(dir, '.env'), 'TRACKED=1\n')
    await git(dir, ['add', '-f', '.env'])
    await git(dir, ['commit', '-qm', 'track env'])
    await git(dir, ['tag', 'v1'])
    await git(dir, ['switch', '-q', 'main'])
    writeFileSync(path.join(dir, '.gitignore'), '.env\n')
    writeFileSync(path.join(dir, '.env'), 'SECRET=local\n')
    const head = await sha(dir)
    await expect(checkoutDetached(dir, await sha(dir, 'v1'))).rejects.toThrow(/\.env/)
    expect(readFileSync(path.join(dir, '.env'), 'utf8')).toBe('SECRET=local\n')
    expect(await sha(dir)).toBe(head)
  })

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

  test('a unique existing tracker is reused before a new-branch fetch mapping is required, without overwriting ignored files', async () => {
    const { dir, tip } = await fixture()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await switchBranch(dir, remote)
    await git(dir, ['branch', '-m', 'my-topic'])
    writeFileSync(path.join(dir, 'build.log'), 'tracked on my-topic\n')
    await git(dir, ['add', 'build.log'])
    await git(dir, ['commit', '-qm', 'local only'])
    const ahead = await sha(dir)
    await git(dir, ['switch', 'main'])
    // A duplicate refspec leaves no single mapping for a new branch, but Git still resolves the existing tracker's upstream.
    await git(dir, ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    expect((await readBranches(dir)).find((entry) => entry.name === 'my-topic')!.upstreamRef).toBe(remote.fullRef)
    // An ignored file that the switch would overwrite is kept, and the switch is refused.
    mkdirSync(path.join(dir, '.git', 'info'), { recursive: true })
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'build.log\n')
    writeFileSync(path.join(dir, 'build.log'), 'ignored on main\n')
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      readFileSync(path.join(dir, '.git', 'config'), 'utf8'), readFileSync(path.join(dir, 'build.log'), 'utf8'),
    ]
    const before = await snapshot()
    await expect(switchBranch(dir, remote)).rejects.toThrow('would be overwritten')
    expect(await snapshot()).toEqual(before)
    unlinkSync(path.join(dir, 'build.log'))
    await switchBranch(dir, remote)
    expect((await readStatus(dir)).head).toBe('my-topic')
    expect(await sha(dir)).toBe(ahead)
    // A new branch still needs exactly one mapping, and a second tracker still makes the choice explicit.
    await git(dir, ['switch', 'main'])
    await git(dir, ['update-ref', 'refs/remotes/origin/later', tip])
    await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/later'))).rejects.toThrow('Ambiguous or unsupported')
    expect((await readBranches(dir)).some((entry) => entry.name === 'later')).toBe(false)
    await git(dir, ['branch', 'second', tip])
    await git(dir, ['config', 'branch.second.remote', 'origin'])
    await git(dir, ['config', 'branch.second.merge', 'refs/heads/topic'])
    await expect(switchBranch(dir, remote)).rejects.toThrow('my-topic, second')
    expect((await readStatus(dir)).head).toBe('main')
  })

  test('an existing tracker whose upstream settings only apply on the current branch is refused before switching', async () => {
    const { dir, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await git(dir, ['switch', '-q', '-c', 'my-topic', tip])
    await git(dir, ['commit', '--allow-empty', '-qm', 'local only'])
    const ahead = await sha(dir)
    await git(dir, ['switch', '-q', 'main'])
    // The tracker's upstream comes only from a file that applies while main is checked out.
    writeFileSync(path.join(gitDir, 'main-upstream.config'), '[branch "my-topic"]\n\tremote = origin\n\tmerge = refs/heads/topic\n')
    await git(dir, ['config', 'includeIf.onbranch:main.path', 'main-upstream.config'])
    expect((await readBranches(dir)).find((entry) => entry.name === 'my-topic')!.upstreamRef).toBe(remote.fullRef)
    mkdirSync(path.join(gitDir, 'info'), { recursive: true })
    writeFileSync(path.join(gitDir, 'info', 'exclude'), 'build.log\n')
    // Work that Git would carry across the switch, so only the new check can stop it.
    writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
    await git(dir, ['add', 'staged.txt'])
    writeFileSync(path.join(dir, 'staged.txt'), 'unstaged\n')
    writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n')
    writeFileSync(path.join(dir, 'build.log'), 'ignored\n')
    const files = ['staged.txt', 'notes.txt', 'build.log'].map((file) => path.join(dir, file))
    const snapshot = async () => [
      await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
      await git(dir, ['status', '--porcelain=v2', '--ignored']),
      ...[path.join(gitDir, 'config'), path.join(gitDir, 'main-upstream.config'), ...files].map((file) => readFileSync(file, 'utf8')),
      ...files.map((file) => statSync(file).mode),
    ]
    const before = await snapshot()
    await expect(switchBranch(dir, remote)).rejects.toThrow('branch.my-topic.remote')
    expect(await snapshot()).toEqual(before)
    // Git itself switches, and the tracker then has no upstream.
    await git(dir, ['switch', '-q', 'my-topic'])
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'my-topic', upstreamRef: null })
    await git(dir, ['switch', '-q', 'main'])
    // The same settings in the repository config are reused, keeping the ahead tip and the upstream.
    await git(dir, ['config', '--unset', 'includeIf.onbranch:main.path'])
    await git(dir, ['config', 'branch.my-topic.remote', 'origin'])
    await git(dir, ['config', 'branch.my-topic.merge', 'refs/heads/topic'])
    await switchBranch(dir, remote)
    expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'my-topic', hash: ahead, upstreamRef: remote.fullRef })
  })

  test('a command-line gitdir include for another repository does not block branch operations, but one for this repository does', async () => {
    const { dir, base, tip } = await fixture()
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim()
    const remote = await select(dir, 'refs/remotes/origin/topic')
    await git(dir, ['switch', '-q', '--track=direct', '-c', 'my-topic', remote.fullRef])
    await git(dir, ['commit', '--allow-empty', '-qm', 'local only'])
    const ahead = await sha(dir)
    await git(dir, ['switch', '-q', 'main'])
    for (const name of ['later', 'refused']) await git(dir, ['update-ref', `refs/remotes/origin/${name}`, tip])
    const external = mkdtempSync(path.join(tmpdir(), 'bettergit-command-'))
    repos.push(external)
    const upstreamFile = path.join(external, 'upstream.config')
    const upstream = (name: string, merge = 'unrelated') => `[branch "${name}"]\n\tremote = origin\n\tmerge = refs/heads/${merge}\n`
    writeFileSync(upstreamFile, ['independent', 'from-commit', 'later', 'refused'].map((name) => upstream(name)).join('') + upstream('my-topic', 'topic'))
    // Process-scoped command-line config, as an app launched with GIT_CONFIG_COUNT would pass to every Git command.
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1']
    const previous = keys.map((key) => process.env[key])
    const scope = (gitdir: string) => Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `includeIf.gitdir:${gitdir}.path`, GIT_CONFIG_VALUE_0: upstreamFile,
      GIT_CONFIG_KEY_1: 'core.abbrev', GIT_CONFIG_VALUE_1: '12',
    })
    try {
      scope(`${dir}-other/.git`)
      expect(await git(dir, ['config', '--show-origin', '--get-all', `includeIf.gitdir:${dir}-other/.git.path`])).toBe(`command line:\t${upstreamFile}\n`)
      await expect(git(dir, ['config', 'branch.independent.remote'])).rejects.toThrow()
      await createBranch(dir, 'independent', { fullRef: 'HEAD', hash: base })
      expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'independent', upstreamRef: null })
      await git(dir, ['switch', '-q', 'main'])
      await branchFromCommit(dir, 'from-commit', tip)
      expect((await readBranches(dir)).find((entry) => entry.name === 'from-commit')).toMatchObject({ hash: tip, upstreamRef: null })
      await switchBranch(dir, await select(dir, 'refs/remotes/origin/later'))
      expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'later', upstreamRef: 'refs/remotes/origin/later' })
      await git(dir, ['switch', '-q', 'main'])
      await switchBranch(dir, remote)
      expect((await readBranches(dir)).find((entry) => entry.current)).toMatchObject({ name: 'my-topic', hash: ahead, upstreamRef: remote.fullRef })
      await git(dir, ['switch', '-q', 'main'])
      // The same include for this repository applies, so Git sees those settings and every operation is refused before writing.
      scope(gitDir)
      expect((await git(dir, ['config', 'branch.refused.remote'])).trim()).toBe('origin')
      mkdirSync(path.join(gitDir, 'info'), { recursive: true })
      writeFileSync(path.join(gitDir, 'info', 'exclude'), 'build.log\n')
      writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
      await git(dir, ['add', 'staged.txt'])
      writeFileSync(path.join(dir, 'staged.txt'), 'unstaged\n')
      writeFileSync(path.join(dir, 'notes.txt'), 'untracked\n')
      writeFileSync(path.join(dir, 'build.log'), 'ignored\n')
      const files = [path.join(gitDir, 'config'), upstreamFile, ...['staged.txt', 'notes.txt', 'build.log'].map((file) => path.join(dir, file))]
      const snapshot = async () => [
        await git(dir, ['for-each-ref']), await git(dir, ['symbolic-ref', 'HEAD']), await git(dir, ['ls-files', '--stage']),
        await git(dir, ['status', '--porcelain=v2', '--ignored']),
        ...files.map((file) => readFileSync(file, 'utf8')), ...files.map((file) => statSync(file).mode),
      ]
      const before = await snapshot()
      await expect(createBranch(dir, 'refused', { fullRef: 'HEAD', hash: base })).rejects.toThrow('branch.refused.remote')
      await expect(branchFromCommit(dir, 'refused', base)).rejects.toThrow('branch.refused.remote')
      await expect(switchBranch(dir, await select(dir, 'refs/remotes/origin/refused'))).rejects.toThrow('branch.refused.remote')
      await expect(switchBranch(dir, remote)).rejects.toThrow('branch.my-topic.remote')
      expect(await snapshot()).toEqual(before)
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      })
    }
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
    // Back on main the mapping applies again, but reusing that tracker would lose its upstream the same way, so it is refused.
    // Creation without tracking still works.
    await git(dir, ['switch', 'main'])
    const reuse = await snapshot()
    await expect(switchBranch(dir, later)).rejects.toThrow('remote.origin.fetch')
    expect(await snapshot()).toEqual(reuse)
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

  test('branch menu writes act on the exact local branch shown, never force, overwrite, self-track or touch the remote', async () => {
    const { dir, base, tip } = await fixture()
    const topic = await select(dir, 'refs/heads/local-base')
    // Unmerged into HEAD with no upstream: the safe delete refuses and keeps the commit. So do the checked-out branch and
    // an identity whose commit changed since it was shown.
    await expect(deleteBranch(dir, topic)).rejects.toThrow()
    expect(await sha(dir, 'refs/heads/local-base')).toBe(tip)
    await expect(deleteBranch(dir, await select(dir, 'refs/heads/main'))).rejects.toThrow('checked out')
    await expect(renameBranch(dir, { ...topic, hash: base }, 'stale')).rejects.toThrow('disappeared or changed')
    await expect(setUpstream(dir, topic, topic)).rejects.toThrow('itself')
    await setUpstream(dir, topic, await select(dir, 'refs/remotes/origin/topic'))
    // A rename never replaces another branch, and carries the upstream to the new name.
    await expect(renameBranch(dir, topic, 'main')).rejects.toThrow('already exists')
    await renameBranch(dir, topic, 'renamed')
    const renamed = (await readBranches(dir)).find((entry) => entry.name === 'renamed')!
    expect(renamed).toMatchObject({ hash: tip, upstreamRef: 'refs/remotes/origin/topic' })
    await unsetUpstream(dir, await select(dir, 'refs/heads/renamed'))
    await expect(unsetUpstream(dir, await select(dir, 'refs/heads/renamed'))).rejects.toThrow('no upstream')
    await git(dir, ['merge', '-q', '--ff-only', 'renamed'])
    await deleteBranch(dir, await select(dir, 'refs/heads/renamed'))
    expect((await readBranches(dir)).map((entry) => entry.fullRef)).toEqual(['refs/heads/main', 'refs/remotes/origin/topic'])
    expect(await sha(dir, 'refs/remotes/origin/topic')).toBe(tip)
  })

  test('renaming refuses upstream settings in an included config without changing the branch or tracking', async () => {
    const { dir, tip } = await fixture()
    const included = path.join(dir, '.git', 'included-tracking.config')
    const content = '[branch "local-base"]\n\tremote = origin\n\tmerge = refs/heads/topic\n'
    writeFileSync(included, content)
    await git(dir, ['config', 'include.path', included])
    const topic = await select(dir, 'refs/heads/local-base')
    await expect(renameBranch(dir, topic, 'renamed')).rejects.toThrow('outside the repository config')
    expect((await readBranches(dir)).find((entry) => entry.fullRef === topic.fullRef))
      .toMatchObject({ hash: tip, upstreamRef: 'refs/remotes/origin/topic' })
    expect((await readBranches(dir)).some((entry) => entry.name === 'renamed')).toBe(false)
    expect(readFileSync(included, 'utf8')).toBe(content)
  })

  test('hidden branches leave History without taking ancestry a shown branch reaches', async () => {
    const { dir, base, tip } = await fixture()
    // A remote HEAD alias of a hidden branch must not bring it back.
    await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/topic'])
    const hashes = async (hidden: string[]) => (await readHistory(dir, 0, 10, [], hidden)).map((entry) => entry.hash)
    const both = ['refs/heads/local-base', 'refs/remotes/origin/topic']
    expect(await hashes([])).toEqual([tip, base])
    expect(await hashes([both[0]])).toEqual([tip, base])
    expect(await hashes(both)).toEqual([base])
    expect(await searchHistory(dir, 'topic', [], both)).toEqual([])
    expect(await hashes([...both, 'refs/heads/main'])).toEqual([])
  })

})

describe('writes that could overwrite untracked or ignored files', () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach(cleanup))
  const sha = async (dir: string, ref = 'HEAD') => (await git(dir, ['rev-parse', ref])).trim()
  const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8')
  // A local clone and a second clone that pushes to the same bare remote. `.env` and `*.secret` are ignored in both.
  const fixture = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-ignored-'))
    dirs.push(dir)
    const remote = path.join(dir, 'remote.git'), local = path.join(dir, 'local'), other = path.join(dir, 'other')
    await git(dir, ['init', '-q', '--bare', '-b', 'main', remote])
    await git(dir, ['clone', '-q', remote, other])
    for (const clone of [other]) {
      await git(clone, ['config', 'user.name', 'Guard Test'])
      await git(clone, ['config', 'user.email', 'guard@example.com'])
    }
    writeFileSync(path.join(other, '.gitignore'), '.env\n*.secret\n')
    await git(other, ['add', '.gitignore'])
    await git(other, ['commit', '-qm', 'base'])
    await git(other, ['push', '-q', '-u', 'origin', 'main'])
    await git(dir, ['clone', '-q', remote, local])
    await git(local, ['config', 'user.name', 'Guard Test'])
    await git(local, ['config', 'user.email', 'guard@example.com'])
    return { dir, local, other }
  }
  // Writes files in the pushing clone (null removes one), force-adds them past .gitignore, commits and pushes.
  const publish = async (other: string, files: Record<string, string | null>, message: string) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) await git(other, ['rm', '-rq', '--', file])
      else {
        mkdirSync(path.dirname(path.join(other, file)), { recursive: true })
        writeFileSync(path.join(other, file), text)
        await git(other, ['add', '-f', '--', file])
      }
    }
    await git(other, ['commit', '-qm', message])
    await git(other, ['push', '-q', 'origin', 'main'])
    return sha(other)
  }

  for (const mode of ['merge', 'rebase'] as const) {
    test(`a ${mode} pull integrates only what its one fetch saw, and refuses a later commit that tracks an ignored file`, async () => {
      const { dir, local, other } = await fixture()
      const seen = await publish(other, { 'b.txt': 'b\n' }, 'b')
      writeFileSync(path.join(local, '.env'), 'SECRET=local\n')
      // The remote advances the moment the fetch updates origin/main, before any merge or rebase runs.
      const hooks = path.join(dir, 'hooks')
      mkdirSync(hooks)
      writeFileSync(path.join(hooks, 'reference-transaction'), [
        '#!/bin/sh',
        '[ "$1" = committed ] || exit 0',
        'grep -q refs/remotes/origin/main || exit 0',
        `[ -e '${dir}/advanced' ] && exit 0`,
        `touch '${dir}/advanced'`,
        `cd '${other}' && env -i PATH="$PATH" HOME="$HOME" sh -c 'echo REMOTE=1 > .env && git add -f .env && git commit -qm late && git push -q origin main'`,
      ].join('\n'))
      chmodSync(path.join(hooks, 'reference-transaction'), 0o755)
      await git(local, ['config', 'core.hooksPath', hooks])
      await pull(local, mode)
      const late = await sha(other)
      expect(late).not.toBe(seen)
      expect(await sha(local)).toBe(seen)
      expect(read(local, '.env')).toBe('SECRET=local\n')
      // The next pull sees the late commit and refuses it, Git's flag for a merge and the guard for a rebase.
      await expect(pull(local, mode)).rejects.toThrow(/\.env/)
      expect(read(local, '.env')).toBe('SECRET=local\n')
      expect(await sha(local)).toBe(seen)
    })
  }

  test('a merge pull with pull.ff=only merges diverged branches, as git pull --no-rebase does', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'b.txt': 'b\n' }, 'b')
    writeFileSync(path.join(local, 'c.txt'), 'c\n')
    await git(local, ['add', 'c.txt'])
    await git(local, ['commit', '-qm', 'c'])
    await git(local, ['config', 'pull.ff', 'only'])
    await pull(local, 'merge')
    expect((await git(local, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ')).toHaveLength(3)
  })

  // HEAD and the upstream both track .env; the user untracks it with git rm --cached and keeps a secret in it.
  const untracked = async () => {
    const { local, other } = await fixture()
    await publish(other, { '.env': 'COMMITTED=1\n' }, 'env')
    await git(local, ['pull', '-q'])
    await git(local, ['rm', '-q', '--cached', '.env'])
    writeFileSync(path.join(local, '.env'), 'SECRET=local\n')
    return { local, other }
  }
  const refused = /untracked or ignored files: \.env\b/

  test('reset to upstream keeps a file untracked with git rm --cached, even when the upstream did not change it', async () => {
    const { local } = await untracked()
    const head = await sha(local)
    await expect(resetToUpstream(local)).rejects.toThrow(refused)
    expect(read(local, '.env')).toBe('SECRET=local\n')
    expect(await sha(local)).toBe(head)
  })

  test('pull and cherry-pick refuse to write back a file untracked with git rm --cached', async () => {
    const pulled = await untracked()
    const head = await sha(pulled.local)
    await publish(pulled.other, { 'b.txt': 'b\n' }, 'b')
    await expect(pull(pulled.local, 'merge')).rejects.toThrow(refused)
    expect(read(pulled.local, '.env')).toBe('SECRET=local\n')
    expect(await sha(pulled.local)).toBe(head)
    const picked = await untracked()
    const commit = await publish(picked.other, { 'b.txt': 'b\n' }, 'b')
    await git(picked.local, ['fetch', '-q'])
    await expect(cherryPick(picked.local, commit)).rejects.toThrow(refused)
    expect(read(picked.local, '.env')).toBe('SECRET=local\n')
  })

  test('a folder of tracked files may become a file, but not while it holds an ignored file', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'config/old.txt': 'old\n' }, 'folder')
    await git(local, ['pull', '-q'])
    await publish(other, { config: null }, 'drop folder')
    await publish(other, { config: 'FILE\n' }, 'file')
    await git(local, ['fetch', '-q'])
    writeFileSync(path.join(local, 'config', '.env'), 'SECRET=local\n')
    await expect(resetToUpstream(local)).rejects.toThrow('config/.env')
    expect(read(local, 'config/.env')).toBe('SECRET=local\n')
    unlinkSync(path.join(local, 'config', '.env'))
    await resetToUpstream(local)
    expect(read(local, 'config')).toBe('FILE\n')
  })

  test('a renamed path with spaces and non-ASCII letters is checked under its new name', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'docs/old name.txt': 'tracked\n' }, 'doc')
    await git(local, ['pull', '-q'])
    mkdirSync(path.join(other, 'dócs'))
    await git(other, ['mv', 'docs/old name.txt', 'dócs/nëw näme.secret'])
    const renamed = await publish(other, {}, 'rename')
    await git(local, ['fetch', '-q'])
    mkdirSync(path.join(local, 'dócs'))
    writeFileSync(path.join(local, 'dócs', 'nëw näme.secret'), 'local\n')
    await expect(cherryPick(local, renamed)).rejects.toThrow('dócs/nëw näme.secret')
    expect(read(local, 'dócs/nëw näme.secret')).toBe('local\n')
    unlinkSync(path.join(local, 'dócs', 'nëw näme.secret'))
    await cherryPick(local, renamed)
    expect(read(local, 'dócs/nëw näme.secret')).toBe('tracked\n')
  })

  const index = (dir: string) => git(dir, ['ls-files', '-s'])
  // Runs `run` with a git on PATH that fails like an older Git on any argument matching `reject`.
  const withOlderGit = async <T>(dir: string, reject: string | undefined, run: () => Promise<T>) => {
    if (!reject) return run()
    const bin = path.join(dir, 'older-git')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg do case "$arg" in ${reject}) echo "error: unknown option $arg" >&2; exit 129;; esac; done\nexec '${Bun.which('git')}' "$@"\n`)
    chmodSync(path.join(bin, 'git'), 0o755)
    const saved = process.env.PATH
    process.env.PATH = `${bin}:${saved}`
    try { return await run() } finally { process.env.PATH = saved }
  }

  // Git 2.38 and 2.39 have merge-tree --write-tree but not --merge-base; Git before 2.38 can't preview at all.
  for (const [git_, reject, refused] of [['this', undefined, 'E/new.secret'], ['2.39', '--merge-base=*', 'E/new.secret'], ['2.37', '--write-tree', 'needs Git 2.38']] as const) {
    test(`a cherry-pick into a folder HEAD renamed is checked where Git puts the file, with Git ${git_}`, async () => {
      const { dir, local, other } = await fixture()
      await publish(other, { 'D/a.txt': 'a\n', 'D/b.txt': 'b\n' }, 'folder')
      await git(local, ['pull', '-q'])
      const added = await publish(other, { 'D/new.secret': 'COMMITTED=1\n' }, 'add')
      await git(local, ['fetch', '-q'])
      await git(local, ['mv', 'D', 'E'])
      await git(local, ['commit', '-qm', 'rename'])
      writeFileSync(path.join(local, 'E', 'new.secret'), 'SECRET=local\n')
      const head = await sha(local), staged = await index(local)
      await expect(withOlderGit(dir, reject, () => cherryPick(local, added))).rejects.toThrow(refused)
      expect(read(local, 'E/new.secret')).toBe('SECRET=local\n')
      expect(await sha(local)).toBe(head)
      expect(await index(local)).toBe(staged)
    })
  }

  test('a rebase pull checks where its replayed local commits write, as into a folder the upstream renamed', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'D/a.txt': 'a\n', 'D/b.txt': 'b\n' }, 'folder')
    await git(local, ['pull', '-q'])
    writeFileSync(path.join(local, 'D', 'new.secret'), 'COMMITTED=1\n')
    await git(local, ['add', '-f', 'D/new.secret'])
    await git(local, ['commit', '-qm', 'local adds secret'])
    await git(other, ['mv', 'D', 'E'])
    await publish(other, {}, 'rename')
    mkdirSync(path.join(local, 'E'))
    writeFileSync(path.join(local, 'E', 'new.secret'), 'SECRET=local\n')
    const head = await sha(local), staged = await index(local)
    await expect(pull(local, 'rebase')).rejects.toThrow('E/new.secret')
    expect(read(local, 'E/new.secret')).toBe('SECRET=local\n')
    expect(await sha(local)).toBe(head)
    expect(await index(local)).toBe(staged)
    expect(await git(local, ['status', '--porcelain'])).toBe('')
  })

  // The apply backend replays the commit that adds D/new.secret as a patch, at D/new.secret, not where a merge puts it.
  test('a rebase pull under rebase.backend=apply is refused before it replays a commit as a patch', async () => {
    const { local, other } = await fixture()
    await git(local, ['config', 'rebase.backend', 'apply'])
    const folder = await publish(other, { 'D/a': 'a\n', 'D/b': 'b\n' }, 'folder')
    await pull(local, 'rebase')
    expect(await sha(local)).toBe(folder)
    writeFileSync(path.join(local, 'D', 'new.secret'), 'COMMITTED=1\n')
    await git(local, ['add', '-f', 'D/new.secret'])
    await git(local, ['commit', '-qm', 'add secret'])
    await git(local, ['rm', '-q', 'D/new.secret'])
    await git(local, ['commit', '-qm', 'remove secret'])
    const ahead = await sha(local)
    await pull(local, 'rebase')
    expect(await sha(local)).toBe(ahead)
    await git(other, ['mv', 'D', 'E'])
    await publish(other, {}, 'rename')
    writeFileSync(path.join(local, 'D', 'new.secret'), 'SECRET=local\n')
    const head = await sha(local), staged = await index(local), status = await git(local, ['status', '--porcelain=v2', '--ignored'])
    await expect(pull(local, 'rebase')).rejects.toThrow('rebase.backend')
    expect(read(local, 'D/new.secret')).toBe('SECRET=local\n')
    expect(await sha(local)).toBe(head)
    expect(await index(local)).toBe(staged)
    expect(await git(local, ['status', '--porcelain=v2', '--ignored'])).toBe(status)
    expect(existsSync(path.join(local, '.git', 'rebase-apply'))).toBe(false)
    expect(existsSync(path.join(local, '.git', 'rebase-merge'))).toBe(false)
    expect((await git(local, ['config', '--get', 'rebase.backend'])).trim()).toBe('apply')
  })

  // macOS disks match names across case and Unicode form, and Git does too under core.ignorecase and precomposeUnicode.
  test('a tracked file under another case and Unicode form is not untracked, but an untracked one in either form is', async () => {
    const { local, other } = await fixture()
    const nfc = 'café.txt'.normalize('NFC'), secret = 'clé.secret'.normalize('NFC')
    await publish(other, { [nfc]: 'tracked\n' }, 'cafe')
    await git(local, ['pull', '-q'])
    // The upstream renames it by case only, and adds a file the local clone keeps as an ignored secret.
    const blob = (await git(other, ['rev-parse', `HEAD:${nfc}`])).trim()
    await git(other, ['rm', '-q', '--cached', nfc])
    await git(other, ['update-index', '--add', '--cacheinfo', `100644,${blob},CAFÉ.txt`.normalize('NFC')])
    await publish(other, { [secret]: 'COMMITTED=1\n' }, 'rename')
    await git(local, ['fetch', '-q'])
    // The local clone's tracked file becomes NFD on disk, which Git still sees as unchanged.
    renameSync(path.join(local, nfc), path.join(local, 'moving'))
    renameSync(path.join(local, 'moving'), path.join(local, nfc.normalize('NFD')))
    expect(await git(local, ['status', '--porcelain'])).toBe('')
    writeFileSync(path.join(local, secret.normalize('NFD')), 'SECRET=local\n')
    await expect(resetToUpstream(local)).rejects.toThrow(`files: ${secret}. Move`)
    await git(local, ['config', 'core.precomposeUnicode', 'false'])
    await expect(resetToUpstream(local)).rejects.toThrow(secret)
    expect(read(local, secret)).toBe('SECRET=local\n')
    await git(local, ['config', 'core.precomposeUnicode', 'true'])
    unlinkSync(path.join(local, secret))
    await resetToUpstream(local)
    expect(read(local, 'CAFÉ.txt')).toBe('tracked\n')
  })

  // HEAD has a folder `slot` where the change adds a file, so Git moves that file aside to slot~<label>, a label only the
  // operation picks: a commit's abbreviated hash and subject, or Stashed changes.
  for (const kind of ['cherry-pick', 'root cherry-pick', 'stash apply'] as const) {
    test(`a ${kind} keeps an ignored file where Git moves a conflicting file aside`, async () => {
      const { local } = await fixture()
      writeFileSync(path.join(local, '.git', 'info', 'exclude'), 'slot~*\n')
      writeFileSync(path.join(local, 'slot'), 'COMMITTED=1\n')
      await git(local, ['add', 'slot'])
      let target = 'stash@{0}'
      if (kind === 'stash apply') await git(local, ['stash', 'push', '-qm', 'add slot'])
      else {
        await git(local, ['commit', '-qm', 'add slot'])
        target = kind === 'cherry-pick' ? await sha(local)
          : (await git(local, ['commit-tree', '-m', 'add slot', 'HEAD^{tree}'])).trim()
        await git(local, ['reset', '-q', '--hard', 'HEAD^'])
      }
      const aside = kind === 'stash apply' ? 'slot~Stashed changes' : `slot~${(await git(local, ['rev-parse', '--short', target])).trim()} (add slot)`
      mkdirSync(path.join(local, 'slot'))
      writeFileSync(path.join(local, 'slot', 'a'), 'a\n')
      await git(local, ['add', 'slot/a'])
      await git(local, ['commit', '-qm', 'add folder'])
      writeFileSync(path.join(local, aside), 'SECRET=local\n')
      const head = await sha(local), staged = await index(local), stashes = await git(local, ['stash', 'list'])
      const run = () => kind === 'stash apply' ? stashAction(local, 'apply', target) : cherryPick(local, target)
      await expect(run()).rejects.toThrow(`files: ${aside}. Move`)
      expect(read(local, aside)).toBe('SECRET=local\n')
      expect(await sha(local)).toBe(head)
      expect(await index(local)).toBe(staged)
      expect(await git(local, ['stash', 'list'])).toBe(stashes)
      expect(await git(local, ['status', '--porcelain'])).toBe('')
      // With the name free, Git's own conflict goes ahead as usual.
      unlinkSync(path.join(local, aside))
      await expect(run()).rejects.toThrow()
      expect(read(local, aside)).toBe('COMMITTED=1\n')
    })
  }

  test('a rebase pull that rebase.rebaseMerges would redo merges for is refused before it writes', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'f.txt': 'base\n', 'D/a': 'a\n', 'D/b': 'b\n' }, 'common base')
    await git(local, ['pull', '-q'])
    // A side branch edits f.txt and adds D/new.secret while main edits f.txt and renames D to E. Their merge puts the
    // secret at E/new.secret and a later commit removes it, so only redoing that merge writes it.
    await git(local, ['switch', '-qc', 'side'])
    writeFileSync(path.join(local, 'f.txt'), 'side\n')
    await git(local, ['commit', '-qam', 'side edits f'])
    writeFileSync(path.join(local, 'D', 'new.secret'), 'COMMITTED=1\n')
    await git(local, ['add', '-f', 'D/new.secret'])
    await git(local, ['commit', '-qm', 'side adds secret'])
    await git(local, ['switch', '-q', 'main'])
    writeFileSync(path.join(local, 'f.txt'), 'main\n')
    await git(local, ['commit', '-qam', 'main edits f'])
    await git(local, ['mv', 'D', 'E'])
    await git(local, ['commit', '-qm', 'main renames D'])
    await expect(git(local, ['merge', '-q', '--no-edit', 'side'])).rejects.toThrow()
    writeFileSync(path.join(local, 'f.txt'), 'resolved\n')
    await git(local, ['add', '-f', '.'])
    await git(local, ['commit', '-qm', 'merge side'])
    await git(local, ['rm', '-q', 'E/new.secret'])
    await git(local, ['commit', '-qm', 'remove secret'])
    await publish(other, { 'up.txt': 'up\n' }, 'upstream advances')
    await git(local, ['config', 'rebase.rebaseMerges', 'true'])
    writeFileSync(path.join(local, 'E', 'new.secret'), 'SECRET=local\n')
    const head = await sha(local), staged = await index(local)
    await expect(pull(local, 'rebase')).rejects.toThrow('rebase.rebaseMerges')
    expect(read(local, 'E/new.secret')).toBe('SECRET=local\n')
    expect(await sha(local)).toBe(head)
    expect(await index(local)).toBe(staged)
    expect(await git(local, ['status', '--porcelain'])).toBe('')
    expect(existsSync(path.join(local, '.git', 'rebase-merge'))).toBe(false)
    // A branch with no merges has none to redo, so the setting changes nothing there.
    const linear = await fixture()
    await git(linear.local, ['config', 'rebase.rebaseMerges', 'true'])
    writeFileSync(path.join(linear.local, 'c.txt'), 'c\n')
    await git(linear.local, ['add', 'c.txt'])
    await git(linear.local, ['commit', '-qm', 'c'])
    const upstream = await publish(linear.other, { 'b.txt': 'b\n' }, 'b')
    await pull(linear.local, 'rebase')
    expect(await sha(linear.local, 'HEAD^')).toBe(upstream)
    expect(read(linear.local, 'c.txt')).toBe('c\n')
  })

  // A branch with no commits yet that tracks the populated remote, as after git init, git remote add and a fetch.
  for (const mode of ['merge', 'rebase', 'named'] as const) {
    test(`a ${mode} pull into a branch with no commits checks out the remote, but not over an ignored file it tracks`, async () => {
      const { dir, other } = await fixture()
      const fresh = path.join(dir, 'fresh')
      await git(dir, ['init', '-q', '-b', 'main', fresh])
      await git(fresh, ['remote', 'add', 'origin', path.join(dir, 'remote.git')])
      await git(fresh, ['fetch', '-q', 'origin'])
      await git(fresh, ['config', 'branch.main.remote', 'origin'])
      await git(fresh, ['config', 'branch.main.merge', 'refs/heads/main'])
      const remote = await publish(other, { '.env': 'COMMITTED=1\n' }, 'env')
      writeFileSync(path.join(fresh, '.git', 'info', 'exclude'), '.env\n')
      writeFileSync(path.join(fresh, '.env'), 'SECRET=local\n')
      const run = () => mode === 'named' ? pullFrom(fresh, 'origin', 'main') : pull(fresh, mode)
      await expect(run()).rejects.toThrow('files: .env. Move')
      expect(read(fresh, '.env')).toBe('SECRET=local\n')
      await expect(sha(fresh)).rejects.toThrow()
      expect(await index(fresh)).toBe('')
      unlinkSync(path.join(fresh, '.env'))
      await run()
      expect(await sha(fresh)).toBe(remote)
      expect(read(fresh, '.env')).toBe('COMMITTED=1\n')
      expect(await git(fresh, ['status', '--porcelain'])).toBe('')
    })
  }

  // The toolbar's Fetch and Push dropdown modes, against a local bare remote.
  const commitFile = async (dir: string, file: string, text: string) => {
    writeFileSync(path.join(dir, file), text)
    await git(dir, ['add', file])
    await git(dir, ['commit', '-qm', file])
    return sha(dir)
  }

  test('pull --ff-only fast-forwards a branch that is only behind, leaves one only ahead, and refuses a diverged one without writing', async () => {
    const { local, other } = await fixture()
    const upstream = await publish(other, { 'b.txt': 'b\n' }, 'b')
    await pull(local, 'ff-only')
    expect(await sha(local)).toBe(upstream)
    expect((await git(local, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ')).toHaveLength(2)
    const mine = await commitFile(local, 'c.txt', 'c\n')
    await pull(local, 'ff-only')
    expect(await sha(local)).toBe(mine)
    await publish(other, { 'd.txt': 'd\n' }, 'd')
    await expect(pull(local, 'ff-only')).rejects.toThrow(/fast-forward/)
    expect(await sha(local)).toBe(mine)
  })

  test('pull --rebase --autostash rebases over uncommitted edits and puts them back, beside ignored files', async () => {
    const { local, other } = await fixture()
    await commitFile(local, 'c.txt', 'c\n')
    const upstream = await publish(other, { 'b.txt': 'b\n' }, 'b')
    writeFileSync(path.join(local, 'c.txt'), 'c edited\n')
    writeFileSync(path.join(local, '.env'), 'SECRET=local\n')
    // Without autostash, Git refuses to rebase a dirty tree.
    await expect(pull(local, 'rebase')).rejects.toThrow()
    await pull(local, 'rebase-autostash')
    expect(await sha(local, 'HEAD^')).toBe(upstream)
    expect(read(local, 'c.txt')).toBe('c edited\n')
    expect(read(local, '.env')).toBe('SECRET=local\n')
    expect(await git(local, ['stash', 'list'])).toBe('')
  })

  test('pull --rebase --autostash refuses before writing when putting the stash back would replace an ignored file', async () => {
    const { local, other } = await fixture()
    await publish(other, { 'D/a': 'a\n' }, 'folder')
    await git(local, ['pull', '-q'])
    await git(other, ['mv', 'D', 'E'])
    await publish(other, {}, 'rename')
    // Only the stash holds D/new.secret. Reapplied after the upstream rename, Git puts it at E/new.secret.
    writeFileSync(path.join(local, 'D', 'new.secret'), 'STAGED=1\n')
    await git(local, ['add', '-f', 'D/new.secret'])
    mkdirSync(path.join(local, 'E'))
    writeFileSync(path.join(local, 'E', 'new.secret'), 'SECRET=local\n')
    const head = await sha(local), staged = await index(local)
    await expect(pull(local, 'rebase-autostash')).rejects.toThrow('files: E/new.secret. Move')
    expect(read(local, 'E/new.secret')).toBe('SECRET=local\n')
    expect(read(local, 'D/new.secret')).toBe('STAGED=1\n')
    expect(await sha(local)).toBe(head)
    expect(await index(local)).toBe(staged)
    expect(await git(local, ['stash', 'list'])).toBe('')

    // A rebase that stops on a conflict would put the stash back onto a tree no one can check yet.
    const stops = await fixture()
    await commitFile(stops.local, 'f.txt', 'local\n')
    await publish(stops.other, { 'f.txt': 'upstream\n' }, 'f')
    writeFileSync(path.join(stops.local, 'c.txt'), 'uncommitted\n')
    await git(stops.local, ['add', 'c.txt'])
    const stopsHead = await sha(stops.local)
    await expect(pull(stops.local, 'rebase-autostash')).rejects.toThrow('stop on a conflict')
    expect(await sha(stops.local)).toBe(stopsHead)
    expect(read(stops.local, 'c.txt')).toBe('uncommitted\n')
    expect(await git(stops.local, ['stash', 'list'])).toBe('')
    expect(existsSync(path.join(stops.local, '.git', 'rebase-merge'))).toBe(false)
  })

  test('fetch --tags brings tags the default fetch skips, and fetch --prune drops deleted remote branches', async () => {
    const { local, other } = await fixture()
    await git(local, ['config', 'fetch.prune', 'false'])
    await git(other, ['tag', 'v1'])
    await git(other, ['push', '-q', 'origin', 'v1', 'HEAD:refs/heads/gone'])
    await fetchAll(local)
    expect(await git(local, ['tag', '--list'])).toBe('')
    await fetchAll(local, 'tags')
    expect((await git(local, ['tag', '--list'])).trim()).toBe('v1')
    await fetchAll(local, 'fetch')
    expect((await git(local, ['branch', '-r'])).includes('origin/gone')).toBe(true)
    await git(other, ['push', '-q', 'origin', ':gone'])
    await fetchAll(local, 'fetch')
    expect((await git(local, ['branch', '-r'])).includes('origin/gone')).toBe(true)
    await fetchAll(local, 'prune')
    expect((await git(local, ['branch', '-r'])).includes('origin/gone')).toBe(false)
  })

  test('force with lease refuses an upstream that moved since the fetch, and force replaces it', async () => {
    const { local, other } = await fixture()
    await commitFile(local, 'c.txt', 'c\n')
    await git(local, ['commit', '-q', '--amend', '-m', 'rewritten'])
    const theirs = await publish(other, { 'b.txt': 'b\n' }, 'b')
    await expect(push(local, true, 'main')).rejects.toThrow()
    await expect(push(local, true, 'main', 'force-with-lease')).rejects.toThrow()
    expect(await sha(other, 'origin/main')).toBe(theirs)
    await push(local, true, 'main', 'force')
    expect(await git(local, ['ls-remote', 'origin', 'refs/heads/main'])).toStartWith(await sha(local))
    // After a fetch the lease holds, so a rewrite of the now-known upstream goes through.
    await git(local, ['fetch', '-q'])
    await git(local, ['commit', '-q', '--amend', '-m', 'again'])
    await push(local, true, 'main', 'force-with-lease')
    expect(await git(local, ['ls-remote', 'origin', 'refs/heads/main'])).toStartWith(await sha(local))
  })

  test('push --no-verify skips a failing pre-push hook, and a force push needs an upstream', async () => {
    const { dir, local } = await fixture()
    const hooks = path.join(dir, 'push-hooks')
    mkdirSync(hooks)
    writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nexit 1\n')
    chmodSync(path.join(hooks, 'pre-push'), 0o755)
    await git(local, ['config', 'core.hooksPath', hooks])
    const mine = await commitFile(local, 'c.txt', 'c\n')
    await expect(push(local, true, 'main')).rejects.toThrow()
    await push(local, true, 'main', 'no-verify')
    expect(await git(local, ['ls-remote', 'origin', 'refs/heads/main'])).toStartWith(mine)
    await expect(push(local, false, 'main', 'force')).rejects.toThrow(/no upstream/)
  })

  test('unknown sync modes are refused before Git runs', async () => {
    const { local, other } = await fixture()
    const head = await sha(local)
    await publish(other, { 'b.txt': 'b\n' }, 'b')
    await expect(pull(local, '--autostash' as never)).rejects.toThrow('Unknown pull mode')
    await expect(fetchAll(local, '--upload-pack=x' as never)).rejects.toThrow('Unknown fetch mode')
    await expect(push(local, true, 'main', '--mirror' as never)).rejects.toThrow('Unknown push mode')
    expect(await sha(local)).toBe(head)
    expect(await git(local, ['rev-parse', 'origin/main'])).toStartWith(head)
  })
})

describe('hunk staging', () => {
  const base = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
  const edited = base.map((line, index) => (index === 1 ? 'first change' : index === 17 ? 'second change' : line))
  const text = (lines: string[]) => lines.join('\n') + '\n'

  const dirs: string[] = []
  afterAll(() => dirs.forEach(cleanup))
  async function hunkRepo(committed: string | Buffer, working: string | Buffer, file = 'a.txt') {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-hunks-'))
    dirs.push(dir)
    await git(dir, ['init', '-q', '-b', 'main'])
    await git(dir, ['config', 'user.email', 't@example.com'])
    await git(dir, ['config', 'user.name', 'T'])
    writeFileSync(path.join(dir, file), committed)
    await git(dir, ['add', '--', file])
    await git(dir, ['commit', '-qm', 'base'])
    writeFileSync(path.join(dir, file), working)
    return dir
  }
  const shownHunks = async (dir: string, staged: boolean, ignoreWhitespace = false, context = 3) =>
    (await workingDiff(dir, staged, context, undefined, ignoreWhitespace))[0]?.hunks ?? []
  const requestOf = (hunk: { header: string; lines: { type: 'context' | 'add' | 'del' | 'note'; text: string }[]; id?: string }, staged: boolean, file = 'a.txt', context = 3): HunkRequest =>
    ({ path: file, staged, context, header: hunk.header, lines: hunk.lines.map(({ type, text }) => ({ type, text })), id: hunk.id ?? '' })
  const indexBytes = async (dir: string, file = 'a.txt') => (await gitRaw(dir, ['show', `:${file}`])).stdout

  test('stages only the chosen hunk of two, and unstages it again', async () => {
    const dir = await hunkRepo(text(base), text(edited))
    const hunks = await shownHunks(dir, false)
    expect(hunks).toHaveLength(2)
    await applyHunk(dir, 'stage', requestOf(hunks[0], false))
    expect((await indexBytes(dir)).toString()).toBe(text(base.map((line, index) => (index === 1 ? 'first change' : line))))
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(text(edited))
    expect((await shownHunks(dir, false)).map((hunk) => hunk.lines.filter((line) => line.type === 'add').map((line) => line.text))).toEqual([['second change']])
    const staged = await shownHunks(dir, true)
    await applyHunk(dir, 'unstage', requestOf(staged[0], true))
    expect((await indexBytes(dir)).toString()).toBe(text(base))
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(text(edited))
  })

  test('discards only the chosen hunk from the working file', async () => {
    const dir = await hunkRepo(text(base), text(edited))
    await applyHunk(dir, 'discard', requestOf((await shownHunks(dir, false))[1], false))
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(text(base.map((line, index) => (index === 1 ? 'first change' : line))))
    expect((await indexBytes(dir)).toString()).toBe(text(base))
  })

  test('a hunk changed since it was shown, or shown with whitespace hidden, is refused and changes nothing', async () => {
    const dir = await hunkRepo(text(base), text(edited))
    const shown = (await shownHunks(dir, false))[0]
    const later = text(edited.map((line, index) => (index === 2 ? 'typed since' : line)))
    writeFileSync(path.join(dir, 'a.txt'), later)
    await expect(applyHunk(dir, 'stage', requestOf(shown, false))).rejects.toThrow('changed since it was shown')
    await expect(applyHunk(dir, 'discard', requestOf(shown, false))).rejects.toThrow('changed since it was shown')
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(later)
    expect((await indexBytes(dir)).toString()).toBe(text(base))

    const spaced = await hunkRepo(text(base), text(edited.map((line, index) => (index === 2 ? 'line  3' : line))))
    const hidden = (await shownHunks(spaced, false, true))[0]
    await expect(applyHunk(spaced, 'stage', requestOf(hidden, false))).rejects.toThrow('changed since it was shown')
    expect((await indexBytes(spaced)).toString()).toBe(text(base))
  })

  test('refuses untracked, added, binary and conflicted files, and malformed requests', async () => {
    const dir = await hunkRepo(text(base), text(edited))
    writeFileSync(path.join(dir, 'new.txt'), 'fresh\n')
    const added = { path: 'new.txt', staged: false, context: 3, header: '@@ -0,0 +1 @@', lines: [{ type: 'add' as const, text: 'fresh' }], id: '' }
    await expect(applyHunk(dir, 'stage', added)).rejects.toThrow('changed since it was shown')
    await git(dir, ['add', 'new.txt'])
    await expect(applyHunk(dir, 'unstage', { ...added, staged: true })).rejects.toThrow('not a modified text file')
    const binary = await hunkRepo(Buffer.from([0, 1, 2, 10]), Buffer.from([0, 1, 3, 10]), 'b.bin')
    await expect(applyHunk(binary, 'stage', { ...added, path: 'b.bin' })).rejects.toThrow('not a modified text file')
    const conflicted = await hunkRepo('base\n', 'base\n')
    await git(conflicted, ['checkout', '-qb', 'side'])
    writeFileSync(path.join(conflicted, 'a.txt'), 'side\n')
    await git(conflicted, ['commit', '-qam', 'side'])
    await git(conflicted, ['checkout', '-q', 'main'])
    writeFileSync(path.join(conflicted, 'a.txt'), 'main\n')
    await git(conflicted, ['commit', '-qam', 'main'])
    await expect(git(conflicted, ['merge', '-q', 'side'])).rejects.toThrow()
    await expect(applyHunk(conflicted, 'stage', { ...added, path: 'a.txt' })).rejects.toThrow('merge conflict')

    const request = requestOf((await shownHunks(dir, false))[0], false)
    expect(() => parseHunk('stage', { ...request, staged: true })).toThrow('cannot be staged')
    expect(() => parseHunk('unstage', request)).toThrow('cannot be unstaged')
    expect(() => parseHunk('reset', request)).toThrow('Unknown hunk action')
    for (const bad of ['../a.txt', '/etc/passwd', 'a//b', '', 'a\0b']) expect(() => parseHunk('stage', { ...request, path: bad })).toThrow('Invalid file path')
    for (const bad of [-1, 1.5, 100001, '3']) expect(() => parseHunk('stage', { ...request, context: bad })).toThrow('Invalid context')
    expect(() => parseHunk('stage', { ...request, lines: [{ type: 'weird', text: '' }] })).toThrow('Invalid hunk lines')
    expect(() => parseHunk('stage', { ...request, id: undefined })).toThrow('Invalid hunk id')
    expect(parseHunk('discard', request)).toEqual(['discard', request])
  })

  // 0xe9 and 0xf1 are invalid UTF-8 alone, so both show as U+FFFD and the shown hunk reads the same before and after.
  for (const [ending, end] of [['a final newline', '\n'], ['no final newline', '']] as const) {
    test(`a hunk whose raw bytes changed to text that reads the same is refused for every action, with ${ending}`, async () => {
      const bytes = (byte: number) => Buffer.concat([Buffer.from(text(base.slice(0, 19))), Buffer.from([byte]), Buffer.from(end)])
      const dir = await hunkRepo(bytes(0x61), bytes(0xe9))
      const shown = (await shownHunks(dir, false))[0]
      writeFileSync(path.join(dir, 'a.txt'), bytes(0xf1))
      const fresh = (await shownHunks(dir, false))[0]
      expect({ header: fresh.header, lines: fresh.lines }).toEqual({ header: shown.header, lines: shown.lines })
      for (const action of ['stage', 'discard'] as const) {
        await expect(applyHunk(dir, action, requestOf(shown, false))).rejects.toThrow('changed since it was shown')
      }
      expect(readFileSync(path.join(dir, 'a.txt')).equals(bytes(0xf1))).toBe(true)
      expect((await indexBytes(dir)).equals(bytes(0x61))).toBe(true)

      writeFileSync(path.join(dir, 'a.txt'), bytes(0xe9))
      await git(dir, ['add', 'a.txt'])
      const staged = (await shownHunks(dir, true))[0]
      writeFileSync(path.join(dir, 'a.txt'), bytes(0xf1))
      await git(dir, ['add', 'a.txt'])
      await expect(applyHunk(dir, 'unstage', requestOf(staged, true))).rejects.toThrow('changed since it was shown')
      expect((await indexBytes(dir)).equals(bytes(0xf1))).toBe(true)
      // The current hunk still applies, byte for byte.
      await applyHunk(dir, 'unstage', requestOf((await shownHunks(dir, true))[0], true))
      expect((await indexBytes(dir)).equals(bytes(0x61))).toBe(true)
      expect(readFileSync(path.join(dir, 'a.txt')).equals(bytes(0xf1))).toBe(true)
    })
  }

  test('keeps Latin-1 bytes and a missing final newline exact', async () => {
    const latin = (words: string[]) => Buffer.concat(words.map((word, index) => Buffer.concat([Buffer.from(word, 'latin1'), index < words.length - 1 ? Buffer.from('\n') : Buffer.alloc(0)])))
    const before = [...base.slice(0, 19), 'café']
    const after = [...base.slice(0, 19), 'naïve']
    after[1] = 'résumé'
    const dir = await hunkRepo(latin(before), latin(after))
    const hunks = await shownHunks(dir, false)
    const last = hunks[hunks.length - 1]
    expect(last.lines.some((line) => line.type === 'note')).toBe(true)
    await applyHunk(dir, 'stage', requestOf(last, false))
    expect((await indexBytes(dir)).equals(latin([...base.slice(0, 19), 'naïve']))).toBe(true)
    expect(readFileSync(path.join(dir, 'a.txt')).equals(latin(after))).toBe(true)
  })
})

describe('commit details', () => {
  test('reads identity, parents, unfiltered first-parent stats, exact message, signature state and current refs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-details-'))
    try {
      await git(dir, ['init', '-q', '-b', 'main'])
      await git(dir, ['config', 'user.email', 'ann@example.com'])
      await git(dir, ['config', 'user.name', 'Ann'])
      await git(dir, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-qm', 'root'])
      writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n')
      writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, 0, 255]))
      await git(dir, ['add', '-A'])
      // A field separator in the message must not shift the fields before it.
      const message = 'second\n\nbody with \x1f inside\nand more'
      await git(dir, ['-c', 'user.name=Cy', '-c', 'user.email=cy@example.com', 'commit', '-q', '--author=Bo <bo@example.com>', '-m', message])
      const head = (await git(dir, ['rev-parse', 'HEAD'])).trim()
      const rootHash = (await git(dir, ['rev-parse', 'HEAD~1'])).trim()
      const details = await commitDetails(dir, head)
      expect(details.hash).toBe(head)
      expect(details.tree).toBe((await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim())
      expect(details.parents).toEqual([rootHash])
      expect(details.author).toEqual({ name: 'Bo', email: 'bo@example.com' })
      expect(details.committer).toEqual({ name: 'Cy', email: 'cy@example.com' })
      expect(Number.isNaN(Date.parse(details.authorDate))).toBe(false)
      expect(details.body).toBe(message)
      expect(details.signature).toEqual({ code: 'N', signer: '' })
      expect(details.stats).toEqual({ files: 2, additions: 2, deletions: 1 })
      // A root commit counts against the empty tree.
      expect((await commitDetails(dir, rootHash)).stats).toEqual({ files: 1, additions: 2, deletions: 0 })
      expect(parseNumstat('-\t-\tb.bin\n3\t1\ta.txt\n')).toEqual({ files: 2, additions: 3, deletions: 1 })

      await git(dir, ['branch', 'topic'])
      await git(dir, ['tag', '-a', 'v1', '-m', 'v1'])
      await git(dir, ['update-ref', 'refs/remotes/origin/main', head])
      await git(dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
      expect(await commitRefs(dir, head)).toEqual({ branches: ['main', 'topic'], remotes: ['origin/main'], tags: ['v1'] })
      // The same hash after a branch moves away reads its refs again.
      await git(dir, ['branch', '-f', 'topic', rootHash])
      expect((await commitRefs(dir, head)).branches).toEqual(['main'])
      await expect(commitRefs(dir, '--all')).rejects.toThrow('Invalid commit hash.')
      await expect(commitDetails(dir, 'HEAD')).rejects.toThrow('Invalid commit hash.')
    } finally {
      cleanup(dir)
    }
  })

  test('a bounded read fails on time even when a helper keeps git\'s output open', async () => {
    const started = Date.now()
    await expect(git(tmpdir(), ['-c', 'alias.stall=!sleep 5 & sleep 5', 'stall'], { timeoutMs: 200 })).rejects.toThrow('timed out')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('tells a good SSH signature apart from one git cannot check', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bettergit-signed-'))
    try {
      const key = path.join(dir, 'key')
      const made = Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'ann', '-f', key])
      if (made.exitCode !== 0) return
      await git(dir, ['init', '-q', '-b', 'main', 'repo'])
      const work = path.join(dir, 'repo')
      await git(work, ['config', 'user.email', 'ann@example.com'])
      await git(work, ['config', 'user.name', 'Ann'])
      await git(work, ['config', 'gpg.format', 'ssh'])
      await git(work, ['config', 'user.signingkey', `${key}.pub`])
      await git(work, ['commit', '-q', '-S', '--allow-empty', '-m', 'signed'])
      const head = (await git(work, ['rev-parse', 'HEAD'])).trim()
      const signers = path.join(dir, 'allowed')
      writeFileSync(signers, `ann@example.com ${readFileSync(`${key}.pub`, 'utf8')}`)
      await git(work, ['config', 'gpg.ssh.allowedSignersFile', signers])
      expect((await commitDetails(work, head)).signature?.code).toBe('G')
      // No signer list: the signature cannot be checked, which is not the same as a bad one.
      await git(work, ['config', '--unset', 'gpg.ssh.allowedSignersFile'])
      const unchecked = (await commitDetails(work, head)).signature
      expect(unchecked?.code === 'B').toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})
