import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyChoices, BASE_REASON_TEXT, conflictBlocks, DEFAULT_MARKER_SIZE, fromMergeOutput, matchBasesAcrossRuns, MAX_CONFLICT_BLOCKS, parseConflicts,
  splitTokens, toMergeInput, withStageEnds,
  type BaseReason, type Combine, type ConflictBlock, type ConflictDocument, type ConflictFingerprint, type ConflictPreview,
  type ConflictReset, type ConflictResetResult, type ConflictResetState, type ConflictSave, type ConflictSaved, type ConflictTake, type Part,
  type StageBlock,
} from '../../shared/conflict'
import { gitRaw } from './exec'

// Limits keep one resolution bounded. A file over a limit is refused with its reason, never processed in part.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_TOKENS = 20_000
// git reports the conflict count as the exit code of merge-file, truncated to 127. Other codes are git errors.
const MERGE_CONFLICTS_MAX = 127
const STYLES = ['--diff3', '--zdiff3'] as const
// Concurrent git merge-file runs while combining one file's conflicts.
const COMBINE_WORKERS = 8
const REGULAR_MODES = new Set(['100644', '100755'])
const STALE = 'The file changed after it was loaded. Reload the conflict before saving.'
const STALE_RESET = 'The file changed after it was loaded. Reload the conflict before resetting.'
const STALE_TAKE = 'The file changed after it was loaded. Reload the conflict before choosing a side.'
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
  const driver = attributes.get('merge')
  if (size === undefined || driver === undefined) throw new ConflictRefusal('Git could not read the conflict attributes. Reload the conflict.')
  if (![String(DEFAULT_MARKER_SIZE), 'unspecified', 'set', 'unset'].includes(size)) {
    throw new ConflictRefusal(`This file uses conflict-marker-size=${size}. Only seven-character markers are supported. Resolve and stage it outside BetterGit.`)
  }
  const custom = new ConflictRefusal('This file uses a custom or non-text merge driver. Resolve and stage it outside BetterGit.')
  // git runs a driver configured under the attribute's name before its built-in ones. check-attr prints set, unset, and
  // unspecified both for those states and for a merge attribute with that literal value, so a driver configured under
  // the printed word refuses either reading. unset is refused anyway, as a binary merge or a custom name.
  // shortcut: a bare or absent merge attribute never runs such a driver, but refuses with it too. Upgrade if such files
  // need resolving here.
  if ((driver !== 'set' && driver !== 'text' && driver !== 'unspecified') || await configuresMergeDriver(repo, driver)) throw custom
  if (driver !== 'unspecified') return
  const configured = await gitRaw(repo, ['config', '--get', 'merge.default'])
  if (configured.code !== 0 && configured.code !== 1) throw new ConflictRefusal('Git could not read the merge driver. Reload the conflict.')
  // With no merge.default, git uses its built-in text driver without looking for a configured one.
  if (configured.code === 1) return
  const fallback = configured.stdout.toString('utf8').replace(/\n$/, '')
  if ((fallback !== 'set' && fallback !== 'text') || await configuresMergeDriver(repo, fallback)) throw custom
}

// Whether git has any setting for a merge driver of this name, which it would run before a built-in driver.
async function configuresMergeDriver(repo: string, name: string): Promise<boolean> {
  const listed = await gitRaw(repo, ['config', '--get-regexp', `^merge\\.${name}\\.`])
  if (listed.code !== 0 && listed.code !== 1) throw new ConflictRefusal('Git could not read the merge driver. Reload the conflict.')
  return listed.code === 0
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
  // Both are reads, so they run at once. Their refusals still come in this order.
  const listing = unmergedEntries(repo, checked)
  const format = assertSupportedConflictFormat(repo, checked)
  format.catch(() => {})
  const stages = await listing
  if (!stages) throw new ConflictRefusal('This file is not in a merge conflict.')
  requireTextualStages(stages)
  await format
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

type Sides = [Buffer, Buffer, Buffer]

// Each git spawn costs tens of milliseconds, so one snapshot's load, combine, and reset share a single read of its sides.
const sidesRead = new WeakMap<Snapshot, Promise<Sides>>()

// The three stage sides as bytes, ours, base, theirs. Sizes come first, in one call, so an oversized blob is never
// read. Throws a refusal when git lacks a side, or a side is too large or not text.
function readStageSides(repo: string, snapshot: Snapshot): Promise<Sides> {
  let read = sidesRead.get(snapshot)
  if (!read) {
    read = readSides(repo, snapshot.stages)
    read.catch(() => {})
    sidesRead.set(snapshot, read)
  }
  return read
}

async function readSides(repo: string, stages: Map<number, StageEntry>): Promise<Sides> {
  const unreadable = new ConflictRefusal('Git could not read a version of this file, so it cannot be reset.')
  const shas = [2, 1, 3].map((stage) => stages.get(stage)?.sha)
  if (shas.some((sha) => !sha)) throw unreadable
  const input = Buffer.from(`${shas.join('\n')}\n`)
  const sizes = await gitRaw(repo, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], input)
  const listed = sizes.stdout.toString('utf8').trim().split('\n')
  if (sizes.code !== 0 || listed.length !== 3 || listed.some((line) => !/^blob \d+$/.test(line))) throw unreadable
  if (listed.some((line) => Number(line.slice(5)) > MAX_BYTES)) throw new ConflictRefusal(TOO_LARGE)
  const batch = await gitRaw(repo, ['cat-file', '--batch'], input)
  const blobs = batch.code === 0 ? batchBlobs(batch.stdout, 3) : null
  if (!blobs || blobs.some((blob) => blob.length > MAX_BYTES)) throw unreadable
  if (blobs.some((blob) => decodeText(blob) === null)) {
    throw new ConflictRefusal('A version of this file in Git is not UTF-8 text, so it cannot be reset here.')
  }
  return [blobs[0], blobs[1], blobs[2]]
}

// `git cat-file --batch` prints each object as "<sha> <type> <size>", a newline, its bytes, and a newline. Null unless
// the output holds `count` blobs.
export function batchBlobs(output: Buffer, count: number): Buffer[] | null {
  const blobs: Buffer[] = []
  let at = 0
  while (blobs.length < count) {
    const end = output.indexOf(10, at)
    const header = end < 0 ? null : /^[0-9a-f]+ blob (\d+)$/.exec(output.subarray(at, end).toString('latin1'))
    if (!header) return null
    const start = end + 1
    const stop = start + Number(header[1])
    if (stop >= output.length || output[stop] !== 10) return null
    blobs.push(output.subarray(start, stop))
    at = stop + 1
  }
  return blobs
}

// The same sides for combining, or null when they cannot be read within the limits.
async function stageSides(repo: string, snapshot: Snapshot): Promise<Sides | null> {
  try {
    return await readStageSides(repo, snapshot)
  } catch (error) {
    if (error instanceof ConflictRefusal) return null
    throw error
  }
}

// git's 3-way merge of the stage sides, printed with seven-character markers and the given side labels. The inputs
// are temp files, so nothing in the repository is read or written.
async function mergeSides([ours, base, theirs]: [Buffer, Buffer, Buffer], style: (typeof STYLES)[number], labels: [string, string, string]) {
  return withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'ours'), ours)
    await fs.writeFile(path.join(dir, 'base'), base)
    await fs.writeFile(path.join(dir, 'theirs'), theirs)
    return gitRaw(dir, ['merge-file', style, '-p', `--marker-size=${DEFAULT_MARKER_SIZE}`,
      '-L', labels[0], '-L', labels[1], '-L', labels[2], 'ours', 'base', 'theirs'])
  })
}

// git's 3-way merge of the stage sides in one marker style. Null when git's answer cannot be read as conflict blocks.
async function mergeStages(sides: [Buffer, Buffer, Buffer], style: (typeof STYLES)[number]): Promise<StageBlock[] | null> {
  const merged = await mergeSides(sides, style, ['ours', 'base', 'theirs'])
  if (merged.code === 0) return []
  if (merged.code < 1 || merged.code > MERGE_CONFLICTS_MAX) return null
  const text = decodeText(merged.stdout)
  const parsed = text === null ? null : parseConflicts(text)
  if (parsed === null || !parsed.ok) return null
  return conflictBlocks(parsed.parts).map((block) => ({ current: block.current, base: block.fileBase, incoming: block.incoming }))
}

// One run per marker style, so a file written in any style can find its base. Null when git's stages cannot be read.
async function stageRuns(repo: string, snapshot: Snapshot): Promise<StageBlock[][] | null> {
  const sides = await stageSides(repo, snapshot)
  if (!sides) return null
  const runs = await Promise.all(STYLES.map((style) => mergeStages(sides, style)))
  return runs.every((run) => run !== null) ? runs : null
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
  const runs = await stageRuns(repo, snapshot)
  if (!runs) return blocks.map(() => unavailable('unreadable'))
  const matches = matchBasesAcrossRuns(blocks, runs)
  const states = new Array<Combine>(matches.length)
  // Each combine is one git spawn, so a file with many conflicts runs a few at once instead of one after another.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(COMBINE_WORKERS, matches.length) }, async () => {
    while (next < matches.length) {
      const index = next++
      const match = matches[index]
      states[index] = match.state === 'matched' ? await combineBlock(blocks[index], match.base) : unavailable(match.reason)
    }
  }))
  return states
}

// One stage as text, or null when git cannot give it as a blob within the size limit, or it is not text.
async function stageText(repo: string, sha: string): Promise<string | null> {
  const size = await gitRaw(repo, ['cat-file', '-s', sha])
  if (size.code !== 0 || Number(size.stdout.toString('utf8')) > MAX_BYTES) return null
  const blob = await gitRaw(repo, ['cat-file', 'blob', sha])
  return blob.code === 0 ? decodeText(blob.stdout) : null
}

// The parts, with the block that ends the file marked from stages 2 and 3, ours and theirs. The stages are in the
// fingerprint, so a save reads the same stage ends as the load it was reviewed from.
async function withStageEndsOf(repo: string, snapshot: Snapshot, parts: Part[]): Promise<Part[]> {
  if (parts.at(-1)?.kind !== 'conflict') return parts
  // The shared read holds both stages as text when it succeeds. Otherwise each stage is read on its own.
  const sides = snapshot.stages.has(1) ? await stageSides(repo, snapshot) : null
  if (sides) return withStageEnds(parts, decodeText(sides[0]), decodeText(sides[2]))
  const [ours, theirs] = await Promise.all([2, 3].map((stage) => stageText(repo, snapshot.stages.get(stage)!.sha)))
  return withStageEnds(parts, ours, theirs)
}

// Reset writes git's raw stage text, so it refuses any path whose checkout would convert those bytes. The attributes
// are checked first, so a configured filter command never runs. Then git's own checkout conversion of every stage must
// equal its raw bytes, which catches line-ending conversion from autocrlf, eol, or core.eol.
// shortcut: stages with no newline do not reveal CRLF conversion, so their recreated markers end in LF. Git normalizes
// them again on add. Upgrade if such files need checkout-exact markers.
async function assertRawCheckout(repo: string, snapshot: Snapshot, sides: Promise<Sides>): Promise<void> {
  const listed = await gitRaw(repo, ['check-attr', '-z', 'filter', 'ident', 'working-tree-encoding', '--', snapshot.relPath])
  if (listed.code !== 0) throw new ConflictRefusal('Git could not read the checkout attributes. Reload the conflict.')
  const fields = listed.stdout.toString('utf8').split('\0')
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [name, value] = [fields[index + 1], fields[index + 2]]
    if (fields[index] !== snapshot.relPath) continue
    if (value !== 'unspecified' && value !== 'unset') {
      throw new ConflictRefusal(`This file uses the ${name} attribute, so Git changes it on checkout. Reset it outside BetterGit.`)
    }
    // check-attr prints the same word for filter=unset or filter=unspecified as for an inactive filter, and git runs a
    // driver configured under that name. The two cannot be told apart, so any such driver refuses before it can run.
    if (name === 'filter') {
      const drivers = await gitRaw(repo, ['config', '--get-regexp', `^filter\\.${value}\\.(smudge|process)$`])
      if (drivers.code === 0) {
        throw new ConflictRefusal(`Git has a filter driver named ${value}, which may change this file on checkout. Reset it outside BetterGit.`)
      }
      if (drivers.code !== 1) throw new ConflictRefusal('Git could not read the filter configuration. Reload the conflict.')
    }
  }
  const shas = [2, 1, 3].map((stage) => snapshot.stages.get(stage)!.sha)
  const converted = await Promise.all(shas.map((sha) => gitRaw(repo, ['cat-file', '--filters', `--path=${snapshot.relPath}`, sha])))
  if (converted.some((result) => result.code !== 0)) throw new ConflictRefusal('Git could not read a version of this file, so it cannot be reset.')
  const raw = await sides
  if (converted.some((result, index) => !result.stdout.equals(raw[index]))) {
    throw new ConflictRefusal('Git converts this file on checkout, such as its line endings, so it cannot be reset here.')
  }
}

// The whole file recreated from git's index stages as canonical diff3 conflicts, with its parsed parts. It does not
// recover old branch labels or a file written in another style. Anything git cannot recreate safely is refused.
async function reconstruct(repo: string, snapshot: Snapshot): Promise<{ bytes: Buffer; parts: Part[]; blocks: ConflictBlock[] }> {
  if (!snapshot.stages.has(1)) {
    throw new ConflictRefusal('Git has no common base for this conflict, so it cannot be recreated. Resolve it outside BetterGit.')
  }
  // The checkout check, the read and the merge are independent reads, so they run at once. Refusals keep this order.
  const reading = readStageSides(repo, snapshot)
  const checking = assertRawCheckout(repo, snapshot, reading)
  checking.catch(() => {})
  const sides = await reading
  const merging = mergeSides(sides, '--diff3', ['Current', 'Base', 'Incoming'])
  merging.catch(() => {})
  await checking
  const merged = await merging
  if (merged.code === 0) throw new ConflictRefusal('Git merges these versions without a conflict, so there is no conflict to recreate.')
  if (merged.code < 1 || merged.code > MERGE_CONFLICTS_MAX) throw new ConflictRefusal('Git could not recreate this conflict.')
  if (merged.stdout.length > MAX_BYTES) throw new ConflictRefusal(TOO_LARGE)
  const text = decodeText(merged.stdout)
  const parsed = text === null ? null : parseConflicts(text)
  if (parsed === null || !parsed.ok) throw new ConflictRefusal('Git recreated a conflict that BetterGit cannot read.')
  const blocks = conflictBlocks(parsed.parts)
  if (blocks.length === 0) throw new ConflictRefusal('Git merges these versions without a conflict, so there is no conflict to recreate.')
  if (blocks.length > MAX_CONFLICT_BLOCKS) throw new ConflictRefusal(TOO_MANY_CONFLICTS)
  // readStageSides checked that the sides are text, so these parts carry the same stage ends a load marks.
  return { bytes: merged.stdout, parts: withStageEnds(parsed.parts, decodeText(sides[0]), decodeText(sides[2])), blocks }
}

// Reset is offered only when the recreation would succeed now, whatever the working markers look like.
async function resetState(repo: string, snapshot: Snapshot): Promise<ConflictResetState> {
  try {
    await reconstruct(repo, snapshot)
    return { available: true, fingerprint: snapshot.fingerprint }
  } catch (error) {
    if (error instanceof ConflictRefusal) return { available: false, reason: error.message }
    throw error
  }
}

// What the UI shows for one file: its parts with combine states, or the reason it cannot be resolved here.
export async function loadConflict(repo: string, relPath: string): Promise<ConflictDocument> {
  try {
    const snapshot = await readSnapshot(repo, relPath)
    // The reset check reads git on its own, so it runs alongside the combine states.
    const resetting = resetState(repo, snapshot)
    const parsed = parseConflicts(snapshot.text)
    if (!parsed.ok) return { supported: false, message: parsed.failure.message, reset: await resetting }
    const blocks = conflictBlocks(parsed.parts)
    if (blocks.length > MAX_CONFLICT_BLOCKS) return { supported: false, message: TOO_MANY_CONFLICTS, reset: await resetting }
    const [parts, combine, reset] = await Promise.all([withStageEndsOf(repo, snapshot, parsed.parts), combineStates(repo, snapshot, blocks), resetting])
    return { supported: true, fingerprint: snapshot.fingerprint, parts, combine, reset }
  } catch (error) {
    if (error instanceof ConflictRefusal) return { supported: false, message: error.message, reset: { available: false, reason: error.message } }
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
  const applied = applyChoices(await withStageEndsOf(repo, snapshot, parsed.parts), save.choices, combine)
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

// Replaces the whole working file with the conflicts recreated from git's index stages. The index is only read, so the
// file stays unmerged. The returned document is built before the write, and returned only after the rename.
export async function resetConflict(repo: string, relPath: string, request: ConflictReset): Promise<ConflictResetResult> {
  const snapshot = await readSnapshot(repo, relPath)
  if (!sameFingerprint(snapshot.fingerprint, request.fingerprint)) throw new ConflictRefusal(STALE_RESET)
  const { bytes, parts, blocks } = await reconstruct(repo, snapshot)
  const combine = await combineStates(repo, snapshot, blocks)
  const fingerprint = { working: digest(bytes), stages: snapshot.fingerprint.stages }
  // The stages are unchanged, so recreating from the fresh snapshot rechecks the attributes and conversion that could have.
  await replaceWorkingFile(repo, snapshot, bytes, STALE_RESET, async (again) => {
    if (!(await reconstruct(repo, again)).bytes.equals(bytes)) throw new ConflictRefusal(STALE_RESET)
  })
  return { supported: true, fingerprint, parts, combine, reset: { available: true, fingerprint } }
}

// Replaces the whole working file with one side from git's index, the way `git checkout --ours` or `--theirs` does,
// so git's own checkout conversion applies. The index is only read, so the file stays unmerged until it is staged. The
// snapshot repeats the checks a load made, and the fingerprint binds the write to the file the user confirmed.
export async function takeConflictSide(repo: string, relPath: string, request: ConflictTake): Promise<void> {
  const snapshot = await readSnapshot(repo, relPath)
  if (!sameFingerprint(snapshot.fingerprint, request.fingerprint)) throw new ConflictRefusal(STALE_TAKE)
  // A post-checkout hook could modify unrelated files or stage this file before the user chooses Stage.
  const done = await gitRaw(repo, ['-c', 'core.hooksPath=/dev/null', '--literal-pathspecs', 'checkout', `--${request.side}`, '--', snapshot.relPath])
  if (done.code !== 0) throw new ConflictRefusal(done.stderr || `Git could not check out ${request.side}.`)
}
