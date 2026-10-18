import { afterEach, expect, spyOn, test } from 'bun:test'
import { tokenizeCode } from '../src/renderer/src/tokenize-core'

afterEach(() => {
  ;(performance.now as unknown as { mockRestore?: () => void }).mockRestore?.()
})

test('every tokenised line has the text of its source line while slice sizes grow and shrink', async () => {
  const lines = Array.from({ length: 500 }, (_, index) => `const value${index} = "line ${index}" // ${index}`)
  // A fake clock that makes slices look slow, then fast, so the slice size keeps changing between slices.
  const steps = [1, 30, 0.1, 2, 15, 0.2, 0.5]
  let clock = 0
  let calls = 0
  spyOn(performance, 'now').mockImplementation(() => (clock += steps[calls++ % steps.length]))
  const out = await tokenizeCode(lines.join('\n'), 'typescript')
  expect(out?.map((segments) => segments.map((segment) => segment.text).join(''))).toEqual(lines)
})
