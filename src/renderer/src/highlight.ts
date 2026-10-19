import { bundledLanguages } from 'shiki/langs'
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

// The colours of code already tokenised, without waiting, so a view built from cached code is coloured on its first frame.
export function cachedTokens(code: string, language: string | null): Segment[][] | undefined {
  return language ? cache.get(`${language}\n${code}`) : undefined
}

// Returns one list of coloured segments per input line. Falls back to plain text whenever colouring fails.
export async function highlightLines(lines: string[], language: string | null, stale?: () => boolean): Promise<Segment[][]> {
  return (await tokenize(lines.join('\n'), language, stale)) ?? lines.map((text) => [{ text }])
}

// Tokenising runs in a worker, so a slow grammar rule (some backtrack badly on some lines) never holds the window.
// Where a worker cannot start, it runs in the page, in slices (tokenize-core.ts). Requests for the same code share one run.
let worker: Worker | null | undefined
let nextJob = 0
// Undefined hands a job back for the page to run, when the worker fails.
const jobs = new Map<number, (lines: Segment[][] | null | undefined) => void>()
const running = new Map<string, Promise<Segment[][] | null>>()

function tokenizer(): Worker | null {
  if (worker !== undefined) return worker
  try {
    worker = new Worker(new URL('./highlight-worker.ts', import.meta.url), { type: 'module' })
    // Bun (the tests) keeps a process alive while a worker runs; browsers have no unref.
    ;(worker as Worker & { unref?: () => void }).unref?.()
    worker.onmessage = ({ data }: MessageEvent<{ id: number; lines: Segment[][] | null }>) => {
      jobs.get(data.id)?.(data.lines)
      jobs.delete(data.id)
    }
    // A worker that fails to load hands its waiting jobs back to the page.
    worker.onerror = () => {
      worker = null
      for (const finish of jobs.values()) finish(undefined)
      jobs.clear()
    }
  } catch {
    worker = null
  }
  return worker
}

function run(code: string, language: string, stale?: () => boolean): Promise<Segment[][] | null> {
  const thread = tokenizer()
  if (!thread) return import('./tokenize-core').then(({ tokenizeCode }) => tokenizeCode(code, language, stale))
  const id = ++nextJob
  return new Promise<Segment[][] | null | undefined>((resolve) => {
    jobs.set(id, resolve)
    thread.postMessage({ id, code, language })
    // A request nobody waits for any more is dropped from the worker's queue.
    const poll = setInterval(() => {
      if (!jobs.has(id)) return clearInterval(poll)
      if (stale?.()) {
        clearInterval(poll)
        thread.postMessage({ cancel: id })
      }
    }, 50)
  }).then((lines) => (lines === undefined ? run(code, language, stale) : lines))
}

// Null when the code is not coloured, or when `stale` turns true before it finishes (such as text typed since).
export async function tokenize(code: string, language: string | null, stale?: () => boolean): Promise<Segment[][] | null> {
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return null
  const key = `${language}\n${code}`
  const cached = cache.get(key)
  if (cached) return cached
  let pending = running.get(key)
  if (!pending) {
    pending = run(code, language, stale).finally(() => running.delete(key))
    running.set(key, pending)
  }
  const out = await pending
  if (!out) return null
  if (!cache.has(key)) {
    if (cachedLines + out.length > CACHE_LINES) {
      cache.clear()
      cachedLines = 0
    }
    cache.set(key, out)
    cachedLines += out.length
  }
  return out
}

// Colours every line of a file, grouped the same way as its hunks. Hunks are coloured as one block,
// so a token that spans two hunks may be coloured slightly differently than in the full file.
// A run cut short by `stale` returns plain text, which the caller drops.
export async function highlightFile(file: DiffFile, overrides: Record<string, string>, stale?: () => boolean): Promise<Segment[][][]> {
  const flat = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  return byHunk(file, flat, await highlightLines(flat, languageFor(file.newPath ?? file.oldPath ?? '', overrides), stale))
}

// Colours files ahead of showing them. Resolves when they are done or after `ms`, whichever comes first.
export function warmColours(files: DiffFile[], overrides: Record<string, string>, ms = 150): Promise<void> {
  const done = Promise.all(files.map((file) => highlightFile(file, overrides))).then(() => undefined, () => undefined)
  return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, ms))])
}

// highlightFile's result without waiting, when the same code was coloured before.
export function cachedFileTokens(file: DiffFile, overrides: Record<string, string>): Segment[][][] | undefined {
  const language = languageFor(file.newPath ?? file.oldPath ?? '', overrides)
  if (!language) return undefined
  const flat = file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
  const segments = cachedTokens(flat.join('\n'), language)
  return segments && byHunk(file, flat, segments)
}

function byHunk(file: DiffFile, flat: string[], segments: Segment[][]): Segment[][][] {
  let cursor = 0
  return file.hunks.map((hunk) => hunk.lines.map(() => {
    const line = segments[cursor] ?? [{ text: flat[cursor] }]
    cursor++
    return line
  }))
}
