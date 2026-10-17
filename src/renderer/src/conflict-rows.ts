import type { DiffFile, DiffHunk, DiffLine } from '../../main/git/diff'
import type { IndexedLine, SplitRow } from './DiffView'
import { applyChoices, splitLines, type Choice, type Combine, type ConflictBlock, type Part } from '../../shared/conflict'

// Where a result line comes from. Marker kinds are the marker lines themselves, taken from the parse, never matched in text.
export type RowKind = 'text' | 'current' | 'base' | 'incoming' | 'combine' | 'marker-open' | 'marker-base' | 'marker-split' | 'marker-close'

export interface ResultRow {
  kind: RowKind
  // The line as saved, terminator included. Joining every row gives the saved text.
  raw: string
  // The conflict the line belongs to, by index, or null for unchanged text.
  block: number | null
  // A context row for DiffView: oldNo is the line in the working file, or null for combined text. newNo is the line in the result.
  line: DiffLine
}

export interface ConflictRows {
  result: ResultRow[]
  // Per block, the row its controls sit above. A block that keeps no lines still has one; past the last row means the end.
  anchors: number[]
}

interface Piece {
  kind: RowKind
  text: string
  old: number | null
  block: number | null
}

export const isMarker = (kind: RowKind) => kind.startsWith('marker-')

// One row per line. Only a line feed, or a carriage return before it, ends a line and is not shown. Any other carriage
// return, including one that ends the file, shows as a visible glyph, so no text is hidden and no control character reaches the page.
export const displayLine = (line: string) => line.replace(/\r?\n$/, '').replace(/\r/g, '␍')

const newlines = (text: string) => text.split('\n').length - 1

// The block as written, in the same order as the markers it is saved with when unresolved.
function piecesOf(block: ConflictBlock): { kind: RowKind; text: string }[] {
  const { markers } = block
  return [
    { kind: 'marker-open', text: markers.open },
    { kind: 'current', text: block.current },
    ...(markers.base === null ? [] : [{ kind: 'marker-base' as const, text: markers.base }, { kind: 'base' as const, text: block.fileBase ?? '' }]),
    { kind: 'marker-split', text: markers.split },
    { kind: 'incoming', text: block.incoming },
    { kind: 'marker-close', text: markers.close },
  ]
}

// Builds the rows the same way applyChoices builds the text, so the caller can check one against the other.
export function conflictRows(parts: readonly Part[], choices: readonly Choice[], combine: readonly Combine[]): ConflictRows {
  const pieces: Piece[] = []
  let old = 1
  for (const part of parts) {
    if (part.kind === 'text') {
      pieces.push({ kind: 'text', text: part.text, old, block: null })
      old += newlines(part.text)
      continue
    }
    const marked = piecesOf(part).map((piece): Piece => {
      const placed = { ...piece, old, block: part.index }
      old += newlines(piece.text)
      return placed
    })
    const choice = choices[part.index] ?? null
    const ready = combine[part.index]
    const kept: Piece[] = choice === null ? marked
      : choice === 'combine' ? (ready?.state === 'ready' ? [{ kind: 'combine', text: ready.text, old: null, block: part.index }] : [])
      : marked.filter((piece) => piece.kind === choice || (choice === 'both' && (piece.kind === 'current' || piece.kind === 'incoming')))
    // As in applyChoices: a closing marker with no terminator ends the file, so the replacement ends without one too.
    if (choice !== null && !part.markers.close.endsWith('\n')) {
      const last = [...kept].reverse().find((piece) => piece.text !== '')
      if (last) last.text = last.text.replace(/\r?\n$/, '')
    }
    // The empty piece marks where the block starts, so a block that keeps no lines still has a place for its controls.
    pieces.push({ kind: 'text', text: '', old: null, block: part.index }, ...kept)
  }
  const result: ResultRow[] = []
  const anchors: number[] = []
  type Line = Omit<ResultRow, 'line'> & { old: number | null }
  const emit = ({ kind, raw, block, old }: Line) => {
    result.push({ kind, raw, block, line: { type: 'context', text: displayLine(raw), oldNo: old, newNo: result.length + 1 } })
  }
  // A piece with no terminator, such as a lone byte order mark before a conflict, shares its line with the next piece.
  let carry: Line | null = null
  for (const piece of pieces) {
    if (piece.block !== null) anchors[piece.block] ??= result.length
    for (const [index, raw] of splitLines(piece.text).entries()) {
      const row: Line = { kind: piece.kind, raw: (carry?.raw ?? '') + raw, block: piece.block, old: piece.old === null ? null : piece.old + index }
      carry = null
      if (raw.endsWith('\n')) emit(row)
      else carry = row
    }
  }
  if (carry) emit(carry)
  return { result, anchors }
}

export interface ConflictFile {
  file: DiffFile
  // The conflict kind of each shown line.
  kinds: Map<DiffLine, RowKind>
  split: Map<DiffHunk, SplitRow[]>
  // Blocks whose controls sit above a shown line, and blocks whose controls sit after the last line of the file.
  before: Map<DiffLine, number[]>
  end: number[]
}

// The whole result as one DiffView file. Every line of a conflict, resolved or not, counts as a change, so unchanged lines
// more than `context` away fold out of view like in any diff, and the viewer's own expand rows widen them.
export function conflictFile(path: string, parts: readonly Part[], choices: readonly Choice[], combine: readonly Combine[], context: number): ConflictFile {
  const applied = applyChoices(parts, choices, combine)
  if (!applied.ok) return conflictFile(path, parts, [], combine, context)
  let { result, anchors } = conflictRows(parts, choices, combine)
  // The rows must be the saved text. If they ever are not, the saved text shows undecorated, with every control at the top.
  if (result.map((row) => row.raw).join('') !== applied.text) {
    result = conflictRows([{ kind: 'text', text: applied.text }], [], []).result
    anchors = anchors.map(() => 0)
  }
  // Each change opens a window of `context` lines. Windows overlap heavily at large contexts, so each one only counts its
  // start and end, and one running sum then marks every line once.
  const edges = new Array<number>(result.length + 1).fill(0)
  const reveal = (from: number, to: number) => {
    const start = Math.max(0, from)
    const stop = Math.min(result.length - 1, to)
    if (start > stop) return
    edges[start]++
    edges[stop + 1]--
  }
  result.forEach((row, index) => { if (row.block !== null) reveal(index - context, index + context) })
  anchors.forEach((at) => reveal(at - context, at + Math.max(context - 1, 0)))
  let open = 0
  const shown = result.map((_, index) => (open += edges[index]) > 0)
  const hunks: DiffHunk[] = []
  result.forEach((row, index) => {
    if (!shown[index]) return
    if (index === 0 || !shown[index - 1]) hunks.push({ header: '', lines: [] })
    hunks[hunks.length - 1].lines.push(row.line)
  })
  // A result with no lines still needs a place for its controls.
  if (hunks.length === 0) hunks.push({ header: '', lines: [] })
  for (const hunk of hunks) {
    const olds = hunk.lines.flatMap((line) => (line.oldNo === null ? [] : [line.oldNo]))
    hunk.header = `@@ -${olds[0] ?? 0},${olds.length} +${hunk.lines[0]?.newNo ?? 0},${hunk.lines.length} @@`
  }
  const before = new Map<DiffLine, number[]>()
  const end: number[] = []
  anchors.forEach((at, block) => {
    const line = result[at]?.line
    if (line) before.set(line, [...(before.get(line) ?? []), block])
    else end.push(block)
  })
  return {
    file: { oldPath: path, newPath: path, status: 'modified', binary: false, hunks },
    kinds: new Map(result.map((row) => [row.line, row.kind])),
    split: splitConflicts(hunks, result, choices),
    before,
    end,
  }
}

// Unresolved sides keep their own source order and preview line numbers. Resolved text is shared inline, as context is.
// Each hunk is walked once; grouping by parsed block identity never guesses markers from their text.
function splitConflicts(hunks: DiffHunk[], result: ResultRow[], choices: readonly Choice[]): Map<DiffHunk, SplitRow[]> {
  const metadata = new Map(result.map((row) => [row.line, row]))
  return new Map(hunks.map((hunk) => {
    const rows: SplitRow[] = []
    let index = 0
    while (index < hunk.lines.length) {
      const line = hunk.lines[index]
      const block = metadata.get(line)?.block
      const cell = { line, index, number: line.newNo }
      if (block == null || choices[block] != null) {
        rows.push({ left: cell, right: cell })
        index++
        continue
      }
      const start = index
      const first = rows.length
      const sides = new Map<RowKind, IndexedLine[]>()
      while (index < hunk.lines.length && metadata.get(hunk.lines[index])?.block === block) {
        const line = hunk.lines[index]
        const kind = metadata.get(line)!.kind
        if (!sides.has(kind)) sides.set(kind, [])
        sides.get(kind)!.push({ line, index, number: line.newNo })
        index++
      }
      const pair = (left: IndexedLine[], right: IndexedLine[]) => {
        for (let at = 0; at < Math.max(left.length, right.length); at++) rows.push({ left: left[at] ?? null, right: right[at] ?? null })
      }
      pair(sides.get('marker-split') ?? [], sides.get('marker-open') ?? [])
      pair(sides.get('incoming') ?? [], sides.get('current') ?? [])
      pair(sides.get('marker-close') ?? [], [...(sides.get('marker-base') ?? []), ...(sides.get('base') ?? [])])
      // The first projected row may start at the incoming separator, after the raw control anchor.
      if (rows[first]) rows[first].controlIndex = start
    }
    return [hunk, rows]
  }))
}
