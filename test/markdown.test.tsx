import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseDiff, type DiffFile, type DiffLine, type MovedBlock } from '../src/main/git/diff'
import { isMarkdownPath, MarkdownContent, markdownHunk } from '../src/renderer/src/MarkdownLine'

const line = (text: string, type: DiffLine['type'] = 'context', number = 1): DiffLine => ({
  text, type, oldNo: type === 'add' || type === 'note' ? null : number, newNo: type === 'del' || type === 'note' ? null : number,
})
const file = (path: string, lines: DiffLine[], header = '@@ -1 +1 @@'): DiffFile => ({
  oldPath: path, newPath: path, status: 'modified', binary: false, hunks: [{ header, lines }],
})

// Exercise the real DiffView in an isolated process, without the session suite's global window/storage stubs.
const RENDER = `
const stored = JSON.parse(process.env.MARKDOWN_STORAGE)
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value } },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout },
  fetch: () => { throw new Error('Unexpected resource request') },
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
// Records the real parser's calls without replacing it; installed after the React patch so DiffView sees both.
const parser = (await import('bun:test')).spyOn(await import('./src/renderer/src/MarkdownLine'), 'markdownHunk')
const { renderToStaticMarkup } = await import('react-dom/server')
const { DiffView } = await import('./src/renderer/src/DiffView')
const prefs = await import('./src/renderer/src/prefs')
const props = JSON.parse(process.env.MARKDOWN_PROPS)
props.persist = { id: 'markdown-files', key: 'commit' }
if (process.env.MARKDOWN_CONFLICT === 'true') props.conflict = { row: () => undefined, controls: () => null, splitRows: () => [] }
const render = () => renderToStaticMarkup(react.createElement(DiffView, props))
const html = render()
const parsed = parser.mock.calls.map(([lines]) => lines.map(line => line.text))
const otherView = render()
if (process.env.MARKDOWN_RESET === 'true') prefs.setFormatMarkdown(false)
console.log(JSON.stringify({ html, otherView, reset: render(), stored, parsed }))
`

function render(files: DiffFile[], layout: 'unified' | 'split' = 'unified', formatted = true, moves: MovedBlock[] = [], storage: Record<string, string> = {}, conflict = false) {
  const child = Bun.spawnSync([process.execPath, '-e', RENDER], {
    cwd: `${import.meta.dir}/..`, stderr: 'pipe',
    env: {
      ...process.env, MARKDOWN_PROPS: JSON.stringify({ files, moves, stage: { staged: false, disabled: true } }),
      MARKDOWN_STORAGE: JSON.stringify({ 'bettergit.diffLayout': layout, 'bettergit.formatMarkdown': String(formatted), ...storage }),
      MARKDOWN_RESET: 'true', MARKDOWN_CONFLICT: String(conflict),
    },
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  // `parsed` lists the source lines of each markdownHunk call made by the first render.
  return JSON.parse(child.stdout.toString()) as { html: string; otherView: string; reset: string; stored: Record<string, string>; parsed: string[][] }
}

for (const [name, source, tag] of [['paragraph', 'first\rsecond', 'p'], ['headings', '# first\r# second', 'h1']] as const) {
  for (const layout of ['unified', 'split'] as const) test(`bare CR ${name} survives actual parseDiff and ${layout} DiffView formatting`, () => {
    const files = parseDiff(['diff --git a/bare-cr.md b/bare-cr.md', '--- a/bare-cr.md', '+++ b/bare-cr.md', '@@ -0,0 +1 @@', `+${source}`, ''].join('\n'))
    expect(files[0].hunks[0].lines).toHaveLength(1)
    expect(files[0].hunks[0].lines[0].text).toBe(source)
    const { html, reset } = render(files, layout)
    expect(reset).toContain(`<code><span class="sx">${source}</span></code>`)
    expect(html.includes('first')).toBe(true)
    expect(html.includes('second')).toBe(true)
    expect((html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe(tag === 'p' ? 1 : 2)
    expect([...html.matchAll(/data-source-range="([^"]+)"/g)].map(match => match[1]).every(range => range === '0:0')).toBe(true)
    expect((html.match(/data-source-row=/g) ?? []).length).toBe(1)
    expect(html).toContain('data-source-row="0:0:0" data-source-side="new"')
    expect(html).toContain('<span class="gutter">1</span>')
    expect(html).toContain('<span class="sign">+</span>')
  })
}

test('bare CR source ranges retain UTF16 boundaries and blank/note rails without a source syntax readout', () => {
  const source = '😀 first\rsecond'
  const files = parseDiff([
    'diff --git a/boundary.md b/boundary.md', '--- a/boundary.md', '+++ b/boundary.md', '@@ -0,0 +1,3 @@',
    `+${source}`, '+# next', '+', '\\ No newline at end of file',
    'diff --git a/syntax.md b/syntax.md', '--- a/syntax.md', '+++ b/syntax.md', '@@ -1 +1 @@',
    '-😀 *same*\rsecond', '+😀 _same_\rsecond', '',
  ].join('\n'))
  expect(files[0].hunks[0].lines.map(line => line.text)).toEqual([source, '# next', '', '\\ No newline at end of file'])
  for (const layout of ['unified', 'split'] as const) {
    const { html, reset } = render(files, layout)
    const boundary = html.split('data-path="boundary.md"')[1].split('</section>')[0]
    expect(boundary).toContain('<p data-source-range="0:0">')
    expect(boundary).toContain('<h1 data-source-range="1:1">')
    expect(boundary).not.toContain('data-source-range="0:1"')
    expect(boundary).toContain(source)
    expect(reset).toContain(`<code><span class="sx">${source}</span></code>`)
    expect((boundary.match(/data-source-row=/g) ?? []).length).toBe(layout === 'unified' ? 4 : 5)
    expect((boundary.match(/data-source-row="0:0:0"/g) ?? []).length).toBe(1)
    expect((boundary.match(/data-source-row="0:0:2"/g) ?? []).length).toBe(1)
    expect(boundary).toContain('No newline at end of file')
    const syntax = html.split('data-path="syntax.md"')[1].split('</section>')[0]
    expect((syntax.match(/<p[ >]/g) ?? []).length).toBe(2)
    expect([...syntax.matchAll(/<em>(.*?)<\/em>/g)].map(match => match[1].replace(/<[^>]+>/g, ''))).toEqual(['same', 'same'])
    expect(syntax).not.toContain('Source syntax')
    expect((syntax.match(/data-source-row=/g) ?? []).length).toBe(2)
  }
})

test('real DiffView formats the manifest table and edited inline-code paragraph in both layouts', () => {
  const manifest = readFileSync(new URL('../feature-manifest.md', import.meta.url), 'utf8').split('\n')
  const header = manifest.findIndex(text => text.startsWith('| ID | Item |'))
  expect(header).toBeGreaterThan(0)
  const table = manifest.slice(header, header + 4).map((text, index) => line(text, 'add', header + index + 1))
  const paragraph = manifest[6]
  const changed = [line(paragraph.replace('`wrick17/bettergit`', 'wrick17/bettergit'), 'del', 7), line(paragraph, 'add', 7)]
  for (const layout of ['unified', 'split'] as const) {
    const html = render([file('feature-manifest.md', table), file('paragraph.md', changed)], layout).html
    expect(html).toMatch(/<table[ >]/)
    expect((html.match(/<th[ >]/g) ?? []).length).toBe(6)
    expect((html.match(/<td[ >]/g) ?? []).length).toBe(12)
    const codes = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(match => match[1].replace(/<[^>]*>/g, ''))
    expect(codes).toContain('HistoryView.tsx')
    expect(codes).toContain('session.ts')
    expect(codes).toContain('wrick17/bettergit')
    expect(codes).not.toContain(paragraph)
    expect(html).toContain('<p')
    expect((html.match(/data-source-row=/g) ?? []).length).toBe(table.length + changed.length)
    expect(html).toContain('<span class="sign">+</span>')
    expect(html).toContain('<span class="sign">-</span>')
  }
})

function fragment(text: string) {
  const parsed = markdownHunk(text.split('\n').map((text, index) => line(text, 'context', index + 1)))
  return renderToStaticMarkup(<MarkdownContent nodes={parsed.new.nodes} side={parsed.new} />)
}

test('recognizes Markdown displayed paths and leaves non-Markdown source untouched', () => {
  expect(['README.md', 'doc.MARKDOWN', 'folder/a.Md'].every(isMarkdownPath)).toBe(true)
  expect(['README.md.ts', 'README', 'folder.md/a'].some(isMarkdownPath)).toBe(false)
  const renamed = { ...file('old.txt', [line('# Renamed')]), newPath: 'new.MD', status: 'renamed' as const }
  const deleted = { ...file('gone.markdown', [line('# Deleted', 'del')]), newPath: null, status: 'deleted' as const }
  const html = render([renamed, deleted, file('literal.ts', [line('# Raw')])]).html
  expect(html).toContain('data-path="new.MD"')
  expect(html).toContain('data-path="gone.markdown"')
  expect((html.match(/<h1[ >]/g) ?? []).length).toBe(2)
  expect(html).toContain('<code><span class="sx"># Raw</span></code>')
})

test('real DiffView renders multiline paragraphs, nested task lists, quotes, strike and inert destinations', () => {
  const text = ['## A ***bold and soft*** heading', '', 'A **bold', 'continued** paragraph with ~~removed~~ and `code`.', '', '- [x] done', '  - nested', '    continuation', '', '> quoted', '> second line', '', '[label][ref] and ![portrait](file:///private/photo.png)', '', '[ref]: https://example.com', '', 'A footnote[^1]', '', '[^1]: local note']
  for (const layout of ['unified', 'split'] as const) {
    const html = render([file('blocks.md', text.map((text, index) => line(text, 'add', index + 1)))], layout).html
    expect(html).toMatch(/<h2[ >]/)
    expect(html).toContain('<em><strong>')
    expect(html).toContain('<strong><span>bold\ncontinued</span></strong>')
    expect((html.match(/<ul[ >]/g) ?? []).length).toBe(2)
    expect(html).toContain('aria-label="Completed task"')
    expect(html).toContain('<blockquote')
    expect(html).toContain('<del><span>removed</span></del>')
    expect(html).toContain('<code><span>code</span></code>')
    expect(html).toContain('md-destination')
    expect(html).not.toContain('[label][ref]')
    expect(html).toContain('https://example.com')
    expect(html).toContain('role="img" aria-label="portrait"')
    expect(html).toContain('file:///private/photo.png')
    expect(html).toContain('<sup')
    expect(html).toContain('local note')
    expect((html.match(/data-source-row=/g) ?? []).length).toBe(text.length)
    expect(html).not.toMatch(/\s(?:src|href)=/)
  }
})

test('hunk sides keep independent fence state and never infer missing reference definitions', () => {
  const lines = [line('```md', 'del'), line('# inside old fence', 'context', 2), line('```', 'del', 3)]
  const parsed = markdownHunk(lines)
  expect(parsed.old.nodes[0].type).toBe('code')
  expect(parsed.new.nodes[0].type).toBe('heading')
  expect(fragment('```\n# unfinished')).toContain('<pre')
  expect(fragment('```\n# unfinished')).not.toContain('<h1')
  expect(fragment('[label][missing]')).toContain('[label][missing]')
  const separated = file('fragment.md', [line('[label][ref]')])
  separated.hunks.push({ header: '@@ -20 +20 @@', lines: [line('[ref]: https://outside.test', 'context', 20), line('# separate', 'context', 21)] })
  const html = render([separated]).html
  expect(html).toContain('[label][ref]')
  expect(html).toContain('<h1')
  expect(html).toContain('Visible Markdown fragment')
  for (const layout of ['unified', 'split'] as const) {
    const fenced = render([file('fence.md', lines)], layout).html
    expect(fenced).toContain('<pre')
    expect(fenced).toContain('<h1')
    expect(fenced).not.toContain('data-source-row="0:0:0" data-source-side="new"')
  }
})

test('table rows cut below their header by the hunk still render as a headerless table', () => {
  for (const rows of [['|---|---|', '| A | one |', '| B | two |'], ['| A | one |', '| B | two |']]) {
    const html = fragment(rows.join('\n'))
    expect(html).toContain('<table data-source-range="0:')
    expect(html).not.toContain('<th')
    expect((html.match(/<td[ >]/g) ?? []).length).toBe(4)
    expect(html).not.toContain('|')
  }
  // A header that is in the hunk is kept, and a pipe row after a blank line is not a table in the file either.
  expect(fragment('| H | I |\n|---|---|\n| A | one |')).toContain('<th')
  expect(fragment('text\n\n| A | one |')).not.toContain('<table')
  // Lone pipe-led prose lines are paragraphs, not one-column tables.
  for (const prose of ['| note', '| --- |']) {
    const html = fragment(prose)
    expect(html).not.toContain('<table')
    expect(html).toContain('<p')
  }
})

test('word edits keep intraline tints while syntax-only edits stay formatted', () => {
  const pairs = [['A **before** phrase', 'A **after** phrase'], ['A *stable* phrase', 'A **stable** phrase'], ['*same*', '_same_'], ['**same**', '__same__'], ['A `before` value', 'A `after` value']]
  for (const layout of ['unified', 'split'] as const) {
    const files = pairs.map(([before, after], index) => file(`syntax-${index}.md`, [line(before, 'del'), line(after, 'add')]))
    const html = render(files, layout).html
    expect(html).toContain('<strong><span class="intra">before</span></strong>')
    expect(html).toContain('<strong><span class="intra">after</span></strong>')
    expect(html).toContain('<em><span>same</span></em>')
    expect(html).toContain('<strong><span>same</span></strong>')
    expect(html).toContain('<code><span class="intra">before</span></code>')
    expect(html).not.toContain('Source syntax')
    expect(html).not.toContain('<code><span class="sx">*same*</span></code>')
    expect(html).not.toContain('<code><span class="sx">A **stable** phrase</span></code>')
    const pureText = html.split('data-path="syntax-0.md"')[1].split('</section>')[0]
  }
})

test('paired blocks retain exact side rails for alignment, fence, reference and normalized edits', () => {
  const table = [line('| Name | Value |', 'context', 1), line('|---|---|', 'del', 2), line('| one | before |', 'del', 3), line('|:---|---:|', 'add', 2), line('| one | after |', 'add', 3), line('| two | added |', 'add', 4), line('', 'context', 5)]
  const fixtures = [file('table.md', table), file('shape.md', [line('paragraph', 'del'), line('- first', 'add'), line('- second', 'add', 2)]), file('fence.md', [line('```ts', 'del'), line('~~~ts', 'add'), line('const one = 1', 'context', 2), line('```', 'del', 3), line('~~~', 'add', 3)]), file('reference.md', [line('[label][ref]', 'context'), line('', 'context', 2), line('[ref]: /before', 'del', 3), line('[ref]: /after', 'add', 3)]), file('normalized.md', [line('A &amp; B', 'del'), line('A &#38; B', 'add')])]
  for (const layout of ['unified', 'split'] as const) {
    const html = render(fixtures, layout).html
    const tables = html.split('data-path="table.md"')[1].split('</section>')[0]
    expect((tables.match(/<table[ >]/g) ?? []).length).toBe(2)
    const rail = (side: string) => [...tables.matchAll(new RegExp(`data-source-row="0:0:(\\d+)" data-source-side="${side}"`, 'g'))].map(match => Number(match[1]))
    expect(rail('old')).toEqual([0, 1, 2, ...(layout === 'split' ? [6] : [])])
    expect(rail('new')).toEqual([0, 3, 4, 5, ...(layout === 'split' ? [6] : [])])
    expect(tables).not.toContain('Source syntax')
    expect(tables).not.toContain('<code><span class="sx">| Name | Value |</span></code>')
    const shape = html.split('data-path="shape.md"')[1].split('</section>')[0]
    expect(shape).toContain('<p')
    expect(shape).toContain('<ul')
    expect(shape).not.toContain('<code><span class="sx">paragraph</span></code>')
    expect(html).toContain('/before')
    expect(html).toContain('/after')
    expect(html).not.toMatch(/\s(?:src|href)=/)
  }
})

for (const layout of ['unified', 'split'] as const) test(`formatted ${layout} removes decorative block labels while preserving actual Markdown words`, () => {
  const fixtures = [file('changed.md', [line('# Before', 'del'), line('# After', 'add')]), file('added.md', [line('Added', 'add')]), file('removed.md', [line('Removed', 'del')]), file('syntax.md', [line('*same*', 'del'), line('_same_', 'add')])]
  const moves: MovedBlock[] = [{ from: [{ file: 0, hunk: 0, line: 0 }], to: [{ file: 0, hunk: 0, line: 1 }] }]
  const html = render(fixtures, layout, true, moves).html
  expect(html.includes('md-block-label')).toBe(false)
  const text = html.replace(/<[^>]+>/g, '')
  for (const word of ['Before', 'After', 'Added', 'Removed']) expect(text).toContain(word)
  expect((html.match(/<h1[ >]/g) ?? []).length).toBe(2)
  expect((html.match(/data-source-row=/g) ?? []).length).toBe(6)
  expect(html).toContain('<span class="sign">+</span>')
  expect(html).toContain('<span class="sign">-</span>')
  expect(html).not.toContain('Source syntax')
  expect(html).toContain('moved to line')
  expect(html).toContain('md-moved-text')
})

// Run DiffView's production measurement effect with known viewport rectangles; no browser or copied geometry code.
const MOVE_GEOMETRY_CHECK = `
const react = require('react')
const stored = { 'bettergit.formatMarkdown': process.env.MOVE_CHECK_FORMAT ?? 'true', 'bettergit.diffLayout': process.env.MOVE_CHECK_LAYOUT ?? 'split' }
const formatted = stored['bettergit.formatMarkdown'] === 'true'
const observed = []
Object.assign(globalThis, {
  localStorage: { getItem: key => stored[key] ?? null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout },
  ResizeObserver: class { constructor(callback) { globalThis.resizeMove = callback } observe(element) { observed.push(element) } disconnect() {} },
})
let cursor = 0
const hooks = [], effects = []
const slot = initial => { const at = cursor++; return hooks[at] ?? (hooks[at] = initial()) }
react.useRef = value => slot(() => ({ current: value }))
react.useState = value => { const state = slot(() => ({ value: typeof value === 'function' ? value() : value })); return [state.value, next => { state.value = typeof next === 'function' ? next(state.value) : next }] }
react.useEffect = () => undefined
react.useMemo = compute => compute()
react.useId = () => 'move-geometry'
react.useDeferredValue = value => value
react.useCallback = callback => callback
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
react.useLayoutEffect = (effect, deps) => {
  const state = slot(() => ({}))
  if (!state.deps || deps.some((value, index) => value !== state.deps[index])) effects.push(() => { state.cleanup?.(); state.cleanup = effect(); state.deps = deps })
}
const rect = (left, top, width, height) => ({ left, right: left + width, top, bottom: top + height, width, height })
const semantic = (range, box) => ({ dataset: { sourceRange: range }, box, getBoundingClientRect() { return this.box } })
const endpoint = (index, railBox, blockBox, contentBox) => {
  const node = semantic('1:4', contentBox)
  const content = { querySelectorAll: () => [semantic('0:0', rect(blockBox.left, blockBox.top, blockBox.width, 20)), node] }
  const block = { box: blockBox, getBoundingClientRect() { return this.box }, querySelector: () => content, querySelectorAll: () => content.querySelectorAll() }
  return { dataset: { sourceRow: index + ':0:2' }, railBox, block, node, getBoundingClientRect() { return formatted ? this.railBox : block.box }, closest: () => formatted ? block : null }
}
const from = endpoint(0, rect(100, 210, 62, 22), rect(100, 200, 480, 180), rect(162, 236, 418, 132))
const to = endpoint(1, rect(616, 512, 62, 22), rect(616, 500, 484, 300), rect(678, 544, 422, 232))
let hidden = false
const container = { box: rect(100, 50, 1000, 1000), offsetHeight: 1000, getBoundingClientRect() { return this.box }, querySelector: selector => selector.includes('0-from') ? from : selector.includes('0-to') && !hidden ? to : null, closest: () => null }
const { DiffView } = await import('./src/renderer/src/DiffView')
const fence = String.fromCharCode(96).repeat(3)
const files = ['source.md', 'target.md'].map((name, index) => ({ oldPath: name, newPath: name, status: 'modified', binary: false, hunks: [{ header: '@@ -1,5 +1,5 @@', lines: ['# Heading', fence + 'ts', 'function moved() {', '  return 1', fence].map((text, line) => ({ text, type: line ? (index ? 'add' : 'del') : 'context', oldNo: index && line ? null : line + 1, newNo: !index && line ? null : line + 1 })) }] }))
const props = { files, moves: [{ from: [{ file: 0, hunk: 0, line: 2 }], to: [{ file: 1, hunk: 0, line: 2 }] }] }
const render = () => { cursor = 0; const tree = DiffView.type(props); tree.props.ref.current = container; return tree }
render(); for (const effect of effects.splice(0)) effect()
const find = node => { if (!node || typeof node !== 'object') return; if (node.type === 'path' && node.props.stroke === 'var(--move)') return node.props.d; for (const child of [node.props?.children].flat(Infinity)) { const found = find(child); if (found) return found } }
const result = { path: find(render()), observedBlockAndContent: [from.block, from.node, to.block, to.node].every(element => observed.includes(element)) }
if (formatted && stored['bettergit.diffLayout'] === 'split') {
  // The overlay and both endpoints share viewport translation when the pane scrolls.
  const shift = box => rect(box.left + 20, box.top - 200, box.width, box.height)
  container.box = shift(container.box)
  for (const point of [from, to]) { point.railBox = shift(point.railBox); point.block.box = shift(point.block.box); point.node.box = shift(point.node.box) }
  globalThis.resizeMove(); result.scrolled = find(render())
  // Reflow can change the two content heights independently while keeping a facing gap.
  from.block.box = rect(120, 0, 560, 276); from.node.box = rect(182, 36, 498, 228)
  to.block.box = rect(716, 386, 564, 220); to.node.box = rect(778, 430, 502, 140)
  globalThis.resizeMove(); result.resized = find(render())
  hidden = true; globalThis.resizeMove(); result.hidden = find(render()) ?? null
  hidden = false; globalThis.resizeMove(); result.restored = find(render())
}
console.log(JSON.stringify(result))
for (const state of hooks) state.cleanup?.()
`

test('split moved Markdown connects facing block edges at the moved content, outside both bodies', () => {
  const child = Bun.spawnSync([process.execPath, '-e', MOVE_GEOMETRY_CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const result = JSON.parse(child.stdout.toString()) as { path: string; scrolled: string; resized: string; hidden: null; restored: string; observedBlockAndContent: boolean }
  expect(result.path).toBe('M 480 252 C 490.8 252, 490.8 610, 516 610')
  expect(result.observedBlockAndContent).toBe(true)
  expect(result.scrolled).toBe(result.path)
  expect(result.resized).toBe('M 560 300 C 570.8 300, 570.8 650, 596 650')
  expect(result.hidden).toBeNull()
  expect(result.restored).toBe(result.resized)
  const files = ['source.md', 'target.md'].map((path, index) => file(path, ['# Heading', '```ts', 'function moved() {', '  return 1', '```'].map((text, number) => line(text, number ? index ? 'add' : 'del' : 'context', number + 1))))
  const moves: MovedBlock[] = [{ from: [{ file: 0, hunk: 0, line: 2 }], to: [{ file: 1, hunk: 0, line: 2 }] }]
  const html = render(files, 'split', true, moves).html
  expect((html.match(/<pre data-source-range="1:4">/g) ?? []).length).toBe(2)
  expect((html.match(/data-move-id="0-from" data-source-row="0:0:2"/g) ?? []).length).toBe(1)
  expect((html.match(/data-move-id="0-to" data-source-row="1:0:2"/g) ?? []).length).toBe(1)
  expect(html).not.toContain('md-block-label')
})

test('shared move measurement retains raw split facing edges and the dedicated unified lane', () => {
  for (const [layout, formatted, expected] of [['split', 'false', 'M 480 240 C 490.8 240, 490.8 600, 516 600'], ['unified', 'true', 'M 26 171 H 5 V 473 H 26']]) {
    const child = Bun.spawnSync([process.execPath, '-e', MOVE_GEOMETRY_CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe', env: { ...process.env, MOVE_CHECK_LAYOUT: layout, MOVE_CHECK_FORMAT: formatted } })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    expect(JSON.parse(child.stdout.toString()).path).toBe(expected)
  }
})

// Run the real DiffView hooks for two mounted views. Only geometry and the hook lifecycle are inert substitutes;
// both preference handlers, source capture and effect cleanup/restoration come from the production module.
const ANCHOR_CHECK = `
const react = require('react')
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout },
})
let active, cursor
const effects = []
const slot = (initial) => {
  const index = cursor++
  return active.hooks[index] ?? (active.hooks[index] = initial())
}
react.useRef = (value) => slot(() => ({ current: value }))
react.useState = (value) => {
  const state = slot(() => ({ value: typeof value === 'function' ? value() : value }))
  return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next }]
}
react.useEffect = () => undefined
react.useMemo = (compute) => compute()
react.useId = () => 'anchor-test'
react.useDeferredValue = (value) => value
react.useCallback = (callback) => callback
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
react.useLayoutEffect = (effect, deps) => {
  const state = slot(() => ({}))
  if (!state.deps || deps.some((value, index) => value !== state.deps[index])) {
    effects.push(() => { state.cleanup?.(); state.cleanup = effect(); state.deps = deps })
  }
}
const { DiffView, setDiffLayout } = await import('./src/renderer/src/DiffView')
const prefs = await import('./src/renderer/src/prefs')
const flush = () => { for (const effect of effects.splice(0)) effect() }
const findButton = (node) => {
  if (!node || typeof node !== 'object') return
  if (node.props?.icon === 'markdown') return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findButton(child)
    if (found) return found
  }
}
const results = []
for (const mode of ['format', 'layout', 'formatted-layout']) for (const reversed of [false, true]) for (const separate of [false, true]) {
  prefs.setFormatMarkdown(mode === 'formatted-layout')
  setDiffLayout('unified')
  let shifted = false
  const pane = () => ({
    top: 500, writes: 0,
    get scrollTop() { return this.top },
    set scrollTop(value) { this.writes++; this.top = value },
    getBoundingClientRect: () => ({ top: 0, bottom: 900 }),
  })
  const firstPane = pane()
  const secondPane = separate ? pane() : firstPane
  const mount = (name, owner, before, growth, toolbarBottom) => {
    const row = {
      dataset: { sourceRow: '0:0:0', sourceSide: mode === 'formatted-layout' ? 'new' : undefined },
      getBoundingClientRect: () => ({ top: before + (shifted ? growth : 0) - owner.scrollTop, bottom: before + (shifted ? growth : 0) - owner.scrollTop + 22 }),
    }
    const container = {
      closest: () => owner,
      querySelector: () => ({ getBoundingClientRect: () => ({ bottom: toolbarBottom }) }),
      querySelectorAll: () => shifted && mode === 'formatted-layout' ? [{ dataset: { sourceRow: '0:0:0', sourceSide: 'old' }, getBoundingClientRect: () => ({ top: 400, bottom: 422 }) }, row] : [row],
    }
    const files = [{ oldPath: name, newPath: name, status: 'modified', binary: false,
      hunks: [{ header: '@@ -1 +1 @@', lines: [{ text: '# heading', type: 'context', oldNo: 1, newNo: 1 }] }] }]
    return { hooks: [], container, row, props: { files, moves: [], stage: { staged: name === 'staged.md', onToggle: () => undefined } } }
  }
  const staged = mount('staged.md', firstPane, 582, 50, 40)
  const unstaged = mount('unstaged.md', secondPane, separate ? 582 : 900, 150, separate ? 40 : 358)
  const views = reversed ? [unstaged, staged] : [staged, unstaged]
  const render = (view) => {
    active = view; cursor = 0
    view.tree = DiffView.type(view.props)
    view.tree.props.ref.current = view.container
  }
  views.forEach(render); flush()
  if (mode === 'format') findButton(unstaged.tree).props.onClick()
  else setDiffLayout('split')
  shifted = true
  views.forEach(render); flush()
  results.push({ mode, reversed, separate, first: firstPane.scrollTop, second: secondPane.scrollTop,
    firstWrites: firstPane.writes, secondWrites: secondPane.writes, firstRowTop: staged.row.getBoundingClientRect().top,
    secondRowTop: unstaged.row.getBoundingClientRect().top })
  for (const view of views) for (const state of view.hooks) state.cleanup?.()
}
console.log(JSON.stringify(results))
`

test('two mounted staged/unstaged views restore one first-visible row per scroll pane on both toggles', () => {
  const child = Bun.spawnSync([process.execPath, '-e', ANCHOR_CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const results = JSON.parse(child.stdout.toString()) as Array<{ mode: string; reversed: boolean; separate: boolean; first: number; second: number; firstWrites: number; secondWrites: number; firstRowTop: number; secondRowTop: number }>
  expect(results).toHaveLength(12)
  for (const result of results) {
    expect(result.first, JSON.stringify(result)).toBe(550)
    expect(result.firstWrites).toBe(1)
    expect(result.firstRowTop).toBe(82)
    expect(result.second).toBe(result.separate ? 650 : 550)
    expect(result.secondWrites).toBe(1)
    if (result.separate) expect(result.secondRowTop).toBe(82)
  }
})

test('formatting preserves patch order, pairing, gutters, move targets, signs, stats, headers and empty hunks', () => {
  const lines = [line('# Old one', 'del', 7), line('# Old two', 'del', 8), line('# New one', 'add', 9), line('context', 'context', 10)]
  const main = file('move.md', lines, '@@ -7,3 +9,2 @@')
  main.hunks.push({ header: '@@ empty @@', lines: [] })
  const headerOnly = { ...file('header.MD', []), hunks: [] }
  const additions = file('extra.md', [line('same *phrase*', 'del'), line('same **phrase**', 'add'), line('extra **addition**', 'add', 2)])
  const blank = file('blank.md', [line(''), line('  ', 'add', 2), line('\\ No newline at end of file', 'note')])
  const moves: MovedBlock[] = [{ from: [{ file: 0, hunk: 0, line: 0 }], to: [{ file: 0, hunk: 0, line: 2 }] }]
  const unified = render([main, headerOnly, additions, blank], 'unified', true, moves).html
  const unifiedText = unified.replace(/<[^>]+>/g, '')
  expect(unifiedText.indexOf('Old one')).toBeLessThan(unifiedText.indexOf('Old two'))
  expect(unifiedText.indexOf('Old two')).toBeLessThan(unifiedText.indexOf('New one'))
  const split = render([main, headerOnly, additions, blank], 'split', true, moves).html
  for (const html of [unified, split]) {
    expect(html).toContain('data-move-id="0-from" data-source-row="0:0:0"')
    expect(html).toContain('data-move-id="0-to" data-source-row="0:0:2"')
    expect(html).toContain('moved to line 9')
    expect(html).toContain('moved from line 7')
    expect((html.match(/data-move-id="0-from"/g) ?? []).length).toBe(1)
    expect((html.match(/data-move-id="0-to"/g) ?? []).length).toBe(1)
    expect(html).toContain('md-moved-text')
    expect(html).toContain('aria-label="1 added, 2 removed"')
    expect(html).toContain('aria-label="Stage move.md" disabled=""')
    expect(html).toContain('aria-label="move.md: expanded — click to collapse it"')
    expect(html).toContain('@@ empty @@')
    expect(html).toContain('data-path="header.MD"')
    expect(html).toContain('<span class="gutter">7</span>')
    expect(html).toContain('<span class="sign">-</span>')
    expect(html).toContain('<span class="sign">+</span>')
  }
  expect((split.match(/split-cell empty/g) ?? []).length).toBe(3)
  expect(split).toContain('No newline at end of file')
  const splitText = split.replace(/<[^>]+>/g, '')
  expect(splitText.indexOf('Old one')).toBeLessThan(splitText.indexOf('New one'))
  expect(splitText.indexOf('Old two')).toBeLessThan(splitText.indexOf('New one'))
  for (const layout of ['unified', 'split'] as const) {
    const raw = render([main, headerOnly, additions, blank], layout, false, moves).html
    const formatted = layout === 'unified' ? unified : split
    const sourceRows = (html: string) => [...html.matchAll(/data-source-row="([^"]+)"/g)].map(match => match[1])
    expect(sourceRows(formatted).sort()).toEqual(sourceRows(raw).sort())
  }
})

test('formatting keeps collapse persistence and restores raw content across both views', () => {
  const files = [file('read.md', [line('# Visible')]), file('closed.md', [line('# Hidden')]), file('remembered.md', [line('# Saved closed')])]
  // The default large-file collapse path still runs before Markdown rows are rendered.
  files[1].hunks[0].lines = Array.from({ length: 401 }, (_, index) => line(`# Hidden ${index}`, 'add', index + 1))
  const { html, otherView, reset, stored } = render(files, 'unified', true, [], {
    'bettergit.session': JSON.stringify({ views: { 'markdown-files': { key: 'commit', value: { 'remembered.md': false } } } }),
  })
  expect(html).toContain('<h1')
  expect(html).toContain('401 changed lines hidden')
  expect(html).not.toContain('Hidden 400')
  expect(html).not.toContain('Saved closed')
  expect(html).toContain('aria-label="remembered.md: collapsed — click to expand it"')
  expect(otherView).toBe(html)
  expect(reset).toContain('<code><span class="sx"># Visible</span></code>')
  expect(reset).not.toContain('<h1')
  expect(stored['bettergit.formatMarkdown']).toBe('false')
  expect(render(files, 'unified', false, [], stored).html).toContain('aria-label="Formatted Markdown: off — click to format Markdown" aria-pressed="false"')
})

test('formatting parses only open Markdown files; expanding builds the plan, raw and conflict views never parse', () => {
  const hidden = Array.from({ length: 401 }, (_, index) => line(`# Hidden ${index}`, 'add', index + 1))
  const files = [file('read.md', [line('# Visible')]), file('closed.md', hidden), file('remembered.md', [line('# Saved closed')])]
  const session = (value: Record<string, boolean>) => ({ 'bettergit.session': JSON.stringify({ views: { 'markdown-files': { key: 'commit', value } } }) })
  const collapsed = render(files, 'unified', true, [], session({ 'remembered.md': false }))
  expect(collapsed.html).toContain('401 changed lines hidden')
  expect(collapsed.parsed).toEqual([['# Visible']])
  const opened = session({ 'closed.md': true, 'remembered.md': true })
  const expanded = render(files, 'unified', true, [], opened)
  expect(expanded.parsed).toEqual([['# Visible'], hidden.map(entry => entry.text), ['# Saved closed']])
  const closed = expanded.html.split('data-path="closed.md"')[1].split('</section>')[0]
  expect((closed.match(/<h1[ >]/g) ?? []).length).toBe(401)
  expect((closed.match(/data-source-row=/g) ?? []).length).toBe(401)
  expect(closed).toContain('Hidden 400')
  expect(closed).toContain('data-source-row="1:0:400" data-source-side="new"')
  for (const control of [render(files, 'unified', false, [], opened), render(files, 'unified', true, [], opened, true)]) {
    expect(control.parsed).toEqual([])
    expect(control.html).toContain('<code><span class="sx"># Hidden 400</span></code>')
    expect(control.html).not.toContain('<h1')
  }
})

test('a Markdown hunk too large to format, counting its context, shows the raw diff without parsing, in both layouts', () => {
  const pair = [line('const total = count + 1', 'del', 2), line('const total = amount + 1', 'add', 2)]
  // One by row count (short context rows), one by characters (few long context rows). Each has a single replacement.
  const byRows = [...Array.from({ length: 5_001 }, (_, index) => line(`row ${index}`, 'context', index + 3)), ...pair]
  const byChars = [...Array.from({ length: 41 }, (_, index) => line(`${index} ${'x'.repeat(5_000)}`, 'context', index + 3)), ...pair]
  for (const [name, lines] of [['rows', byRows], ['chars', byChars]] as const) for (const layout of ['unified', 'split'] as const) {
    const { html, parsed } = render([file(`large-${name}.md`, lines)], layout)
    expect(parsed).toEqual([])
    expect(html).toContain('Too large to format as Markdown. Showing the source diff.')
    expect(html).toContain('aria-label="Formatted Markdown: on — click to show the raw source" aria-pressed="true"')
    expect(html).not.toContain('md-hunk')
    expect(html).toContain(`<code><span class="sx">${lines[0].text}</span></code>`)
    expect(html).toContain(`<code><span class="sx">${lines.at(-3)!.text}</span></code>`)
    expect((html.match(/class="intra"/g) ?? []).length).toBe(2)
    if (layout === 'unified') for (const sign of ['+', '-']) expect(html).toContain(`<span class="sign">${sign}</span>`)
  }
  // A hunk under the limit is still formatted.
  const small = render([file('small.md', [line('# Heading'), ...pair])], 'split')
  expect(small.parsed).toEqual([['# Heading', ...pair.map(entry => entry.text)]])
  expect(small.html).toContain('<h1')
  expect(small.html).not.toContain('Too large to format')
})

test('unsafe HTML, SVG, URL schemes and image destinations produce only inert text with no resource attributes', () => {
  const payloads = [
    '<script>globalThis.pwned = true</script>', '<svg onload="fetch(\'/secret\')"><image href="/private" /></svg>',
    '<img src="https://evil.test/tracker" onerror="alert(1)">',
    '<style>@import "https://evil.test/track";</style>', '<iframe srcdoc="<script>fetch(\'/secret\')</script>"></iframe>',
    ...['javascript:alert(1)', 'data:text/html,secret', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///private/key', 'http://evil.test/track', '//evil.test/track', '/local.png'].flatMap((url) => [`[label](${url})`, `![alt](${url})`]),
  ]
  const html = render(payloads.map((text, index) => file(`unsafe-${index}.md`, [line(text, 'add')]))).html
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('&lt;svg onload=')
  expect(html).toContain('file:///private/key')
  expect(html).toContain('data:text/html,secret')
  expect(html).not.toMatch(/<(?:script|img|image|iframe|a|object|style)\b/i)
  const tags = html.match(/<[^>]+>/g)?.join('') ?? ''
  expect(tags).not.toMatch(/\s(?:src|href|onload|onerror|srcdoc)=/i)
  expect(html.split('<div class="hunk">').slice(1).map(hunk => hunk.split('</section>')[0]).join('')).not.toMatch(/<svg\b/i)
  expect(html).not.toContain('style=')
})

test('long malformed syntax stays bounded without dropping source', () => {
  const text = '*['.repeat(10_000)
  const started = performance.now()
  const result = markdownHunk([line(text)])
  expect(result.new.entries[0].line.text).toBe(text)
  expect((renderToStaticMarkup(<MarkdownContent nodes={result.new.nodes} side={result.new} />).match(/\[/g) ?? []).length).toBe(10_000)
  // Strikethrough runs spread over the rows of one paragraph are bounded the same way.
  const rows = Array.from({ length: 100 }, () => line('a~'.repeat(100)))
  expect(renderToStaticMarkup(<MarkdownContent nodes={markdownHunk(rows).new.nodes} side={markdownHunk(rows).new} />)).not.toContain('<del')
  // Alternating markers are separate runs to the parser, so they count separately.
  for (const mixed of ['*_'.repeat(10_000) + 'x', '*~_'.repeat(7_000) + 'x']) expect(markdownHunk([line(mixed)]).new.entries[0].line.text).toBe(mixed)
  // Closing brackets are bounded too: each tries to close a link or reference, and they stay literal past the limit.
  const brackets = markdownHunk([line('[a][b]'.repeat(40_000))]).new
  expect((renderToStaticMarkup(<MarkdownContent nodes={brackets.nodes} side={brackets} />).match(/\]/g) ?? []).length).toBe(80_000)
  // Unbounded, these take seconds even on a fast machine (quadratic delimiter matching); bounded, tens of milliseconds.
  expect(performance.now() - started).toBeLessThan(2000)
})
