import type { DiffLine } from '../../main/git/diff'
import type { Segment } from './highlight'

// A changed stretch of one line, as [start, end) offsets in UTF-16 code units.
export type Span = [number, number]

// Words, runs of whitespace, and single punctuation marks. Each token is compared as one unit.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

// Lines that share less than this share of their words were rewritten. Tinting the whole line already says that.
const MIN_SHARED = 0.5

// The table of matched tokens has one cell per pair of tokens. Past this, the line stays plain.
// shortcut: a 200k-cell table caps the middle of a rewritten line, upgrade to a diff-match-patch-style bisect if long rewrites need emphasis.
const MAX_CELLS = 200_000

interface Token {
  text: string
  start: number
}

interface Compared {
  before: Span[]
  after: Span[]
}

// Changed stretches of two paired lines, or null when they share too little to pair or are too long to compare.
export function changedSpans(before: string, after: string): Compared | null {
  const a = tokenize(before)
  const b = tokenize(after)
  // Shared words at the start and end cost no table cells, so one edit in a long line stays cheap.
  let head = 0
  while (head < a.length && head < b.length && a[head].text === b[head].text) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail].text === b[b.length - 1 - tail].text) tail++
  const middleA = a.slice(head, a.length - tail)
  const middleB = b.slice(head, b.length - tail)
  if (middleA.length * middleB.length > MAX_CELLS) return null

  const matchedA = new Array<boolean>(a.length).fill(false)
  const matchedB = new Array<boolean>(b.length).fill(false)
  for (let i = 0; i < head; i++) matchedA[i] = matchedB[i] = true
  for (let i = 0; i < tail; i++) matchedA[a.length - 1 - i] = matchedB[b.length - 1 - i] = true
  matchCommon(middleA, middleB, (i, j) => {
    matchedA[head + i] = true
    matchedB[head + j] = true
  })

  const shared = a.filter((token, i) => matchedA[i] && token.text.trim() !== '').length
  const words = a.concat(b).filter((token) => token.text.trim() !== '').length
  if (words === 0 || (2 * shared) / words < MIN_SHARED) return null
  return { before: spansOf(a, matchedA), after: spansOf(b, matchedB) }
}

// Pairs each removed line with the added line at the same position in its replacement block, as the split view does.
// Blocks that only remove or only add lines get nothing, because there is no other side to compare.
export function intralineSpans(lines: DiffLine[]): Map<number, Span[]> {
  const spans = new Map<number, Span[]>()
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== 'del' && lines[i].type !== 'add') {
      i++
      continue
    }
    const dels: number[] = []
    const adds: number[] = []
    while (i < lines.length && lines[i].type === 'del') dels.push(i++)
    // git prints "\ No newline at end of file" right after an old last line that lacks one, before the added lines.
    while (i < lines.length && lines[i].type === 'note') i++
    while (i < lines.length && lines[i].type === 'add') adds.push(i++)
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const pair = changedSpans(lines[dels[k]].text, lines[adds[k]].text)
      if (!pair) continue
      spans.set(dels[k], pair.before)
      spans.set(adds[k], pair.after)
    }
  }
  return spans
}

export type Piece = Segment & { changed: boolean }

// Cuts coloured segments wherever a changed span starts or ends, so every piece is wholly changed or wholly unchanged.
export function emphasize(text: string, segments: Segment[], spans: Span[]): Piece[] {
  const flags = new Uint8Array(text.length)
  for (const [start, end] of spans) flags.fill(1, start, end)
  const pieces: Piece[] = []
  let offset = 0
  for (const segment of segments) {
    let start = 0
    for (let i = 1; i <= segment.text.length; i++) {
      if (i === segment.text.length || flags[offset + i] !== flags[offset + start]) {
        pieces.push({ ...segment, text: segment.text.slice(start, i), changed: flags[offset + start] === 1 })
        start = i
      }
    }
    offset += segment.text.length
  }
  return pieces
}

function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(TOKEN), (match) => ({ text: match[0], start: match.index }))
}

// Marks the tokens of the longest common subsequence. Lengths fit in Uint16 because the table is capped at MAX_CELLS.
function matchCommon(a: Token[], b: Token[], onMatch: (i: number, j: number) => void) {
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i].text === b[j].text
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i].text === b[j].text) {
      onMatch(i++, j++)
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++
    } else {
      j++
    }
  }
}

// Joins runs of unmatched tokens into one span, so a changed phrase is one highlighted block.
function spansOf(tokens: Token[], matched: boolean[]): Span[] {
  const spans: Span[] = []
  tokens.forEach((token, i) => {
    if (matched[i]) return
    const end = token.start + token.text.length
    const last = spans[spans.length - 1]
    if (last && last[1] === token.start) last[1] = end
    else spans.push([token.start, end])
  })
  return spans
}
