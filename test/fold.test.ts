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
