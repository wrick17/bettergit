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
      commitIdentity: async () => ({ name: 'Effective Author', email: 'author@example.test', error: null }),
      working: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject, done: false })),
    },
  },
  // No layout here: no element is under any point, and frames are drawn only by the modes that queue them.
  document: { activeElement: null, elementFromPoint: () => null },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
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
let Component = ChangesView
const { setContextLines, setIgnoreWhitespace } = await import('./src/renderer/src/prefs')
const { parseDiff } = await import('./src/main/git/diff')

function render() {
  do {
    dirty = false; cursor = 0; effects = []
    tree = Component(props)
    for (const effect of effects) effect()
    // Each DiffView shows the files it was given, as it does once its deferred render lands.
    if (diffViewsShow) for (const view of findAll(tree, (p) => typeof p.onShown === 'function')) view.onShown(view.files)
  } while (dirty)
}
let diffViewsShow = true
function findAll(node, match, out = []) {
  for (const child of [node].flat(Infinity)) {
    if (!react.isValidElement(child)) continue
    if (match(child.props)) out.push(child.props)
    findAll(child.props.children, match, out)
  }
  return out
}
async function flush(renderUpdates = true) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    if (renderUpdates && dirty && mounted) render()
  }
}
function find(node, match) {
  // Lists rendered with map are nested arrays among the children.
  for (const child of [node].flat(Infinity)) {
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
  return { files: ['a.ts', 'b.ts'].flatMap((path) => {
    const patch = 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1 @@\n-old\n+' + label + '\n'
    return parseDiff(patch, Buffer.from(patch))
  }), moves: [] }
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

if (process.env.CHECK_MODE === 'hunk-context') {
  const writes = []
  window.bettergit.applyHunk = async (...args) => { writes.push(args) }
  document.createElement = () => ({ remove() {} })
  document.body = { append() {} }
  globalThis.requestAnimationFrame = (callback) => { callback(); return 0 }
  let confirms = 0
  window.confirm = () => { confirms++; return true }
  for (const selected of [false, true]) {
    await start(selected)
    for (const [step, context] of [3, 10, 25, 100000, 3].entries()) {
      if (step) {
        setContextLines(context); render()
        assert.equal(diff().stage.onHunk, undefined, 'old-context hunk writes remain available during reload')
        await load('context-' + context)
      }
      const view = diff(), hunk = view.files[0].hunks[0]
      assert.equal(typeof view.stage.onHunk, 'function', 'fresh context did not restore per-hunk actions')
      for (const action of ['stage', 'discard']) {
        await view.stage.onHunk('a.ts', hunk, action); await flush()
        assert.deepEqual(writes.at(-1), ['/repo', action, { path: 'a.ts', staged: false, context,
          header: hunk.header, lines: hunk.lines.map(({ type, text }) => ({ type, text })), id: hunk.id }])
      }
    }
    const request = expand()
    request.done = true; request.resolve({ files: [working('wide').files[0]], moves: [] })
    await flush()
    const view = diff(), hunk = view.files[0].hunks[0]
    await view.stage.onHunk('a.ts', hunk, 'stage'); await flush()
    assert.equal(writes.at(-1)[2].context, 10, 'expanded hunk did not use its own Git context')
    assert.equal(writes.at(-1)[2].id, hunk.id)
    unmount()
  }
  assert.equal(confirms, 0, 'the file controls confirm inline before invoking hunk writes')
} else if (process.env.CHECK_MODE === 'rails') {
  await start(true)
  find(tree, (p) => p['aria-label'] === 'Commit message').onChange({ target: { value: 'unfinished draft' } })
  render()
  const files = diff().files
  const scroller = find(tree, (p) => p.className === 'diff-pane').ref
  const before = requests.length
  let shows = 0
  props = { ...props, listOpen: false, detailOpen: false, diffOpen: false, onShowDiff: () => { shows++ } }
  render(); await flush()
  assert.ok(find(tree, (p) => p.className?.startsWith('file-list folded')), 'collapsed file list was unmounted')
  assert.equal(find(tree, (p) => p.className === 'diff-pane').ref, scroller)
  assert.equal(diff().files, files, 'collapse replaced the selected diff')
  assert.equal(find(tree, (p) => p['aria-label'] === 'Commit message').value, 'unfinished draft')
  assert.equal(find(tree, (p) => p.fold && p.label).fold.collapsed, true)
  find(tree, (p) => p.fold && p.label).fold.paneHandlers.onPointerEnter()
  render()
  assert.equal(find(tree, (p) => p.fold && p.label).fold.collapsed, false, 'hover did not preview the collapsed diff')
  assert.equal(props.diffOpen, false, 'hover changed the saved expansion choice')
  assert.equal(requests.length, before, 'collapsing or previewing reloaded the diff')
  find(tree, (p) => p.title === 'Changes' && typeof p.onSelect === 'function').onSelect(change('a.ts'))
  assert.equal(shows, 1, 'picking a file did not expand a collapsed diff')
  props = { ...props, listOpen: true, detailOpen: true, diffOpen: true }
  render(); await flush()
  assert.equal(find(tree, (p) => p.className === 'diff-pane').ref, scroller)
  assert.equal(find(tree, (p) => p['aria-label'] === 'Commit message').value, 'unfinished draft')
  unmount()
} else if (process.env.CHECK_MODE === 'toggle-cache') {
  // A whitespace option loaded under the same status shows again at once, without a reload or a loading frame, and
  // picking a file reuses its section's load. A refresh drops the loads, so the next toggle loads again.
  for (const selected of [false, true]) {
    await start(selected)
    setIgnoreWhitespace(true); render()
    await load('filtered')
    const before = requests.length
    setIgnoreWhitespace(false); render()
    assert.equal(requests.length, before, 'a loaded option was fetched again')
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, 'initial', 'the loaded option did not show at once')
    find(tree, (p) => p.title === 'Changes' && typeof p.onSelect === 'function').onSelect(change('b.ts')); render()
    await flush()
    assert.equal(requests.length, before, 'picking a file reloaded its section')
    props = { ...props, revision: 2 }; render()
    await load('refreshed')
    setIgnoreWhitespace(true); render()
    assert.ok(requests.slice(before).some((r) => !r.done && r.args[4] === true), 'a refresh kept the old whitespace load')
    setIgnoreWhitespace(false)
    unmount()
  }
} else if (process.env.CHECK_MODE === 'conflict-reset') {
  const { parseConflicts, conflictBlocks } = await import('./src/shared/conflict')
  const loads = [], resets = [], confirms = []
  let answer = true
  Object.assign(window.bettergit, {
    conflictLoad: (...args) => new Promise((resolve, reject) => loads.push({ args, resolve, reject })),
    conflictReset: (...args) => new Promise((resolve, reject) => resets.push({ args, resolve, reject })),
  })
  // The confirmation's underlay is a scrim on the body, beside the app root. Frames run only when the test draws them.
  const body = [], frames = [], under = []
  Object.assign(document, {
    body: { append: (el) => body.push(el) },
    createElement: () => ({ className: '', remove() { body.splice(body.indexOf(this), 1) } }),
  })
  globalThis.requestAnimationFrame = (callback) => frames.push(callback)
  const drawFrame = async () => { for (const callback of frames.splice(0)) callback(); await flush() }
  const answered = async () => { await flush(); await drawFrame(); await drawFrame() }
  window.confirm = (message) => {
    confirms.push(message); under.push(body.map((el) => el.className))
    if (answer instanceof Error) throw answer
    return answer
  }
  const fingerprint = (label) => ({ working: label.repeat(64), stages: 'b'.repeat(64) })
  const conflictDoc = (label) => {
    const { parts } = parseConflicts('x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n')
    return { supported: true, fingerprint: fingerprint(label), parts, combine: conflictBlocks(parts).map(() => ({ state: 'overlap' })), reset: { available: true, fingerprint: fingerprint(label) } }
  }
  const conflicted = (path) => ({ path, staged: false, unstaged: false, conflicted: true, kind: 'modified' })
  // Every conflicted file is on screen, each with its own resolver. The first is c.ts, the file restored below.
  const view = () => find(tree, (p) => typeof p.onReset === 'function')
  const fileView = (path) => find(tree, (p) => typeof p.onReset === 'function' && p.path === path)
  const load = (path, doc) => loads.filter((entry) => entry.args[1] === path).at(-1).resolve(doc)
  const choose = () => { view().onChoose(0, 'current'); render(); assert.deepEqual(view().choices, ['current']) }
  stored.clear(); errors = []; slots = []; mounted = true
  stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'c.ts', staged: false } } }))
  props = {
    repo: '/repo', revision: 1, status: { changes: [conflicted('c.ts'), conflicted('d.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render()
  // Both files load at once, the picked one first.
  assert.deepEqual(loads.map((entry) => entry.args), [['/repo', 'c.ts'], ['/repo', 'd.ts']])
  const first = conflictDoc('a')
  load('c.ts', first); await flush()
  choose()

  const { confirmOverBlur } = await import('./src/renderer/src/confirm')
  // Non-file actions still use native confirmations. The blurred underlay is up and drawn for two frames before the sheet opens, and a second request meanwhile asks nothing.
  // Cancel asks once, calls nothing and takes the underlay down.
  answer = false
  void confirmOverBlur('Test repository confirmation'); await flush()
  assert.deepEqual(body.map((el) => el.className), ['scrim confirm-scrim'])
  await drawFrame()
  void confirmOverBlur('Test repository confirmation'); await flush()
  assert.equal(confirms.length, 0)
  await drawFrame()
  assert.deepEqual(under, [['scrim confirm-scrim']])
  assert.deepEqual(body, [])
  assert.equal(resets.length, 0)
  assert.equal(confirms.length, 1)
  assert.equal(confirms[0], 'Test repository confirmation')
  assert.deepEqual(view().choices, ['current'])

  // A confirmation that fails is a cancel, and its underlay still comes down.
  answer = new Error('no sheet')
  void confirmOverBlur('Test repository confirmation'); await answered()
  assert.equal(resets.length, 0)
  assert.deepEqual(body, [])

  // The request is the confirmed fingerprint alone. A refusal keeps the model and its choices.
  answer = true
  view().onReset(); await answered()
  assert.deepEqual(body, [])
  assert.deepEqual(resets[0].args, ['/repo', 'c.ts', { fingerprint: fingerprint('a') }])
  resets[0].reject(new Error('refused')); await flush()
  // A refused write reaches onError named with its action, for the notification hub.
  assert.deepEqual(errors, ['ActionError: refused'])
  assert.equal(view().model, first)
  assert.deepEqual(view().choices, ['current'])

  // A reset that writes the same bytes still installs its model and clears the choices.
  view().onReset(); await answered()
  const same = conflictDoc('a')
  resets[1].resolve(same); await flush()
  assert.equal(view().model, same)
  assert.deepEqual(view().choices, [])

  // A reply replaces only the file it was asked for, even after another file is picked. Picking does not reload.
  choose()
  view().onReset(); await answered()
  find(tree, (p) => p.title === 'Conflicts' && typeof p.onSelect === 'function').onSelect(conflicted('d.ts')); render()
  assert.equal(loads.length, 2)
  const other = conflictDoc('d')
  load('d.ts', other); await flush()
  fileView('d.ts').onChoose(0, 'incoming'); render()
  const reset = conflictDoc('c')
  resets[2].resolve(reset); await flush()
  assert.equal(fileView('c.ts').model, reset)
  assert.deepEqual(fileView('c.ts').choices, [])
  assert.equal(fileView('d.ts').model, other)
  assert.deepEqual(fileView('d.ts').choices, ['incoming'])

  // Nor does a reply for a repo the pane has left.
  choose()
  view().onReset(); await answered()
  props = { ...props, repo: '/other' }; render()
  // Same path and fingerprint as the request, so only the repo tells them apart.
  const elsewhere = conflictDoc('c')
  load('c.ts', elsewhere); await flush()
  resets[3].resolve(conflictDoc('f')); await flush()
  assert.equal(fileView('c.ts').model, elsewhere)
  unmount()

  // Paths are keys: files named like Object's own members load and resolve like any other.
  loads.length = 0; slots = []; mounted = true
  stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'constructor', staged: false } } }))
  props = { ...props, repo: '/repo', revision: 1, status: { changes: [conflicted('constructor'), conflicted('__proto__')] } }
  render()
  assert.equal(fileView('constructor'), undefined, 'an unloaded file named constructor showed a resolver')
  assert.equal(fileView('__proto__'), undefined, 'an unloaded file named __proto__ showed a resolver')
  for (const path of ['constructor', '__proto__']) load(path, conflictDoc(path === 'constructor' ? 'c' : 'p'))
  await flush()
  for (const path of ['constructor', '__proto__']) assert.equal(fileView(path).model.supported, true)
  fileView('__proto__').onChoose(0, 'current'); render()
  assert.deepEqual(fileView('__proto__').choices, ['current'])
  unmount()

  // The inline controls confirm before these callbacks send only the fingerprint and side.
  const staged = [], takes = []
  Object.assign(window.bettergit, {
    stage: (...args) => { staged.push(args); return Promise.resolve() },
    conflictTake: (...args) => { takes.push(args); return Promise.resolve() },
  })
  loads.length = 0; slots = []; mounted = true; confirms.length = 0
  props = { ...props, repo: '/repo', revision: 1, status: { changes: [conflicted('c.ts'), conflicted('d.ts')] } }
  render()
  const clean = { supported: true, fingerprint: fingerprint('e'), parts: parseConflicts('clean\n').parts, combine: [], reset: { available: true, fingerprint: fingerprint('e') } }
  load('c.ts', clean); load('d.ts', conflictDoc('d')); await flush()
  fileView('c.ts').onStage(); await flush()
  assert.deepEqual(staged, [['/repo', ['c.ts']]])
  fileView('d.ts').onTake('theirs'); await answered()
  assert.deepEqual(takes, [['/repo', 'd.ts', { fingerprint: fingerprint('d'), side: 'theirs' }]])
  assert.equal(confirms.length, 0, 'confirmed file callbacks must not open a second native dialog')
  unmount()
}

if (process.env.CHECK_MODE === 'commit-draft') {
  const commits = []
  window.bettergit.commitChanges = (...args) => new Promise((resolve) => commits.push({ args, resolve }))
  const box = () => find(tree, (p) => p['aria-label'] === 'Commit message')
  const draft = () => JSON.parse(stored.get('bettergit.session')).places['/repo'].draft
  const remount = () => { unmount(); slots = []; mounted = true; render() }
  // Nothing typed after the remount, a different draft, and the committed text typed again.
  for (const typed of [null, 'second', 'first']) {
    await start(false)
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
} else if (process.env.CHECK_MODE === 'restore') {
  const frames = new Map()
  let nextFrame = 1
  globalThis.requestAnimationFrame = (callback) => { frames.set(nextFrame, callback); return nextFrame++ }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  const tick = () => { const run = [...frames.values()]; frames.clear(); run.forEach((callback) => callback()) }
  const revealed = []
  const box = () => ({ top: 0, bottom: 0 })
  const sections = ['a.ts', 'b.ts'].map((path) => ({ dataset: { path }, scrollIntoView: () => revealed.push(path), classList: { add() {}, remove() {} }, getBoundingClientRect: box }))
  const pane = { scrollTop: 400, querySelectorAll: () => sections, getBoundingClientRect: box }
  stored.clear(); requests.length = 0; errors = []; slots = []; mounted = true
  setContextLines(3); setIgnoreWhitespace(false)
  stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'a.ts', staged: false } } }))
  props = {
    repo: '/repo', revision: 1, status: { changes: [change('a.ts'), change('b.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render()
  find(tree, (p) => p.className === 'diff-pane').ref.current = pane
  render()
  // A restored file with no saved position is shown once its diff loads and is on screen, before that frame paints.
  diffViewsShow = false
  await load('initial')
  tick(); tick()
  assert.deepEqual(revealed, [], 'revealed before the diff showed its files')
  diffViewsShow = true
  render()
  assert.deepEqual(revealed, ['a.ts'])
  assert.equal(pane.scrollTop, 400)
  // Picking another file in the same section scrolls the diff already on screen to it. Nothing reloads.
  const loads = requests.length
  find(tree, (p) => p.title === 'Changes' && typeof p.onSelect === 'function').onSelect(change('b.ts')); render()
  tick(); tick()
  assert.deepEqual(revealed, ['a.ts', 'b.ts'])
  assert.equal(requests.length, loads, 'picking a file in the section on screen reloaded its diff')
  assert.equal(pane.scrollTop, 400)
  // The same pane leaves the file for all changes and restores the saved position for all, here 0.
  const session = JSON.parse(stored.get('bettergit.session'))
  session.views = { '/repo|changes-diff': { key: 'all', value: 0 } }
  stored.set('bettergit.session', JSON.stringify(session))
  find(tree, (p) => p.className?.startsWith('file-list')).onClick({ target: { closest: () => null } }); render()
  assert.equal(pane.scrollTop, 0)
  unmount()
} else if (process.env.CHECK_MODE === 'whitespace-failure') {
  const views = (selected) => (selected ? [false] : [false, true]).map((staged) => find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === staged))
  const counts = (node, out = []) => {
    for (const child of Array.isArray(node) ? node : [node]) {
      if (!react.isValidElement(child)) continue
      if (child.props.className === 'diff-section') out.push(child)
      counts(child.props.children, out)
    }
    return out.filter((h2) => [].concat(h2.props.children).some((c) => react.isValidElement(c) && c.props.className === 'count')).length
  }
  const settle = async (outcome) => {
    for (const request of requests.filter((r) => !r.done && r.args[3] === undefined)) {
      request.done = true
      if (outcome instanceof Error) request.reject(outcome)
      else request.resolve(outcome)
    }
    await flush()
  }
  for (const selected of [false, true]) {
    await start(selected)
    // Hiding whitespace reloads with the new option. If that load fails, the hunks loaded without it are not shown under it.
    setIgnoreWhitespace(true); render()
    assert.ok(requests.filter((r) => !r.done && r.args[3] === undefined).every((r) => r.args[4] === true))
    await settle(new Error('filtered load failed'))
    assert.deepEqual(errors, ['Error: filtered load failed'])
    // The failure stays on screen in place of the changes, with the toolbar mounted so the option can be changed back.
    for (let pass = 0; pass < 2; pass++) {
      for (const view of views(selected)) {
        assert.ok(view, 'toolbar unmounted after a failed load')
        assert.deepEqual(view.files, [], 'hunks loaded with whitespace shown under hidden whitespace')
        assert.equal(view.emptyHint, 'Could not load these changes.')
      }
      if (!selected) assert.equal(counts(tree), 0, 'a failed load shows file counts')
      render()
    }
    // A refresh with the same options that loads no files is a valid empty view, with the default text.
    props = { ...props, revision: 2 }; render()
    await settle({ files: [], moves: [] })
    for (const view of views(selected)) assert.equal(view.emptyHint, undefined)
    if (!selected) assert.equal(counts(tree), 2)
    // Showing whitespace again loads the changes. A failed refresh with those options keeps them.
    setIgnoreWhitespace(false); render(); await load('shown')
    props = { ...props, revision: 3 }; render()
    await settle(new Error('refresh failed'))
    assert.equal(diff().files[0].hunks[0].lines.at(-1).text, 'shown')
    for (const view of views(selected)) assert.equal(view.emptyHint, undefined)
    unmount()
  }
} else if (process.env.CHECK_MODE === 'initial-failure') {
  // The first load fails before any result has shown. The failure stays in place of the changes, with the toolbar
  // mounted, after the error banner clears; a later load for the same view replaces it.
  const views = (selected) => (selected ? [false] : [false, true]).map((staged) => find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === staged))
  for (const selected of [false, true]) {
    stored.clear(); requests.length = 0; errors = []; slots = []; mounted = true
    setContextLines(3); setIgnoreWhitespace(false)
    if (selected) stored.set('bettergit.session', JSON.stringify({ places: { '/repo': { file: 'a.ts', staged: false } } }))
    props = {
      repo: '/repo', revision: 1, status: { changes: [change('a.ts'), change('b.ts')] },
      listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
    }
    render()
    for (const request of requests.filter((r) => !r.done && r.args[3] === undefined)) { request.done = true; request.reject(new Error('first load failed')) }
    await flush()
    assert.deepEqual(errors, ['Error: first load failed'])
    for (let pass = 0; pass < 2; pass++) {
      for (const view of views(selected)) {
        assert.ok(view, 'no diff toolbar after a failed first load')
        assert.deepEqual(view.files, [])
        assert.equal(view.emptyHint, 'Could not load these changes.')
      }
      render()
    }
    props = { ...props, revision: 2 }; render(); await load('recovered')
    for (const view of views(selected)) {
      assert.equal(view.emptyHint, undefined)
      assert.equal(view.files[0].hunks[0].lines.at(-1).text, 'recovered')
    }
    unmount()
  }
} else if (process.env.CHECK_MODE === 'option-pending') {
  // While a load for new options runs, hunks, counts and row stats from the old options are not shown; the toolbar is.
  const views = (selected) => (selected ? [false] : [false, true]).map((staged) => find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === staged))
  const texts = (selected) => views(selected).map((view) => view.files.map((file) => file.hunks[0].lines.at(-1).text))
  const counted = () => {
    const out = []
    const walk = (node) => { for (const child of Array.isArray(node) ? node : [node]) if (react.isValidElement(child)) { if (child.props.className === 'count') out.push(child); walk(child.props.children) } }
    walk(tree)
    return out.length
  }
  const rowStats = () => find(tree, (p) => p.title === 'Changes' && p.stats instanceof Map).stats.size
  const settle = async (option, outcome) => {
    for (const request of requests.filter((r) => !r.done && r.args[3] === undefined && r.args[4] === option)) {
      request.done = true
      if (outcome instanceof Error) request.reject(outcome)
      else request.resolve(working(outcome))
    }
    await flush()
  }
  for (const selected of [false, true]) {
    await start(selected)
    const loadedCounts = counted()
    assert.ok(rowStats() > 0)
    setIgnoreWhitespace(true); render()
    for (const view of views(selected)) {
      assert.ok(view, 'toolbar unmounted while the new option loads')
      assert.deepEqual(view.files, [], 'old-option hunks shown while the new option loads')
      assert.equal(view.emptyHint, 'Loading…')
    }
    assert.equal(rowStats(), 0, 'old-option row stats shown while the new option loads')
    assert.equal(counted(), loadedCounts - (selected ? 0 : 2), 'old-option section counts shown while the new option loads')
    // Switching back shows the result loaded for that option at once, while its refresh runs.
    setIgnoreWhitespace(false); render()
    assert.deepEqual(texts(selected), views(selected).map(() => ['initial', 'initial']))
    // A reply for an option already left changes nothing; the current reply shows.
    setIgnoreWhitespace(true); render()
    await settle(false, 'obsolete')
    for (const view of views(selected)) assert.equal(view.emptyHint, 'Loading…')
    await settle(true, 'filtered')
    assert.deepEqual(texts(selected), views(selected).map(() => ['filtered', 'filtered']))
    assert.ok(rowStats() > 0)
    // A refresh with the same options keeps its result while it runs and after it fails.
    props = { ...props, revision: 2 }; render()
    assert.deepEqual(texts(selected), views(selected).map(() => ['filtered', 'filtered']))
    await settle(true, new Error('refresh failed'))
    assert.deepEqual(texts(selected), views(selected).map(() => ['filtered', 'filtered']))
    for (const view of views(selected)) assert.equal(view.emptyHint, undefined)
    assert.deepEqual(errors, ['Error: refresh failed'])
    unmount()
  }
} else if (process.env.CHECK_MODE === 'option-scroll') {
  // The pane models the browser: its height follows the files on screen (a view shown is laid out before it paints), a
  // shorter pane clamps scrollTop at the next frame, and a clamp fires the pane's scroll event. A scrolled view keeps its
  // place through an option reload.
  const frames = new Map()
  let nextFrame = 1
  globalThis.requestAnimationFrame = (callback) => { frames.set(nextFrame, callback); return nextFrame++ }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  let top = 0
  let revealTarget = null
  const pane = { clientHeight: 100, querySelectorAll: (selector) => selector === '[data-path]' && revealTarget ? [revealTarget] : [], getBoundingClientRect: () => ({ top: 0, bottom: 100 }) }
  Object.defineProperty(pane, 'scrollTop', { get: () => top, set: (value) => { top = Math.max(0, Math.min(value, pane.scrollHeight - pane.clientHeight)) } })
  Object.defineProperty(pane, 'scrollHeight', { get: () => {
    const shown = []
    const walk = (node) => { for (const child of Array.isArray(node) ? node : [node]) if (react.isValidElement(child)) { if (Array.isArray(child.props.files) && child.props.stage) shown.push(...child.props.files); walk(child.props.children) } }
    walk(tree)
    return shown.length ? 3000 : 40
  } })
  const scrolled = () => find(tree, (p) => p.className === 'diff-pane').onScroll({ currentTarget: pane })
  const frame = () => {
    const before = pane.scrollTop
    pane.scrollTop = before
    if (pane.scrollTop !== before) scrolled()
    const run = [...frames.values()]; frames.clear(); run.forEach((callback) => callback())
  }
  const saved = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return JSON.parse(stored.get('bettergit.session')).views['/repo|changes-diff']
  }
  stored.clear(); requests.length = 0; errors = []; slots = []; mounted = true
  setContextLines(3); setIgnoreWhitespace(false)
  props = {
    repo: '/repo', revision: 1, status: { changes: [change('a.ts'), change('b.ts')] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render()
  find(tree, (p) => p.className === 'diff-pane').ref.current = pane
  await load('initial')
  frame(); frame()
  pane.scrollTop = 900; scrolled()
  setIgnoreWhitespace(true); render()
  frame()
  assert.equal(pane.scrollTop, 0)
  await load('filtered')
  frame(); frame()
  assert.equal(pane.scrollTop, 900, 'scroll position lost across an option reload')
  assert.deepEqual(await saved(), { key: 'all', value: 900 }, 'the clamp to the top was saved')
  // Picking a file while an option reload runs leaves that file to its own reveal, not the old position. A context
  // not loaded yet reloads; the whitespace option loaded before would show at once.
  setContextLines(10); render()
  frame()
  assert.equal(pane.scrollTop, 900, 'context reload must keep the existing editor and its scroll position')
  // Give revealFile a real target in this model. The old empty-pane clamp used to move it without a reveal.
  revealTarget = { dataset: { path: 'b.ts' }, classList: { add() {}, remove() {} }, offsetWidth: 100,
    scrollIntoView: () => { pane.scrollTop = 1200 } }
  find(tree, (p) => p.title === 'Changes' && typeof p.onSelect === 'function').onSelect(change('b.ts')); render()
  await load('picked')
  frame(); frame(); frame()
  assert.equal(pane.scrollTop, 1200, 'old view position restored into a picked file instead of its header')
  setIgnoreWhitespace(false); setContextLines(3)
  unmount()
} else if (process.env.CHECK_MODE === 'status-loads') {
  for (const mode of ['all', 'selected-working', 'selected-staged']) for (const reject of [false, true]) {
    await start(false)
    if (mode !== 'all') {
      const title = mode === 'selected-staged' ? 'Staged' : 'Changes'
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
    // The selected section shares the all view's load of that section.
    assert.equal(currentLoads.length, 2, mode + ': status must start fresh base loads')
    const current = working('current')
    current.files = current.files.filter((file) => file.newPath === 'b.ts')
    for (const request of currentLoads) { request.done = true; request.resolve(current) }
    await flush()
    for (const staged of mode === 'all' ? [false, true] : [mode === 'selected-staged']) {
      const view = find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === staged)
      assert.deepEqual(view.files.map((file) => file.newPath), ['b.ts'], mode + ': obsolete a.ts leaked')
      assert.equal(view.files[0].hunks[0].lines.at(-1).text, 'current')
    }
    // A later failure for the current status still reports, once per failed load.
    props = { ...props, status: { changes: [change('b.ts')] } }; render()
    const active = requests.filter((r) => !r.done && r.args[3] === undefined)
    for (const request of active) { request.done = true; request.reject(new Error('active status failure')) }
    await flush()
    assert.equal(errors.length, 1)
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
    assert.equal(errors.length, 1)
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
    // Picking another file in the section on screen keeps that diff, so its widen still applies. Not a target change.
    if (transition === 'file' && selected) { unmount(); continue }
    if (transition === 'file' || transition === 'section') {
      const section = transition === 'section' ? 'Staged' : 'Changes'
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

if (process.env.CHECK_MODE === 'identity') {
  await start(false)
  const author = find(tree, (p) => p['aria-label'] === 'Edit commit identity')
  assert.ok(author, 'commit box shows an editable effective Git author')
  assert.equal(author.children, 'Effective Author <author@example.test>')
  author.onClick(); render()
  const dialog = find(tree, (p) => typeof p.onSaved === 'function' && p.repo === '/repo')
  assert.ok(dialog, 'click opens the identity dialog for this repository')
  unmount()
}

if (process.env.CHECK_MODE === 'identity-dialog') {
  const { IdentityDialog } = await import('./src/renderer/src/IdentityDialog')
  const writes = [], saved = []
  let closed = 0
  window.bettergit.setCommitIdentity = async (...args) => {
    writes.push(args)
    return { name: 'Environment Author', email: 'env@example.test', error: null }
  }
  Component = IdentityDialog
  slots = []; mounted = true
  props = { repo: '/repo', identity: { name: 'Old Author', email: 'old@example.test', error: null }, onSaved: (next) => saved.push(next), onClose: () => closed++ }
  render()
  const radios = () => findAll(tree, (p) => p.type === 'radio')
  assert.deepEqual(radios().map((p) => p.checked), [true, false], 'scope defaults to this repository')
  const fields = () => findAll(tree, (p) => p.required)
  fields()[0].onChange({ target: { value: 'New Author' } }); render()
  fields()[1].onChange({ target: { value: 'new@example.test' } }); render()
  await find(tree, (p) => typeof p.onSubmit === 'function').onSubmit({ preventDefault() {} }); render()
  assert.deepEqual(writes[0], ['/repo', 'New Author', 'new@example.test', 'local'])
  assert.equal(saved[0].name, 'Environment Author')
  assert.match(find(tree, (p) => p.role === 'alert').children, /Configuration saved.*environment variable takes precedence/)
  assert.equal(closed, 0, 'an effective override must be explained before closing')
  radios()[1].onChange(); render()
  await find(tree, (p) => typeof p.onSubmit === 'function').onSubmit({ preventDefault() {} }); render()
  assert.equal(writes[1][3], 'global', 'only an explicit scope change writes global config')
  unmount()
}

if (process.env.CHECK_MODE === 'membership') {
  // Status gives one entry per side: a.ts is unstaged, b.ts staged, c.ts both. Each diff and action stays on its side.
  const side = (path, staged) => ({ path, staged, unstaged: !staged, conflicted: false, kind: 'modified' })
  const patch = (paths, label) => ({ files: paths.flatMap((path) => parseDiff('diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -1 +1 @@\n-old\n+' + label + ' ' + path + '\n')), moves: [] })
  const respond = async () => {
    for (const request of requests.filter((r) => !r.done)) {
      request.done = true
      request.resolve(patch(props.status.changes.filter((change) => request.args[1] ? change.staged : change.unstaged).map((change) => change.path), request.args[1] ? 'staged' : 'working'))
    }
    await flush()
  }
  const writes = []
  window.bettergit.stage = (_repo, paths) => { writes.push(['stage', paths]); return Promise.resolve() }
  window.bettergit.unstage = (_repo, paths) => { writes.push(['unstage', paths]); return Promise.resolve() }
  stored.clear(); requests.length = 0; errors = []; slots = []; mounted = true
  setContextLines(3); setIgnoreWhitespace(false)
  props = {
    repo: '/repo', revision: 1, status: { changes: [side('a.ts', false), side('b.ts', true), side('c.ts', true), side('c.ts', false)] },
    listOpen: true, detailOpen: true, onChanged() {}, onError: (error) => errors.push(String(error)),
  }
  render(); await respond()
  const lists = findAll(tree, (p) => typeof p.title === 'string' && Array.isArray(p.changes))
  assert.deepEqual(lists.map((list) => list.title), ['Changes', 'Staged'])
  assert.deepEqual(lists[0].changes.map((c) => [c.path, c.staged]), [['a.ts', false], ['c.ts', false]])
  assert.deepEqual(lists[1].changes.map((c) => c.path), ['b.ts', 'c.ts'])
  const text = (file) => file.hunks[0].lines.at(-1).text
  const changesView = find(tree, (p) => Array.isArray(p.files) && p.stage?.staged === false)
  assert.deepEqual(changesView.files.map(text), ['working a.ts', 'working c.ts'])
  assert.equal(changesView.stage.stagedPaths, undefined)
  lists[0].onToggleAll(); await flush()
  assert.deepEqual(writes, [['stage', ['a.ts', 'c.ts']]])
  // A staged row unstages and opens only the staged diff.
  lists[1].onToggle(lists[1].changes[0]); await flush()
  assert.deepEqual(writes.at(-1), ['unstage', ['b.ts']])
  lists[1].onSelect(lists[1].changes[0]); render(); await respond()
  // A picked file replaces both section diffs with its own, so it is the only diff on screen.
  const diffs = findAll(tree, (p) => Array.isArray(p.files) && p.stage)
  assert.equal(diffs.length, 1)
  const [selected] = diffs
  assert.equal(selected.stage.staged, true)
  assert.equal(selected.edit, undefined, 'staged files cannot edit the working tree')
  assert.equal(text(selected.files.find((file) => file.newPath === 'b.ts')), 'staged b.ts')
  // The selection follows its file when it leaves the staged section, then follows it back after staging.
  props = { ...props, status: { changes: [side('a.ts', false), side('b.ts', false), side('c.ts', true), side('c.ts', false)] } }
  render(); await respond()
  let moved = find(tree, (p) => Array.isArray(p.files) && p.stage)
  assert.equal(moved.stage.staged, false)
  assert.equal(text(moved.files.find((file) => file.newPath === 'b.ts')), 'working b.ts')
  props = { ...props, status: { changes: [side('a.ts', false), side('b.ts', true), side('c.ts', true), side('c.ts', false)] } }
  render(); await respond()
  moved = find(tree, (p) => Array.isArray(p.files) && p.stage)
  assert.equal(moved.stage.staged, true)
  assert.equal(text(moved.files.find((file) => file.newPath === 'b.ts')), 'staged b.ts')
  // Clearing the selection shows conflicts before both diff sections in the continuous all-files pane.
  window.bettergit.conflictLoad = () => new Promise(() => {})
  props = { ...props, status: { changes: [...props.status.changes, { path: 'd.ts', staged: false, unstaged: false, conflicted: true, kind: 'modified' }] } }
  find(tree, (p) => p.className?.startsWith('file-list')).onClick({ target: { closest: () => null } })
  render(); await respond()
  assert.deepEqual(findAll(tree, (p) => typeof p.title === 'string' && Array.isArray(p.changes)).map((p) => p.title), ['Conflicts', 'Changes', 'Staged'])
  const headings = findAll(tree, (p) => p.className === 'diff-section')
  assert.deepEqual(headings.map((p) => p.children[0].trim()), ['Conflicts', 'Changes', 'Staged'])
  assert.ok(find(tree, (p) => p['aria-label'] === 'Conflict in d.ts'))
  assert.deepEqual(errors, [])
  unmount()
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
test('Changes restores fresh stage and discard hunk actions after context reloads and per-file expansion', () => check('hunk-context'))
test('all Changes drops stale widen replies and errors across options, refreshes, targets and unmount', () => check('all'))
test('selected Changes drops stale widen replies and errors across options, refreshes, targets and unmount', () => check('selected'))
test('old Changes loads and widens cannot replace a newer load error', () => check('errors'))
test('a base reload invalidates old file widens before React renders the replacement', () => check('batched'))
test('status changes invalidate pending base loads and start current staged, working and selected loads', () => check('status-loads'))
test('a widen requested under the current revision remains valid after its base reload fails', () => check('retained'))
test('a commit that finishes after the tab remounts clears its own draft but keeps a newer one', () => check('commit-draft'))
test('the diff pane restores or reveals only for the view on screen, after its own diff loads', () => check('restore'))
test('a failed load with new whitespace options shows the failure in place of the old hunks and keeps the toolbar', () => check('whitespace-failure'))
test('a failed first load shows the failure with the toolbar, and a later load replaces it', () => check('initial-failure'))
test('while new options load, old hunks, counts and stats are hidden behind a loading toolbar, and only the current reply shows', () => check('option-pending'))
test('a scrolled diff keeps its place through an option reload, and a file picked meanwhile is not moved to it', () => check('option-scroll'))
test('a toggled-back option and a picked file reuse the loads of the current status', () => check('toggle-cache'))
test('collapsed Changes rails retain the draft, selection, diff container and loaded files through preview and expansion', () => check('rails'))
test('Changes contains only unstaged files and follows selections across staging', () => check('membership'))
test('confirmed conflict reset keeps choices on refusal, clears them on success, and drops replies for another target; Stage and taking a side reach their writes', () => check('conflict-reset'))

test('commit box shows the effective author and opens identity editing', () => check('identity'))

test('identity dialog defaults local, saves the selected scope, and explains effective overrides', () => check('identity-dialog'))
