import { expect, test } from 'bun:test'
import { parseDiff, type DiffLine } from '../src/main/git/diff'
import { changedSpans, emphasize, intralineSpans, type Span } from '../src/renderer/src/intraline'

// The changed text of one side, so assertions read as the words a reader sees highlighted.
const changedText = (text: string, spans: Span[] = []) => spans.map(([start, end]) => text.slice(start, end))

test('a one-word replacement highlights only the changed word on each side', () => {
  const before = 'const total = count + 1'
  const after = 'const total = amount + 1'
  const pair = changedSpans(before, after)
  expect(changedText(before, pair?.before)).toEqual(['count'])
  expect(changedText(after, pair?.after)).toEqual(['amount'])
})

test('separate edits stay separate, and a whitespace change is a change', () => {
  const before = 'const a = foo(1) + bar(2)'
  const after = 'const a = foo(9) + baz(2)'
  const pair = changedSpans(before, after)
  expect(changedText(before, pair?.before)).toEqual(['1', 'bar'])
  expect(changedText(after, pair?.after)).toEqual(['9', 'baz'])
  expect(changedText('return  value', changedSpans('return  value', 'return value')?.before)).toEqual(['  '])
})

test('lines that share too little are not paired, and identical lines have no spans', () => {
  expect(changedSpans('alpha beta', 'zeta omega')).toBeNull()
  expect(changedSpans('same', 'same')).toEqual({ before: [], after: [] })
})

test('removal-only and addition-only blocks get no word spans', () => {
  const lines: DiffLine[] = [
    { type: 'context', text: 'keep', oldNo: 1, newNo: 1 },
    { type: 'add', text: 'new line here', oldNo: null, newNo: 2 },
    { type: 'add', text: 'another new line', oldNo: null, newNo: 3 },
  ]
  expect(intralineSpans(lines).size).toBe(0)
})

test('a replacement block pairs its lines in order and leaves the extra line plain', () => {
  const lines: DiffLine[] = [
    { type: 'del', text: 'value = old', oldNo: 1, newNo: null },
    { type: 'del', text: 'unrelated', oldNo: 2, newNo: null },
    { type: 'add', text: 'value = new', oldNo: null, newNo: 1 },
  ]
  const spans = intralineSpans(lines)
  expect(changedText(lines[0].text, spans.get(0))).toEqual(['old'])
  expect(changedText(lines[2].text, spans.get(2))).toEqual(['new'])
  expect(spans.has(1)).toBe(false)
})

test('a last line that gains or loses its final newline still pairs across git\'s note', () => {
  const note = '\\ No newline at end of file'
  const hunk = (body: string[]) => parseDiff(['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1 +1 @@', ...body].join('\n'))[0].hunks[0].lines
  const oldMissing = hunk(['-const total = count + 1', note, '+const total = amount + 1'])
  const newMissing = hunk(['-const total = count + 1', '+const total = amount + 1', note])
  expect(oldMissing.map((line) => line.type)).toEqual(['del', 'note', 'add'])
  for (const lines of [oldMissing, newMissing]) {
    const spans = intralineSpans(lines)
    const del = lines.findIndex((line) => line.type === 'del')
    const add = lines.findIndex((line) => line.type === 'add')
    expect(changedText(lines[del].text, spans.get(del))).toEqual(['count'])
    expect(changedText(lines[add].text, spans.get(add))).toEqual(['amount'])
    expect(spans.size).toBe(2)
  }
})

test('a long line with one edit is still compared cheaply, and a fully rewritten long line is left plain', () => {
  const shared = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
  const pair = changedSpans(`${shared} old`, `${shared} new`)
  expect(changedText(`${shared} old`, pair?.before)).toEqual(['old'])
  const rewritten = changedSpans(
    Array.from({ length: 600 }, (_, i) => `a${i}`).join(' '),
    Array.from({ length: 600 }, (_, i) => `b${i}`).join(' '),
  )
  expect(rewritten).toBeNull()
})

test('emphasis splits coloured segments without losing text or colour, even across markup boundaries', () => {
  const text = '<b>x</b>'
  const segments = [
    { text: '<b>', light: '#1' },
    { text: 'x', light: '#2' },
    { text: '</b>', light: '#3' },
  ]
  const pieces = emphasize(text, segments, [[1, 2]])
  expect(pieces.map((piece) => piece.text).join('')).toBe(text)
  expect(pieces.filter((piece) => piece.changed)).toEqual([{ text: 'b', light: '#1', changed: true }])
  expect(pieces.find((piece) => piece.text === 'x')).toEqual({ text: 'x', light: '#2', changed: false })
})

// Renders the real row components, so a cell that drops its `changed` prop fails here even though the helpers pass.
// Runs in a child process: DiffView reads localStorage and window when it loads, and session.test.ts stubs them in this process.
const RENDER_CHECK = `
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout },
})
const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { SplitCell, UnifiedLine } = await import('./src/renderer/src/DiffView')
const { intralineSpans } = await import('./src/renderer/src/intraline')
const lines = [
  { type: 'del', text: 'const total = count + 1', oldNo: 1, newNo: null },
  { type: 'add', text: 'const total = amount + 1', oldNo: null, newNo: 1 },
]
const spans = intralineSpans(lines)
const intraCount = (html) => (html.match(/class="intra"/g) ?? []).length
console.log(JSON.stringify({
  split: intraCount(renderToStaticMarkup(createElement(SplitCell, { cell: { line: lines[0], index: 0 }, side: 'old', changed: spans.get(0) }))),
  unified: intraCount(renderToStaticMarkup(createElement(UnifiedLine, { line: lines[1], changed: spans.get(1) }))),
  splitMoved: intraCount(renderToStaticMarkup(createElement(SplitCell, { cell: { line: lines[0], index: 0 }, side: 'old', changed: spans.get(0), label: 'moved' }))),
}))
`

test('split and unified rows render the changed words, and a moved label drops them', () => {
  const child = Bun.spawnSync([process.execPath, '-e', RENDER_CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.stderr.toString()).toBe('')
  expect(JSON.parse(child.stdout.toString())).toEqual({ split: 1, unified: 1, splitMoved: 0 })
})
