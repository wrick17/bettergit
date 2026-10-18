import { tokenizeCode } from './tokenize-core'

// Tokenises code off the page's thread (see highlight.ts). Jobs run one at a time in arrival order; a cancelled job stops
// at its next slice, since tokenizeCode yields between slices and this worker reads its messages then.
const cancelled = new Set<number>()
let queue = Promise.resolve()

self.onmessage = ({ data }: MessageEvent<{ id: number; code: string; language: string } | { cancel: number }>) => {
  if ('cancel' in data) {
    cancelled.add(data.cancel)
    return
  }
  const { id, code, language } = data
  queue = queue.then(async () => {
    const lines = cancelled.has(id) ? null : await tokenizeCode(code, language, () => cancelled.has(id))
    cancelled.delete(id)
    self.postMessage({ id, lines })
  })
}
