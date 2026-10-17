import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyChoices, BASE_REASON_TEXT, conflictBlocks, DEFAULT_MARKER_SIZE, fromMergeOutput, matchBasesAcrossRuns, MAX_CONFLICT_BLOCKS, parseConflicts,
  splitTokens, toMergeInput,
  type BaseReason, type Combine, type ConflictBlock, type ConflictDocument, type ConflictFingerprint, type ConflictPreview,
  type ConflictSave, type ConflictSaved, type StageBlock,
} from '../../shared/conflict'
import { gitRaw } from './exec'

// Limits keep one resolution bounded. A file over a limit is refused with its reason, never processed in part.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_TOKENS = 20_000
// git reports the conflict count as the exit code of merge-file, truncated to 127. Other codes are git errors.
const MERGE_CONFLICTS_MAX = 127
const STYLES = ['--diff3', '--zdiff3'] as const
const REGULAR_MODES = new Set(['100644', '100755'])
const STALE = 'The file changed after it was loaded. Reload the conflict before saving.'
const TOO_MANY_CONFLICTS = `This file has more than ${MAX_CONFLICT_BLOCKS} conflicts. Resolve it outside BetterGit.`
const TOO_LARGE = 'This file is too large to resolve here.'

// A refusal the user can act on. Its message reaches the renderer unchanged.
export class ConflictRefusal extends Error {}

// The parser and stage reconstruction support Git's ordinary text driver and seven-character markers only.
// Refuse other formats before treating a marker-free parse as resolved, including when staging an unmerged path.
export async function assertSupportedConflictFormat(repo: string, relPath: string): Promise<void> {
  const listed = await gitRaw(repo, ['check-attr', '-z', 'conflict-marker-size', 'merge', '--', relPath])
  if (listed.code !== 0) throw new ConflictRefusal('Git could not read the conflict attributes. Reload the conflict.')
  const fields = listed.stdout.toString('utf8').split('\0')
  const attributes = new Map<string, string>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index] === relPath) attributes.set(fields[index + 1], fields[index + 2])
  }
  const size = attributes.get('conflict-marker-size')
  let driver = attributes.get('merge')
  if (size === undefined || driver === undefined) throw new ConflictRefusal('Git could not read the conflict attributes. Reload the conflict.')
  if (![String(DEFAULT_MARKER_SIZE), 'unspecified', 'set', 'unset'].includes(size)) {
    throw new ConflictRefusal(`This file uses conflict-marker-size=${size}. Only seven-character markers are supported. Resolve and stage it outside BetterGit.`)
  }
  if (driver === 'unspecified') {
    const configured = await gitRaw(repo, ['config', '--get', 'merge.default'])
    if (configured.code !== 0 && configured.code !== 1) throw new ConflictRefusal('Git could not read the merge driver. Reload the conflict.')
    // With no merge.default, git uses its built-in text driver without looking for a configured one.
    if (configured.code === 1) return
    driver = configured.stdout.toString('utf8').trim()
  }
  // git runs a driver configured under the selected name before its built-in ones, so set and text can name one too.
  // shortcut: check-attr prints set for a bare merge attribute as well, which never runs a driver, so a configured set
  // driver refuses it too. Upgrade if such files need resolving here.
  if (driver === 'set' || driver === 'text') {
    const custom = await gitRaw(repo, ['config', '--get-regexp', `^merge\\.${driver}\\.`])
    if (custom.code !== 0 && custom.code !== 1) throw new ConflictRefusal('Git could not read the merge driver. Reload the conflict.')
    if (custom.code === 1) return
  }
  throw new ConflictRefusal('This file uses a custom or non-text merge driver. Resolve and stage it outside BetterGit.')
}

interface StageEntry {
  stage: number
  mode: string
  sha: string
  // The raw index record, so the stage digest covers exactly what git listed.
  record: string
}

interface Snapshot {
  // The checked path relative to the repository, as git lists it.
  relPath: string
  file: string
  mode: number
  fingerprint: ConflictFingerprint
  text: string
  stages: Map<number, StageEntry>
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

const sameFingerprint = (a: ConflictFingerprint, b: ConflictFingerprint) => a.working === b.working && a.stages === b.stages

// The text of a file with no NUL bytes and valid UTF-8. A byte order mark stays in the text. Null for anything else.
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return null
  }
}

// Paths come from the renderer, so only plain relative paths pass. The index check below decides which paths are real.
function checkRelativePath(relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096 || /[\0\n]/.test(relPath)) {
    throw new ConflictRefusal('The file path is not valid.')
  }
  if (path.isAbsolute(relPath) || relPath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new ConflictRefusal('The file path must be relative to the repository.')
  }
  return relPath
}

// The index entries git lists as unmerged for this exact path. Null when the path is not unmerged.
async function unmergedEntries(repo: string, relPath: string): Promise<Map<number, StageEntry> | null> {
  const listed = await gitRaw(repo, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', relPath])
  if (listed.code !== 0) throw new ConflictRefusal(`Git could not list the conflict: ${listed.stderr || 'unknown error'}`)
  const stages = new Map<number, StageEntry>()
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== relPath) continue
    const [mode, sha, stage] = record.slice(0, tab).split(' ')
    stages.set(Number(stage), { stage: Number(stage), mode, sha, record })
  }
  return stages.size > 0 ? stages : null
}

function requireTextualStages(stages: Map<number, StageEntry>): void {
  if (!stages.has(2) || !stages.has(3)) {
    throw new ConflictRefusal('Only conflicts changed on both sides are resolved here. Delete and add conflicts need another tool.')
  }
  for (const entry of stages.values()) {
    if (!REGULAR_MODES.has(entry.mode)) throw new ConflictRefusal('Symbolic links and submodules are not resolved here.')
  }
}

const stageDigest = (stages: Map<number, StageEntry>) =>
  digest([...stages.values()].sort((a, b) => a.stage - b.stage).map((entry) => entry.record).join('\n'))

// The working file and the index stages of one unmerged path, read and checked together. Anything unsupported throws.
async function readSnapshot(repo: string, relPath: unknown): Promise<Snapshot> {
  const checked = checkRelativePath(relPath)
  const stages = await unmergedEntries(repo, checked)
  if (!stages) throw new ConflictRefusal('This file is not in a merge conflict.')
  requireTextualStages(stages)
  await assertSupportedConflictFormat(repo, checked)
  const root = await fs.realpath(repo)
  const file = path.join(root, checked)
  const missing = new ConflictRefusal('The conflicted file is missing from the working tree.')
  // The parent folder must resolve inside the repository, so a symbolic link cannot send the write elsewhere.
  const parent = await fs.realpath(path.dirname(file)).catch(() => null)
  if (parent === null) throw missing
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new ConflictRefusal('This file is outside the repository.')
  const info = await fs.lstat(file).catch(() => null)
  if (!info) throw missing
  if (!info.isFile()) throw new ConflictRefusal('Only regular files are resolved here. Symbolic links and folders are not resolved.')
  if (info.size > MAX_BYTES) throw new ConflictRefusal(TOO_LARGE)
  const bytes = await fs.readFile(file)
  if (bytes.length > MAX_BYTES) throw new ConflictRefusal(TOO_LARGE)
  const text = decodeText(bytes)
  if (text === null) {
    throw new ConflictRefusal(bytes.includes(0)
      ? 'This file contains NUL bytes, so it is not text. Resolve it outside BetterGit.'
      : 'This file is not valid UTF-8 text, so it cannot be resolved here.')
  }
  return { relPath: checked, file, mode: info.mode & 0o7777, fingerprint: { working: digest(bytes), stages: stageDigest(stages) }, text, stages }
}

async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bettergit-merge-'))
  try {
    return await work(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// The three stage sides as bytes, ours, base, theirs. Sizes come first, in one call, so an oversized blob is never
// read. Throws a refusal when git lacks a side, or a side is too large or not text.
async function readStageSides(repo: string, stages: Map<number, StageEntry>): Promise<[Buffer, Buffer, Buffer]> {
  const unreadable = new ConflictRefusal('Git could not read a version of this file, so it cannot be reset.')
  const shas = [2, 1, 3].map((stage) => stages.get(stage)?.sha)
  if (shas.some((sha) => !sha)) throw unreadable
  const sizes = await gitRaw(repo, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], Buffer.from(`${shas.join('\n')}\n`))
  const listed = sizes.stdout.toString('utf8').trim().split('\n')
  if (sizes.code !== 0 || listed.length !== 3 || listed.some((line) => !/^blob \d+$/.test(line))) throw unreadable
  if (listed.some((line) => Number(line.slice(5)) > MAX_BYTES)) throw new ConflictRefusal(TOO_LARGE)
  const blobs = await Promise.all(shas.map((sha) => gitRaw(repo, ['cat-file', 'blob', sha!])))
  if (blobs.some((blob) => blob.code !== 0 || blob.stdout.length > MAX_BYTES)) throw unreadable
  if (blobs.some((blob) => decodeText(blob.stdout) === null)) {
    throw new ConflictRefusal('A version of this file in Git is not UTF-8 text, so it cannot be reset here.')
  }
  return [blobs[0].stdout, blobs[1].stdout, blobs[2].stdout]
}

// The same sides for combining, or null when they cannot be read within the limits.
async function stageSides(repo: string, stages: Map<number, StageEntry>): Promise<[Buffer, Buffer, Buffer] | null> {
  try {
    return await readStageSides(repo, stages)
  } catch (error) {
    if (error instanceof ConflictRefusal) return null
    throw error
  }
}

// git's 3-way merge of the stage sides in one marker style. Null when git's answer cannot be read as conflict blocks.
async function mergeStages([ours, base, theirs]: [Buffer, Buffer, Buffer], style: (typeof STYLES)[number]): Promise<StageBlock[] | null> {
  return withTempDir<StageBlock[] | null>(async (dir) => {
    await fs.writeFile(path.join(dir, 'ours'), ours)
    await fs.writeFile(path.join(dir, 'base'), base)
    await fs.writeFile(path.join(dir, 'theirs'), theirs)
    const merged = await gitRaw(dir, ['merge-file', style, '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'])
    if (merged.code === 0) return []
    if (merged.code < 1 || merged.code > MERGE_CONFLICTS_MAX) return null
    const text = decodeText(merged.stdout)
    const parsed = text === null ? null : parseConflicts(text)
    if (parsed === null || !parsed.ok) return null
    return conflictBlocks(parsed.parts).map((block) => ({ current: block.current, base: block.fileBase, incoming: block.incoming }))
  })
}

// One run per marker style, so a file written in any style can find its base. Null when git's stages cannot be read.
async function stageRuns(repo: string, stages: Map<number, StageEntry>): Promise<StageBlock[][] | null> {
  const sides = await stageSides(repo, stages)
  if (!sides) return null
  const runs: StageBlock[][] = []
  for (const style of STYLES) {
    const run = await mergeStages(sides, style)
    if (!run) return null
    runs.push(run)
  }
  return runs
}

// git's 3-way merge of one block over token records. A clean merge returns text. An overlap stays a manual choice.
async function combineBlock(block: ConflictBlock, base: string): Promise<Combine> {
  const tokens = splitTokens(block.current).length + splitTokens(base).length + splitTokens(block.incoming).length
  if (tokens > MAX_TOKENS) return { state: 'unavailable', reason: 'This conflict is too large to combine here.' }
  let records: [string, string, string]
  try {
    records = [toMergeInput(block.current), toMergeInput(base), toMergeInput(block.incoming)]
  } catch {
    return { state: 'unavailable', reason: 'This conflict cannot be encoded for combining.' }
  }
  return withTempDir<Combine>(async (dir) => {
    await fs.writeFile(path.join(dir, 'current'), records[0])
    await fs.writeFile(path.join(dir, 'base'), records[1])
    await fs.writeFile(path.join(dir, 'incoming'), records[2])
    const merged = await gitRaw(dir, ['merge-file', '-p', 'current', 'base', 'incoming'])
    if (merged.code === 0) {
      try {
        return { state: 'ready', text: fromMergeOutput(merged.stdout.toString('utf8')) }
      } catch {
        return { state: 'unavailable', reason: 'Git returned a merge this file cannot read, so combining is unavailable.' }
      }
    }
    if (merged.code >= 1 && merged.code <= MERGE_CONFLICTS_MAX) return { state: 'overlap' }
    return { state: 'unavailable', reason: 'Git could not merge this conflict, so combining is unavailable.' }
  })
}

// One Combine per block, by block index. A block is merged only from a base that matches it exactly.
async function combineStates(repo: string, snapshot: Snapshot, blocks: ConflictBlock[]): Promise<Combine[]> {
  if (blocks.length === 0) return []
  const unavailable = (reason: BaseReason): Combine => ({ state: 'unavailable', reason: BASE_REASON_TEXT[reason] })
  if (!snapshot.stages.has(1)) return blocks.map(() => unavailable('no-ancestor'))
  const runs = await stageRuns(repo, snapshot.stages)
  if (!runs) return blocks.map(() => unavailable('unreadable'))
  const states: Combine[] = []
  for (const [index, match] of matchBasesAcrossRuns(blocks, runs).entries()) {
    states.push(match.state === 'matched' ? await combineBlock(blocks[index], match.base) : unavailable(match.reason))
  }
  return states
}

// What the UI shows for one file: its parts with combine states, or the reason it cannot be resolved here.
export async function loadConflict(repo: string, relPath: string): Promise<ConflictDocument> {
  try {
    const snapshot = await readSnapshot(repo, relPath)
    const parsed = parseConflicts(snapshot.text)
    if (!parsed.ok) return { supported: false, message: parsed.failure.message }
    const blocks = conflictBlocks(parsed.parts)
    if (blocks.length > MAX_CONFLICT_BLOCKS) return { supported: false, message: TOO_MANY_CONFLICTS }
    return { supported: true, fingerprint: snapshot.fingerprint, parts: parsed.parts, combine: await combineStates(repo, snapshot, blocks) }
  } catch (error) {
    if (error instanceof ConflictRefusal) return { supported: false, message: error.message }
    throw error
  }
}

// The text the choices produce from the file as it is now. The fingerprint is checked before anything is built.
async function resolve(repo: string, relPath: string, save: ConflictSave): Promise<{ snapshot: Snapshot; text: string; unresolved: number }> {
  const snapshot = await readSnapshot(repo, relPath)
  if (!sameFingerprint(snapshot.fingerprint, save.fingerprint)) throw new ConflictRefusal(STALE)
  const parsed = parseConflicts(snapshot.text)
  if (!parsed.ok) throw new ConflictRefusal(parsed.failure.message)
  const blocks = conflictBlocks(parsed.parts)
  if (blocks.length > MAX_CONFLICT_BLOCKS) throw new ConflictRefusal(TOO_MANY_CONFLICTS)
  if (save.choices.length !== blocks.length) throw new ConflictRefusal('The choices no longer match the conflicts in this file. Reload the conflict.')
  const combine = save.choices.includes('combine') ? await combineStates(repo, snapshot, blocks) : []
  const applied = applyChoices(parsed.parts, save.choices, combine)
  if (!applied.ok) throw new ConflictRefusal(applied.reason)
  if (Buffer.byteLength(applied.text, 'utf8') > MAX_BYTES) throw new ConflictRefusal(TOO_LARGE)
  return { snapshot, text: applied.text, unresolved: applied.unresolved }
}

export async function previewConflict(repo: string, relPath: string, save: ConflictSave): Promise<ConflictPreview> {
  const { text, unresolved } = await resolve(repo, relPath, save)
  return { text, unresolved }
}

// Writes bytes to a temp file beside the original, checks the file, its stages, place and mode once more, then renames
// the temp file over the original. Nothing is staged, and nothing is retried. `recheck` adds a caller's own last check.
async function replaceWorkingFile(repo: string, snapshot: Snapshot, bytes: Buffer, stale: string, recheck?: (again: Snapshot) => Promise<void>) {
  const temp = path.join(path.dirname(snapshot.file), `.${path.basename(snapshot.file)}.bettergit-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
    await fs.chmod(temp, snapshot.mode)
    const again = await readSnapshot(repo, snapshot.relPath)
    if (!sameFingerprint(again.fingerprint, snapshot.fingerprint) || again.file !== snapshot.file || again.mode !== snapshot.mode) {
      throw new ConflictRefusal(stale)
    }
    await recheck?.(again)
    await fs.rename(temp, snapshot.file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function saveConflict(repo: string, relPath: string, save: ConflictSave): Promise<ConflictSaved> {
  const { snapshot, text, unresolved } = await resolve(repo, relPath, save)
  const bytes = Buffer.from(text, 'utf8')
  await replaceWorkingFile(repo, snapshot, bytes, STALE)
  return { fingerprint: { working: digest(bytes), stages: snapshot.fingerprint.stages }, unresolved }
}
