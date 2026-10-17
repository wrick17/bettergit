import { expect, test } from 'bun:test'
import { FOLD_BELOW } from '../src/renderer/src/fold'

// Every fold stage must be reachable above the 900px minimum window width, and the stages must fold in order.
test('fold stops fold sidebar, then list, then details, all above the minimum window width', () => {
  expect(FOLD_BELOW.sidebar).toBeGreaterThan(FOLD_BELOW.list)
  expect(FOLD_BELOW.list).toBeGreaterThan(FOLD_BELOW.details)
  expect(FOLD_BELOW.details).toBeGreaterThanOrEqual(900)
})
