import { expect, test } from 'bun:test'

// Renders the real DiffView, so a regression that returns early before the toolbar fails here.
// Runs in a child process: DiffView reads localStorage and window when it loads, and session.test.ts stubs them in this process.
// The server renderer has no store subscription, so the child reads each store's snapshot directly. The stores are synchronous.
const RENDER_CHECK = `
const stored = {
  'bettergit.ignoreWhitespace': process.env.IGNORE_WHITESPACE ?? 'false',
  'bettergit.formatMarkdown': process.env.FORMAT_MARKDOWN,
  'bettergit.contextLines': process.env.CONTEXT_LINES,
  'bettergit.contextLines.v2': process.env.CONTEXT_LINES_V2,
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
// MARKDOWN_FILE adds one binary Markdown file, so the formatting toggle shows.
const files = source ? [{ oldPath: 'gone.txt', newPath: null, status: 'deleted', binary: true, hunks: [] }]
  : process.env.MARKDOWN_FILE ? [{ oldPath: 'notes.md', newPath: 'notes.md', status: 'modified', binary: true, hunks: [] }] : []
// The staged section passes a stage control, as ChangesView does.
const stage = process.env.STAGED ? { staged: true, onToggle: () => undefined } : undefined
const view = createElement(DiffView, { files, moves: [], stage })
const bridge = { app: { name: 'VS Code', icon: null }, openFile: async () => undefined, onError: () => undefined, source }
console.log(JSON.stringify(renderToStaticMarkup(source ? createElement(EditorContext.Provider, { value: bridge }, view) : view)))
`

function renderEmpty(ignoreWhitespace: 'true' | 'false', formatMarkdown?: 'true' | 'false', editorSource?: 'working' | 'commit', staged?: boolean, markdownFile?: boolean): string {
  const child = Bun.spawnSync([process.execPath, '-e', RENDER_CHECK], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, IGNORE_WHITESPACE: ignoreWhitespace, FORMAT_MARKDOWN: formatMarkdown, EDITOR_SOURCE: editorSource, STAGED: staged ? '1' : '', MARKDOWN_FILE: markdownFile ? '1' : '' },
    stderr: 'pipe',
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString().trim())
}

// The opening tag of the whitespace button, so its attributes can be checked without matching the whole markup.
function whitespaceButton(html: string): string {
  return html.match(/<button[^>]*aria-label="Whitespace changes:[^"]*"[^>]*>/)?.[0] ?? ''
}

test('legacy All opens compactly, saved compact choices remain, and a new All preference restores', () => {
  const renderContext = (saved?: string, current?: string) => {
    const child = Bun.spawnSync([process.execPath, '-e', RENDER_CHECK], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, CONTEXT_LINES: saved, CONTEXT_LINES_V2: current },
      stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
    const html = JSON.parse(child.stdout.toString().trim()) as string
    return html.match(/<button[^>]*aria-label="([^"]*unchanged context[^"]*)"[^>]*aria-pressed="true"[^>]*>/)?.[1]
  }
  expect(renderContext('100000')).toBe('3 lines of unchanged context around each change: on')
  for (const saved of [undefined, 'invalid', '3', '10', '25']) {
    expect(renderContext(saved)).toBe(`${saved === '10' || saved === '25' ? saved : '3'} lines of unchanged context around each change: on`)
  }
  expect(renderContext('100000', '100000')).toBe('All lines of unchanged context around each change: on')
  const chosen = Bun.spawnSync([process.execPath, '-e', `
    const stored = { 'bettergit.contextLines': '100000' }
    globalThis.localStorage = { getItem: key => stored[key] ?? null, setItem: (key, value) => stored[key] = value }
    require('react').useSyncExternalStore = (_subscribe, snapshot) => snapshot()
    const prefs = await import('./src/renderer/src/prefs?initial')
    prefs.setContextLines(100000)
    const reloaded = await import('./src/renderer/src/prefs?reload')
    console.log(JSON.stringify({ persisted: stored['bettergit.contextLines.v2'], restored: reloaded.useContextLines() }))
  `], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(chosen.exitCode, chosen.stderr.toString()).toBe(0)
  expect(JSON.parse(chosen.stdout.toString())).toEqual({ persisted: '100000', restored: 100000 })
})

test('an empty filtered diff keeps the Hide whitespace button pressed and actionable', () => {
  const html = renderEmpty('true')
  expect(html).toContain('Whitespace changes are hidden')
  const button = whitespaceButton(html)
  expect(button).toContain('aria-pressed="true"')
  expect(button).toContain('aria-label="Whitespace changes: hidden — click to show them"')
  expect(button).not.toContain('disabled')
})

test('an empty diff with the option off shows the plain message and an unpressed button', () => {
  const html = renderEmpty('false')
  expect(html).toContain('No changes in this view.')
  expect(whitespaceButton(html)).toContain('aria-pressed="false"')
  expect(whitespaceButton(html)).toContain('aria-label="Whitespace changes: shown — click to hide them"')
})

test('Format Markdown shows only with a Markdown file, says its state, and sits left of the fixed layout and whitespace controls', () => {
  expect(renderEmpty('true', 'true')).not.toContain('Formatted Markdown')
  for (const saved of [undefined, 'true', 'false'] as const) {
    const html = renderEmpty('true', saved, undefined, false, true)
    const button = html.match(/<button[^>]*aria-label="Formatted Markdown:[^"]*"[^>]*>/)?.[0] ?? ''
    expect(button).toContain(`aria-pressed="${saved === 'true'}"`)
    expect(button).toContain(saved === 'true' ? 'Formatted Markdown: on — click to show the raw source' : 'Formatted Markdown: off — click to format Markdown')
    expect(button).not.toContain('disabled')
    const content = html.match(/<button[^>]*aria-label="Formatted Markdown:[^"]*"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
    expect(content).toContain('<svg')
    expect(content.replace(/<[^>]*>/g, '')).toBe('')
    const toolbar = html.slice(0, html.indexOf('<section'))
    const buttons = [...toolbar.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1].split(':')[0])
    expect(buttons.slice(-5)).toEqual(['Formatted Markdown', 'Unified layout', 'Split layout', 'Word wrap', 'Whitespace changes'])
  }
})

// A deleted status does not say whether the working file exists now: a past commit's deletion or a staged deletion
// may have been recreated. The button stays available, and the main process checks the file and reports a missing one
// through the bridge's onError.
test('Open in VS Code stays available for deletions in history and in the working view', () => {
  const openButton = (html: string) => html.match(/<button[^>]*aria-label="Open [^"]*gone\.txt in VS Code"[^>]*>/)?.[0] ?? ''
  for (const staged of [false, true]) {
    const working = openButton(renderEmpty('false', undefined, 'working', staged))
    expect(working).toContain('aria-label="Open gone.txt in VS Code"')
    expect(working).not.toContain('aria-disabled')
    expect(working).not.toContain('blocked')
  }
  const commit = openButton(renderEmpty('false', undefined, 'commit'))
  expect(commit).toContain('aria-label="Open working copy of gone.txt in VS Code"')
  expect(commit).not.toContain('aria-disabled')
  expect(commit).not.toContain('blocked')
})

// Exercise DiffView's real observer and render decisions without a browser or Git reads.
const RESPONSIVE_CHECK = `
const react = require('react')
const stored = { 'bettergit.diffLayout': 'split' }
const writes = [], observers = [], effects = [], hooks = []
let cursor = 0, width = 1000, widthUpdates = 0
Object.assign(globalThis, {
  localStorage: { getItem: key => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; writes.push([key, value]) } },
  window: { innerWidth: 2000, addEventListener() {}, setTimeout, clearTimeout },
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
  },
})
const slot = initial => { const at = cursor++; return hooks[at] ?? (hooks[at] = initial()) }
const same = (left, right) => left && left.length === right.length && right.every((value, index) => Object.is(value, left[index]))
react.useRef = value => slot(() => ({ current: value }))
react.useState = initial => {
  const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
  return [state.value, next => { if (typeof next === 'boolean') widthUpdates++; state.value = typeof next === 'function' ? next(state.value) : next }]
}
react.useMemo = (compute, deps) => {
  const state = slot(() => ({}))
  if (!same(state.deps, deps)) { state.value = compute(); state.deps = deps }
  return state.value
}
react.useLayoutEffect = (effect, deps) => {
  const state = slot(() => ({}))
  if (!same(state.deps, deps)) effects.push(() => { state.cleanup?.(); state.cleanup = effect(); state.deps = deps })
}
react.useEffect = () => undefined
react.useCallback = callback => callback
react.useDeferredValue = value => value
react.useId = () => 'responsive-diff'
react.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
const { DiffView, LayoutToggles } = await import('./src/renderer/src/DiffView')
const { renderToStaticMarkup } = await import('react-dom/server')
const container = { closest: () => null, getBoundingClientRect: () => ({ width }) }
const file = { oldPath: 'readme.txt', newPath: 'readme.txt', status: 'modified', binary: false, hunks: [] }
const props = { files: [file], moves: [] }
const find = (node, match) => {
  if (!node || typeof node !== 'object') return
  if (match(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, match); if (found) return found }
}
let tree
const render = () => {
  cursor = 0; tree = DiffView.type(props); tree.props.ref.current = container
  for (const effect of effects.splice(0)) effect()
  return find(tree, node => node.props?.file === file).props
}
const resize = next => {
  width = next
  observers[0].callback([{ target: container, contentRect: { width, height: 500 } }])
  return render()
}
const snapshot = section => {
  const toggles = find(tree, node => node.type === LayoutToggles)
  const html = renderToStaticMarkup(react.createElement(LayoutToggles, toggles.props))
  return { mode: section.layout, saved: stored['bettergit.diffLayout'], html,
    notice: JSON.stringify(tree).includes('Unified for narrow pane') }
}
const initial = render()
const wide = snapshot(initial)
const narrowSection = resize(899)
const narrow = snapshot(narrowSection)
resize(700); resize(700)
const restoredSection = resize(900)
const restored = snapshot(restoredSection)
// A click on Unified during the fallback makes it an explicit preference, even after widening.
resize(899)
find(LayoutToggles({ autoUnified: true }), node => node.props?.icon === 'rows').props.onClick()
const explicit = snapshot(resize(1000))
console.log(JSON.stringify({ wide, narrow, restored, explicit, widthUpdates,
  stableData: initial.labels === narrowSection.labels && initial.anchors === restoredSection.anchors && initial.stat === narrowSection.stat,
  observerCount: observers.length, observedContainer: observers[0].target === container, writes }))
for (const state of hooks) state.cleanup?.()
`

test('split falls back at the diff container width, restores at 900px, and keeps the selected preference', () => {
  const child = Bun.spawnSync([process.execPath, '-e', RESPONSIVE_CHECK], { cwd: `${import.meta.dir}/..`, stderr: 'pipe' })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const result = JSON.parse(child.stdout.toString())
  expect([result.wide.mode, result.narrow.mode, result.restored.mode, result.explicit.mode]).toEqual(['split', 'unified', 'split', 'unified'])
  expect([result.wide.saved, result.narrow.saved, result.restored.saved, result.explicit.saved]).toEqual(['split', 'split', 'split', 'unified'])
  expect(result.narrow.notice).toBe(true)
  expect(result.restored.notice).toBe(false)
  expect(result.narrow.html).toMatch(/aria-label="Split layout: selected; unified while this pane is narrow"[^>]*aria-pressed="true"/)
  expect(result.narrow.html).toMatch(/aria-label="Unified layout: automatic for this narrow pane[^"]*"[^>]*aria-pressed="false"/)
  expect(result.explicit.html).toMatch(/aria-label="Unified layout: on"[^>]*aria-pressed="true"/)
  expect(result.writes).toEqual([['bettergit.diffLayout', 'unified']])
  expect(result.widthUpdates).toBe(4)
  expect(result.stableData).toBe(true)
  expect(result.observerCount).toBe(1)
  expect(result.observedContainer).toBe(true)
})
