import { promises as fs } from 'node:fs'
import path from 'node:path'
import { git } from './exec'

// "All" in the UI. Git reads it as more context than any file has, so the diff shows the whole file.
const MAX_CONTEXT = 100000
const MAX_UNTRACKED_BYTES = 512 * 1024

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'note'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  oldPath: string | null
  newPath: string | null
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  binary: boolean
  hunks: DiffHunk[]
}

export interface MovedBlock {
  from: LineRef[]
  to: LineRef[]
}

export interface LineRef {
  file: number
  hunk: number
  line: number
}

export const MIN_MOVED_LINES = 3

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [] }
      files.push(file)
      hunk = null
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(raw)
      if (match) {
        file.oldPath = match[1]
        file.newPath = match[2]
      }
      continue
    }
    // git prints a conflicted path as a combined diff, with two-column markers. Its lines belong to no regular file, so
    // the section is dropped here. Without this, its hunks would attach to the file printed before it.
    if (raw.startsWith('diff --cc ') || raw.startsWith('diff --combined ') || raw.startsWith('@@@')) {
      file = null
      hunk = null
      continue
    }
    if (!file) continue
    if (raw.startsWith('new file mode')) file.status = 'added'
    else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
    else if (raw.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = raw.slice('rename from '.length)
    } else if (raw.startsWith('rename to ')) {
      file.newPath = raw.slice('rename to '.length)
    } else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      file.binary = true
    } else if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      oldNo = match ? Number(match[1]) : 0
      newNo = match ? Number(match[2]) : 0
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
    } else if (hunk) {
      const marker = raw[0]
      const text = raw.slice(1)
      if (marker === ' ') {
        hunk.lines.push({ type: 'context', text, oldNo: oldNo++, newNo: newNo++ })
      } else if (marker === '-') {
        hunk.lines.push({ type: 'del', text, oldNo: oldNo++, newNo: null })
      } else if (marker === '+') {
        hunk.lines.push({ type: 'add', text, oldNo: null, newNo: newNo++ })
      } else if (marker === '\\') {
        hunk.lines.push({ type: 'note', text: raw, oldNo: null, newNo: null })
      }
    }
  }
  return files
}

interface Entry {
  key: string
  ref: LineRef
  run: number
}

// Finds blocks that were removed in one place and added in another within the same diff.
// Lines match on their trimmed text, so re-indentation still counts as a move. Blocks shorter
// than MIN_MOVED_LINES and blank-only blocks are ignored. This is a heuristic, not git's
// --color-moved algorithm: it does not match reordered lines inside a block.
export function detectMoves(files: DiffFile[]): MovedBlock[] {
  const dels: Entry[] = []
  const adds: Entry[] = []
  let run = 0
  files.forEach((file, fileIndex) => {
    file.hunks.forEach((hunk, hunkIndex) => {
      let previous: DiffLine['type'] | null = null
      hunk.lines.forEach((line, lineIndex) => {
        if (line.type !== 'add' && line.type !== 'del') {
          previous = line.type
          return
        }
        if (previous !== line.type) run++
        previous = line.type
        const entry: Entry = { key: line.text.trim(), ref: { file: fileIndex, hunk: hunkIndex, line: lineIndex }, run }
        if (line.type === 'del') dels.push(entry)
        else adds.push(entry)
      })
    })
  })

  const addsByKey = new Map<string, number[]>()
  adds.forEach((entry, index) => {
    if (!entry.key) return
    const list = addsByKey.get(entry.key) ?? []
    list.push(index)
    addsByKey.set(entry.key, list)
  })

  const usedAdds = new Set<number>()
  const moves: MovedBlock[] = []
  for (let d = 0; d < dels.length; d++) {
    const candidates = addsByKey.get(dels[d].key) ?? []
    let best: { add: number; length: number } | null = null
    for (const a of candidates) {
      if (usedAdds.has(a)) continue
      let length = 0
      while (d + length < dels.length && a + length < adds.length && dels[d + length].key === adds[a + length].key) {
        // A block must be contiguous on both sides; a context line or a switch between removed and added ends it.
        if (length > 0 && (dels[d + length].run !== dels[d + length - 1].run || adds[a + length].run !== adds[a + length - 1].run)) break
        length++
      }
      if (length > (best?.length ?? 0)) best = { add: a, length }
    }
    if (!best || best.length < MIN_MOVED_LINES) continue
    const slice = dels.slice(d, d + best.length)
    if (slice.every((entry) => !entry.key)) continue
    const toSlice = adds.slice(best.add, best.add + best.length)
    for (let i = 0; i < best.length; i++) usedAdds.add(best.add + i)
    moves.push({ from: slice.map((entry) => entry.ref), to: toSlice.map((entry) => entry.ref) })
    d += best.length - 1
  }
  return moves
}

function contextArg(context: number): string {
  return `-U${Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(context)))}`
}

// `ignoreWhitespace` is git's --ignore-all-space. A file with only whitespace edits drops out of the patch, and
// whitespace-only lines inside a hunk become context. It also hides a space removed inside a line ("a b" to "ab").
export async function commitDiff(repo: string, hash: string, context = 3, ignoreWhitespace = false): Promise<DiffFile[]> {
  const output = await git(repo, ['diff-tree', '-p', '--root', '-m', '--first-parent', '--find-renames', contextArg(context), ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', hash])
  return parseDiff(output)
}

// Callers pass resolved commit hashes, so refs never reach git as raw input.
export async function compare(repo: string, from: string, to: string, ignoreWhitespace = false): Promise<{ files: DiffFile[]; moves: MovedBlock[] }> {
  const files = parseDiff(await git(repo, ['diff', '--find-renames', '-U3', ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', from, to]))
  return { files, moves: detectMoves(files) }
}

// Unstaged changes include untracked files. git diff never shows them, so each one becomes a file of added lines.
// `path` limits the diff to one file, so the view can widen its context without refetching everything.
// Untracked files are whole-file additions, so `ignoreWhitespace` never hides them.
export async function workingDiff(repo: string, staged: boolean, context = 3, path?: string, ignoreWhitespace = false): Promise<DiffFile[]> {
  const args = ['diff', '--find-renames', contextArg(context), ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', '--no-ext-diff']
  if (staged) args.push('--cached')
  if (path) args.push('--', path)
  const files = parseDiff(await git(repo, args))
  return staged ? files : [...files, ...(await untrackedFiles(repo, path))]
}

async function untrackedFiles(repo: string, only?: string): Promise<DiffFile[]> {
  const names = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z', ...(only ? ['--', only] : [])])).split('\0').filter(Boolean)
  const files: DiffFile[] = []
  for (const name of names) {
    const content = await fs.readFile(path.join(repo, name)).catch(() => null)
    if (!content) continue
    if (content.length > MAX_UNTRACKED_BYTES || content.includes(0)) {
      files.push({ oldPath: null, newPath: name, status: 'added', binary: true, hunks: [] })
      continue
    }
    const lines = content.toString('utf8').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    files.push({
      oldPath: null,
      newPath: name,
      status: 'added',
      binary: false,
      hunks: [{
        header: `@@ -0,0 +1,${lines.length} @@`,
        lines: lines.map((text, index) => ({ type: 'add' as const, text, oldNo: null, newNo: index + 1 })),
      }],
    })
  }
  return files
}
