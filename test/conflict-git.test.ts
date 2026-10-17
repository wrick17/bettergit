import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConflict, previewConflict, saveConflict } from '../src/main/git/conflict'
import { parseDiff, workingDiff } from '../src/main/git/diff'
import { stagePaths } from '../src/main/git/ops'
import type { Choice, ConflictDocument, ConflictFingerprint } from '../src/shared/conflict'

// Real Git runs here, in temp repositories that test code builds and removes. The shared checkout is never touched.
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

type Style = 'merge' | 'diff3' | 'zdiff3'

interface Sides {
  // null means the file is absent on that side, which makes a delete or add conflict.
  base: string | null
  ours: string | null
  theirs: string | null
  style?: Style
  // Symbolic links to write in place of content, per side. Each value is the link target.
  symlinks?: { base?: string; ours?: string; theirs?: string }
  // Plain files committed on the base, to check that unrelated paths are left alone.
  plain?: Record<string, string>
  config?: Record<string, string>
}

// Builds a repository whose file 'doc.txt' is conflicted by a real merge. Returns the repository path.
function conflictRepo(sides: Sides): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bettergit-k-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [key, value] of [
    ['user.name', 'Fixture'], ['user.email', 'fixture@example.com'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['merge.conflictStyle', sides.style ?? 'merge'],
    ...Object.entries(sides.config ?? {}),
  ]) git(repo, ['config', key, value])
  const file = path.join(repo, 'doc.txt')
  const put = (value: string | null, link: string | undefined) => {
    rmSync(file, { force: true })
    if (link !== undefined) symlinkSync(link, file)
    else if (value !== null) writeFileSync(file, value)
  }
  for (const [name, value] of Object.entries(sides.plain ?? {})) writeFileSync(path.join(repo, name), value)
  put(sides.base, sides.symlinks?.base)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  git(repo, ['checkout', '-q', '-b', 'topic'])
  put(sides.theirs, sides.symlinks?.theirs)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'theirs'])
  git(repo, ['checkout', '-q', 'main'])
  put(sides.ours, sides.symlinks?.ours)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'ours'])
  const merged = spawnSync('git', ['merge', '--no-edit', 'topic'], { cwd: repo, encoding: 'utf8' })
  if (merged.status === 0) throw new Error('The fixture merge did not conflict.')
  return repo
}

// The file as the model describes it, or a failed test with the reason the model gave.
async function loaded(repo: string, file = 'doc.txt'): Promise<Extract<ConflictDocument, { supported: true }>> {
  const model = await loadConflict(repo, file)
  if (!model.supported) throw new Error(model.message)
  return model
}

async function resolve(repo: string, choices: Choice[], file = 'doc.txt') {
  const model = await loaded(repo, file)
  return saveConflict(repo, file, { fingerprint: model.fingerprint, choices })
}

const text = (repo: string, file = 'doc.txt') => readFileSync(path.join(repo, file)).toString('utf8')
const stagesOf = (repo: string, file = 'doc.txt') => git(repo, ['ls-files', '-u', '--', file]).split('\n').filter(Boolean)
// BetterGit's temporary file beside this repository's doc.txt. Failures injected into the shared fs methods fire only
// for it, and every other path runs the real method, so filesystem work elsewhere at the same time never takes them.
const isTemp = (repo: string, file: unknown) =>
  path.dirname(String(file)) === realpathSync(repo) && /^\.doc\.txt\.bettergit-.+\.tmp$/.test(path.basename(String(file)))
// An inert merge driver that records each run beside the repository and leaves the conflict unmerged.
const CANARY = 'echo ran >> ../driver-runs; false'
const driverRuns = (repo: string) => {
  const runs = path.join(repo, '..', 'driver-runs')
  return existsSync(runs) ? readFileSync(runs, 'utf8') : ''
}

describe('conflict resolution on real Git merges', () => {
  test('a normal-style conflict loads as one supported block with both fingerprints', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    const model = await loaded(repo)
    expect(model.parts.filter((part) => part.kind === 'conflict')).toHaveLength(1)
    expect(model.fingerprint.working).toHaveLength(64)
    expect(model.fingerprint.stages).toHaveLength(64)
  })

  for (const [body, ours, theirs] of [
    ['a closing marker before the separator', '>>>>>> label\n', '>>>>>>>x label\n'],
    ['an incoming literal opening', 'current\n', '<<<<<< literal incoming\n'],
  ]) {
    test(`six-character Git markers with ${body} cannot appear clean or stage after attributes change to seven`, async () => {
      const repo = conflictRepo({ base: 'original\n', ours, theirs })
      const initial = await loaded(repo)
      const stages = stagesOf(repo)
      writeFileSync(path.join(repo, '.gitattributes'), 'doc.txt conflict-marker-size=6\n')
      git(repo, ['checkout', '--conflict=merge', '--', 'doc.txt'])
      const before = readFileSync(path.join(repo, 'doc.txt'))
      expect(before.toString('utf8')).toStartWith('<<<<<< ours\n')
      expect(stages).toHaveLength(3)
      writeFileSync(path.join(repo, '.gitattributes'), 'doc.txt conflict-marker-size=7\n')
      const model = await loadConflict(repo, 'doc.txt')
      const save = { fingerprint: { ...initial.fingerprint, working: createHash('sha256').update(before).digest('hex') }, choices: [] }
      const preview = await previewConflict(repo, 'doc.txt', save).then(
        (result) => ({ unresolved: result.unresolved }), (error: Error) => ({ refused: error.message }),
      )
      const saved = await saveConflict(repo, 'doc.txt', save).then(
        (result) => ({ unresolved: result.unresolved }), (error: Error) => ({ refused: error.message }),
      )
      const beforeStaging = stagesOf(repo).length
      const stage = await stagePaths(repo, ['doc.txt']).then(
        () => ({ staged: true }), (error: Error) => ({ refused: error.message }),
      )
      expect({ model, preview, saved, beforeStaging, stage, afterStaging: stagesOf(repo).length, workingUnchanged: readFileSync(path.join(repo, 'doc.txt')).equals(before) }).toMatchObject({
        model: { supported: false, message: expect.stringContaining('marker') },
        preview: { refused: expect.stringContaining('marker') },
        saved: { refused: expect.stringContaining('marker') },
        beforeStaging: 3,
        stage: { refused: expect.stringContaining('still has conflict markers') },
        afterStaging: 3,
        workingUnchanged: true,
      })
      expect(readFileSync(path.join(repo, 'doc.txt'))).toEqual(before)
      expect(stagesOf(repo)).toEqual(stages)
    })
  }

  test('current, incoming, and both write the exact bytes, and preview matches the saved text', async () => {
    const cases: [Choice, string][] = [
      ['current', 'top\nmine\nend\n'],
      ['incoming', 'top\nyours\nend\n'],
      ['both', 'top\nmine\nyours\nend\n'],
    ]
    for (const [choice, expected] of cases) {
      const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
      const model = await loaded(repo)
      const preview = await previewConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: [choice] })
      await saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: [choice] })
      expect(text(repo)).toBe(expected)
      expect(preview.text).toBe(expected)
    }
  })

  test('saving never stages: the file is still unmerged with all three stages', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    await resolve(repo, ['current'])
    expect(stagesOf(repo).map((line) => line.split(' ')[2].split('\t')[0])).toEqual(['1', '2', '3'])
  })

  test('disjoint words on one line combine into both edits', async () => {
    const repo = conflictRepo({ base: 'alpha beta gamma\n', ours: 'ALPHA beta gamma\n', theirs: 'alpha beta GAMMA\n' })
    const model = await loaded(repo)
    expect(model.combine[0]).toEqual({ state: 'ready', text: 'ALPHA beta GAMMA\n' })
    await resolve(repo, ['combine'])
    expect(text(repo)).toBe('ALPHA beta GAMMA\n')
  })

  test('the same word changed differently is an overlap, refused for combine, and the file is not written', async () => {
    const repo = conflictRepo({ base: 'alpha beta gamma\n', ours: 'alpha BETA gamma\n', theirs: 'alpha bravo gamma\n' })
    const model = await loaded(repo)
    expect(model.combine[0]).toEqual({ state: 'overlap' })
    await expect(resolve(repo, ['combine'])).rejects.toThrow('cannot be combined')
    expect(text(repo)).toContain('<<<<<<< HEAD')
  })

  test('several conflicts take independent choices, and an unresolved one keeps its markers', async () => {
    // Four common lines keep the two conflicts apart. Git folds conflicts that sit closer together into one block.
    const common = 'm1\nm2\nm3\nm4\n'
    const repo = conflictRepo({
      base: `top\nold1\n${common}old2\nend\n`,
      ours: `top\nA1\n${common}A2\nend\n`,
      theirs: `top\nB1\n${common}B2\nend\n`,
    })
    await resolve(repo, ['both', null])
    expect(text(repo)).toBe(`top\nA1\nB1\n${common}<<<<<<< HEAD\nA2\n=======\nB2\n>>>>>>> topic\nend\n`)
  })

  test('CRLF bytes survive a combine', async () => {
    const repo = conflictRepo({ base: 'alpha beta gamma\r\n', ours: 'ALPHA beta gamma\r\n', theirs: 'alpha beta GAMMA\r\n' })
    await resolve(repo, ['combine'])
    expect(text(repo)).toBe('ALPHA beta GAMMA\r\n')
  })

  test('a byte order mark inside a conflicting line survives a combine', async () => {
    const repo = conflictRepo({ base: '﻿alpha beta\n', ours: '﻿ALPHA beta\n', theirs: '﻿alpha BETA\n' })
    await resolve(repo, ['combine'])
    expect(text(repo)).toBe('﻿ALPHA BETA\n')
  })

  test('a last line with no newline, outside the conflict, stays without one', async () => {
    const repo = conflictRepo({ base: 'x\nold\nend', ours: 'x\nmine\nend', theirs: 'x\nyours\nend' })
    await resolve(repo, ['incoming'])
    expect(text(repo)).toBe('x\nyours\nend')
  })

  test('stale working bytes are refused, and the hand edit is kept', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    const model = await loaded(repo)
    writeFileSync(path.join(repo, 'doc.txt'), 'edited by hand\n')
    await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
      .rejects.toThrow('changed after it was loaded')
    expect(text(repo)).toBe('edited by hand\n')
  })

  test('a changed index stage is refused, and the file is left alone', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    const model = await loaded(repo)
    const blob = git(repo, ['hash-object', '-w', '--stdin'], Buffer.from('other\n'))
    git(repo, ['update-index', '--index-info'], Buffer.from(`100644 ${blob} 3\tdoc.txt\n`))
    await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
      .rejects.toThrow('changed after it was loaded')
    expect(text(repo)).toContain('<<<<<<< HEAD')
  })

  test('saving preserves executable permissions and leaves no temporary file', async () => {
    const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
    chmodSync(path.join(repo, 'doc.txt'), 0o755)
    const stages = stagesOf(repo)
    await resolve(repo, ['current'])
    expect(statSync(path.join(repo, 'doc.txt')).mode & 0o777).toBe(0o755)
    expect(readdirSync(repo).filter((name) => name.includes('.bettergit-'))).toEqual([])
    expect(stagesOf(repo)).toEqual(stages)
  })

  for (const operation of ['writeFile', 'rename'] as const) {
    test(`a failed atomic ${operation} keeps the original and cleans the temporary file`, async () => {
      const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
      const model = await loaded(repo)
      const before = text(repo)
      const stages = stagesOf(repo)
      const failure = new Error(`injected ${operation} failure`)
      const [realWrite, realRename] = [fs.writeFile.bind(fs), fs.rename.bind(fs)]
      const injected = operation === 'writeFile'
        ? spyOn(fs, 'writeFile').mockImplementation(async (file, bytes, options) => {
          if (!isTemp(repo, file)) return realWrite(file, bytes, options)
          writeFileSync(String(file), 'partial write')
          throw failure
        })
        : spyOn(fs, 'rename').mockImplementation(async (from, to) => {
          if (!isTemp(repo, from)) return realRename(from, to)
          throw failure
        })
      // Other filesystem work while the failure is armed, as from a test file running at the same time, starts first.
      const other = path.join(path.dirname(repo), 'other.txt')
      writeFileSync(`${other}.new`, 'other\n')
      try {
        const [unrelated, saved] = await Promise.allSettled([
          operation === 'writeFile' ? fs.writeFile(other, 'other\n') : fs.rename(`${other}.new`, other),
          saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }),
        ])
        expect(unrelated.status).toBe('fulfilled')
        expect(saved.status === 'rejected' && saved.reason).toBe(failure)
      } finally {
        injected.mockRestore()
      }
      expect(readFileSync(other, 'utf8')).toBe('other\n')
      expect(text(repo)).toBe(before)
      expect(stagesOf(repo)).toEqual(stages)
      expect(readdirSync(repo).filter((name) => name.includes('.bettergit-'))).toEqual([])
    })
  }

  for (const change of ['working', 'index'] as const) {
    test(`a ${change} change during the temporary write is caught before rename`, async () => {
      const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
      const model = await loaded(repo)
      const originalWrite = fs.writeFile.bind(fs)
      const injected = spyOn(fs, 'writeFile').mockImplementation(async (file, bytes, options) => {
        await originalWrite(file, bytes, options)
        if (!isTemp(repo, file)) return
        if (change === 'working') writeFileSync(path.join(repo, 'doc.txt'), 'external edit\n')
        else {
          const blob = git(repo, ['hash-object', '-w', '--stdin'], Buffer.from('other\n'))
          git(repo, ['update-index', '--index-info'], Buffer.from(`100644 ${blob} 3\tdoc.txt\n`))
        }
      })
      try {
        await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
          .rejects.toThrow('changed after it was loaded')
      } finally {
        injected.mockRestore()
      }
      if (change === 'working') expect(text(repo)).toBe('external edit\n')
      else expect(text(repo)).toContain('<<<<<<< HEAD')
      expect(stagesOf(repo)).toHaveLength(3)
      expect(readdirSync(repo).filter((name) => name.includes('.bettergit-'))).toEqual([])
    })
  }

  test('a mode change during the temporary write is caught before rename, and nothing is written or staged', async () => {
    const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
    const file = path.join(repo, 'doc.txt')
    chmodSync(file, 0o644)
    const model = await loaded(repo)
    const before = text(repo)
    const stages = stagesOf(repo)
    const originalChmod = fs.chmod.bind(fs)
    const injected = spyOn(fs, 'chmod').mockImplementation(async (temp, mode) => {
      await originalChmod(temp, mode)
      if (isTemp(repo, temp)) chmodSync(file, 0o755)
    })
    try {
      await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
        .rejects.toThrow('changed after it was loaded')
    } finally {
      injected.mockRestore()
    }
    expect(text(repo)).toBe(before)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    expect(stagesOf(repo)).toEqual(stages)
    expect(readdirSync(repo).filter((name) => name.includes('.bettergit-'))).toEqual([])
  })

  test('an oversized stage leaves combine unavailable without reading the blob or merging', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    const big = git(repo, ['hash-object', '-w', '--stdin'], Buffer.from(`old\n${'x'.repeat(2 * 1024 * 1024)}\n`))
    git(repo, ['update-index', '--index-info'], Buffer.from(`100644 ${big} 1\tdoc.txt\n`))
    const trace = path.join(path.dirname(repo), 'git-trace.log')
    process.env.GIT_TRACE = trace
    let model: ConflictDocument
    try {
      model = await loadConflict(repo, 'doc.txt')
    } finally {
      delete process.env.GIT_TRACE
    }
    expect(model.supported && model.combine).toEqual([{ state: 'unavailable', reason: expect.stringContaining('could not be read') }])
    const traced = readFileSync(trace, 'utf8')
    expect(traced).toContain("cat-file '--batch-check")
    expect(traced).not.toContain(`cat-file blob ${big}`)
    expect(traced).not.toContain('merge-file')
  }, 60_000)

  test('paths outside the unmerged list and paths that escape the repository are refused', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n', plain: { 'notes.txt': 'plain\n' } })
    const model = await loaded(repo)
    const save = { fingerprint: model.fingerprint, choices: ['current' as Choice] }
    const notes = await loadConflict(repo, 'notes.txt')
    expect(notes).toEqual({ supported: false, message: 'This file is not in a merge conflict.' })
    expect((await loadConflict(repo, '../outside.txt'))).toEqual({ supported: false, message: 'The file path must be relative to the repository.' })
    await expect(saveConflict(repo, 'notes.txt', save)).rejects.toThrow('not in a merge conflict')
    expect(text(repo, 'notes.txt')).toBe('plain\n')
  })

  test('a conflict whose stages are symbolic links is unsupported, and nothing is written through them', async () => {
    const repo = conflictRepo({
      base: null,
      ours: null,
      theirs: null,
      symlinks: { base: '../base-target.txt', ours: '../outside.txt', theirs: '../elsewhere.txt' },
    })
    const outside = path.join(repo, '..', 'outside.txt')
    writeFileSync(outside, 'keep\n')
    expect(await loadConflict(repo, 'doc.txt')).toEqual({ supported: false, message: 'Symbolic links and submodules are not resolved here.' })
    await expect(saveConflict(repo, 'doc.txt', { fingerprint: { working: '0'.repeat(64), stages: '0'.repeat(64) } as ConflictFingerprint, choices: ['current'] }))
      .rejects.toThrow('Symbolic links')
    expect(readFileSync(outside, 'utf8')).toBe('keep\n')
  })

  test('a regular conflict whose working file was replaced by a symbolic link is refused', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    const model = await loaded(repo)
    const outside = path.join(repo, '..', 'outside.txt')
    writeFileSync(outside, 'keep\n')
    rmSync(path.join(repo, 'doc.txt'))
    symlinkSync('../outside.txt', path.join(repo, 'doc.txt'))
    expect(await loadConflict(repo, 'doc.txt')).toEqual({ supported: false, message: 'Only regular files are resolved here. Symbolic links and folders are not resolved.' })
    await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] })).rejects.toThrow('Only regular files')
    expect(readFileSync(outside, 'utf8')).toBe('keep\n')
  })

  test('an unmerged path through a parent symlink outside the real repository is refused', async () => {
    const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
    const model = await loaded(repo)
    const outside = path.join(repo, '..', 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'doc.txt'), 'keep\n')
    symlinkSync('../outside', path.join(repo, 'escape'))
    const records = stagesOf(repo).map((line) => line.replace('\tdoc.txt', '\tescape/doc.txt')).join('\n') + '\n'
    git(repo, ['update-index', '--index-info'], Buffer.from(records))
    expect(await loadConflict(repo, 'escape/doc.txt')).toEqual({ supported: false, message: 'This file is outside the repository.' })
    await expect(saveConflict(repo, 'escape/doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
      .rejects.toThrow('outside the repository')
    expect(readFileSync(path.join(outside, 'doc.txt'), 'utf8')).toBe('keep\n')
  })

  for (const [name, bytes, reason] of [
    ['NUL', Buffer.from('a\0b'), 'NUL bytes'],
    ['invalid UTF-8', Buffer.from([0xff]), 'not valid UTF-8'],
    ['oversized', Buffer.alloc(2 * 1024 * 1024 + 1, 65), 'too large'],
  ] as const) {
    test(`${name} working bytes are refused without writing or staging`, async () => {
      const repo = conflictRepo({ base: 'old\n', ours: 'mine\n', theirs: 'yours\n' })
      const model = await loaded(repo)
      const stages = stagesOf(repo)
      writeFileSync(path.join(repo, 'doc.txt'), bytes)
      expect(await loadConflict(repo, 'doc.txt')).toMatchObject({ supported: false, message: expect.stringContaining(reason) })
      await expect(saveConflict(repo, 'doc.txt', { fingerprint: model.fingerprint, choices: ['current'] }))
        .rejects.toThrow(reason)
      expect(readFileSync(path.join(repo, 'doc.txt'))).toEqual(bytes)
      expect(stagesOf(repo)).toEqual(stages)
    })
  }

  test('a delete-versus-modify conflict is unsupported with a clear reason', async () => {
    const repo = conflictRepo({ base: 'alpha\n', ours: null, theirs: 'beta\n' })
    expect(await loadConflict(repo, 'doc.txt')).toEqual({
      supported: false,
      message: 'Only conflicts changed on both sides are resolved here. Delete and add conflicts need another tool.',
    })
  })

  test('stage all cannot resolve a file that still has markers, and allows it once resolved', async () => {
    const repo = conflictRepo({ base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n' })
    await expect(stagePaths(repo, ['doc.txt'])).rejects.toThrow('still has conflict markers')
    expect(stagesOf(repo)).toHaveLength(3)
    await resolve(repo, ['current'])
    await stagePaths(repo, ['doc.txt'])
    expect(stagesOf(repo)).toHaveLength(0)
  })

  test('eight-character markers are refused without clearing the unmerged index or writing the file', async () => {
    const repo = conflictRepo({
      base: 'top\nold\nend\n', ours: 'top\nmine\nend\n', theirs: 'top\nyours\nend\n',
      plain: { '.gitattributes': 'doc.txt conflict-marker-size=8\n' },
    })
    const before = text(repo)
    const stages = stagesOf(repo)
    expect(before).toContain('<<<<<<<< HEAD\n')
    expect(stages).toHaveLength(3)
    const model = await loadConflict(repo, 'doc.txt')
    expect(model).toMatchObject({ supported: false, message: expect.stringContaining('conflict-marker-size') })
    const save = { fingerprint: { working: '0'.repeat(64), stages: '0'.repeat(64) }, choices: [] }
    await expect(previewConflict(repo, 'doc.txt', save)).rejects.toThrow('conflict-marker-size')
    await expect(saveConflict(repo, 'doc.txt', save)).rejects.toThrow('conflict-marker-size')
    await expect(stagePaths(repo, ['.'])).rejects.toThrow('conflict-marker-size')
    expect(text(repo)).toBe(before)
    expect(stagesOf(repo)).toEqual(stages)
  })

  // Git runs a merge driver configured under the selected name before its built-in drivers, even for set, text, and
  // unspecified, the word check-attr also prints for an absent attribute.
  for (const [selection, name] of [
    ['attribute', 'fixture'], ['default', 'fixture'], ['attribute', 'set'], ['attribute', 'text'], ['attribute', 'unspecified'], ['default', 'set'],
  ] as const) {
    test(`a custom merge driver named ${name} selected by ${selection} cannot appear clean or clear the unmerged index`, async () => {
      const repo = conflictRepo({
        base: 'old\n', ours: 'mine\n', theirs: 'yours\n',
        plain: { 'notes.txt': 'plain\n', ...(selection === 'attribute' ? { '.gitattributes': `doc.txt merge=${name}\n` } : {}) },
        config: { [`merge.${name}.driver`]: CANARY, ...(selection === 'default' ? { 'merge.default': name } : {}) },
      })
      const files = () => ['doc.txt', 'notes.txt', '.git/index', '.git/config'].map((file) => readFileSync(path.join(repo, file)))
      const before = files()
      const stages = stagesOf(repo)
      expect(text(repo)).toBe('mine\n')
      expect(stages).toHaveLength(3)
      expect(driverRuns(repo)).toBe('ran\n')
      expect(await loadConflict(repo, 'doc.txt')).toMatchObject({ supported: false, message: expect.stringContaining('merge driver') })
      await expect(stagePaths(repo, ['doc.txt'])).rejects.toThrow('merge driver')
      expect(files()).toEqual(before)
      expect(stagesOf(repo)).toEqual(stages)
      expect(driverRuns(repo)).toBe('ran\n')
    })
  }

  // check-attr prints set for a bare merge attribute and unspecified for an absent one, the same words as merge=set and
  // merge=unspecified, so a driver configured under either word refuses both, though Git runs its text driver for the
  // bare and absent ones. Without such a driver, or when neither the attribute nor merge.default names one, the file
  // stays supported.
  test("set, text, and unspecified keep Git's text merge unless a driver of that name could run", async () => {
    for (const [attributes, driver, supported] of [
      ['doc.txt merge\n', 'set', false], [null, 'unspecified', false],
      ['doc.txt merge=set\n', null, true], ['doc.txt merge=unspecified\n', null, true], [null, 'text', true], [null, null, true],
    ] as const) {
      const repo = conflictRepo({
        base: 'old\n', ours: 'mine\n', theirs: 'yours\n',
        plain: attributes ? { '.gitattributes': attributes } : {},
        config: driver ? { [`merge.${driver}.driver`]: CANARY } : {},
      })
      const before = text(repo)
      expect(before).toContain('<<<<<<< HEAD\n')
      const model = await loadConflict(repo, 'doc.txt')
      expect(model.supported).toBe(supported)
      if (!supported) await expect(stagePaths(repo, ['doc.txt'])).rejects.toThrow('merge driver')
      expect(text(repo)).toBe(before)
      expect(driverRuns(repo)).toBe('')
    }
  }, 60_000)

  test('marker-looking text in an ordinary file is staged as written', async () => {
    const repo = conflictRepo({
      base: 'top\nold\nend\n',
      ours: 'top\nmine\nend\n',
      theirs: 'top\nyours\nend\n',
      plain: { 'notes.md': 'before\n' },
    })
    writeFileSync(path.join(repo, 'notes.md'), '<<<<<<< example\nnot a conflict\n')
    await expect(stagePaths(repo, ['notes.md'])).resolves.toBeUndefined()
  })

  test('a combined diff section does not attach to the file printed before it', async () => {
    const repo = conflictRepo({
      base: 'top\nold\nend\n',
      ours: 'top\nmine\nend\n',
      theirs: 'top\nyours\nend\n',
      plain: { 'a.txt': 'first\n' },
    })
    writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    const files = await workingDiff(repo, false)
    expect(files.map((file) => file.newPath)).toEqual(['a.txt'])
    expect(files[0].hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))).toEqual(['first', 'changed'])
  })

  test('combined diff headers and triple-at hunks cannot append to a regular diff', () => {
    const before = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-first\n+changed\n'
    const after = 'diff --git a/z.txt b/z.txt\n--- a/z.txt\n+++ b/z.txt\n@@ -1 +1 @@\n-last\n+final\n'
    for (const header of ['diff --cc doc.txt\n', 'diff --combined doc.txt\n', '']) {
      const files = parseDiff(before + header + '@@@ -1,1 -1,1 +1,1 @@@\n++conflict\n' + after)
      expect(files.map((file) => file.newPath)).toEqual(['a.txt', 'z.txt'])
      expect(files[0].hunks).toEqual(parseDiff(before)[0].hunks)
      expect(files[1].hunks).toEqual(parseDiff(after)[0].hunks)
    }
  })

  // The counterexample: normal markers keep only the differing first line, and diff3 or zdiff3 may widen the region.
  // Each style must either combine to the one correct result, or report that combining is unavailable. Never a guess.
  for (const style of ['merge', 'diff3', 'zdiff3'] as const) {
    test(`base boundary counterexample in ${style} style is combined correctly or refused`, async () => {
      const repo = conflictRepo({
        base: 'red fox jumps\nold\nend\n',
        ours: 'blue fox jumps\nshared\nend\n',
        theirs: 'red fox sleeps\nshared\nend\n',
        style,
      })
      const model = await loaded(repo)
      const [state] = model.combine
      if (state.state === 'ready') {
        // The block may be wider in diff3 style, since 'shared' sits inside its region. The saved file is the same either way.
        await resolve(repo, ['combine'])
        expect(text(repo)).toBe('blue fox sleeps\nshared\nend\n')
      } else {
        expect(['overlap', 'unavailable']).toContain(state.state)
        expect(text(repo)).toContain('<<<<<<< HEAD')
      }
    })
  }
})
