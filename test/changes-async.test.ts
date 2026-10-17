import { expect, test } from 'bun:test'

// Isolates renderer globals from the other suites. The hook runner drives the real ChangesView
// callbacks and effects without a browser or a live Electron app.
const CHECK = String.raw`
const assert = require('node:assert/strict')
const react = require('react')
const stored = new Map()
const requests = []
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  window: {
    innerWidth: 1900, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    bettergit: {
      working: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject, done: false })),
    },
  },
  document: { activeElement: null },
  requestAnimationFrame: () => 0,
})

let slots, cursor, effects, dirty, mounted, props, tree
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

const { ChangesView } = await import('./src/renderer/src/ChangesView')

function render() {
  do {
    dirty = false; cursor = 0; effects = []
    tree = ChangesView(props)
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
const change = (path) => ({ path, staged: true, unstaged: true, conflicted: false, kind: 'modified' })
function unmount() {
  for (const slot of slots) slot?.cleanup?.()
  mounted = false
}
async function start() {
  stored.clear(); requests.length = 0; slots = []; mounted = true
  props = {
    repo: '/repo', revision: 1, status: { changes: [change('a.ts'), change('b.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => { throw error },
  }
  render()
}

if (process.env.CHECK_MODE === 'commit-draft') {
  const commits = []
  window.bettergit.commitChanges = (...args) => new Promise((resolve) => commits.push({ args, resolve }))
  const box = () => find(tree, (p) => p['aria-label'] === 'Commit message')
  const draft = () => JSON.parse(stored.get('bettergit.session')).places['/repo'].draft
  const remount = () => { unmount(); slots = []; mounted = true; render() }
  // Nothing typed after the remount, a different draft, and the committed text typed again.
  for (const typed of [null, 'second', 'first']) {
    await start()
    box().onChange({ target: { value: 'first' } }); render()
    find(tree, (p) => p.className === 'commit-action').onClick()
    // The tab is left and shown again while the commit runs.
    remount()
    assert.equal(box().value, 'first')
    if (typed !== null) { box().onChange({ target: { value: typed } }); render() }
    commits[0].resolve(); await flush()
    assert.deepEqual(commits[0].args, ['/repo', 'first', false])
    assert.equal(draft(), typed ?? undefined, 'old commit cleared a newer draft')
    commits.length = 0
    unmount()
  }
}
`

function check(mode: string) {
  const child = Bun.spawnSync([process.execPath, '-e', CHECK], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, CHECK_MODE: mode },
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
}

test('a commit that finishes after the tab remounts clears its own draft but keeps a newer one', () => check('commit-draft'))
