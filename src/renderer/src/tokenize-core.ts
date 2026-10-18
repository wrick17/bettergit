import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import type { Segment } from './highlight'

// Shiki tokenising, shared by the highlight worker and the in-page fallback used where workers cannot start.
let highlighter: Promise<HighlighterCore> | null = null

// The JavaScript regex engine avoids WebAssembly, which the page's content security policy does not allow.
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [bundledThemes['github-dark'](), bundledThemes['github-light']()],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  })
  return highlighter
}

// Lines tokenised between yields. Tokenising stops every few milliseconds, so the in-page fallback lets input and frames
// through and the worker reads cancellations: a whole large file takes the same total time either way. A slice
// that ran long (some grammar rules backtrack badly on some lines) makes the next slices shorter, down to one line, and
// one line stops colouring after LINE_MS, the rest of it plain, so no single task holds the window.
const SLICE_LINES = 40
const SLICE_MS = 6
const LINE_MS = 15
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))


// Null when the code is not coloured, or when `stale` turns true before it finishes (such as text typed since).
// One list of coloured segments per line, or null when colouring fails or `stale` turns true before it finishes.
export async function tokenizeCode(code: string, language: string, stale?: () => boolean): Promise<Segment[][] | null> {
  try {
    const shiki = await getHighlighter()
    if (!shiki.getLoadedLanguages().includes(language)) {
      await shiki.loadLanguage(bundledLanguages[language as BundledLanguage]())
    }
    const lines = code.split('\n')
    const out: Segment[][] = []
    let grammarState: ReturnType<typeof shiki.getLastGrammarState> | undefined
    let sliceStart = performance.now()
    let size = SLICE_LINES
    for (let index = 0; index < lines.length; index += size) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await nextTask()
        if (stale?.()) return null
        sliceStart = performance.now()
      }
      const started = performance.now()
      // The grammar state carries open strings and comments across slices, so colours match one whole-file pass.
      const tokens = shiki.codeToTokensWithThemes(lines.slice(index, index + size).join('\n'), {
        lang: language,
        themes: { light: 'github-light', dark: 'github-dark' },
        grammarState,
        tokenizeTimeLimit: LINE_MS,
      })
      const took = performance.now() - started
      size = took > SLICE_MS * 2 ? Math.max(1, size >> 2) : took < SLICE_MS / 2 ? Math.min(SLICE_LINES, size * 2) : size
      grammarState = shiki.getLastGrammarState(tokens)
      for (const line of tokens) out.push(line.map((token) => ({
        text: token.content,
        light: token.variants.light?.color,
        dark: token.variants.dark?.color,
      })))
    }
    return out
  } catch {
    return null
  }
}
