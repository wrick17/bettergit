import { expect, test } from 'bun:test'

// Like diff-toolbar.test.ts, isolate renderer globals from the other suites. The hook runner
// drives the real ChangesView callbacks and effects without a browser or a live Electron app.
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

let slots, cursor, effects, dirty, mounted, props, tree, errors
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
const { setContextLines, setIgnoreWhitespace } = await import('./src/renderer/src/prefs')
const { parseDiff } = await import('./src/main/git/diff')

function render() {
  do {
    dirty = false; cursor = 0; effects = []
    tree = ChangesView(props)
    for (const effect of effects) effect()
  } while (dirty)
}
async function flush(renderUpdates = true) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    if (renderUpdates && dirty && mounted) render()
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
const diff = () => find(tree, (p) => Array.isArray(p.files) && typeof p.onExpand === 'function' && !p.stage.staged)
  ?? find(tree, (p) => Array.isArray(p.files) && typeof p.onExpand === 'function')
const change = (path) => ({ path, staged: true, unstaged: true, conflicted: false, kind: 'modified' })
function working(label) {
  return { files: ['a.ts', 'b.ts'].flatMap((path) => parseDiff('diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1 @@\n-old\n+' + label + '\n')), moves: [] }
}
async function load(label, renderUpdates = true) {
  for (const request of requests.filter((r) => !r.done && r.args[3] === undefined)) {
    request.done = true; request.resolve(working(label))
  }
  await flush(renderUpdates)
}
function unmount() {
  for (const slot of slots) slot?.cleanup?.()
  mounted = false
}
async function start(selected) {
  stored.clear(); requests.length = 0; errors = []; slots = []; mounted = true
  setContextLines(3); setIgnoreWhitespace(false)
  if (selected) stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'a.ts', staged: false } } }))
  props = {
    repo: '/repo', revision: 1, status: { changes: [change('a.ts'), change('b.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render(); await load('initial')
}
function expand() {
  const view = diff()
  assert.ok(view, 'Changes diff is mounted')
  view.onExpand(view.files[0])
  const request = requests.at(-1)
  assert.equal(request.args[3], 'a.ts')
  assert.equal(request.args[2], 10)
  return request
}

if (process.env.CHECK_MODE === 'conflict-reset') {
  const { parseConflicts, conflictBlocks } = await import('./src/shared/conflict')
  const loads = [], resets = [], confirms = []
  let answer = true
  Object.assign(window.bettergit, {
    conflictLoad: (...args) => new Promise((resolve, reject) => loads.push({ args, resolve, reject })),
    conflictReset: (...args) => new Promise((resolve, reject) => resets.push({ args, resolve, reject })),
  })
  window.confirm = (message) => { confirms.push(message); return answer }
  const fingerprint = (label) => ({ working: label.repeat(64), stages: 'b'.repeat(64) })
  const conflictDoc = (label) => {
    const { parts } = parseConflicts('x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n')
    return { supported: true, fingerprint: fingerprint(label), parts, combine: conflictBlocks(parts).map(() => ({ state: 'overlap' })), reset: { available: true, fingerprint: fingerprint(label) } }
  }
  const conflicted = (path) => ({ path, staged: false, unstaged: false, conflicted: true, kind: 'modified' })
  const view = () => find(tree, (p) => typeof p.onReset === 'function')
  const choose = () => { view().onChoose(0, 'current'); render(); assert.deepEqual(view().choices, ['current']) }
  stored.clear(); errors = []; slots = []; mounted = true
  stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'c.ts', staged: false } } }))
  props = {
    repo: '/repo', revision: 1, status: { changes: [conflicted('c.ts'), conflicted('d.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render()
  const first = conflictDoc('a')
  loads.at(-1).resolve(first); await flush()
  choose()

  // Cancel asks once and calls nothing.
  answer = false
  view().onReset(); await flush()
  assert.equal(resets.length, 0)
  assert.equal(confirms.length, 1)
  for (const words of ['c.ts', "Git's index", 'saved edits and unsaved choices', 'stays unmerged and unstaged', 'Other files are unchanged']) {
    assert.ok(confirms[0].includes(words), 'confirmation says: ' + words)
  }
  assert.deepEqual(view().choices, ['current'])

  // The request is the confirmed fingerprint alone. A refusal keeps the model and its choices.
  answer = true
  view().onReset(); await flush()
  assert.deepEqual(resets[0].args, ['/repo', 'c.ts', { fingerprint: fingerprint('a') }])
  resets[0].reject(new Error('refused')); await flush()
  assert.deepEqual(errors, ['Error: refused'])
  assert.equal(view().model, first)
  assert.deepEqual(view().choices, ['current'])

  // A reset that writes the same bytes still installs its model and clears the choices.
  view().onReset(); await flush()
  const same = conflictDoc('a')
  resets[1].resolve(same); await flush()
  assert.equal(view().model, same)
  assert.deepEqual(view().choices, [])

  // A reply for a file the pane has left does not replace the file now on screen.
  choose()
  view().onReset(); await flush()
  find(tree, (p) => p.title === 'Conflicts' && typeof p.onSelect === 'function').onSelect(conflicted('d.ts')); render()
  const other = conflictDoc('d')
  loads.at(-1).resolve(other); await flush()
  resets[2].resolve(conflictDoc('c')); await flush()
  assert.equal(view().path, 'd.ts')
  assert.equal(view().model, other)

  // Nor does a reply for a repo the pane has left.
  choose()
  view().onReset(); await flush()
  props = { ...props, repo: '/other' }; render()
  // Same path and fingerprint as the request, so only the repo tells them apart.
  const elsewhere = conflictDoc('d')
  loads.at(-1).resolve(elsewhere); await flush()
  resets[3].resolve(conflictDoc('f')); await flush()
  assert.equal(view().model, elsewhere)
  unmount()
}

if (process.env.CHECK_MODE === 'status-loads') {
  for (const mode of ['all', 'selected-working', 'selected-staged']) for (const reject of [false, true]) {
    await start(false)
    if (mode !== 'all') {
      const title = mode === 'selected-staged' ? 'Staged' : 'Unstaged'
      find(tree, (p) => p.title === title && typeof p.onSelect === 'function').onSelect(change('b.ts'))
      render(); await load('initial')
    }
    props = { ...props, revision: 2 }; render()
    const oldLoads = requests.filter((r) => !r.done && r.args[3] === undefined)
    const oldWiden = expand()
    const beforeStatus = requests.length
    props = { ...props, status: { changes: [change('b.ts')] } }; render()
    const currentLoads = requests.slice(beforeStatus).filter((r) => r.args[3] === undefined)
    const beforeReply = JSON.stringify(diff().files)
    for (const request of [...oldLoads, oldWiden]) {
      request.done = true
      if (reject) request.reject(new Error('obsolete status request'))
      else request.resolve(working('obsolete'))
    }
    await flush()
    assert.equal(JSON.stringify(diff().files), beforeReply, mode + ': old base load replaced the current source')
    assert.deepEqual(errors, [], mode + ': obsolete status error reached onError')
    assert.deepEqual(JSON.parse(stored.get('bettergit.session')).places['/repo'].widened, {})
    assert.equal(currentLoads.length, mode === 'all' ? 2 : 3, mode + ': status must start fresh base loads')
    const current = working('current')
    current.files = current.files.filter((file) => file.newPath === 'b.ts')
    for (const request of currentLoads) { request.done = true; request.resolve(current) }
    await flush()
    for (const staged of mode === 'all' ? [false, true] : [mode === 'selected-staged']) {
      const view = find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === staged)
      assert.deepEqual(view.files.map((file) => file.newPath), ['b.ts'], mode + ': obsolete a.ts leaked')
      assert.equal(view.files[0].hunks[0].lines.at(-1).text, 'current')
    }
    // A later failure for the current status must still report from each active loader.
    props = { ...props, status: { changes: [change('b.ts')] } }; render()
    const active = requests.filter((r) => !r.done && r.args[3] === undefined)
    for (const request of active) { request.done = true; request.reject(new Error('active status failure')) }
    await flush()
    assert.equal(errors.length, mode === 'all' ? 1 : 2)
    assert.ok(errors.every((error) => error === 'Error: active status failure'))
    unmount()
  }
} else if (process.env.CHECK_MODE === 'retained') {
  for (const selected of [false, true]) for (const reject of [false, true]) {
    await start(selected)
    props = { ...props, revision: 2 }; render()
    // This widen is requested from the still-displayed file under the NEW revision.
    const currentWiden = expand()
    for (const request of requests.filter((r) => !r.done && r.args[3] === undefined)) {
      request.done = true; request.reject(new Error('current base failure'))
    }
    await flush()
    assert.equal(errors.length, selected ? 2 : 1)
    const baseErrors = [...errors]
    currentWiden.done = true
    if (reject) currentWiden.reject(new Error('current widen failure'))
    else currentWiden.resolve({ files: [working('retained-wide').files[0]], moves: [] })
    await flush()
    assert.deepEqual(errors, reject ? [...baseErrors, 'Error: current widen failure'] : baseErrors)
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, reject ? 'initial' : 'retained-wide')
    assert.equal(JSON.parse(stored.get('bettergit.session')).places['/repo'].widened['u:a.ts'], reject ? undefined : 10)
    unmount()
  }
} else if (process.env.CHECK_MODE === 'batched') {
  for (const selected of [false, true]) for (const reject of [false, true]) {
    await start(selected)
    props = { ...props, revision: 2 }; render()
    const oldWiden = expand()
    await load('latest', false)
    oldWiden.done = true
    if (reject) oldWiden.reject(new Error('stale batched error'))
    else oldWiden.resolve({ files: [working('stale-wide').files[0]], moves: [] })
    await flush()
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, 'latest', 'batched widen replaced the latest file')
    assert.equal(JSON.parse(stored.get('bettergit.session')).places['/repo'].widened['u:a.ts'], undefined)
    assert.deepEqual(errors, [])
    unmount()
  }
} else if (process.env.CHECK_MODE === 'errors') {
  for (const selected of [false, true]) {
    await start(selected)
    const oldWiden = expand()
    props = { ...props, revision: 2 }; render()
    const oldLoads = requests.filter((r) => !r.done && r.args[3] === undefined)
    setIgnoreWhitespace(true); render()
    const latestLoad = requests.at(-1)
    latestLoad.done = true; latestLoad.reject(new Error('latest load error'))
    await flush()
    assert.deepEqual(errors, ['Error: latest load error'])
    for (const request of [...oldLoads, oldWiden]) {
      request.done = true; request.reject(new Error('stale request error'))
    }
    await flush()
    assert.deepEqual(errors, ['Error: latest load error'], 'stale failure replaced the latest load error')
    unmount()
  }
} else if (process.env.CHECK_MODE === 'fresh') {
  for (const selected of [false, true]) {
    await start(selected)
    const request = expand()
    request.done = true; request.resolve({ files: [working('fresh-wide').files[0]], moves: [] })
    await flush()
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, 'fresh-wide')
    assert.equal(diff().files[1].hunks[0].lines.at(-1).text, 'initial')
    assert.equal(JSON.parse(stored.get('bettergit.session')).places['/repo'].widened['u:a.ts'], 10)
    assert.deepEqual(errors, [])
    const view = diff()
    view.onExpand(view.files[0]); const widerA = requests.at(-1)
    view.onExpand(view.files[1]); const widerB = requests.at(-1)
    assert.equal(widerA.args[2], 25)
    widerB.done = true; widerB.resolve({ files: [working('wide-b').files[1]], moves: [] })
    await flush(false)
    widerA.done = true; widerA.resolve({ files: [working('wider-a').files[0]], moves: [] })
    await flush()
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, 'wider-a')
    assert.equal(diff().files[1].hunks[0].lines.at(-1).text, 'wide-b')
    assert.deepEqual(JSON.parse(stored.get('bettergit.session')).places['/repo'].widened, { 'u:a.ts': 25, 'u:b.ts': 10 })
    unmount()
  }
} else {
  const selected = process.env.CHECK_MODE === 'selected'
  const transitions = ['whitespace', 'context', 'revision', 'status', 'repo', 'file', 'section', 'clear', 'unmount']
  for (const transition of transitions) for (const reject of [false, true]) {
    await start(selected)
    const request = expand()
    if (transition === 'whitespace') setIgnoreWhitespace(true)
    if (transition === 'context') setContextLines(25)
    if (transition === 'revision') props = { ...props, revision: 2 }
    if (transition === 'status') props = { ...props, status: { ...props.status, changes: [...props.status.changes] } }
    if (transition === 'repo') props = { ...props, repo: '/other' }
    if (transition === 'file' || transition === 'section') {
      const section = transition === 'section' ? 'Staged' : 'Unstaged'
      find(tree, (p) => p.title === section && typeof p.onSelect === 'function').onSelect(change(transition === 'file' ? 'b.ts' : 'a.ts'))
    }
    if (transition === 'clear') {
      // Clearing an already empty selection is not a target change.
      if (!selected) { unmount(); continue }
      find(tree, (p) => p.className?.startsWith('file-list')).onClick({ target: { closest: () => null } })
    }
    if (transition === 'unmount') unmount()
    else { render(); await load('latest') }
    const before = JSON.stringify(diff()?.files)
    errors.push('latest error')
    request.done = true
    if (reject) request.reject(new Error('stale widen error'))
    else request.resolve({ files: [working('stale-wide').files[0]], moves: [] })
    await flush()
    assert.equal(JSON.stringify(diff()?.files), before, transition + ': old widen replaced latest diff')
    assert.deepEqual(errors, ['latest error'], transition + ': old widen replaced latest error')
    const place = JSON.parse(stored.get('bettergit.session')).places['/repo']
    assert.equal(place?.widened?.['u:a.ts'], undefined, transition + ': old widen persisted its level')
    if (mounted) unmount()
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

test('a current Changes widen replaces only its file and persists its level', () => check('fresh'))
test('all Changes drops stale widen replies and errors across options, refreshes, targets and unmount', () => check('all'))
test('selected Changes drops stale widen replies and errors across options, refreshes, targets and unmount', () => check('selected'))
test('old Changes loads and widens cannot replace a newer load error', () => check('errors'))
test('a base reload invalidates old file widens before React renders the replacement', () => check('batched'))
test('status changes invalidate pending base loads and start current staged, working and selected loads', () => check('status-loads'))
test('a widen requested under the current revision remains valid after its base reload fails', () => check('retained'))
