import { expect, test } from 'bun:test'

// Isolate renderer globals as in diff-toolbar.test.ts. Render the real HistoryView and
// run its effects with dependency cleanup, then control the metadata IPC promises.
const CHECK = String.raw`
const assert = require('node:assert/strict')
const requests = []
const deferred = (kind, repo) => new Promise((resolve, reject) => requests.push({ kind, repo, resolve, reject }))
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem() {} },
  window: {
    innerWidth: 1900, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    bettergit: {
      history: () => Promise.resolve([]),
      status: (repo) => deferred('status', repo),
      remotes: (repo) => deferred('remotes', repo),
    },
  },
  document: { querySelector: () => null },
})
const react = require('react')
let captured = [], active = []
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
react.useEffect = (setup, deps) => captured.push({ setup, deps })
const { renderToStaticMarkup } = await import('react-dom/server')
const { HistoryView } = await import('./src/renderer/src/HistoryView')

function render(props) {
  captured = []
  renderToStaticMarkup(react.createElement(HistoryView, {
    head: null, listOpen: false, detailOpen: false, ...props,
  }))
  active = captured.map((effect, index) => {
    const previous = active[index]
    if (previous?.deps && effect.deps && previous.deps.length === effect.deps.length
      && previous.deps.every((value, i) => Object.is(value, effect.deps[i]))) return previous
    previous?.cleanup?.()
    return { deps: effect.deps, cleanup: effect.setup() }
  })
  return requests.slice(-2)
}
function unmount() {
  for (const effect of active) effect.cleanup?.()
  active = []
}
async function rejectMetadata(pair, kind, error) {
  pair.find((request) => request.kind === kind).reject(error)
  pair.find((request) => request.kind !== kind).resolve(kind === 'status' ? [] : { upstream: null })
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

for (const transition of ['repo', 'revision']) for (const kind of ['status', 'remotes']) {
  const errors = []
  const props = { repo: '/old', revision: 1, onError: (error) => errors.push(error) }
  const old = render(props)
  const next = render({ ...props, ...(transition === 'repo' ? { repo: '/new' } : { revision: 2 }) })
  assert.notEqual(old[0], next[0], 'metadata reloaded for ' + transition)
  await rejectMetadata(old, kind, new Error('obsolete ' + kind))
  assert.deepEqual(errors, [], transition + ': obsolete rejection reached onError')
  const currentError = new Error('current ' + kind)
  await rejectMetadata(next, kind, currentError)
  assert.deepEqual(errors, [currentError], transition + ': current rejection must remain visible')
  unmount()
}

const errors = []
const pending = render({ repo: '/unmounted', revision: 1, onError: (error) => errors.push(error) })
unmount()
await rejectMetadata(pending, 'status', new Error('after unmount'))
assert.deepEqual(errors, [], 'unmounted metadata rejection reached onError')
console.log('4 repo/revision rejection cases and 1 unmount case passed')
`

test('History metadata drops obsolete rejections and reports current failures', () => {
  const child = Bun.spawnSync([process.execPath, '-e', CHECK], {
    cwd: `${import.meta.dir}/..`,
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString()).toContain('4 repo/revision rejection cases and 1 unmount case passed')
})

// Drives the real HistoryView hooks, as in changes-async.test.ts, with the commit menu's own compare actions.
const COMPARE = String.raw`
const assert = require('node:assert/strict')
const react = require('react')
const twoCommits = () => ['A', 'B']
let pages = twoCommits
const stored = new Map()
const calls = { commit: [], compare: [], mergeBase: [] }
const later = (list, args) => new Promise((resolve, reject) => list.push({ args, resolve, reject }))
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  window: {
    innerWidth: 1900, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    bettergit: {
      history: (_repo, skip, limit) => Promise.resolve(pages(skip, limit).map((hash) => ({ hash, parents: [], refs: [], author: 'x', date: 0, subject: 'subject ' + hash }))),
      status: () => Promise.resolve({ upstream: null }),
      remotes: () => Promise.resolve([]),
      searchHistory: () => Promise.resolve([]),
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

const props = { repo: '/repo', head: 'H', branch: null, revision: 1, listOpen: true, detailOpen: true, diffOpen: true, onShowDiff() {}, onError: (error) => { throw error } }
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
const compareBase = () => commitItems(find(tree, (p) => p.input?.onCompare).input, { setPrompt() {}, setNotice() {}, pending: null })
  .find((item) => item.key === 'compareBase').onClick()

// Paging appends a page: the selection stays, the rows already laid out are kept as they are, and the arrow keys step
// past the end of the first page.
{
  pages = (skip, limit = 300) => (skip >= 600 ? [] : Array.from({ length: Math.min(limit, 600 - skip) }, (_, index) => 'P' + (skip + index)))
  await mount({ places: { '/repo': { commit: 'P298' } } })
  const list = () => find(tree, (p) => p.rows && p.onSelect)
  const first = list().rows
  assert.equal(first.length, 300)
  assert.equal(list().selected, 'P298')
  const key = (name) => list().onKeyDown({ key: name, preventDefault() {} })
  key('ArrowDown'); render(); await flush()
  assert.equal(list().selected, 'P299')
  assert.equal(list().rows.length, 600, 'stepping near the end loaded the next page')
  assert.ok(first.every((row, index) => list().rows[index] === row), 'paging laid out the shown rows again')
  key('ArrowDown'); render()
  assert.equal(list().selected, 'P300', 'the arrow key stepped into the appended page')
  // A refresh with nothing new reloads every paged row and keeps the laid-out graph.
  const paged = list().rows
  props.revision = 2; render(); await flush()
  assert.equal(list().rows, paged, 'an unchanged refresh laid out the graph again or dropped paged rows')
  props.revision = 1
  unmount()
  pages = twoCommits
}
// A refresh of a short history does not show "Load more" while it loads.
{
  await mount({ places: {} })
  props.revision = 2; render()
  assert.ok(!find(tree, (p) => p.className === 'more'), 'Load more flashed during a refresh')
  await flush()
  props.revision = 1
  unmount()
}
console.log('paging cases passed')

// A background refresh keeps the lanes on screen; an explicit refresh lays the graph out afresh, even when a background
// refresh starts before its reply. The reply it replaced is dropped and does not use up the fresh layout.
{
  const history = window.bettergit.history
  const commit = (hash, parents, refs = []) => ({ hash, parents, refs, author: 'x', date: 0, subject: hash })
  const before = () => [commit('c', ['main']), commit('b', ['main']), commit('a', ['main']), commit('main', ['root'], ['HEAD -> main']), commit('root', [])]
  let list = before
  const held = []
  let hold = false
  window.bettergit.history = () => hold ? new Promise((resolve) => held.push(resolve)) : Promise.resolve(list())
  props.refreshes = 0
  await mount({ places: {} })
  const lane = (hash) => find(tree, (p) => p.rows && p.onSelect).rows.find((row) => row.commit.hash === hash).lane
  assert.equal(lane('c'), 1)
  list = () => [commit('a2', ['a']), ...before()]
  props.revision = 2; render(); await flush()
  assert.equal(lane('c'), 1, 'a background refresh moved a commit already on screen')
  hold = true
  props.refreshes = 1; render(); await flush()
  props.revision = 3; render(); await flush()
  assert.equal(held.length, 2)
  held[0](list()); await flush()
  assert.equal(lane('c'), 1, 'the reply of a replaced request was applied')
  held[1](list()); await flush()
  assert.equal(lane('c'), 2, 'a background refresh swallowed the explicit refresh')
  hold = false
  props.revision = 1; delete props.refreshes
  unmount()
  window.bettergit.history = history
}
console.log('refresh layout cases passed')

// A merge-base lookup started on A that answers after B is selected must not compare A under B's heading.
await mount({ places: { '/repo': { commit: 'A' } } })
await detail('A')
compareBase()
find(tree, (p) => p.rows && p.onSelect).onSelect('B')
render(); await detail('B')
await answer(calls.mergeBase, 'H', () => 'BASE-A')
assert.deepEqual(calls.compare.map((c) => c.args[1]), [], 'obsolete merge base started a compare')
assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['B.ts'] })
// The same action on the commit still selected compares it.
compareBase()
await answer(calls.mergeBase, 'H', () => 'BASE-B')
assert.deepEqual(calls.compare.map((c) => c.args.slice(1)), [['B', 'BASE-B', false]])
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
assert.deepEqual(calls.compare.map((c) => c.args.slice(1)), [['A', 'BASE', false]])
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
find(tree, (p) => p.rows && p.onSelect).onSelect('B')
render(); await detail('B')
assert.deepEqual(savedCompare(), { key: 'B', value: null })
find(tree, (p) => p.rows && p.onSelect).onSelect('A')
render(); await detail('A')
assert.equal(calls.compare.length, 0, 'spent startup restore reopened its compare')
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['A.ts'] })
assert.deepEqual(savedCompare(), { key: 'A', value: null })
unmount()
console.log('compare selection and restore cases passed')

// With nothing saved, History opens on the newest commit. The author filter reloads the list through git with those names.
{
  const pages = []
  const history = window.bettergit.history
  window.bettergit.history = (...args) => { pages.push(args); return history(...args) }
  await mount({ places: {} })
  assert.deepEqual(calls.commit.map((c) => c.args[1]), ['A'], 'the newest commit was not opened')
  find(tree, (p) => p.authors && p.onChange).onChange(['x'])
  render(); await flush()
  assert.deepEqual(pages.at(-1), ['/repo', 0, 300, ['x']])
  unmount()
  window.bettergit.history = history
}
console.log('first commit and author filter cases passed')

// History opens on HEAD and follows it when it moves, as on a branch switch: a HEAD older than the loaded rows is paged
// in, selected and revealed. A refresh that leaves HEAD alone, like a fetch, keeps the user's pick, and a search never pages.
{
  const asked = []
  const history = window.bettergit.history
  window.bettergit.history = (...args) => { asked.push(args.slice(1, 3)); return history(...args) }
  pages = (skip, limit = 300) => (skip >= 900 ? [] : Array.from({ length: Math.min(limit, 900 - skip) }, (_, index) => 'P' + (skip + index)))
  const settle = async () => { for (let i = 0; i < 8; i++) await flush() }
  const list = () => find(tree, (p) => p.rows && p.onSelect)
  props.head = 'P5'; props.branch = 'main'
  await mount({ places: {} })
  assert.equal(list().selected, 'P5', 'History did not open on HEAD')
  assert.deepEqual(calls.commit.map((c) => c.args[1]), ['P5'], 'another commit loaded before HEAD')
  list().onSelect('P7'); render(); await flush()
  props.revision = 2; render(); await settle()
  assert.equal(list().selected, 'P7', 'a refresh with HEAD unchanged moved the selection')
  const revealed = list().reveal
  props.head = 'P750'; props.branch = 'feature'; props.revision = 3; render(); await settle()
  assert.equal(list().selected, 'P750', 'a branch switch did not select an older HEAD')
  assert.equal(list().rows.length, 900)
  assert.ok(list().reveal > revealed, 'HEAD was not scrolled into view')
  // Detaching at the same commit focuses it again, even though it is already selected.
  props.branch = null; render(); await settle()
  assert.equal(list().reveal, revealed + 2)
  // A switch made while History is closed is followed when it opens, over the commit saved before it.
  unmount(); props.head = 'P20'; props.branch = 'other'
  mounted = true; slots = []; render(); await settle()
  assert.equal(list().selected, 'P20', 'a switch made while History was closed was not followed')
  find(tree, (p) => p['aria-label'] === 'Search commit messages').onChange({ target: { value: 'nothing' } })
  render(); await settle()
  const before = asked.length
  props.head = 'P880'; props.branch = 'other'; render(); await settle()
  assert.equal(asked.length, before, 'a search paged the history for HEAD')
  assert.equal(JSON.parse(stored.get('bettergit.session')).places['/repo'].commit, 'P20', 'a HEAD outside the search moved the selection')
  unmount()
  window.bettergit.history = history
  pages = twoCommits
  props.head = 'H'; props.branch = null; props.revision = 1
}
console.log('head focus cases passed')

// The code diff hides on its own: the commit's details and files stay, and picking a file asks for the diff back.
{
  let shows = 0
  props.diffOpen = false; props.onShowDiff = () => { shows++ }
  await mount({ places: { '/repo': { commit: 'A' } } })
  await detail('A')
  assert.equal(find(tree, (p) => p.className === 'diff-pane'), undefined, 'the hidden code diff rendered')
  assert.equal(find(tree, (p) => p.className === 'commit-subject')?.children, 'subject A')
  const files = find(tree, (p) => Array.isArray(p.files) && p.onSelect && !p.persist)
  assert.deepEqual(files.files.map((file) => file.path), ['A.ts'])
  files.onSelect('A.ts')
  assert.equal(shows, 1, 'a file click did not show the code diff')
  // The file is scrolled to once the shown diff lays out, two frames on.
  const frames = []
  globalThis.requestAnimationFrame = (callback) => frames.push(callback)
  props.diffOpen = true; render(); await flush()
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['A.ts'] })
  assert.equal(frames.length, 1)
  delete globalThis.requestAnimationFrame
  unmount()
  props.onShowDiff = () => {}
}
console.log('code diff visibility cases passed')

// A whitespace toggle refetches the commit. Until that reply, hunks fetched with the other option are not shown;
// the heading and the diff toolbar stay. A reply for an option already left is dropped.
const { setContextLines, setIgnoreWhitespace } = await import('./src/renderer/src/prefs')
const diffView = () => find(tree, (p) => Array.isArray(p.files) && p.persist)
const stat = () => find(tree, (p) => Array.isArray(p.files) && p.onSelect && !p.persist)?.files.map((file) => file.path)
const reply = (hash, option, label) => {
  const call = calls.commit.find((c) => !c.done && c.args[1] === hash && c.args[3] === option)
  call.done = true
  call.resolve({ files: files(label), moves: [], details: { body: 'subject ' + hash } })
  return flush()
}
await mount({ places: { '/repo': { commit: 'A' } } })
await reply('A', false, 'shown')
setIgnoreWhitespace(true); render(); await flush()
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: [] }, 'old hunks shown under the toggled option')
assert.equal(diffView().emptyHint, 'Loading…')
assert.deepEqual(stat(), [])
await reply('A', true, 'hidden')
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['hidden.ts'] })
assert.equal(diffView().emptyHint, undefined)
// Toggling back to an option already loaded for this commit shows its diff at once, without fetching it again.
const fetched = calls.commit.length
setIgnoreWhitespace(false); render(); await flush()
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['shown.ts'] }, 'loaded option not shown at once')
assert.equal(calls.commit.length, fetched, 'loaded option fetched again')
// With a compare open, the fallback to the commit's own diff is shown only for the option it was fetched with: here
// the loaded own diff for the new option, while the compare refetches.
compareBase()
await answer(calls.mergeBase, 'H', () => 'BASE-A')
await answer(calls.compare, 'A', () => ({ files: files('vs-shown'), moves: [] }))
assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-shown.ts'] })
setIgnoreWhitespace(true); render(); await flush()
assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['hidden.ts'] })
await answer(calls.compare, 'A', () => ({ files: files('vs-hidden'), moves: [] }))
assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-hidden.ts'] })
// Moving to another commit still unmounts the diff until that commit's reply.
find(tree, (p) => p.rows && p.onSelect).onSelect('B')
render()
assert.equal(diffView(), undefined)
await reply('B', true, 'b-hidden')
assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['b-hidden.ts'] })
// A reply for an option already left is dropped.
setIgnoreWhitespace(false); render(); await flush()
assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: [] })
setIgnoreWhitespace(true); render(); await flush()
await reply('B', false, 'obsolete')
assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['b-hidden.ts'] }, 'obsolete reply shown')
setIgnoreWhitespace(false)
unmount()

// A reload that fails for the commit on screen keeps the commit, its compare and the toolbar. Hunks fetched with the
// other option stay hidden, and the failure replaces Loading… until a load succeeds. A failure for a load already
// left changes nothing, and a first load that fails still clears the selection.
{
  const errors = []
  const throwing = props.onError
  props.onError = (error) => errors.push(error.message)
  const fail = (hash, option) => {
    const call = calls.commit.find((c) => !c.done && c.args[1] === hash && c.args[3] === option)
    call.done = true
    call.reject(new Error('git failed'))
    return flush()
  }
  const place = () => JSON.parse(stored.get('bettergit.session')).places['/repo'].commit
  await mount({ places: { '/repo': { commit: 'A' } } })
  await reply('A', false, 'shown')
  compareBase()
  await answer(calls.mergeBase, 'H', () => 'BASE-A')
  await answer(calls.compare, 'A', () => ({ files: files('vs-shown'), moves: [] }))
  setIgnoreWhitespace(true); render(); await flush()
  setIgnoreWhitespace(false); render(); await flush()
  await fail('A', true)
  assert.deepEqual(errors, [], 'a failure for an option already left was reported')
  assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-shown.ts'] })
  setIgnoreWhitespace(true); render(); await flush()
  await fail('A', true)
  assert.deepEqual(errors, ['git failed'])
  assert.equal(place(), 'A', 'the failed reload cleared the selection')
  assert.deepEqual(savedCompare(), { key: 'A', value: { label: 'merge base BASE-A', ref: 'BASE-A' } })
  // The compare asked for is still on its way, so the pane waits for it.
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: [] })
  assert.equal(diffView().emptyHint, 'Loading…')
  await answer(calls.compare, 'A', () => ({ files: files('vs-hidden'), moves: [] }))
  assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-hidden.ts'] })
  // Without the compare, the commit's own diff shows the failure, never the hunks fetched with the other option.
  find(tree, (p) => p.children === 'Exit comparison').onClick()
  render(); await flush()
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: [] })
  assert.deepEqual(stat(), [])
  assert.equal(diffView().emptyHint, 'Could not load this diff.')
  // The app renders again with a new error callback when its banner clears. The failure stays, and no reload starts.
  const loads = calls.commit.length
  props.onError = (error) => errors.push(error.message)
  render(); await flush()
  assert.equal(diffView().emptyHint, 'Could not load this diff.')
  assert.equal(calls.commit.length, loads, 'a parent render reloaded the failed commit')
  // The toolbar retries: the other option shows its own diff again, and coming back loads this one afresh.
  setIgnoreWhitespace(false); render(); await flush()
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['shown.ts'] })
  setIgnoreWhitespace(true); render(); await flush()
  assert.equal(diffView().emptyHint, 'Loading…')
  await reply('A', true, 'hidden')
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['hidden.ts'] })
  // A failure that lands after another commit was selected changes nothing either. The option loaded before shows from
  // the cache, so a context not loaded yet starts the load that fails late.
  setIgnoreWhitespace(false); setContextLines(10); render(); await flush()
  find(tree, (p) => p.rows && p.onSelect).onSelect('B')
  render(); await reply('B', false, 'b-shown')
  await fail('A', false)
  assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['b-shown.ts'] })
  assert.deepEqual(errors, ['git failed'])
  unmount()
  await mount({ places: { '/repo': { commit: 'A' } } })
  await fail('A', false)
  assert.equal(find(tree, (p) => p.className === 'commit-subject'), undefined)
  assert.equal(place(), undefined)
  assert.deepEqual(errors, ['git failed', 'git failed'])
  unmount()
  setContextLines(3)
  props.onError = throwing
}
console.log('whitespace toggle cases passed')

// A scrolled diff keeps its place through a whitespace reload. The pane below models the browser: its height follows the
// files on screen once a frame lays them out, a shorter pane clamps scrollTop, and a clamp fires a scroll event.
{
  const frames = new Map()
  let nextFrame = 1
  globalThis.requestAnimationFrame = (callback) => { frames.set(nextFrame, callback); return nextFrame++ }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  const scrollEvent = (pane) => find(tree, (p) => p.className === 'diff-pane')?.onScroll?.({ currentTarget: pane })
  const makePane = () => {
    let top = 0
    const pane = { clientHeight: 100, scrollHeight: 0, querySelectorAll: () => [], scrollTo() {} }
    Object.defineProperty(pane, 'scrollTop', { get: () => top, set: (value) => { top = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight)) } })
    return pane
  }
  const layout = (pane) => {
    pane.scrollHeight = (diffView()?.files.length ?? 0) > 0 ? 3000 : 40
    const before = pane.scrollTop
    pane.scrollTop = before
    if (pane.scrollTop !== before) scrollEvent(pane)
  }
  const frame = (pane) => { layout(pane); const run = [...frames.values()]; frames.clear(); run.forEach((callback) => callback()) }
  const savedTop = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return JSON.parse(stored.get('bettergit.session')).views['/repo|history-diff']
  }
  await mount({ places: { '/repo': { commit: 'A' } } })
  await reply('A', false, 'tall')
  const ref = find(tree, (p) => p.className === 'diff-pane').ref
  const pane = makePane()
  ref.current = pane
  render(); frame(pane); frame(pane)
  pane.scrollTop = 900; scrollEvent(pane)
  // The reload shows no hunks, so the pane clamps to the top until the reply with the new option lays out.
  setIgnoreWhitespace(true); render(); await flush()
  frame(pane)
  assert.equal(pane.scrollTop, 0)
  await reply('A', true, 'tall-hidden')
  frame(pane); frame(pane)
  assert.equal(pane.scrollTop, 900, 'scroll position lost across a whitespace reload')
  assert.deepEqual(await savedTop(), { key: 'A', value: 900 }, 'the clamp to the top was saved')
  // Leaving the commit while its reload is pending does not carry the old position to the next commit's pane.
  setIgnoreWhitespace(false); render(); await flush()
  frame(pane)
  find(tree, (p) => p.rows && p.onSelect).onSelect('B')
  render()
  const next = makePane()
  ref.current = next
  await reply('B', false, 'b-tall')
  frame(next); frame(next); frame(next)
  assert.equal(next.scrollTop, 0, 'old commit position restored into the next commit')
  setIgnoreWhitespace(false)
  unmount()

  // With a comparison open, the commit's own short diff may reply first. It does not take the comparison's position:
  // the pane keeps waiting, saves nothing from the short diff, and returns to 900 when the tall comparison lays out.
  const short = (hash, option) => {
    const call = calls.commit.find((c) => !c.done && c.args[1] === hash && c.args[3] === option)
    call.done = true
    call.resolve({ files: [], moves: [], details: { body: 'subject ' + hash } })
    return flush()
  }
  const compared = (hash, option, label) => {
    const call = calls.compare.find((c) => !c.done && c.args[1] === hash && c.args[3] === option)
    call.done = true
    call.resolve({ files: files(label), moves: [] })
    return flush()
  }
  await mount({ places: { '/repo': { commit: 'A' } } })
  await short('A', false)
  const comparePane = makePane()
  find(tree, (p) => p.className === 'diff-pane').ref.current = comparePane
  compareBase()
  await answer(calls.mergeBase, 'H', () => 'BASE-A')
  await compared('A', false, 'vs-tall')
  frame(comparePane); frame(comparePane)
  comparePane.scrollTop = 900; scrollEvent(comparePane)
  assert.deepEqual(await savedTop(), { key: 'A', value: 900 })
  setIgnoreWhitespace(true); render(); await flush()
  frame(comparePane)
  assert.equal(comparePane.scrollTop, 0)
  await short('A', true)
  frame(comparePane); frame(comparePane); frame(comparePane)
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: [] })
  assert.equal(comparePane.scrollTop, 0)
  await compared('A', true, 'vs-tall-hidden')
  frame(comparePane); frame(comparePane)
  assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-tall-hidden.ts'] })
  assert.equal(comparePane.scrollTop, 900, 'the commit fallback consumed the comparison position')
  assert.deepEqual(await savedTop(), { key: 'A', value: 900 }, 'the fallback position was saved')
  // Leaving the commit while its comparison wait is pending drops the wait: an obsolete comparison reply changes nothing,
  // and the next commit pane is not moved to the old position.
  // The commit's own diff for this option was loaded before, so it shows from the cache without a reply.
  setIgnoreWhitespace(false); render(); await flush()
  frame(comparePane)
  find(tree, (p) => p.rows && p.onSelect).onSelect('B')
  render()
  const nextPane = makePane()
  await compared('A', false, 'vs-obsolete')
  await reply('B', false, 'b-tall')
  find(tree, (p) => p.className === 'diff-pane').ref.current = nextPane
  render(); frame(nextPane); frame(nextPane); frame(nextPane)
  assert.deepEqual(shown(), { heading: 'subject B', bar: null, files: ['b-tall.ts'] })
  assert.equal(nextPane.scrollTop, 0, 'comparison position restored into the next commit')
  setIgnoreWhitespace(false)
  unmount()

  // Leaving a comparison can keep scrollTop and fire no scroll event. The commit's own diff then owns the position,
  // so a whitespace reload returns to it.
  await mount({ places: { '/repo': { commit: 'A' } } })
  await reply('A', false, 'tall')
  const exitPane = makePane()
  find(tree, (p) => p.className === 'diff-pane').ref.current = exitPane
  render(); frame(exitPane); frame(exitPane)
  compareBase()
  await answer(calls.mergeBase, 'H', () => 'BASE-A')
  await compared('A', false, 'vs-tall')
  frame(exitPane); frame(exitPane)
  exitPane.scrollTop = 900; scrollEvent(exitPane)
  find(tree, (p) => p.children === 'Exit comparison').onClick()
  render(); await flush(); frame(exitPane); frame(exitPane)
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['tall.ts'] })
  assert.equal(exitPane.scrollTop, 900)
  setIgnoreWhitespace(true); render(); await flush()
  frame(exitPane)
  assert.equal(exitPane.scrollTop, 0)
  await reply('A', true, 'tall-hidden')
  frame(exitPane); frame(exitPane)
  assert.equal(exitPane.scrollTop, 900, 'the position was kept for the comparison after leaving it')
  assert.deepEqual(await savedTop(), { key: 'A', value: 900 })
  setIgnoreWhitespace(false)
  unmount()

  // Entering a comparison can do the same. The comparison then owns the position it opened at, so the commit's short
  // fallback during a whitespace reload does not take it.
  await mount({ places: { '/repo': { commit: 'A' } } })
  await reply('A', false, 'tall')
  const enterPane = makePane()
  find(tree, (p) => p.className === 'diff-pane').ref.current = enterPane
  render(); frame(enterPane); frame(enterPane)
  enterPane.scrollTop = 900; scrollEvent(enterPane)
  compareBase()
  await answer(calls.mergeBase, 'H', () => 'BASE-A')
  await compared('A', false, 'vs-tall')
  frame(enterPane); frame(enterPane)
  assert.deepEqual(shown(), { heading: 'subject A', bar: 'compare', files: ['vs-tall.ts'] })
  assert.equal(enterPane.scrollTop, 900)
  setIgnoreWhitespace(true); render(); await flush()
  frame(enterPane)
  await short('A', true)
  frame(enterPane); frame(enterPane); frame(enterPane)
  assert.equal(enterPane.scrollTop, 0)
  await compared('A', true, 'vs-tall-hidden')
  frame(enterPane); frame(enterPane)
  assert.equal(enterPane.scrollTop, 900, 'the position was kept for the commit after entering the comparison')
  assert.deepEqual(await savedTop(), { key: 'A', value: 900 })
  setIgnoreWhitespace(false)
  unmount()

  // A restored comparison that fails during a whitespace reload ends the wait. The commit's own diff keeps the place it
  // shows at, and that place is saved, so a reload does not move the commit to the comparison's position.
  await mount({ places: { '/repo': { commit: 'A' } }, views: { '/repo|compare': saved } })
  await reply('A', false, 'tall')
  const failPane = makePane()
  find(tree, (p) => p.className === 'diff-pane').ref.current = failPane
  render(); frame(failPane); frame(failPane)
  await compared('A', false, 'vs-tall')
  frame(failPane); frame(failPane)
  failPane.scrollTop = 900; scrollEvent(failPane)
  setIgnoreWhitespace(true); render(); await flush()
  frame(failPane)
  const failing = calls.compare.find((c) => !c.done && c.args[1] === 'A' && c.args[3] === true)
  failing.done = true; failing.reject(new Error('ref gone')); await flush()
  await reply('A', true, 'tall-hidden')
  frame(failPane); frame(failPane)
  assert.deepEqual(shown(), { heading: 'subject A', bar: null, files: ['tall-hidden.ts'] })
  assert.equal(failPane.scrollTop, 0)
  assert.deepEqual(await savedTop(), { key: 'A', value: 0 }, 'the failed comparison position was kept for the commit')
  setIgnoreWhitespace(false)
  unmount()

  // A failed reload of the commit's own diff saves nothing either, and a retry from the toolbar returns to the position.
  {
    const throwing = props.onError
    props.onError = () => {}
    await mount({ places: { '/repo': { commit: 'A' } } })
    await reply('A', false, 'tall')
    const retryPane = makePane()
    find(tree, (p) => p.className === 'diff-pane').ref.current = retryPane
    render(); frame(retryPane); frame(retryPane)
    retryPane.scrollTop = 900; scrollEvent(retryPane)
    setIgnoreWhitespace(true); render(); await flush()
    frame(retryPane)
    const rejected = calls.commit.find((c) => !c.done && c.args[1] === 'A' && c.args[3] === true)
    rejected.done = true; rejected.reject(new Error('git failed')); await flush()
    frame(retryPane); frame(retryPane)
    assert.equal(diffView().emptyHint, 'Could not load this diff.')
    assert.deepEqual(await savedTop(), { key: 'A', value: 900 }, 'the failed reload saved the clamp')
    setIgnoreWhitespace(false); render(); await flush()
    frame(retryPane); frame(retryPane)
    assert.equal(retryPane.scrollTop, 900)
    setIgnoreWhitespace(true); render(); await flush()
    frame(retryPane)
    await reply('A', true, 'tall-hidden')
    frame(retryPane); frame(retryPane)
    assert.equal(retryPane.scrollTop, 900, 'the retry lost the position')
    assert.deepEqual(await savedTop(), { key: 'A', value: 900 })
    setIgnoreWhitespace(false)
    unmount()
    props.onError = throwing
  }
}
console.log('whitespace scroll cases passed')
`

test('History compares only the selected commit, restores a saved compare, and shows a diff only for the whitespace option it was fetched with', () => {
  const child = Bun.spawnSync([process.execPath, '-e', COMPARE], {
    cwd: `${import.meta.dir}/..`,
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString()).toContain('compare selection and restore cases passed')
  expect(child.stdout.toString()).toContain('paging cases passed')
  expect(child.stdout.toString()).toContain('refresh layout cases passed')
  expect(child.stdout.toString()).toContain('first commit and author filter cases passed')
  expect(child.stdout.toString()).toContain('head focus cases passed')
  expect(child.stdout.toString()).toContain('code diff visibility cases passed')
  expect(child.stdout.toString()).toContain('whitespace toggle cases passed')
  expect(child.stdout.toString()).toContain('whitespace scroll cases passed')
})

// The commit's file list in tree view: folders before files, renames under their new folder, deletions under their old
// path, and the view choice remembered. Rendered from the real CommitStat with the renderer globals stubbed.
const STAT_TREE = String.raw`
const assert = require('node:assert/strict')
const stored = new Map()
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  window: { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
  document: { querySelector: () => null },
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
const { renderToStaticMarkup } = await import('react-dom/server')
const { CommitStat } = await import('./src/renderer/src/CommitStat')
const file = (oldPath, newPath, status) => ({ oldPath, newPath, status, binary: false, hunks: [] })
const files = [
  file('src/old/a.ts', 'src/lib/a.ts', 'renamed'),
  file('docs/gone.md', null, 'deleted'),
  file('README.md', 'README.md', 'modified'),
  file(null, 'src/lib/b.ts', 'added'),
  file('src/z.ts', 'src/z.ts', 'modified'),
]
const labels = () => [...renderToStaticMarkup(react.createElement(CommitStat, { files, onSelect() {} }))
  .matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]).filter((label) => !/view|layout|Changed files/.test(label))

assert.deepEqual(labels(), [
  'Show diff for src/old/a.ts → src/lib/a.ts, renamed',
  'Show diff for docs/gone.md, deleted',
  'Show diff for README.md, modified',
  'Show diff for src/lib/b.ts, added',
  'Show diff for src/z.ts, modified',
], 'list view keeps the patch order')
stored.set('bettergit.commitFilesView', 'tree')
assert.deepEqual(labels(), [
  'docs, 1 file',
  'Show diff for docs/gone.md, deleted',
  'src, 3 files',
  'src/lib, 2 files',
  'Show diff for src/old/a.ts → src/lib/a.ts, renamed',
  'Show diff for src/lib/b.ts, added',
  'Show diff for src/z.ts, modified',
  'Show diff for README.md, modified',
], 'tree view nests folders before files')
console.log('commit tree cases passed')
`

test('Commit details list files flat or as a folder tree', () => {
  const child = Bun.spawnSync([process.execPath, '-e', STAT_TREE], {
    cwd: `${import.meta.dir}/..`,
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stdout.toString()).toContain('commit tree cases passed')
})
