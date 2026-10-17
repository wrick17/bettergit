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
