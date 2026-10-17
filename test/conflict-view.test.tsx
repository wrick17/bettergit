import { describe, expect, test } from 'bun:test'
import * as rowsModule from '../src/renderer/src/conflict-rows'
import { applyChoices, conflictBlocks, parseConflicts, type Choice, type Combine } from '../src/shared/conflict'

const { conflictRows, displayLine, isMarker } = rowsModule

// ConflictView renders the real DiffView, which reads localStorage and window when it loads. session.test.ts stubs
// them in this process, so every render runs in a child process, as in intraline.test.ts.
const MODEL = String.raw`
const { applyChoices, conflictBlocks, parseConflicts } = await import('./src/shared/conflict')
const unavailable = { state: 'unavailable', reason: 'The base could not be matched.' }
const fingerprint = { working: 'working-bytes-1', stages: 'stage-ids-1' }

// The model the parent builds from a parse. Combine defaults to unavailable, as it is before the backend merge.
function modelFor(text, combine = [], reset = { available: true, fingerprint }) {
  const parsed = parseConflicts(text)
  if (!parsed.ok) return { supported: false, message: parsed.failure.message, reset }
  const blocks = conflictBlocks(parsed.parts)
  return { supported: true, fingerprint, parts: parsed.parts, combine: blocks.map((_, index) => combine[index] ?? unavailable), reset }
}

// Three conflicts: a plain one, a diff3 one after a '=======' string, and one at the end of the file whose incoming
// side is empty and whose closing marker has no newline.
const threeBlocks = '// three conflicts\n'
  + '<<<<<<< HEAD\nexport const fox = "blue fox jumps";\n=======\nexport const fox = "red fox sleeps";\n>>>>>>> topic\n'
  + "const shared = '=======';\n"
  + '<<<<<<< HEAD\nexport const cat = "loud";\n||||||| base\nexport const cat = "base";\n=======\nexport const cat = "quiet";\n>>>>>>> topic\n'
  + '// tail\n'
  + '<<<<<<< HEAD\nexport const sky = "green";\n=======\n>>>>>>> topic'

// Two conflicts far apart: lines 1-10, conflict A on 11-15, 20 unchanged lines, conflict B on 36-40, then lines 41-50.
const range = (label, count) => Array.from({ length: count }, (_, i) => '// ' + label + ' ' + String(i + 1).padStart(2, '0') + '\n').join('')
const distant = range('before', 10)
  + '<<<<<<< HEAD\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> topic\n'
  + range('middle', 20)
  + '<<<<<<< HEAD\nexport const b = 1;\n=======\nexport const b = 2;\n>>>>>>> topic\n'
  + range('after', 10)
`

// The server renderer has no store subscription, so this child reads each store's snapshot directly.
const STATIC_CHECK = String.raw`
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => undefined },
  window: { addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout, clearTimeout },
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
const { renderToStaticMarkup } = await import('react-dom/server')
const { ConflictView } = await import('./src/renderer/src/ConflictView')
` + MODEL + String.raw`
// Finds the first element in the tree whose props match. The save control is rendered by ConflictView itself,
// so walking its element tree reaches the callback without a DOM.
function find(node, match) {
  for (const child of Array.isArray(node) ? node : [node]) {
    if (!react.isValidElement(child)) continue
    if (match(child)) return child
    const found = find(child.props.children, match)
    if (found) return found
  }
  return undefined
}
const twoBlocks = 'x\n<<<<<<< HEAD\nalpha\n=======\nbeta\n>>>>>>> topic\n'
  + 'y\n<<<<<<< HEAD\ngamma\n=======\ndelta\n>>>>>>> topic\n'
const props = (overrides = {}) => ({ path: 'src/app.ts', model: modelFor(twoBlocks), choices: [], onChoose() {}, onSave() {}, onReset() {}, busy: null, ...overrides })
const render = (overrides) => renderToStaticMarkup(react.createElement(ConflictView, props(overrides)))
const saved = []
find(ConflictView(props({ choices: ['current', null], onSave: (save) => saved.push(save) })), (element) => element.props.className === 'conflict-save')?.props.onClick?.()
// The reset control is an IconButton element here, so its props show the reason and busy state its tooltip uses.
const resetButton = (overrides) => find(ConflictView(props(overrides)), (element) => element.props.label === 'Reset resolution')?.props
const resetState = (overrides) => {
  const button = resetButton(overrides)
  return button && { icon: button.icon, busy: !!button.busy, blocked: button.blocked ?? null }
}
let resets = 0
resetButton({ onReset: () => resets++ })?.onClick()
console.log(JSON.stringify({
  markerFree: render({ model: modelFor('clean\n') }),
  otherBusy: render({ choices: ['current', null], busy: 'stage' }),
  resetStates: {
    plain: resetState(),
    markerFree: resetState({ model: modelFor('clean\n') }),
    unsupported: resetState({ model: modelFor('a\0b') }),
    unavailable: resetState({ model: modelFor(twoBlocks, [], { available: false, reason: 'Git has no common base for this conflict.' }) }),
    otherBusy: resetState({ busy: 'stage' }),
    resetting: resetState({ busy: 'conflict-reset' }),
  },
  resets,
  plain: render(),
  chosen: render({ choices: ['incoming', null] }),
  combined: render({ model: modelFor(twoBlocks, [{ state: 'ready', text: 'merged\n' }, unavailable]), choices: ['combine', null] }),
  unsupported: render({ model: modelFor('a\0b') }),
  crlf: render({ model: modelFor('x\r\n<<<<<<< HEAD\r\nalpha\r\n=======\r\nbeta\r\n>>>>>>> topic\r\n') }),
  saving: render({ choices: ['current', null], busy: 'resolve' }),
  inline: render({ model: modelFor(threeBlocks), choices: ['incoming', null, 'incoming'] }),
  inlineText: applyChoices(modelFor(threeBlocks).parts, ['incoming', null, 'incoming'], []).text,
  distant: render({ model: modelFor(distant) }),
  saved,
}))
`

// Real React, real effects and real Shiki, on in-memory host nodes. Buttons are pressed through the props React attached
// to them, and a small parent keeps the choices the way ChangesView does.
const CLIENT_CHECK = String.raw`
class HostNode {
  nodeType = 1
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  childNodes = []
  parentNode = null
  attributes = {}
  style = { setProperty(name, value) { this[name] = value }, removeProperty(name) { delete this[name] } }
  _text = ''
  constructor(tag, doc) { this.tagName = this.nodeName = tag.toUpperCase(); this.ownerDocument = doc }
  appendChild(node) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node }
  insertBefore(node, before) { node.parentNode?.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this; return node }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  setAttributeNS(_ns, name, value) { this.setAttribute(name, value) }
  removeAttribute(name) { delete this.attributes[name] }
  removeAttributeNS(_ns, name) { this.removeAttribute(name) }
  getAttribute(name) { return this.attributes[name] ?? null }
  addEventListener() {}
  removeEventListener() {}
  closest() { return null }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes.at(-1) ?? null }
  get nextSibling() { const siblings = this.parentNode?.childNodes; return siblings?.[siblings.indexOf(this) + 1] ?? null }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join('') }
  set textContent(text) { this.childNodes.forEach((node) => { node.parentNode = null }); this.childNodes = []; this._text = String(text) }
}
class HostText extends HostNode {
  nodeType = 3
  constructor(text, doc) { super('#text', doc); this._text = text }
  get nodeValue() { return this._text }
  set nodeValue(text) { this._text = text }
}
const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null }
doc.createElement = (tag) => new HostNode(tag, doc)
doc.createElementNS = (ns, tag) => Object.assign(new HostNode(tag, doc), { namespaceURI: ns })
doc.createTextNode = (text) => new HostText(text, doc)
doc.documentElement = doc.createElement('html')
doc.body = doc.createElement('body')
doc.documentElement.appendChild(doc.body)
const win = { document: doc, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, HTMLElement: HostNode, HTMLIFrameElement: class {}, location: { protocol: 'http:' } }
doc.defaultView = win
Object.assign(globalThis, { document: doc, window: win, HTMLElement: HostNode, Node: HostNode, localStorage: { getItem: () => null, setItem() {} }, IS_REACT_ACT_ENVIRONMENT: true })
const React = require('react')
const { createRoot } = require('react-dom/client')
const { ConflictView } = await import('./src/renderer/src/ConflictView')
` + MODEL + String.raw`
const host = doc.createElement('div')
doc.body.appendChild(host)
const errors = []
const root = createRoot(host, { onRecoverableError: (error) => errors.push(String(error)), onUncaughtError: (error) => errors.push(String(error)), onCaughtError: (error) => errors.push(String(error)) })
const all = (node, match) => [...(match(node) ? [node] : []), ...node.childNodes.flatMap((child) => all(child, match))]
const hasClass = (node, name) => (node.attributes?.class ?? '').split(' ').includes(name)
const isControls = (node) => node.attributes?.['aria-label']?.startsWith('Resolution for conflict')
const group = (label) => all(host, (node) => node.attributes?.['aria-label'] === 'Resolution for conflict ' + label)[0]
const press = (node) => React.act(() => node[Object.keys(node).find((key) => key.startsWith('__reactProps'))].onClick())
const button = (label, text) => all(group(label), (node) => node.tagName === 'BUTTON' && (node.textContent === text || node.attributes['aria-label'] === text))[0]
const sleep = () => React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
// The file as shown, in order: control groups, and rows by kind with their text, gutters and colour.
const view = () => all(host, (node) => hasClass(node, 'conflict-row') || isControls(node)).map((node) => (isControls(node)
  ? { controls: node.attributes['aria-label'], combination: button(node.attributes['aria-label'].replace('Resolution for conflict ', ''), 'Accept combination') !== undefined, resolved: all(node, (child) => child.tagName === 'BUTTON' && child.attributes['aria-pressed'] === 'true').map((pressed) => pressed.textContent) }
  : { kind: node.attributes.class.split(' ')[3], text: all(node, (child) => child.tagName === 'CODE')[0].textContent,
    gutters: all(node, (child) => hasClass(child, 'gutter')).map((gutter) => gutter.textContent), tok: all(node, (child) => hasClass(child, 'tok')).length > 0 }))
const hunks = () => all(host, (node) => hasClass(node, 'hunk-header')).length
// Rows whose text did not change keep their colours, so a wait names the row it needs coloured.
async function coloured(done = (items) => items.some((item) => item.tok)) {
  for (let i = 0; i < 200 && !done(view()); i++) await sleep()
  return view()
}

const saved = []
let setPath
function Parent({ model }) {
  const [choices, setChoices] = React.useState([])
  const [path, choosePath] = React.useState('src/app.ts')
  setPath = choosePath
  return React.createElement(ConflictView, {
    path, model, choices, busy: null, onReset() {},
    onChoose: (index, choice) => setChoices((previous) => { const next = [...previous]; next[index] = choice; return next }),
    onSave: (save) => saved.push(save),
  })
}
const model = modelFor(threeBlocks)
await React.act(async () => root.render(React.createElement(Parent, { key: 'three', model })))
const first = view()
const unresolved = await coloured()
press(button('1 of 3', 'Accept incoming'))
const switched = view()
const switchedColoured = await coloured((items) => items.find((item) => item.kind === 'incoming')?.tok)
press(button('3 of 3', 'Accept incoming'))
const emptyAtEnd = await coloured()
press(button('3 of 3', 'Clear the choice for conflict 3'))
const undone = await coloured()
React.act(() => setPath('notes.txt'))
for (let i = 0; i < 10; i++) await sleep()
const neutral = view()
press(all(host, (node) => hasClass(node, 'conflict-save'))[0])

const far = modelFor(distant)
await React.act(async () => root.render(React.createElement(Parent, { key: 'distant', model: far })))
const folded = { hunks: hunks(), view: view() }
press(button('2 of 2', 'Accept current'))
press(all(host, (node) => hasClass(node, 'hunk-expand-btn'))[0])
const widened = { hunks: hunks(), view: await coloured() }
const { setDiffLayout } = await import('./src/renderer/src/DiffView')
const splitView = () => all(host, (node) => (hasClass(node, 'split-row') && !hasClass(node, 'conflict-sides')) || isControls(node)).map((node) => isControls(node)
  ? { controls: node.attributes['aria-label'], combination: button(node.attributes['aria-label'].replace('Resolution for conflict ', ''), 'Accept combination') !== undefined, resolved: all(node, (child) => child.tagName === 'BUTTON' && child.attributes['aria-pressed'] === 'true').map((pressed) => pressed.textContent) }
  : { cells: node.childNodes.map((cell) => ({
    empty: hasClass(cell, 'empty'),
    kind: cell.attributes.class.split(' ')[3],
    text: all(cell, (child) => child.tagName === 'CODE')[0]?.textContent,
    gutter: all(cell, (child) => hasClass(child, 'gutter'))[0]?.textContent,
    tok: all(cell, (child) => hasClass(child, 'tok')).length > 0,
  })) })
React.act(() => setDiffLayout('split'))
await React.act(async () => root.render(React.createElement(Parent, { key: 'split', model: modelFor(threeBlocks, [{ state: 'overlap' }]) })))
const split = splitView()
const splitActions = () => all(host, (node) => hasClass(node, 'conflict-split-controls')).map((node) => ({
  block: node.attributes['aria-label'],
  sides: node.childNodes.map((side) => ({
    label: side.attributes['aria-label'],
    buttons: all(side, (child) => child.tagName === 'BUTTON').map((button) => ({
      text: button.textContent, label: button.attributes['aria-label'],
      pressed: button.attributes['aria-pressed'] === 'true', disabled: button.attributes.disabled !== undefined,
    })),
  })),
}))
const initialActions = splitActions()
const sideButton = (label, side, text) => all(group(label).childNodes[side], (node) => node.tagName === 'BUTTON' && (node.textContent === text || node.attributes['aria-label'] === text))[0]
const splitLabels = all(host, (node) => hasClass(node, 'conflict-sides')).map((node) => node.textContent)
await coloured()
const splitColoured = splitView()
press(button('2 of 3', 'Accept current'))
press(button('1 of 3', 'Accept incoming'))
const splitChosenImmediate = splitView()
await coloured((items) => items.find((item) => item.text === 'export const fox = "red fox sleeps";')?.tok)
const splitChosenColoured = splitView()
React.act(() => setDiffLayout('unified'))
const splitToUnified = view()
const unifiedActions = all(host, isControls).map((group) => all(group, (node) => hasClass(node, 'conflict-choice')).map((button) => button.textContent))
React.act(() => setDiffLayout('split'))
const flippedBack = splitView()
press(button('3 of 3', 'Accept incoming'))
const splitEmptyEnd = splitView()
const emptyEndActions = splitActions()
press(sideButton('3 of 3', 1, 'Clear the choice for conflict 3'))
const splitUndo = splitView()
press(button('1 of 3', 'Accept both'))
const splitBoth = splitView()
const bothActions = splitActions()
press(sideButton('1 of 3', 1, 'Accept both'))
const bothClearedActions = splitActions()
press(sideButton('1 of 3', 1, 'Accept both'))
const bothFromRightActions = splitActions()
const splitSavedStart = saved.length
press(all(host, (node) => hasClass(node, 'conflict-save'))[0])
const splitSaved = saved.splice(splitSavedStart)
const rawAfterChoices = applyChoices(model.parts, [], []).text

const unequalModel = modelFor('before\n<<<<<<< HEAD\ncurrent one\ncurrent two\n=======\nincoming one\n>>>>>>> topic\nafter\r', [{ state: 'ready', text: 'combined words\n' }])
await React.act(async () => root.render(React.createElement(Parent, { key: 'unequal', model: unequalModel })))
const unequal = splitView()
press(sideButton('1 of 1', 0, 'Accept combination'))
const splitCombined = splitView()
const combinedActions = splitActions()
press(sideButton('1 of 1', 1, 'Clear the choice for conflict 1'))
const combinedUndoneActions = splitActions()
press(sideButton('1 of 1', 1, 'Accept combination'))
const combinedFromRightActions = splitActions()
press(sideButton('1 of 1', 0, 'Clear the choice for conflict 1'))
const unequalUndo = splitView()
await React.act(async () => root.render(React.createElement(Parent, { key: 'empty-current', model: modelFor('<<<<<<< HEAD\n=======\nincoming only\n>>>>>>> topic') })))
const emptyCurrent = splitView()

await React.act(async () => root.render(React.createElement(Parent, { key: 'far-split', model: far })))
const splitFolded = { hunks: hunks(), view: splitView() }
press(button('2 of 2', 'Accept current'))
press(all(host, (node) => hasClass(node, 'hunk-expand-btn'))[0])
const splitWidened = { hunks: hunks(), view: splitView() }
await React.act(async () => root.unmount())
console.log(JSON.stringify({
  unresolvedText: applyChoices(model.parts, [], []).text,
  oneText: applyChoices(model.parts, ['incoming'], []).text,
  splitChosenText: applyChoices(model.parts, ['incoming', 'current'], []).text,
  bothText: applyChoices(model.parts, ['incoming', null, 'incoming'], []).text,
  farText: applyChoices(far.parts, [], []).text,
  widenedText: applyChoices(far.parts, [null, 'current'], []).text,
  first, unresolved, switched, switchedColoured, emptyAtEnd, undone, neutral, folded, widened, split, initialActions, unifiedActions, emptyEndActions, bothActions, bothClearedActions, bothFromRightActions, combinedActions, combinedUndoneActions, combinedFromRightActions, splitLabels, splitColoured, splitChosenImmediate, splitChosenColoured, splitToUnified, flippedBack, splitEmptyEnd, splitUndo, splitBoth, splitSaved, rawAfterChoices, unequal, splitCombined, unequalUndo, emptyCurrent, splitFolded, splitWidened, saved, errors,
}))
`

function runChild(script: string) {
  const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.stderr.toString()).toBe('')
  expect(child.exitCode).toBe(0)
  return JSON.parse(child.stdout.toString())
}

let markups: ReturnType<typeof runChild> | undefined
let client: ReturnType<typeof runChild> | undefined
const views = () => (markups ??= runChild(STATIC_CHECK))
const clientRun = () => (client ??= runChild(CLIENT_CHECK))
const fingerprint = { working: 'working-bytes-1', stages: 'stage-ids-1' }
const linesOf = (text: string) => text.replace(/\n$/, '').split('\n')
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
type Item = { kind?: string; text?: string; gutters?: string[]; tok?: boolean; controls?: string; resolved?: string[] }
// The shown file as one list: 'controls N' for a control group, otherwise the row kind.
const shape = (items: Item[]) => items.map((item) => item.kind ?? `controls ${/conflict (\d+)/.exec(item.controls!)![1]}`)
const rowText = (items: Item[]) => items.filter((item) => item.kind).map((item) => item.text)

// Line endings, a byte order mark before a conflict, a file that ends on a closing marker, a diff3 base, and a bare
// carriage return inside a line and at the end of the file.
const FIXTURES = [
  "const sep = '======='\n<<<<<<< HEAD\nconst a = 1\n=======\nconst a = 2\n>>>>>>> topic\n",
  'Title\n=======\n\n<<<<<<< HEAD\nOne\n=======\nTwo\n>>>>>>> topic\n',
  'x\r\n<<<<<<< HEAD\r\nalpha\r\n=======\r\nbeta\r\n>>>>>>> topic\r\n',
  '﻿<<<<<<< HEAD\nalpha\n=======\nbeta\n>>>>>>> topic\ntail\n',
  'x\n<<<<<<< HEAD\nalpha\n=======\nbeta\n>>>>>>> topic',
  'x\n<<<<<<< HEAD\nalpha\r\n=======\n>>>>>>> topic',
  'a\n<<<<<<< HEAD\nb1\n||||||| base\nb0\n=======\nb2\n>>>>>>> topic\nc\n',
  'x\n<<<<<<< HEAD\na\rb\n=======\nc\n>>>>>>> topic\n',
  '<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> topic\ntail\r',
]

const partsOf = (text: string) => {
  const parsed = parseConflicts(text)
  if (!parsed.ok) throw new Error(parsed.failure.message)
  return parsed.parts
}

describe('conflictRows', () => {
  test('the result rows join to the saved text for every choice, numbered in order', () => {
    for (const text of FIXTURES) {
      const parts = partsOf(text)
      const combine: Combine[] = conflictBlocks(parts).map(() => ({ state: 'ready', text: 'merged\n' }))
      for (const choice of [null, 'current', 'incoming', 'both', 'combine'] as Choice[]) {
        const choices = combine.map(() => choice)
        const applied = applyChoices(parts, choices, combine)
        if (!applied.ok) throw new Error(applied.reason)
        const { result } = conflictRows(parts, choices, combine)
        expect(result.map((row) => row.raw).join('')).toBe(applied.text)
        expect(result.map((row) => row.line.newNo)).toEqual(result.map((_, index) => index + 1))
        expect(result.some((row) => /[\r\n]/.test(row.line.text))).toBe(false)
        expect(result.some((row) => isMarker(row.kind))).toBe(choice === null)
      }
    }
  })

  test('only a line feed or CRLF ends a shown line; any other carriage return shows as a glyph', () => {
    expect([displayLine('a\n'), displayLine('a\r\n'), displayLine('a\rb\n'), displayLine('tail\r'), displayLine('tail')]).toEqual(['a', 'a', 'a␍b', 'tail␍', 'tail'])
    const last = conflictRows(partsOf(FIXTURES[8]), ['current'], []).result.at(-1)!
    expect(last.raw).toBe('tail\r')
    expect(last.line.text).toBe('tail␍')
  })

  test('markers come only from the parse', () => {
    expect(conflictRows(partsOf(FIXTURES[1]), [], []).result.map((row) => row.kind)).toEqual(['text', 'text', 'text', 'marker-open', 'current', 'marker-split', 'incoming', 'marker-close'])
    expect(conflictRows(partsOf(FIXTURES[0]), [], []).result[0].kind).toBe('text')
    expect(conflictRows(partsOf(FIXTURES[3]), [], []).result[0]).toMatchObject({ kind: 'marker-open', raw: '﻿<<<<<<< HEAD\n' })
    expect(conflictRows(partsOf(FIXTURES[6]), [], []).result.map((row) => row.kind)).toEqual(['text', 'marker-open', 'current', 'marker-base', 'base', 'marker-split', 'incoming', 'marker-close', 'text'])
  })

  test('conflictFile folds unchanged lines into hunks and anchors each conflict, even an empty one at the end', () => {
    const range = (label: string, count: number) => Array.from({ length: count }, (_, i) => `// ${label} ${String(i + 1).padStart(2, '0')}\n`).join('')
    const block = (name: string) => `<<<<<<< HEAD\nexport const ${name} = 1;\n=======\nexport const ${name} = 2;\n>>>>>>> topic\n`
    const parts = partsOf(range('before', 10) + block('a') + range('middle', 20) + block('b') + range('after', 10))
    const folded = rowsModule.conflictFile('src/app.ts', parts, [], [], 3)
    expect(folded.file.hunks.map((hunk) => hunk.lines.map((line) => line.newNo))).toEqual([[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18], [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]])
    expect(folded.before.get(folded.file.hunks[0].lines[3])).toEqual([0])
    expect(folded.before.get(folded.file.hunks[1].lines[3])).toEqual([1])
    const resolved = rowsModule.conflictFile('src/app.ts', parts, [null, 'current'], [], 3)
    expect(resolved.file.hunks[1].lines.map((line) => [line.oldNo, line.newNo, line.text])).toEqual([
      [33, 33, '// middle 18'], [34, 34, '// middle 19'], [35, 35, '// middle 20'], [37, 36, 'export const b = 1;'],
      [41, 37, '// after 01'], [42, 38, '// after 02'], [43, 39, '// after 03'],
    ])
    expect(resolved.kinds.get(resolved.file.hunks[1].lines[3])).toBe('current')
    expect(rowsModule.conflictFile('src/app.ts', parts, [], [], 10).file.hunks.map((hunk) => hunk.lines.length)).toEqual([50])
    const atEnd = rowsModule.conflictFile('a.ts', partsOf(FIXTURES[5]), ['incoming'], [], 3)
    expect(atEnd.file.hunks.map((hunk) => hunk.lines.map((line) => line.text))).toEqual([['x']])
    expect(atEnd.end).toEqual([0])
    const empty = rowsModule.conflictFile('a.ts', partsOf('<<<<<<< HEAD\n=======\nb\n>>>>>>> topic\n'), ['current'], [], 3)
    expect(empty.file.hunks.map((hunk) => hunk.lines.length)).toEqual([0])
    expect(empty.end).toEqual([0])
  })

  test('conflictFile shows overlapping context windows as one hunk and keeps separate ones apart, at any context', () => {
    // A 64000-line side accepted with All context: every window overlaps, and the hunk is the whole result.
    const big = rowsModule.conflictFile('big.ts', partsOf(`<<<<<<< HEAD\n${'x\n'.repeat(64000)}=======\ny\n>>>>>>> topic\n`), ['current'], [], 100000)
    const lines = big.file.hunks.flatMap((hunk) => hunk.lines)
    expect(big.file.hunks.map((hunk) => hunk.header)).toEqual(['@@ -2,64000 +1,64000 @@'])
    expect([lines.length, lines[0].oldNo, lines[0].newNo, lines.at(-1)!.oldNo, lines.at(-1)!.newNo]).toEqual([64000, 2, 1, 64001, 64000])
    expect(big.before.get(lines[0])).toEqual([0])
    // Two conflicts four lines apart: their windows merge at context 3 and part at context 1.
    const block = '<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> topic\n'
    const parts = partsOf(`a\nb\n${block}c\nd\ne\nf\n${block}g\nh\n`)
    const newNumbers = (context: number) => rowsModule.conflictFile('a.ts', parts, [], [], context).file.hunks.map((hunk) => hunk.lines.map((line) => line.newNo))
    expect(newNumbers(3)).toEqual([Array.from({ length: 18 }, (_, index) => index + 1)])
    expect(newNumbers(1)).toEqual([[2, 3, 4, 5, 6, 7, 8], [11, 12, 13, 14, 15, 16, 17]])
    const apart = rowsModule.conflictFile('a.ts', parts, [], [], 1)
    expect([apart.before.get(apart.file.hunks[0].lines[1]), apart.before.get(apart.file.hunks[1].lines[1])]).toEqual([[0], [1]])
  })
})

describe('ConflictView', () => {
  test('shows both sides of every conflict and a count of unresolved ones, with save disabled', () => {
    const markup = views().plain
    for (const code of ['alpha', 'beta', 'gamma', 'delta']) expect(markup).toContain(code)
    expect(markup).toContain('0 of 2 resolved')
    expect(markup).toMatch(/class="conflict-save" disabled=""/)
  })

  test('marks the chosen resolution and enables save once one block is resolved', () => {
    const markup = views().chosen
    expect(markup).toContain('Resolved with incoming')
    expect(markup).toContain('1 of 2 resolved')
    expect(markup).not.toMatch(/class="conflict-save" disabled/)
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Accept incoming</)
  })

  test('an unavailable combination shows its reason and no combination action', () => {
    const markup = views().plain
    expect(markup).toContain('The base could not be matched.')
    expect(markup).not.toContain('Accept combination')
  })

  test('a ready combination can be chosen', () => {
    const markup = views().combined
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Accept combination</)
    expect(markup).toContain('merged')
    // Only the first block has a ready combination; the second, whose base is unavailable, shows no action for it.
    expect(markup.match(/>Accept combination</g)).toHaveLength(1)
  })

  test('an unsupported file shows its reason and no controls', () => {
    const markup = views().unsupported
    expect(markup).toContain('NUL bytes')
    expect(markup).not.toContain('Accept current')
    expect(markup).not.toContain('Save resolution')
  })

  test('carriage returns never reach the page', () => {
    const markup = views().crlf
    expect(markup).toContain('alpha')
    expect(markup).not.toContain('\r')
  })

  test('saving stops every control and says so', () => {
    const markup = views().saving
    expect(markup).toContain('Saving…')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Accept current<\/button>/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Accept incoming<\/button>/)
  })

  test('reset is one icon beside Save, and stays in the bar with broken markers or none left', () => {
    const { plain, markerFree, unsupported, resets } = views()
    for (const markup of [plain, markerFree, unsupported]) {
      expect(markup).toMatch(/<header class="conflict-bar">.*aria-label="Reset resolution".*<\/header>/)
      expect(markup).not.toMatch(/>\s*Reset resolution\s*</)
    }
    expect(plain.indexOf('aria-label="Reset resolution"')).toBeLessThan(plain.indexOf('Save resolution'))
    expect(markerFree).toContain('No conflict markers remain')
    expect(resets).toBe(1)
  })

  test('reset gives its reason when unavailable, and every control stops while a write runs', () => {
    const { resetStates, otherBusy } = views()
    expect(resetStates).toEqual({
      plain: { icon: 'reset', busy: false, blocked: null },
      markerFree: { icon: 'reset', busy: false, blocked: null },
      unsupported: { icon: 'reset', busy: false, blocked: null },
      unavailable: { icon: 'reset', busy: false, blocked: 'Git has no common base for this conflict.' },
      otherBusy: { icon: 'reset', busy: false, blocked: 'Another action is running: Staging…' },
      resetting: { icon: 'reset', busy: true, blocked: null },
    })
    expect(otherBusy).toMatch(/<button[^>]*class="conflict-save"[^>]*disabled=""/)
    expect(otherBusy).toMatch(/<button[^>]*disabled=""[^>]*>Accept current<\/button>/)
  })

  test('save hands back the fingerprint from load with the current choices', () => {
    expect(views().saved).toEqual([{ fingerprint, choices: ['current', null] }])
  })

  test('the file shows once, in the diff viewer, with each conflict\'s controls inline above it', () => {
    const { inline, inlineText } = views()
    const items: Item[] = [...inline.matchAll(/class="line context conflict-row ([\w-]+)|role="group" aria-label="(Resolution for conflict \d+ of 3)"/g)]
      .map((match) => (match[1] ? { kind: match[1] } : { controls: match[2] }))
    expect(shape(items)).toEqual(['text', 'controls 1', 'incoming', 'text', 'controls 2', 'marker-open', 'current', 'marker-base', 'base', 'marker-split', 'incoming', 'marker-close', 'text', 'controls 3'])
    // One copy of each line, in DiffView's own file and hunk: no separate sides, no second result pane.
    for (const line of linesOf(inlineText)) expect(inline.split(`<code>${escape(line)}</code>`).length - 1).toBe(1)
    expect(inline).toContain('class="diff-file"')
    expect(inline).toContain('class="hunk-header"')
    expect(inline).not.toContain('split-cell')
    expect(inline).not.toContain('aria-label="Result"')
    expect(inline).toContain('Clear the choice for conflict 1')
    expect(inline).toContain('Clear the choice for conflict 3')
    expect(inline).not.toContain('Clear the choice for conflict 2')
  })

  test('unchanged lines far from a conflict fold away like any diff', () => {
    const { distant } = views()
    expect(distant.match(/class="hunk-header"/g)).toHaveLength(2)
    expect(distant.match(/class="hunk-expand-btn"/g)).toHaveLength(4)
    for (const hidden of ['// before 07', '// middle 04', '// middle 17', '// after 04']) expect(distant).not.toContain(hidden)
    for (const shown of ['// before 08', '// middle 03', '// middle 18', '// after 03']) expect(distant).toContain(shown)
  })

  test('choosing in place keeps the other choices, shows new text plain then coloured, and Undo works at the end', () => {
    const { unresolvedText, oneText, bothText, first, unresolved, switched, switchedColoured, emptyAtEnd, undone, neutral, saved, errors } = clientRun()
    expect(errors).toEqual([])
    // The exact source shows at once, before any colour arrives.
    expect(rowText(first)).toEqual(linesOf(unresolvedText))
    expect(first.some((item: Item) => item.tok)).toBe(false)
    expect(shape(unresolved)).toEqual(['text', 'controls 1', 'marker-open', 'current', 'marker-split', 'incoming', 'marker-close', 'text', 'controls 2', 'marker-open', 'current', 'marker-base', 'base', 'marker-split', 'incoming', 'marker-close', 'text', 'controls 3', 'marker-open', 'current', 'marker-split', 'marker-close'])
    for (const row of unresolved.filter((item: Item) => item.kind)) expect(row.tok).toBe(!row.kind.startsWith('marker-'))
    expect(unresolved.filter((item: Item) => item.kind).map((row: Item) => row.gutters)).toEqual(linesOf(unresolvedText).map((_, index) => [`${index + 1}`, `${index + 1}`]))
    // Conflict 1 is replaced in place. Its new line is plain until its colours land; nothing stale shows.
    expect(rowText(switched)).toEqual(linesOf(oneText))
    expect(switched.find((item: Item) => item.kind === 'incoming').tok).toBe(false)
    expect(rowText(switchedColoured)).toEqual(linesOf(oneText))
    expect(switchedColoured.find((item: Item) => item.kind === 'incoming')).toMatchObject({ text: 'export const fox = "red fox sleeps";', gutters: ['5', '2'], tok: true })
    expect(switchedColoured.find((item: Item) => item.controls?.includes('conflict 1'))?.resolved).toEqual(['Accept incoming'])
    // An empty side accepted at the end of the file leaves its controls after the last row, so Undo stays reachable.
    expect(rowText(emptyAtEnd)).toEqual(linesOf(bothText))
    expect(shape(emptyAtEnd).at(-1)).toBe('controls 3')
    expect(shape(undone)).toEqual(['text', 'controls 1', 'incoming', 'text', 'controls 2', 'marker-open', 'current', 'marker-base', 'base', 'marker-split', 'incoming', 'marker-close', 'text', 'controls 3', 'marker-open', 'current', 'marker-split', 'marker-close'])
    expect(rowText(neutral)).toEqual(linesOf(oneText))
    expect(neutral.some((item: Item) => item.tok)).toBe(false)
    expect(saved).toEqual([{ fingerprint, choices: ['incoming', null, null] }])
  }, 20_000)

  test('expanding folded context shows the unchanged lines and keeps every conflict control and choice', () => {
    const { farText, widenedText, folded, widened, errors } = clientRun()
    expect(errors).toEqual([])
    expect(folded.hunks).toBe(2)
    expect(rowText(folded.view)).toEqual([...linesOf(farText).slice(7, 18), ...linesOf(farText).slice(32, 43)])
    expect(widened.hunks).toBe(1)
    expect(rowText(widened.view)).toEqual(linesOf(widenedText))
    expect(shape(widened.view).filter((kind) => kind.startsWith('controls'))).toEqual(['controls 1', 'controls 2'])
    expect(widened.view.find((item: Item) => item.controls?.includes('conflict 2'))?.resolved).toEqual(['Accept current'])
    expect(widened.view.find((item: Item) => item.kind === 'current' && item.text === 'export const b = 1;')).toMatchObject({ gutters: ['37', '36'] })
  }, 20_000)
})

type SplitCellSnapshot = { empty: boolean; kind?: string; text?: string; gutter?: string; tok: boolean }
type SplitItem = { controls?: string; resolved?: string[]; combination?: boolean; cells?: SplitCellSnapshot[] }
const pairsOf = (items: SplitItem[]) => items.flatMap((item) => item.cells ? [item.cells] : [])
const sideText = (items: SplitItem[], side: number) => pairsOf(items).map((cells) => cells[side].text).filter((text) => text !== undefined)
const controlsOf = (items: SplitItem[]) => items.filter((item) => item.controls)

test('split conflicts show incoming only on the left and current only on the right in the real viewer', () => {
  const { split, splitLabels, splitColoured, errors } = clientRun()
  expect(errors).toEqual([])
  expect(splitLabels).toEqual(['IncomingCurrent'])
  expect(controlsOf(split).some((item) => item.combination)).toBe(false)
  expect(sideText(split, 0)).toContain('export const fox = "red fox sleeps";')
  expect(sideText(split, 0)).not.toContain('export const fox = "blue fox jumps";')
  expect(sideText(split, 1)).toContain('export const fox = "blue fox jumps";')
  expect(sideText(split, 1)).not.toContain('export const fox = "red fox sleeps";')
  expect(pairsOf(split)[0].map((cell) => [cell.text, cell.gutter])).toEqual([['// three conflicts', '1'], ['// three conflicts', '1']])
  expect(pairsOf(split).find((cells) => cells[0].text === 'export const fox = "red fox sleeps";')!.map((cell) => cell.gutter)).toEqual(['5', '3'])
  expect(controlsOf(split).map((item) => item.controls)).toEqual([
    'Resolution for conflict 1 of 3', 'Resolution for conflict 2 of 3', 'Resolution for conflict 3 of 3',
  ])
  // Every shown cell still names its actual source line in this unresolved preview; neither pane reorders its source.
  const source = linesOf(clientRun().unresolvedText)
  for (const side of [0, 1]) {
    const cells = pairsOf(split).map((pair) => pair[side]).filter((cell) => !cell.empty)
    expect(cells.map((cell) => Number(cell.gutter))).toEqual(cells.map((cell) => Number(cell.gutter)).sort((a, b) => a - b))
    for (const cell of cells) expect(cell.text).toBe(source[Number(cell.gutter) - 1])
    for (const shared of ['// three conflicts', "const shared = '=======';", '// tail']) expect(sideText(split, side)).toContain(shared)
  }
  const colouredCells = pairsOf(splitColoured).flat().filter((cell) => !cell.empty)
  for (const cell of colouredCells) expect(cell.tok).toBe(!cell.kind!.startsWith('marker-'))
})

test('split choices preview inline and survive mode flips, another choice, empty EOF, Undo and Both', () => {
  const { splitChosenImmediate, splitChosenColoured, splitToUnified, flippedBack, splitEmptyEnd, splitUndo, splitBoth, splitSaved, rawAfterChoices } = clientRun()
  expect(splitSaved).toEqual([{ fingerprint, choices: ['both', 'current', null] }])
  expect(rawAfterChoices).toBe(clientRun().unresolvedText)
  const prefix = ['// three conflicts', 'export const fox = "red fox sleeps";', "const shared = '=======';", 'export const cat = "loud";', '// tail']
  for (const side of [0, 1]) expect(sideText(splitChosenImmediate, side).slice(0, 5)).toEqual(prefix)
  // The selected line is raw immediately, then receives only colours that fit that same source text.
  const chosen = pairsOf(splitChosenImmediate).flat().filter((cell) => cell.text === 'export const fox = "red fox sleeps";')
  expect(chosen).toHaveLength(2)
  expect(chosen.every((cell) => !cell.tok)).toBe(true)
  expect(pairsOf(splitChosenColoured).flat().filter((cell) => cell.text === chosen[0].text).every((cell) => cell.tok)).toBe(true)
  expect(controlsOf(flippedBack).map((item) => item.resolved)).toEqual([['Accept incoming'], ['Accept current'], []])
  expect(rowText(splitToUnified)).toEqual(linesOf(clientRun().splitChosenText))
  expect(pairsOf(flippedBack).map((cells) => cells.map((cell) => cell.text))).toEqual(pairsOf(splitChosenImmediate).map((cells) => cells.map((cell) => cell.text)))
  expect(splitEmptyEnd.at(-1)?.controls).toBe('Resolution for conflict 3 of 3')
  expect(controlsOf(splitEmptyEnd).map((item) => item.resolved)).toEqual([['Accept incoming'], ['Accept current'], ['Accept incoming']])
  expect(pairsOf(splitUndo).some((cells) => cells[0].empty && cells[1].text === 'export const sky = "green";')).toBe(true)
  expect(controlsOf(splitUndo).map((item) => item.resolved)).toEqual([['Accept incoming'], ['Accept current'], []])
  for (const side of [0, 1]) {
    expect(sideText(splitBoth, side)).toContain('export const fox = "blue fox jumps";')
    expect(sideText(splitBoth, side)).toContain('export const fox = "red fox sleeps";')
  }
})

test('split unequal sides hatch gaps, combine inline, preserve bare CR, and keep choices when context expands', () => {
  const { unequal, splitCombined, unequalUndo, emptyCurrent, splitFolded, splitWidened } = clientRun()
  expect(pairsOf(emptyCurrent).find((cells) => cells[0].text === 'incoming only')![1].empty).toBe(true)
  expect(controlsOf(unequal)[0].combination).toBe(true)
  expect(pairsOf(unequal).find((cells) => cells[1].text === 'current two')![0].empty).toBe(true)
  expect(sideText(unequal, 0).filter((text) => text?.startsWith('current'))).toEqual([])
  expect(sideText(unequal, 1).filter((text) => text?.startsWith('incoming'))).toEqual([])
  for (const side of [0, 1]) {
    expect(sideText(splitCombined, side)).toEqual(['before', 'combined words', 'after␍'])
    expect(sideText(unequalUndo, side)).toEqual(sideText(unequal, side))
    expect(sideText(splitWidened.view, side)).toContain('// before 01')
    expect(sideText(splitWidened.view, side)).toContain('// after 10')
    expect(sideText(splitWidened.view, side)).toContain('export const b = 1;')
    expect(sideText(splitWidened.view, side)).not.toContain('export const b = 2;')
  }
  expect(splitFolded.hunks).toBe(2)
  expect(splitWidened.hunks).toBe(1)
  expect(controlsOf(splitWidened.view).map((item) => item.resolved)).toEqual([[], ['Accept current']])
})

test('each split column has its own actions for the same conflict block, without an unavailable combination', () => {
  const { initialActions } = clientRun()
  expect(initialActions).toHaveLength(3)
  for (const [index, block] of initialActions.entries()) {
    expect(block.block).toBe(`Resolution for conflict ${index + 1} of 3`)
    expect(block.sides.map((side: { label: string }) => side.label)).toEqual([
      `Incoming actions for conflict ${index + 1} of 3`, `Current actions for conflict ${index + 1} of 3`,
    ])
    // Block 1 overlaps and blocks 2 and 3 have no base, so no column offers a combination.
    expect(block.sides[0].buttons.map((button: { text: string }) => button.text)).toEqual(['Accept incoming', 'Accept both'])
    expect(block.sides[1].buttons.map((button: { text: string }) => button.text)).toEqual(['Accept current', 'Accept both'])
  }
})


test('split Both, Combination and Undo stay synchronized across columns and unified omits an unavailable combination', () => {
  const { bothActions, bothClearedActions, bothFromRightActions, combinedActions, combinedUndoneActions, combinedFromRightActions, emptyEndActions, unifiedActions } = clientRun()
  type Action = { text: string; label?: string; pressed: boolean; disabled: boolean }
  type Block = { sides: { buttons: Action[] }[] }
  const selected = (block: Block) => block.sides.map((side) => side.buttons.filter((button) => button.pressed).map((button) => button.text))
  const undo = (block: Block) => block.sides.map((side) => side.buttons.filter((button) => button.label?.startsWith('Clear the choice')).map((button) => button.disabled))
  expect(selected(bothActions[0])).toEqual([['Accept both'], ['Accept both']])
  expect(selected(bothClearedActions[0])).toEqual([[], []])
  expect(selected(bothFromRightActions[0])).toEqual([['Accept both'], ['Accept both']])
  expect(selected(bothClearedActions[1])).toEqual([[], ['Accept current']])
  expect(undo(bothActions[0])).toEqual([[false], [false]])
  expect(undo(bothClearedActions[0])).toEqual([[], []])
  expect(selected(combinedActions[0])).toEqual([['Accept combination'], ['Accept combination']])
  expect(combinedActions[0].sides.every((side: { buttons: Action[] }) => !side.buttons[2].disabled)).toBe(true)
  expect(selected(combinedUndoneActions[0])).toEqual([[], []])
  expect(selected(combinedFromRightActions[0])).toEqual([['Accept combination'], ['Accept combination']])
  expect(undo(combinedActions[0])).toEqual([[false], [false]])
  expect(undo(combinedUndoneActions[0])).toEqual([[], []])
  expect(selected(emptyEndActions[2])).toEqual([['Accept incoming'], []])
  expect(undo(emptyEndActions[2])).toEqual([[false], [false]])
  expect(unifiedActions).toEqual(Array.from({ length: 3 }, () => ['Accept current', 'Accept incoming', 'Accept both']))
})
