import { expect, test } from 'bun:test'

// Renders the real DiffView as rows virtualise in the app: with an IntersectionObserver present, chunks start as
// placeholders, so the rows below the first screen are not in the markup. Find searches the diff data, so a line in a
// placeholder chunk is still found, and the placeholder names the lines it stands for, which is what reveal scrolls to.
// Runs in a child process, like diff-toolbar.test.ts, so its renderer globals stay out of other suites.
const CHECK = `
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout, innerHeight: 900 },
  IntersectionObserver: class {},
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
const { createElement } = react
const { renderToStaticMarkup } = await import('react-dom/server')
const { DiffView } = await import('./src/renderer/src/DiffView')
const { findMatches } = await import('./src/renderer/src/find')
const lines = Array.from({ length: 3000 }, (_, index) => ({ type: 'context', text: index === 2400 ? 'const needle = 1 // Needle here' : 'line ' + index, oldNo: index + 1, newNo: index + 1 }))
const files = [{ oldPath: 'big.txt', newPath: 'big.txt', status: 'modified', binary: false, hunks: [{ header: '@@ -1,3000 +1,3000 @@', lines }] }]
const html = renderToStaticMarkup(createElement(DiffView, { files, moves: [] }))
console.log(JSON.stringify({ html, matches: findMatches(files, 'NEEDLE') }))
`

test('find matches rows that are not mounted, and the placeholder holding them is addressable', () => {
  const child = Bun.spawnSync([process.execPath, '-e', CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const { html, matches } = JSON.parse(child.stdout.toString()) as { html: string; matches: unknown[] }
  // The row is not rendered: only placeholders were.
  expect(html).not.toContain('needle')
  expect(html).not.toContain('data-source-row="0:0:2400"')
  // Two matches on one line, case-insensitive, with offsets in the line's text.
  expect(matches).toEqual([
    { file: 0, hunk: 0, line: 2400, start: 6, end: 12 },
    { file: 0, hunk: 0, line: 2400, start: 20, end: 26 },
  ])
  // Reveal scrolls to the placeholder whose range holds the line, so its rows mount.
  expect(html).toContain('data-lines="0:0:2400:2449"')
})

// A collapsed file shows only its header, with no row standing in for its hunks. Find reads the header's toggle to open it.
const COLLAPSED = `
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout, innerHeight: 900 },
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
const { renderToStaticMarkup } = await import('react-dom/server')
const { DiffView } = await import('./src/renderer/src/DiffView')
const { revealMatch } = await import('./src/renderer/src/find')
const files = [{ oldPath: 'package-lock.json', newPath: 'package-lock.json', status: 'modified', binary: false,
  hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'del', text: 'old needle', oldNo: 1 }, { type: 'add', text: 'new needle', newNo: 1 }] }] }]
const html = renderToStaticMarkup(react.createElement(DiffView, { files, moves: [] }))
const collapsed = /<header><button class="diff-file-toggle" aria-expanded="false"/.test(html)
const opened = []
const section = { closest: () => null, scrollIntoView: () => undefined, querySelector: (selector) => (selector === ':scope > header > .diff-file-toggle[aria-expanded="false"]' && collapsed ? {} : null), querySelectorAll: () => [] }
const container = { querySelector: (selector) => (selector === '[data-file-index="0"]' ? section : null), querySelectorAll: () => [], closest: () => null }
await revealMatch({ container: { current: container }, files, openFile: (path) => opened.push(path) }, { file: 0, hunk: 0, line: 1, start: 4, end: 10 })
console.log(JSON.stringify({ html, collapsed, opened }))
`

test('a collapsed file shows only its header, and find opens it to reveal a match', () => {
  const child = Bun.spawnSync([process.execPath, '-e', COLLAPSED], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const { html, collapsed, opened } = JSON.parse(child.stdout.toString()) as { html: string; collapsed: boolean; opened: string[] }
  expect(collapsed).toBe(true)
  expect(html).not.toContain('changed line')
  expect(html).not.toContain('Show diff')
  expect(html).not.toContain('needle')
  expect(opened).toEqual(['package-lock.json'])
})
