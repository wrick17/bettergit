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
console.log(JSON.stringify(renderToStaticMarkup(createElement(DiffView, { files: [], moves: [] }))))
`

function renderEmpty(ignoreWhitespace: 'true' | 'false', formatMarkdown?: 'true' | 'false'): string {
  const child = Bun.spawnSync([process.execPath, '-e', RENDER_CHECK], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, IGNORE_WHITESPACE: ignoreWhitespace, FORMAT_MARKDOWN: formatMarkdown },
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString().trim())
}

// The opening tag of the Hide whitespace button, so its attributes can be checked without matching the whole markup.
function whitespaceButton(html: string): string {
  return html.match(/<button[^>]*aria-label="Hide whitespace"[^>]*>/)?.[0] ?? ''
}

test('an empty filtered diff keeps the Hide whitespace button pressed and actionable', () => {
  const html = renderEmpty('true')
  expect(html).toContain('Whitespace changes are hidden')
  const button = whitespaceButton(html)
  expect(button).toContain('aria-pressed="true"')
  expect(button).not.toContain('disabled')
})

test('an empty diff with the option off shows the plain message and an unpressed button', () => {
  const html = renderEmpty('false')
  expect(html).toContain('No changes in this view.')
  expect(whitespaceButton(html)).toContain('aria-pressed="false"')
})

test('Format Markdown defaults to raw and restores its pressed state before the final whitespace control', () => {
  for (const saved of [undefined, 'true', 'false'] as const) {
    const html = renderEmpty('true', saved)
    const button = html.match(/<button[^>]*aria-label="Format Markdown"[^>]*>/)?.[0] ?? ''
    expect(button).toContain(`aria-pressed="${saved === 'true'}"`)
    expect(button).not.toContain('disabled')
    expect(button).toContain('visible Markdown hunk fragments')
    const content = html.match(/<button[^>]*aria-label="Format Markdown"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
    expect(content).toContain('<svg')
    expect(content.replace(/<[^>]*>/g, '')).toBe('')
    const buttons = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1])
    expect(buttons.slice(-2)).toEqual(['Format Markdown', 'Hide whitespace'])
  }
})
