import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import type { DiffFile } from '../../main/git/diff'

// One colour per theme. The diff's CSS picks the right one for the current appearance.
export interface Segment {
  text: string
  light?: string
  dark?: string
}

// Extension (without the dot) to Shiki language. Settings can override any of these.
const DEFAULT_LANGUAGES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', htm: 'html', xml: 'xml',
  swift: 'swift', rs: 'rust', go: 'go', py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', php: 'php', lua: 'lua',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', m: 'objective-c',
  sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
  vue: 'vue', svelte: 'svelte', graphql: 'graphql',
}

// Past this size, colouring costs more than it helps. Those diffs render as plain text.
const MAX_HIGHLIGHT_CHARS = 400_000

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

export function languageFor(filePath: string, overrides: Record<string, string>): string | null {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  const language = overrides[extension] ?? DEFAULT_LANGUAGES[extension]
  return language && language in bundledLanguages ? language : null
}

// Re-rendering or remounting must not re-tokenise the same code. Clearing the whole cache when full is simpler than LRU
// and costs little, since evicted entries are only re-tokenised once. The bound is in lines, since one entry can be a whole file.
const CACHE_LINES = 200_000
const cache = new Map<string, Segment[][]>()
let cachedLines = 0

// Returns one list of coloured segments per input line. Falls back to plain text whenever colouring fails.
export async function highlightLines(lines: string[], language: string | null, stale?: () => boolean): Promise<Segment[][]> {
  return (await tokenize(lines.join('\n'), language, stale)) ?? lines.map((text) => [{ text }])
}

// Lines tokenised between yields. Tokenising runs on the main thread, so it stops every few milliseconds to let input
// and frames through: a whole large file takes the same total time, but the window stays responsive meanwhile.
const SLICE_LINES = 40
const SLICE_MS = 6
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// Null when the code is not coloured, or when `stale` turns true before it finishes (such as text typed since).
export async function tokenize(code: string, language: string | null, stale?: () => boolean): Promise<Segment[][] | null> {
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return null
  const key = `${language}\n${code}`
  const cached = cache.get(key)
  if (cached) return cached
  try {
    const shiki = await getHighlighter()
    if (!shiki.getLoadedLanguages().includes(language)) {
      await shiki.loadLanguage(bundledLanguages[language as BundledLanguage]())
    }
    const lines = code.split('\n')
    const out: Segment[][] = []
    let grammarState: ReturnType<typeof shiki.getLastGrammarState> | undefined
    let sliceStart = performance.now()
    for (let index = 0; index < lines.length; index += SLICE_LINES) {
      if (performance.now() - sliceStart > SLICE_MS) {
        await nextTask()
        if (stale?.()) return null
        sliceStart = performance.now()
      }
      // The grammar state carries open strings and comments across slices, so colours match one whole-file pass.
      const tokens = shiki.codeToTokensWithThemes(lines.slice(index, index + SLICE_LINES).join('\n'), {
        lang: language,
        themes: { light: 'github-light', dark: 'github-dark' },
        grammarState,
      })
      grammarState = shiki.getLastGrammarState(tokens)
      for (const line of tokens) out.push(line.map((token) => ({
        text: token.content,
        light: token.variants.light?.color,
        dark: token.variants.dark?.color,
      })))
    }
    if (cachedLines + out.length > CACHE_LINES) {
      cache.clear()
      cachedLines = 0
    }
    cache.set(key, out)
    cachedLines += out.length
    return out
  } catch {
    return null
  }
}

// Colours every line of a file, grouped the same way as its hunks. Hunks are coloured as one block,
// so a token that spans two hunks may be coloured slightly differently than in the full file.
// A run cut short by `stale` returns plain text, which the caller drops.
export async function highlightFile(file: DiffFile, overrides: Record<string, string>, stale?: () => boolean): Promise<Segment[][][]> {
  const flat = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  const segments = await highlightLines(flat, languageFor(file.newPath ?? file.oldPath ?? '', overrides), stale)
  let cursor = 0
  return file.hunks.map((hunk) => hunk.lines.map(() => {
    const line = segments[cursor] ?? [{ text: flat[cursor] }]
    cursor++
    return line
  }))
}
