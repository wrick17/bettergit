import { tokenizeCode, type SyntaxThemes } from './tokenize-core'

// Tokenises code off the page's thread (see highlight.ts). Jobs run one at a time in arrival order; a cancelled job stops
// at its next slice, since tokenizeCode yields between slices and this worker reads its messages then.
const cancelled = new Set<number>()
let queue = Promise.resolve()
// Theme pairs by key, sent once each and kept (a session sees a handful). Jobs name theirs, so a job queued before a theme
// change is still coloured with the pair its cache key names.
const themes = new Map<string, SyntaxThemes>()

type Message = { id: number; code: string; language: string; theme: string } | { cancel: number } | { key: string; themes: SyntaxThemes }

self.onmessage = ({ data }: MessageEvent<Message>) => {
  if ('cancel' in data) {
    cancelled.add(data.cancel)
    return
  }
  if ('themes' in data) {
    themes.set(data.key, data.themes)
    return
  }
  const { id, code, language, theme } = data
  queue = queue.then(async () => {
    const lines = cancelled.has(id) ? null : await tokenizeCode(code, language, () => cancelled.has(id), themes.get(theme))
    cancelled.delete(id)
    self.postMessage({ id, lines })
  })
}
