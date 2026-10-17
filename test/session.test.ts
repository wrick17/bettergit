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
