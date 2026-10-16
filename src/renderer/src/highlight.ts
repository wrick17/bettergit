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

// Re-rendering must not re-tokenise the same code. Clearing the whole cache when full is simpler than LRU
// and costs little, since evicted entries are only re-tokenised once.
const CACHE_LIMIT = 400
const cache = new Map<string, Segment[][]>()

// Returns one list of coloured segments per input line. Falls back to plain text whenever colouring fails.
export async function highlightLines(lines: string[], language: string | null): Promise<Segment[][]> {
  const plain = lines.map((text) => [{ text }])
  const code = lines.join('\n')
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return plain
  const key = `${language}\n${code}`
  const cached = cache.get(key)
  if (cached) return cached
  try {
    const shiki = await getHighlighter()
    if (!shiki.getLoadedLanguages().includes(language)) {
      await shiki.loadLanguage(bundledLanguages[language as BundledLanguage]())
    }
    const tokens = shiki.codeToTokensWithThemes(code, {
      lang: language,
      themes: { light: 'github-light', dark: 'github-dark' },
    })
    const segments = tokens.map((line) => line.map((token) => ({
      text: token.content,
      light: token.variants.light?.color,
      dark: token.variants.dark?.color,
    })))
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, segments)
    return segments
  } catch {
    return plain
  }
}

// Colours every line of a file, grouped the same way as its hunks. Hunks are coloured as one block,
// so a token that spans two hunks may be coloured slightly differently than in the full file.
export async function highlightFile(file: DiffFile, overrides: Record<string, string>): Promise<Segment[][][]> {
  const flat = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  const segments = await highlightLines(flat, languageFor(file.newPath ?? file.oldPath ?? '', overrides))
  let cursor = 0
  return file.hunks.map((hunk) => hunk.lines.map(() => {
    const line = segments[cursor] ?? [{ text: flat[cursor] }]
    cursor++
    return line
  }))
}
