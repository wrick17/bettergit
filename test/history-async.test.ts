import { expect, test } from 'bun:test'

// Drives the real HistoryView hooks, as in changes-async.test.ts, with the commit menu's own compare actions.
const COMPARE = String.raw`
const assert = require('node:assert/strict')
const react = require('react')
const stored = new Map()
const calls = { commit: [], compare: [], mergeBase: [] }
const later = (list, args) => new Promise((resolve, reject) => list.push({ args, resolve, reject }))
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  window: {
    innerWidth: 1900, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    bettergit: {
      history: () => Promise.resolve(['A', 'B'].map((hash) => ({ hash, parents: [], refs: [], author: 'x', date: 0, subject: 'subject ' + hash }))),
      status: () => Promise.resolve({ upstream: null }),
      remotes: () => Promise.resolve([]),
      commit: (...args) => later(calls.commit, args),
      mergeBase: (...args) => later(calls.mergeBase, args),
      compare: (...args) => later(calls.compare, args),
    },
  },
  document: { activeElement: null, querySelector: () => null },
})

let slots, cursor, effects, dirty, mounted, tree
const changed = (before, after) => !before || !after || before.length !== after.length || before.some((value, i) => !Object.is(value, after[i]))
react.useState = (initial) => {
  const index = cursor++
  const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
  return [slot.value, (update) => {
    assert.ok(mounted, 'state update after unmount')
    const next = typeof update === 'function' ? update(slot.value) : update
    if (!Object.is(slot.value, next)) { slot.value = next; dirty = true }
  }]
}
react.useRef = (initial) => slots[cursor++] ??= { current: initial }
react.useMemo = (factory, deps) => {
  const index = cursor++
  if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: factory() }
  return slots[index].value
}
react.useEffect = (effect, deps) => {
  const index = cursor++
  const previous = slots[index]
  if (!previous || changed(previous.deps, deps)) {
    const slot = slots[index] = { deps, cleanup: previous?.cleanup }
    effects.push(() => { slot.cleanup?.(); slot.cleanup = effect() })
  }
}
react.useLayoutEffect = react.useEffect
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()

const { HistoryView } = await import('./src/renderer/src/HistoryView')
const { commitItems } = await import('./src/renderer/src/CommitMenu')

const props = { repo: '/repo', head: 'H', revision: 1, listOpen: true, detailOpen: true, onError: (error) => { throw error } }
function render() {
  do {
    dirty = false; cursor = 0; effects = []
    tree = HistoryView(props)
    for (const effect of effects) effect()
  } while (dirty)
}
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    if (dirty && mounted) render()
  }
}
function find(node, match) {
  for (const child of Array.isArray(node) ? node : [node]) {
    if (!react.isValidElement(child)) continue
    if (match(child.props)) return child.props
    const found = find(child.props.children, match)
    if (found) return found
  }
}
const files = (label) => [{ path: label + '.ts', hunks: [] }]
async function answer(list, hash, value) {
  for (const call of list.filter((c) => !c.done && c.args[1] === hash)) { call.done = true; call.resolve(value(call)) }
  await flush()
}
const detail = (hash) => answer(calls.commit, hash, () => ({ files: files(hash), moves: [], details: { body: 'subject ' + hash } }))
const shown = () => ({
  heading: find(tree, (p) => p.className === 'commit-subject')?.children,
  bar: find(tree, (p) => p.className === 'compare-bar') ? 'compare' : null,
  files: find(tree, (p) => Array.isArray(p.files) && p.persist)?.files.map((file) => file.path),
})
const savedCompare = () => JSON.parse(stored.get('bettergit.session')).views['/repo|compare']
async function mount(session) {
  stored.clear(); stored.set('bettergit.session', JSON.stringify(session))
  for (const list of Object.values(calls)) list.length = 0
  slots = []; mounted = true
  render(); await flush()
}
function unmount() {
  for (const slot of slots) slot?.cleanup?.()
  mounted = false
}
const compareBase = () => commitItems(find(tree, (p) => p.input?.onCompare).input, { setPrompt() {}, setNotice() {}, pending: null, setPending() {} })
  .find((item) => item.key === 'compareBase').onClick()

// A merge-base lookup started on A that answers after B is selected must not compare A under B's heading.
await mount({ places: { '/repo': { commit: 'A' } } })
await detail('A')
compareBase()
find(tree, (p) => p.row?.commit.hash === 'B').onSelect()
render(); await detail('B')
await answer(calls.mergeBase, 'H', () => 'BASE-A')
// A compare of A, if one started, must not land under B.
await answer(calls.compare, 'A', () => ({ files: files('vs-stale'), moves: [] }))
assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['B.ts'] })
// The same action on the commit still selected compares it.
compareBase()
await answer(calls.mergeBase, 'H', () => 'BASE-B')
assert.deepEqual(calls.compare.filter((c) => c.args[1] === 'B').map((c) => c.args.slice(1)), [['B', 'BASE-B']])
await answer(calls.compare, 'B', () => ({ files: files('vs-base'), moves: [] }))
assert.deepEqual(shown(), { heading: 'subject B', bar: 'compare', files: ['vs-base.ts'] })
unmount()

// A saved compare survives a remount (tab switch or reload) that lands before the commit detail, and returns with one fetch.
const saved = { key: 'A', value: { label: 'merge base BASE', ref: 'BASE' } }
await mount({ places: { '/repo': { commit: 'A' } }, views: { '/repo|compare': saved } })
assert.deepEqual(savedCompare(), saved, 'saved compare overwritten before it was restored')
unmount()
mounted = true; slots = []
render(); await flush()
await detail('A')
assert.deepEqual(calls.compare.map((c) => c.args.slice(1)), [['A', 'BASE']])
await answer(calls.compare, 'A', () => ({ files: files('vs-saved'), moves: [] }))
assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-saved.ts'] })
assert.deepEqual(savedCompare(), saved)
// Exit clears the saved compare, so the next reload opens the commit alone.
find(tree, (p) => p.children === 'Exit comparison').onClick()
render(); await flush()
assert.deepEqual(savedCompare(), { key: 'A', value: null })
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['A.ts'] })
unmount()
// A startup restore is spent once the user leaves its commit, even before that commit's detail arrived.
await mount({ places: { '/repo': { commit: 'A' } }, views: { '/repo|compare': saved } })
find(tree, (p) => p.row?.commit.hash === 'B').onSelect()
render(); await detail('B')
assert.deepEqual(savedCompare(), { key: 'B', value: null })
find(tree, (p) => p.row?.commit.hash === 'A').onSelect()
render(); await detail('A')
assert.equal(calls.compare.length, 0, 'spent startup restore reopened its compare')
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['A.ts'] })
assert.deepEqual(savedCompare(), { key: 'A', value: null })
unmount()
console.log('compare selection and restore cases passed')
`

test('History compares only the selected commit and restores a saved compare', () => {
  const child = Bun.spawnSync([process.execPath, '-e', COMPARE], {
    cwd: `${import.meta.dir}/..`,
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString()).toContain('compare selection and restore cases passed')
})
