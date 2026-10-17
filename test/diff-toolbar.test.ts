import { expect, test } from 'bun:test'

// Renders the real DiffView, so a regression that returns early before the toolbar fails here.
// Runs in a child process: DiffView reads localStorage and window when it loads, and session.test.ts stubs them in this process.
// The server renderer has no store subscription, so the child reads each store's snapshot directly. The stores are synchronous.
const RENDER_CHECK = `
const stored = {
  'bettergit.ignoreWhitespace': process.env.IGNORE_WHITESPACE ?? 'false',
  'bettergit.formatMarkdown': process.env.FORMAT_MARKDOWN,
}
Object.assign(globalThis, {
  localStorage: { getItem: (key) => stored[key] ?? null, setItem: () => undefined },
  window: { addEventListener: () => undefined, setTimeout, clearTimeout },
})
const react = require('react')
react.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
const { createElement } = react
const { renderToStaticMarkup } = await import('react-dom/server')
const { DiffView } = await import('./src/renderer/src/DiffView')
const { EditorContext } = await import('./src/renderer/src/editor-launch')
// EDITOR_SOURCE renders one deleted file under an editor bridge for that view.
const source = process.env.EDITOR_SOURCE
const files = source ? [{ oldPath: 'gone.txt', newPath: null, status: 'deleted', binary: true, hunks: [] }] : []
const view = createElement(DiffView, { files, moves: [] })
const bridge = { editor: 'vscode', openFile: async () => undefined, onError: () => undefined, source }
console.log(JSON.stringify(renderToStaticMarkup(source ? createElement(EditorContext.Provider, { value: bridge }, view) : view)))
`

function renderEmpty(ignoreWhitespace: 'true' | 'false', formatMarkdown?: 'true' | 'false', editorSource?: 'working' | 'commit'): string {
  const child = Bun.spawnSync([process.execPath, '-e', RENDER_CHECK], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, IGNORE_WHITESPACE: ignoreWhitespace, FORMAT_MARKDOWN: formatMarkdown, EDITOR_SOURCE: editorSource },
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString().trim())
}

// A file deleted in a past commit may exist in the working copy now, so only the working view blocks the button.
// The main process still checks the file and reports a missing one through the bridge's onError.
test('Open in VS Code is blocked for a working-copy deletion but not for a deletion in history', () => {
  const openButton = (html: string) => html.match(/<button[^>]*aria-label="Open [^"]*gone\.txt in VS Code"[^>]*>/)?.[0] ?? ''
  const working = openButton(renderEmpty('false', undefined, 'working'))
  expect(working).toContain('aria-disabled="true"')
  expect(working).toContain('blocked')
  const commit = openButton(renderEmpty('false', undefined, 'commit'))
  expect(commit).toContain('aria-label="Open working copy of gone.txt in VS Code"')
  expect(commit).not.toContain('aria-disabled')
  expect(commit).not.toContain('blocked')
})
