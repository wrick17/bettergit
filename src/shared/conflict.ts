// Conflict blocks as plain text. Pure functions only. The renderer previews with them, and the main process
// will save with the same functions, so the preview is the text that gets written.

export const DEFAULT_MARKER_SIZE = 7

// Current is the HEAD side (ours). Incoming is the merging side (theirs). Both joins them in order with no merge.
// Combine is a base-aware merge of the two edits, computed by git.
export type ChoiceKind = 'current' | 'incoming' | 'both' | 'combine'

// Null means unresolved. An unresolved block keeps its markers.
export type Choice = ChoiceKind | null

export interface TextPart {
  kind: 'text'
  text: string
}

export interface ConflictBlock {
  kind: 'conflict'
  // Position among the file's conflicts, counted from zero.
  index: number
  // Marker lines as written, terminators included. An unresolved block is written back from these.
  markers: { open: string; base: string | null; split: string; close: string }
  current: string
  // The base section of a diff3 style file. It is for display. Combining uses the stage base instead.
  fileBase: string | null
  incoming: string
  currentLabel: string
  incomingLabel: string
  // Characters Git added after each side's last line only so the next marker starts a line. Git writes the same markers
  // whether or not a side's version ends with a newline, so the parser never sets this. withStageEnds sets it from the
  // index stages, on the block that ends the file. Absent means none.
  addedNewline?: { current: number; incoming: number }
}

export type Part = TextPart | ConflictBlock

export interface ParseFailure {
  code: 'binary' | 'malformed'
  message: string
}

export type ParseResult = { ok: true; parts: Part[] } | { ok: false; failure: ParseFailure }

// Ready text replaces its block. It ends with a newline, like the sides it replaces.
export type Combine =
  | { state: 'ready'; text: string }
  | { state: 'overlap' }
  | { state: 'unavailable'; reason: string }

// What the file looked like when it was loaded: the working bytes and the index stages. The UI echoes it back on save,
// so a save writes only if the file is still the one the user reviewed. Opaque to the UI.
export interface ConflictFingerprint {
  working: string
  stages: string
}

// Whether the whole file can be rebuilt from Git's index stages. It does not depend on the working markers, so a file
// with broken markers or none left can still be reset. The fingerprint is the one a reset must match.
export type ConflictResetState =
  | { available: true; fingerprint: ConflictFingerprint }
  | { available: false; reason: string }

// Either the reason a file cannot be resolved here, or its parts with one Combine per block, by block index.
export type ConflictDocument = (
  | { supported: false; message: string }
  | { supported: true; fingerprint: ConflictFingerprint; parts: Part[]; combine: Combine[] }
) & { reset: ConflictResetState }

// A reset request carries only the fingerprint the user confirmed. The main process builds the text itself.
export interface ConflictReset {
  fingerprint: ConflictFingerprint
}

export type ConflictResetResult = Extract<ConflictDocument, { supported: true }>

export interface ConflictSave {
  fingerprint: ConflictFingerprint
  choices: Choice[]
}

export type ApplyResult = { ok: true; text: string; unresolved: number } | { ok: false; index: number; reason: string }

export interface ConflictPreview {
  text: string
  unresolved: number
}

export interface ConflictSaved {
  fingerprint: ConflictFingerprint
  unresolved: number
}

// Limits one resolution to a size the main process can finish. Larger files are refused with a reason.
export const MAX_CONFLICT_BLOCKS = 200

export type BaseReason = 'no-ancestor' | 'boundary' | 'ambiguous' | 'unreadable'

export const BASE_REASON_TEXT: Record<BaseReason, string> = {
  'no-ancestor': 'This file has no common ancestor, so its edits cannot be combined.',
  boundary: 'This block does not match Git\'s conflict boundaries, so its base is unknown and combining is unavailable. Choose current, incoming, or both.',
  ambiguous: 'Identical conflicts cannot be matched to one base, so combining is unavailable.',
  unreadable: 'Git\'s base for this file could not be read, so combining is unavailable.',
}

const BINARY_MESSAGE = 'This file contains NUL bytes, so it is not text. Resolve it outside BetterGit.'

type MarkerKind = 'open' | 'base' | 'split' | 'close' | 'unsupported' | 'content'

// Splits after every newline and keeps each terminator, so joining the lines gives the input back exactly.
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

export function conflictBlocks(parts: readonly Part[]): ConflictBlock[] {
  return parts.filter((part): part is ConflictBlock => part.kind === 'conflict')
}

export function parseConflicts(input: string, markerSize = DEFAULT_MARKER_SIZE): ParseResult {
  if (input.includes('\0')) return { ok: false, failure: { code: 'binary', message: BINARY_MESSAGE } }
  // A byte order mark is kept as text before the first part, so a resolution never drops it.
  const bom = input.startsWith('﻿') ? '﻿' : ''
  const patterns = {
    open: new RegExp(`^<{${markerSize}}(?: |$)`),
    base: new RegExp(`^\\|{${markerSize}}(?: |$)`),
    split: new RegExp(`^={${markerSize}}$`),
    close: new RegExp(`^>{${markerSize}}(?: |$)`),
  }
  const kindOf = (text: string): MarkerKind => {
    if (patterns.open.test(text)) return 'open'
    if (patterns.base.test(text)) return 'base'
    if (patterns.split.test(text)) return 'split'
    if (patterns.close.test(text)) return 'close'
    // Attribute edits cannot turn existing marker runs into ordinary text. Standalone '=' lines remain Markdown.
    const marker = /^(<+|\|+|>+)(?: |$)/.exec(text)
    if (marker && marker[1].length >= DEFAULT_MARKER_SIZE) return 'unsupported'
    return 'content'
  }
  const labelOf = (line: string) => line.replace(/\r?\n?$/, '').slice(markerSize + 1)
  const fail = (message: string): ParseResult => ({ ok: false, failure: { code: 'malformed', message } })

  const parts: Part[] = []
  let plain = bom
  let state: 'text' | 'current' | 'base' | 'incoming' = 'text'
  let startedAt = 0
  let open = ''
  let currentLabel = ''
  let current = ''
  let baseMarker: string | null = null
  let baseText = ''
  let split = ''
  let incoming = ''
  let blocks = 0
  // Short runs also occur in prose and code. Only a matching opening/separator/closing sequence is refused.
  // Each width only advances: a literal opening in the body must not discard an observed separator.
  const shortStates = new Map<number, 'current' | 'incoming'>()

  for (const [position, line] of splitLines(input.slice(bom.length)).entries()) {
    const number = position + 1
    const text = line.replace(/\r?\n?$/, '')
    const short = /^(<+)(?: |$)|^(=+)$|^(>+)(?: |$)/.exec(text)
    if (short) {
      const width = (short[1] ?? short[2] ?? short[3]).length
      if (width < DEFAULT_MARKER_SIZE && width !== markerSize) {
        if (short[1] && !shortStates.has(width)) shortStates.set(width, 'current')
        else if (short[2] && shortStates.has(width)) shortStates.set(width, 'incoming')
        else if (short[3] && shortStates.get(width) === 'incoming') {
          return fail(`Line ${number} completes a conflict with an unsupported marker length. Resolve it outside BetterGit.`)
        }
      }
    }
    const kind = kindOf(text)
    if (kind === 'unsupported') return fail(`Line ${number} has a conflict marker with an unsupported length. Resolve it outside BetterGit.`)
    // A standalone separator can be a Markdown underline. Base and closing markers need an opening marker.
    if (state === 'text') {
      if (kind === 'base' || kind === 'close') return fail(`Line ${number} has a conflict marker without an opening marker.`)
      if (kind !== 'open') {
        plain += line
        continue
      }
      if (plain) parts.push({ kind: 'text', text: plain })
      plain = ''
      open = line
      currentLabel = labelOf(line)
      current = ''
      baseMarker = null
      baseText = ''
      incoming = ''
      startedAt = number
      state = 'current'
      continue
    }
    if (kind === 'content') {
      if (state === 'current') current += line
      else if (state === 'base') baseText += line
      else incoming += line
      continue
    }
    if (state === 'current' && kind === 'base') {
      baseMarker = line
      state = 'base'
    } else if (state !== 'incoming' && kind === 'split') {
      split = line
      state = 'incoming'
    } else if (state === 'incoming' && kind === 'close') {
      parts.push({
        kind: 'conflict',
        index: blocks++,
        markers: { open, base: baseMarker, split, close: line },
        current,
        fileBase: baseMarker === null ? null : baseText,
        incoming,
        currentLabel,
        incomingLabel: labelOf(line),
      })
      state = 'text'
    } else {
      return fail(kind === 'open'
        ? `Line ${number} starts a conflict inside another conflict.`
        : `Line ${number} has a conflict marker out of order.`)
    }
  }
  if (state !== 'text') return fail(`Line ${startedAt} starts a conflict that never ends.`)
  if (plain) parts.push({ kind: 'text', text: plain })
  return { ok: true, parts }
}

// Replaces each block by its choice. Ready combine text replaces the block; a combine that is not ready is refused.
export function applyChoices(parts: readonly Part[], choices: readonly Choice[], combine: readonly Combine[]): ApplyResult {
  let text = ''
  let unresolved = 0
  for (const part of parts) {
    if (part.kind === 'text') {
      text += part.text
      continue
    }
    const choice = choices[part.index] ?? null
    if (choice === null) {
      unresolved++
      text += markedBlock(part)
      continue
    }
    const replacement = replacementFor(part, choice, combine[part.index])
    if (replacement === null) {
      return { ok: false, index: part.index, reason: `Conflict ${part.index + 1} cannot be combined. Choose another resolution.` }
    }
    text += endOfChoice(part, choice, replacement)
  }
  return { ok: true, text, unresolved }
}

// The end of a chosen block's replacement. A closing marker with no terminator ends the file, so the replacement ends
// without one too. Otherwise it drops the newline Git added after the side that ends it: incoming ends both unless it is
// empty, and a combination ends with both sides, so it drops only a newline both added. Only a newline is ever dropped.
export function endOfChoice(block: ConflictBlock, choice: ChoiceKind, text: string): string {
  if (!block.markers.close.endsWith('\n')) return text.replace(/\r?\n$/, '')
  const added = block.addedNewline ?? { current: 0, incoming: 0 }
  const count = choice === 'current' || (choice === 'both' && block.incoming === '') ? added.current
    : choice === 'combine' ? (added.current === added.incoming ? added.current : 0)
    : added.incoming
  return count > 0 && ['\n', '\r\n'].includes(text.slice(-count)) ? text.slice(0, -count) : text
}

// Marks the block that ends the file with the newline Git added to each side, read against that side's index stage:
// ours for current, theirs for incoming. A side is marked only when its stage ends without a newline and the side ends
// with that same last line plus one newline, so a side edited after the merge keeps its text. A null stage, one Git
// could not give, marks nothing.
export function withStageEnds(parts: Part[], ours: string | null, theirs: string | null): Part[] {
  const last = parts.at(-1)
  if (last?.kind !== 'conflict' || !last.markers.close.endsWith('\n')) return parts
  const added = { current: addedAfter(last.current, ours), incoming: addedAfter(last.incoming, theirs) }
  return added.current || added.incoming ? [...parts.slice(0, -1), { ...last, addedNewline: added }] : parts
}

function addedAfter(side: string, stage: string | null): number {
  if (stage === null) return 0
  const line = stage.slice(stage.lastIndexOf('\n') + 1)
  if (line === '') return 0
  return ['\r\n', '\n'].find((end) => side === line + end || side.endsWith(`\n${line}${end}`))?.length ?? 0
}

function replacementFor(block: ConflictBlock, choice: ChoiceKind, combine: Combine | undefined): string | null {
  switch (choice) {
    case 'current': return block.current
    case 'incoming': return block.incoming
    case 'both': return block.current + block.incoming
    case 'combine': return combine?.state === 'ready' ? combine.text : null
  }
}

function markedBlock(block: ConflictBlock): string {
  const { markers } = block
  return markers.open + block.current + (markers.base ?? '') + (block.fileBase ?? '') + markers.split + block.incoming + markers.close
}

// The stage sides of one file, read from git. Base is null when stage 1 is absent.
export interface StageBlock {
  current: string
  base: string | null
  incoming: string
}

export type BaseMatch = { state: 'matched'; base: string } | { state: 'unavailable'; reason: BaseReason }

// Matches each working block to its stage base by exact sides. A block gets a base only when the stages hold
// the same sides exactly as often as the file does, and every match shares one base. Anything else is unavailable.
// Marker styles disagree on region edges: normal markers keep only the differing lines, while diff3 also keeps shared
// lines and the base line. A block whose sides match no stage block therefore gets no base (boundary), never a guess.
export function matchBases(blocks: readonly ConflictBlock[], stages: readonly StageBlock[]): BaseMatch[] {
  const keyOf = (current: string, incoming: string) => JSON.stringify([current, incoming])
  const stageByKey = new Map<string, StageBlock[]>()
  for (const stage of stages) {
    const key = keyOf(stage.current, stage.incoming)
    stageByKey.set(key, [...(stageByKey.get(key) ?? []), stage])
  }
  const fileCount = new Map<string, number>()
  for (const block of blocks) {
    const key = keyOf(block.current, block.incoming)
    fileCount.set(key, (fileCount.get(key) ?? 0) + 1)
  }
  return blocks.map((block): BaseMatch => {
    const key = keyOf(block.current, block.incoming)
    const candidates = stageByKey.get(key) ?? []
    if (candidates.length === 0) return { state: 'unavailable', reason: 'boundary' }
    const [first] = candidates
    if (first.base === null) return { state: 'unavailable', reason: 'no-ancestor' }
    const sharedBase = candidates.every((stage) => stage.base === first.base)
    if (!sharedBase || candidates.length !== fileCount.get(key)) return { state: 'unavailable', reason: 'ambiguous' }
    return { state: 'matched', base: first.base }
  })
}

// Matches against several stage runs, one per marker style, because each style draws region edges differently.
// A block takes a base only when every run that matches it agrees. Disagreement is ambiguous, never a guess.
export function matchBasesAcrossRuns(blocks: readonly ConflictBlock[], runs: readonly (readonly StageBlock[])[]): BaseMatch[] {
  const perRun = runs.map((stages) => matchBases(blocks, stages))
  return blocks.map((_, index): BaseMatch => {
    const matches = perRun.map((run) => run[index])
    if (matches.some((match) => match.state === 'unavailable' && match.reason === 'ambiguous')) return { state: 'unavailable', reason: 'ambiguous' }
    const bases = matches.flatMap((match) => (match.state === 'matched' ? [match.base] : []))
    if (bases.length === 0) {
      const reasons = matches.map((match) => (match.state === 'unavailable' ? match.reason : 'boundary'))
      const onlyAncestor = reasons.length > 0 && reasons.every((reason) => reason === 'no-ancestor')
      return { state: 'unavailable', reason: onlyAncestor ? 'no-ancestor' : 'boundary' }
    }
    if (bases.some((base) => base !== bases[0])) return { state: 'unavailable', reason: 'ambiguous' }
    return { state: 'matched', base: bases[0] }
  })
}

const CHOICE_VALUES: readonly unknown[] = ['current', 'incoming', 'both', 'combine']
const DIGEST = /^[0-9a-f]{64}$/

// Checks a save request from the renderer against the contract. Anything else is refused, so no file text can reach
// the main process through this path. The choices are checked for shape here, and their count against the file later.
export function parseConflictSave(input: unknown): ConflictSave {
  const record = recordOf(input, 'fingerprint,choices', 'save')
  const fingerprint = fingerprintOf(record.fingerprint, 'save')
  const { choices } = record
  if (!Array.isArray(choices) || choices.length > MAX_CONFLICT_BLOCKS) throw new Error('The save request has an invalid list of choices.')
  for (const choice of choices) {
    if (choice !== null && !CHOICE_VALUES.includes(choice)) throw new Error('A choice is not one of the resolutions.')
  }
  return { fingerprint, choices: choices as Choice[] }
}

// A reset request is the fingerprint alone. Text, stage IDs, and paths from the renderer are refused.
export function parseConflictReset(input: unknown): ConflictReset {
  return { fingerprint: fingerprintOf(recordOf(input, 'fingerprint', 'reset').fingerprint, 'reset') }
}

function fingerprintOf(input: unknown, kind: string): ConflictFingerprint {
  const fingerprint = recordOf(input, 'stages,working', kind)
  if (typeof fingerprint.working !== 'string' || !DIGEST.test(fingerprint.working)) throw new Error(`The ${kind} request has no valid working digest.`)
  if (typeof fingerprint.stages !== 'string' || !DIGEST.test(fingerprint.stages)) throw new Error(`The ${kind} request has no valid stage digest.`)
  return { working: fingerprint.working, stages: fingerprint.stages }
}

function recordOf(input: unknown, fields: string, kind: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error(`The ${kind} request is not an object.`)
  const record = input as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== fields.split(',').sort().join(',')) throw new Error(`The ${kind} request has unexpected fields.`)
  return record
}

// Words, runs of spaces and tabs, carriage returns, newlines, and single symbols. Every character lands in one token,
// so joining the tokens gives the input back exactly.
const TOKEN = /\n|[^\S\n]+|[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_\s]/gu

export function splitTokens(text: string): string[] {
  return text.match(TOKEN) ?? []
}

// git merge-file reads lines, so each token becomes one record: its UTF-8 bytes in hex. A record never contains a
// newline, carriage return, or space, so no token is split or merged into a neighbour, and blank lines need no special case.
// A side needs no final newline, because the records carry no line structure of their own.
const encoder = new TextEncoder()
// ignoreBOM keeps a leading byte order mark in the text. Without it, the decoder silently drops the mark.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function toMergeInput(text: string): string {
  if (LONE_SURROGATE.test(text)) throw new Error('Text with a lone surrogate cannot be encoded as UTF-8.')
  return splitTokens(text).map((token) => `${hexOf(encoder.encode(token))}\n`).join('')
}

export function fromMergeOutput(output: string): string {
  return splitLines(output).map((line) => {
    if (!/^(?:[0-9a-f]{2})+\n$/.test(line)) throw new Error('Merge output has a line that is not a token record.')
    const bytes = Uint8Array.from(line.slice(0, -1).match(/../g) ?? [], (pair) => parseInt(pair, 16))
    return decoder.decode(bytes)
  }).join('')
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
