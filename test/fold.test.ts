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

// An empty commit lists no files, so its details have no control. The header, marked tabindex="-1", takes focus instead.
test('opening commit details from the strip with no control focuses the header and keeps the pane open', async () => {
  let focused = false
  const header = { focus: () => { focused = true } }
  const released = await openFromStrip((selector) => (selector.includes('[tabindex="-1"]') ? header : null))
  expect(focused).toBe(true)
  expect(released).toEqual([])
})

test('a rail previews on hover, cancels a pending leave, and returns keyboard focus on Escape', async () => {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/fold.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  const slots: any[] = []
  let slot = 0
  const keep = (create: () => unknown) => {
    const at = slot++
    if (!(at in slots)) slots[at] = create()
    return at
  }
  const document = { activeElement: null as unknown }
  const target = { focus: () => { document.activeElement = target } }
  const strip = { focus: () => { document.activeElement = strip } }
  const pane = { querySelector: () => target, contains: (element: unknown) => element === target }
  const refs = [pane, strip, 0]
  const timers = new Map<number, () => void>()
  let nextTimer = 0
  const react = {
    useEffect() {}, useLayoutEffect: (effect: () => void) => effect(),
    useRef: () => slots[keep(() => ({ current: refs.shift() }))],
    useState: (initial: unknown) => {
      const at = keep(() => initial)
      return [slots[at], (value: unknown) => { slots[at] = value }]
    },
  }
  const module = { exports: {} as { useFoldHold: (...args: any[]) => any } }
  runInNewContext(await compiled.outputs[0].text(), {
    module, exports: module.exports, require: () => react, document,
    window: {
      setTimeout: (callback: () => void, delay: number) => { expect(delay).toBe(120); timers.set(++nextTimer, callback); return nextTimer },
      clearTimeout: (id: number) => timers.delete(id),
    },
  })
  const render = () => { slot = 0; return module.exports.useFoldHold(true, 'button') }
  expect(render().collapsed).toBe(true)
  render().paneHandlers.onPointerEnter()
  expect(render().collapsed).toBe(false)
  render().paneHandlers.onPointerLeave()
  expect(render().collapsed).toBe(false)
  render().paneHandlers.onPointerEnter()
  expect(timers.size).toBe(0)
  render().paneHandlers.onPointerLeave()
  for (const callback of timers.values()) callback()
  expect(render().collapsed).toBe(true)
  strip.focus()
  render().activate()
  expect(render().collapsed).toBe(false)
  expect(document.activeElement).toBe(target)
  render().paneHandlers.onKeyDown({ key: 'Escape', defaultPrevented: false, preventDefault() {} })
  expect(render().collapsed).toBe(true)
  expect(document.activeElement).toBe(strip)
})

// Runs the real divider hook in memory on a stub grid. getComputedStyle reports the tracks as laid out on screen;
// with no tracks it throws, so an uncapped divider shows it never measures. State survives between renders, as in React.
async function loadDivider(stored: number, shown: string | null, args: number[]) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/Splitter.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['react'] })
  const saved = new Map([['width', String(stored)]])
  const grid = { style: { gridTemplateColumns: '' }, dataset: {} }
  const slots: unknown[] = []
  let slot = 0
  const keep = (create: () => unknown) => {
    const at = slot++
    if (!(at in slots)) slots[at] = create()
    return at
  }
  const react = {
    useState: (init: unknown) => {
      const at = keep(() => (typeof init === 'function' ? init() : init))
      return [slots[at], (value: unknown) => { slots[at] = value }]
    },
    useRef: (current: unknown) => slots[keep(() => ({ current }))],
  }
  const module = { exports: {} as { useResizable: (key: string, ...args: number[]) => { track?: string; handle: Record<string, any> } } }
  runInNewContext(await compiled.outputs[0].text(), {
    module, exports: module.exports, require: () => react,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) },
    getComputedStyle: () => {
      if (shown === null) throw new Error('an uncapped divider measured the grid')
      return { gridTemplateColumns: shown }
    },
    requestAnimationFrame: (run: () => void) => { run(); return 0 },
    cancelAnimationFrame() {},
  })
  const render = () => {
    slot = 0
    return module.exports.useResizable('width', ...args)
  }
  return { render, grid, saved, target: { parentElement: grid, setPointerCapture() {} } }
}

async function dragDivider(stored: number, shown: string, args: number[], dx: number | null) {
  const { render, grid, saved, target } = await loadDivider(stored, shown, args)
  const { track, handle } = render()
  handle.onPointerDown({ clientX: 500, pointerId: 1, currentTarget: target })
  if (dx !== null) handle.onPointerMove({ clientX: 500 + dx })
  handle.onPointerUp()
  return { track, painted: grid.style.gridTemplateColumns, saved: saved.get('width') }
}

// Focuses the divider, presses keys, and reads the separator's [value, min, max] after each render.
async function pressDivider(stored: number, shown: string | null, args: number[], keys: string[]) {
  const { render, saved, target } = await loadDivider(stored, shown, args)
  const value = () => {
    const { handle } = render()
    return [handle['aria-valuenow'], handle['aria-valuemin'], handle['aria-valuemax']]
  }
  render().handle.onFocus?.({ currentTarget: target })
  const seen = [value()]
  for (const key of keys) {
    render().handle.onKeyDown({ key, shiftKey: false, currentTarget: target })
    seen.push(value())
  }
  return { seen, saved: saved.get('width') }
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
  // In a 600px grid the 35% cap, 210px, is below the 280px minimum, so a drag cannot move the track and keeps the saved width.
  expect(await dragDivider(400, '210px 8px 382px', [400, 280, 1100, 35], -30))
    .toEqual({ track: 'min(400px, 35%)', painted: 'min(400px, 35%) 8px minmax(0, 1fr)', saved: '400' })
})

test('an uncapped divider still drags from its saved width', async () => {
  const { painted, saved } = await dragDivider(300, '999px 8px 400px', [264, 200, 420], -1)
  expect({ painted, saved }).toEqual({ painted: '299px 8px minmax(0, 1fr)', saved: '299' })
})

// A saved 400px list in a 1000px grid shows at the 35% cap, 350px. Each step moves what is shown, and the value reports it.
test('a capped divider steps from its rendered width and reports the width on screen', async () => {
  expect(await pressDivider(400, '350px 8px 642px', [400, 280, 1100, 35], ['ArrowLeft', 'ArrowRight', 'ArrowRight']))
    .toEqual({ seen: [[350, 280, 350], [338, 280, 350], [350, 280, 350], [350, 280, 350]], saved: '350' })
})

// Below its minimum the cap pins the track. Steps cannot move it, so the saved width is kept for a wider window.
test('a divider capped below its minimum is pinned and keeps the saved width', async () => {
  expect(await pressDivider(400, '210px 8px 382px', [400, 280, 1100, 35], ['ArrowLeft', 'ArrowLeft']))
    .toEqual({ seen: [[210, 210, 210], [210, 210, 210], [210, 210, 210]], saved: '400' })
})

test('an uncapped divider still steps from its saved width without measuring', async () => {
  expect(await pressDivider(300, null, [264, 200, 420], ['ArrowLeft', 'ArrowRight', 'ArrowRight']))
    .toEqual({ seen: [[300, 200, 420], [288, 200, 420], [300, 200, 420], [312, 200, 420]], saved: '312' })
})
