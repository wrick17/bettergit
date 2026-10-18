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
