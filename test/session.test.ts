import { expect, test } from 'bun:test'

// session.ts reads localStorage and window when it loads, so the test stubs both before importing it.
const store = new Map<string, string>()
const pagehide: Array<() => void> = []

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  },
  window: {
    addEventListener: (type: string, listener: () => void) => { if (type === 'pagehide') pagehide.push(listener) },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  },
})

const session = await import('../src/renderer/src/session')

test('a place keeps what other views wrote and drops the fields cleared', () => {
  session.savePlace('/repo', { file: 'a.ts', staged: true, draft: 'wip' })
  session.savePlace('/repo', { query: 'fix', draft: undefined })
  expect(session.loadSession().places['/repo']).toEqual({ file: 'a.ts', staged: true, query: 'fix' })
})

test('the last scroll position is written when the window hides, and a view returns only for its key', () => {
  session.rememberScroll('/repo|history-list', 'list', 120)
  session.rememberScroll('/repo|history-list', 'list', 480)
  expect(session.loadSession().views).toEqual({})
  pagehide.forEach((listener) => listener())
  expect(session.loadSession().views).toEqual({ '/repo|history-list': { key: 'list', value: 480 } })
  expect(session.savedView('/repo|history-list', 'list', 0)).toBe(480)
  expect(session.savedView('/repo|history-list', 'other', 0)).toBe(0)
})

test('a file collapse map and a scroll position under separate ids both survive a reload', () => {
  session.saveView('/repo|history-files', 'sha1', { 'extension.js': false })
  session.rememberScroll('/repo|history-diff', 'sha1', 700)
  pagehide.forEach((listener) => listener())
  expect(session.savedView('/repo|history-files', 'sha1', {})).toEqual({ 'extension.js': false })
  expect(session.savedView('/repo|history-diff', 'sha1', 0)).toBe(700)
})

// The hook needs its own React stubs, so it runs in a child process like changes-async.test.ts.
const REMOUNT = String.raw`
const assert = require('node:assert/strict')
const react = require('react')
const stored = new Map([['bettergit.session', JSON.stringify({ views: { pane: { key: 'list', value: 100 } } })]])
const pagehide = []
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
  window: { addEventListener: (type, listener) => { if (type === 'pagehide') pagehide.push(listener) }, setTimeout: () => 1, clearTimeout() {} },
  requestAnimationFrame: (callback) => callback(),
})
let slots, cursor
react.useRef = (initial) => slots[cursor++] ??= { current: initial }
react.useEffect = (effect) => effect()
const { useScrollMemory, savedView } = await import('./src/renderer/src/session')
function mount() {
  slots = []; cursor = 0
  const element = { scrollTop: 0 }
  const onScroll = useScrollMemory({ current: element }, 'pane', 'list', true)
  return { element, scroll: () => onScroll({ currentTarget: element }) }
}
const first = mount()
assert.equal(first.element.scrollTop, 100)
first.element.scrollTop = 900
first.scroll()
// Shown again before the 250ms write: the new pane takes the buffered position, and its restore scroll keeps it.
const second = mount()
assert.equal(second.element.scrollTop, 900)
second.scroll()
pagehide.forEach((listener) => listener())
assert.equal(savedView('pane', 'list', 0), 900)
`

test('a pane shown again before the scroll write restores the latest position and keeps it', () => {
  const child = Bun.spawnSync([process.execPath, '-e', REMOUNT], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
})
