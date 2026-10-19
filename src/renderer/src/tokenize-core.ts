import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import type { ColorTheme } from '../../shared/themes'
import type { Segment } from './highlight'

// The pair of themes to colour with. A missing side uses the built-in GitHub theme.
export interface SyntaxThemes {
  light?: ColorTheme
  dark?: ColorTheme
}

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

// A theme's name in Shiki, loading it the first time. A theme Shiki refuses falls back to the built-in one.
async function themeName(shiki: HighlighterCore, theme: ColorTheme | undefined, fallback: string): Promise<string> {
  if (!theme) return fallback
  if (shiki.getLoadedThemes().includes(theme.name)) return theme.name
  try {
    await shiki.loadTheme({ name: theme.name, type: theme.dark ? 'dark' : 'light', colors: theme.colors, tokenColors: theme.tokenColors })
    return theme.name
  } catch {
    return fallback
  }
}

// Null when the code is not coloured, or when `stale` turns true before it finishes (such as text typed since).
// One list of coloured segments per line, or null when colouring fails or `stale` turns true before it finishes.
export async function tokenizeCode(code: string, language: string, stale?: () => boolean, themes?: SyntaxThemes): Promise<Segment[][] | null> {
  try {
    const shiki = await getHighlighter()
    if (!shiki.getLoadedLanguages().includes(language)) {
      await shiki.loadLanguage(bundledLanguages[language as BundledLanguage]())
    }
    const light = await themeName(shiki, themes?.light, 'github-light')
    const dark = await themeName(shiki, themes?.dark, 'github-dark')
    const lines = code.split('\n')
    const out: Segment[][] = []
    let grammarState: ReturnType<typeof shiki.getLastGrammarState> | undefined
    let sliceStart = performance.now()
    let size = SLICE_LINES
    // Invariant: `out` holds exactly the first `out.length` lines, so each slice starts where the last one ended.
    while (out.length < lines.length) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await nextTask()
        if (stale?.()) return null
        sliceStart = performance.now()
      }
      const slice = lines.slice(out.length, out.length + size)
      const started = performance.now()
      // The grammar state carries open strings and comments across slices, so colours match one whole-file pass.
      const tokens = shiki.codeToTokensWithThemes(slice.join('\n'), {
        lang: language,
        themes: { light, dark },
        grammarState,
        tokenizeTimeLimit: LINE_MS,
      })
      const took = performance.now() - started
      size = took > SLICE_MS * 2 ? Math.max(1, size >> 2) : took < SLICE_MS / 2 ? Math.min(SLICE_LINES, size * 2) : size
      grammarState = shiki.getLastGrammarState(tokens)
      slice.forEach((source, at) => {
        const line = tokens[at] ?? []
        // Token text is what the diff shows, so a line whose tokens do not spell its source (Shiki drops a trailing \r) is shown plain.
        const spelled = line.map((token) => token.content).join('') === source.replace(/\r$/, '')
        out.push(spelled ? line.map((token) => ({
          text: token.content,
          light: token.variants.light?.color,
          dark: token.variants.dark?.color,
        })) : [{ text: source }])
      })
    }
    return out
  } catch {
    return null
  }
}
