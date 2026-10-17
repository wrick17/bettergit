import { expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { FOLD_BELOW } from '../src/renderer/src/fold'

// Every fold stage must be reachable above the 900px minimum window width, and the stages must fold in order.
test('fold stops fold sidebar, then list, then details, all above the minimum window width', () => {
  expect(FOLD_BELOW.sidebar).toBeGreaterThan(FOLD_BELOW.list)
  expect(FOLD_BELOW.list).toBeGreaterThan(FOLD_BELOW.details)
  expect(FOLD_BELOW.details).toBeGreaterThanOrEqual(900)
})

// Runs the real hook in memory, like sidebar-keyboard.test.ts, at the moment the strip's keyboard activation opens the pane.
async function openFromStrip(query: (selector: string) => unknown) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/fold.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  const strip = { focus() {} }
  const pane = { querySelector: query, contains: () => true }
  const refs = [pane, strip, 0]
  const states = [false, true] // pointer, keyboard: the strip was just activated from the keyboard
  const released: boolean[] = []
  const react = {
    useEffect() {}, useLayoutEffect: (effect: () => void) => effect(), useSyncExternalStore: () => true,
    useRef: () => ({ current: refs.shift() }),
    useState: () => [states.shift(), (value: boolean) => released.push(value)],
  }
  const module = { exports: {} as { useFoldHold: (folded: boolean, target: string) => unknown } }
  runInNewContext(await compiled.outputs[0].text(), { module, exports: module.exports, require: () => react, window: {}, document: { activeElement: strip } })
  module.exports.useFoldHold(true, '[role="treeitem"][tabindex="0"]')
  return released
}

// An empty repo list, or one where every repo is hidden, has no tree row to focus. The header's Add button takes focus instead.
test('opening the sidebar from its strip with no tree row focuses a header control and keeps the pane open', async () => {
  let focused = false
  const add = { focus: () => { focused = true } }
  const released = await openFromStrip((selector) => (selector.includes('treeitem') ? null : add))
  expect(focused).toBe(true)
  expect(released).toEqual([])
})

test('a pane with nothing to focus releases the keyboard hold', async () => {
  expect(await openFromStrip(() => null)).toEqual([false])
})

// Runs the real divider hook in memory on a stub grid. getComputedStyle reports the first track as laid out on screen.
async function dragDivider(stored: number, shown: string, args: number[], dx: number | null) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/Splitter.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['react'] })
  const saved = new Map([['width', String(stored)]])
  const grid = { style: { gridTemplateColumns: '' }, dataset: {} }
  const react = { useState: (init: () => number) => [init(), () => {}], useRef: (current: unknown) => ({ current }) }
  const module = { exports: {} as { useResizable: (key: string, ...args: number[]) => { track?: string; handle: Record<string, (event?: unknown) => void> } } }
  runInNewContext(await compiled.outputs[0].text(), {
    module, exports: module.exports, require: () => react,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
    getComputedStyle: () => ({ gridTemplateColumns: shown }),
    requestAnimationFrame: (run: () => void) => { run(); return 0 },
    cancelAnimationFrame() {},
  })
  const { track, handle } = module.exports.useResizable('width', ...args)
  handle.onPointerDown({ clientX: 500, pointerId: 1, currentTarget: { parentElement: grid, setPointerCapture() {} } })
  if (dx !== null) handle.onPointerMove({ clientX: 500 + dx })
  handle.onPointerUp()
  return { track, painted: grid.style.gridTemplateColumns, saved: saved.get('width') }
}

// A saved width above the cap renders at the cap. Dragging starts there and keeps the cap, as History renders it.
test('capped History dividers drag from the rendered width and paint the same capped track', async () => {
  expect(await dragDivider(1100, '350px 8px 642px', [400, 280, 1100, 35], -1))
    .toEqual({ track: 'min(1100px, 35%)', painted: 'min(349px, 35%) 8px minmax(0, 1fr)', saved: '349' })
  expect(await dragDivider(640, '400px 8px 592px', [320, 240, 640, 40], -1))
    .toEqual({ track: 'min(640px, 40%)', painted: 'min(399px, 40%) 8px minmax(0, 1fr)', saved: '399' })
  // A click without a move keeps the saved width.
  expect(await dragDivider(1100, '350px 8px 642px', [400, 280, 1100, 35], null))
    .toEqual({ track: 'min(1100px, 35%)', painted: 'min(1100px, 35%) 8px minmax(0, 1fr)', saved: '1100' })
})

test('an uncapped divider still drags from its saved width', async () => {
  const { painted, saved } = await dragDivider(300, '999px 8px 400px', [264, 200, 420], -1)
  expect({ painted, saved }).toEqual({ painted: '299px 8px minmax(0, 1fr)', saved: '299' })
})
