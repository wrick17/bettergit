import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GitError, git, gitRaw } from './exec'
import { assertHash } from './history'

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
  // Working-tree hunks only: the hash of git's raw bytes for the hunk, which hunk actions send back. Shown text cannot
  // tell two invalid UTF-8 bytes apart, as both decode to U+FFFD; this can.
  id?: string
}

// The hash a hunk's raw bytes are matched by, from its @@ line up to the next hunk or file.
export function hunkId(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface DiffFile {
  oldPath: string | null
  newPath: string | null
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  binary: boolean
  hunks: DiffHunk[]
  // Set only on a file sent without its hunks, in the file list of a large diff (see listOnly).
  counts?: { adds: number; dels: number }
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

// Git's C-style quoting, which it uses for a path holding a quote, a backslash or a control byte even with
// core.quotepath=off. Escapes stand for bytes, so octal UTF-8 sequences decode to their characters. Unquoted text is as is.
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
export function unquotePath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const parts: Buffer[] = []
  for (const [match, escape] of text.slice(1, -1).matchAll(/\\([0-7]{3}|[\s\S])|[^\\]+/g)) {
    parts.push(escape === undefined ? Buffer.from(match) : Buffer.from([escape.length === 3 ? parseInt(escape, 8) : ESCAPES[escape] ?? escape.charCodeAt(0)]))
  }
  return Buffer.concat(parts).toString('utf8')
}

// The two paths of a `diff --git` line. Either side may be quoted; an unquoted path never holds a quote, so the first
// ` "b/` starts a quoted second side.
function headerPaths(rest: string): [string, string] | null {
  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0]
  const split = quoted ? quoted.length : rest.endsWith('"') ? rest.indexOf(' "b/') : -1
  if (split < 0) {
    const match = /^a\/(.*) b\/(.*)$/.exec(rest)
    return match ? [match[1], match[2]] : null
  }
  const from = unquotePath(rest.slice(0, split))
  const to = unquotePath(rest.slice(split + 1))
  return from.startsWith('a/') && to.startsWith('b/') ? [from.slice(2), to.slice(2)] : null
}

// Given the bytes `text` was decoded from, each hunk also gets its id. A newline byte is never part of an invalid UTF-8
// sequence, so the text and the bytes split into the same lines.
export function parseDiff(text: string, bytes?: Buffer): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let at = 0
  let hunkAt = 0
  const seal = (end: number) => { if (hunk && bytes) hunk.id = hunkId(bytes.subarray(hunkAt, end)) }
  for (const raw of text.split('\n')) {
    const start = at
    if (bytes) {
      const newline = bytes.indexOf(0x0a, at)
      at = newline < 0 ? bytes.length : newline + 1
    }
    if (raw.startsWith('diff --git ')) {
      seal(start)
      file = { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [] }
      files.push(file)
      hunk = null
      const paths = headerPaths(raw.slice('diff --git '.length))
      if (paths) [file.oldPath, file.newPath] = paths
      continue
    }
    // git prints a conflicted path as a combined diff, with two-column markers. Its lines belong to no regular file, so
    // the section is dropped here. Without this, its hunks would attach to the file printed before it.
    if (raw.startsWith('diff --cc ') || raw.startsWith('diff --combined ') || raw.startsWith('@@@')) {
      seal(start)
      file = null
      hunk = null
      continue
    }
    if (!file) continue
    if (raw.startsWith('new file mode')) file.status = 'added'
    else if (raw.startsWith('deleted file mode')) file.status = 'deleted'
    else if (raw.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquotePath(raw.slice('rename from '.length))
    } else if (raw.startsWith('rename to ')) {
      file.newPath = unquotePath(raw.slice('rename to '.length))
    } else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      file.binary = true
    } else if (raw.startsWith('@@')) {
      seal(start)
      hunkAt = start
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
  seal(at)
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

// Past this many files a diff is sent as its file list only, with each file's counts, and a view loads one file's hunks
// at a time. Mounting and colouring thousands of files at once hangs the window.
export const LARGE_DIFF_FILES = 300

export interface Patch {
  files: DiffFile[]
  moves: MovedBlock[]
  // Set when `files` came without hunks. Moves are not looked for.
  large?: true
}

// The patch the views get: whole, or for a large diff its file list only. Parsed whole either way, so status, renames,
// binary files and dropped whitespace-only files read exactly as in a whole patch.
export function listOnly(files: DiffFile[]): Patch {
  if (files.length <= LARGE_DIFF_FILES) return { files, moves: detectMoves(files) }
  return {
    files: files.map((file) => {
      const counts = { adds: 0, dels: 0 }
      for (const hunk of file.hunks) for (const line of hunk.lines) {
        if (line.type === 'add') counts.adds++
        else if (line.type === 'del') counts.dels++
      }
      return { ...file, hunks: [], counts }
    }),
    moves: [],
    large: true,
  }
}

// One file's paths, as a pathspec: both sides of a rename, so git still pairs them as one.
function pathspec(paths?: string[]): string[] {
  return paths?.length ? ['--', ...paths] : []
}

function contextArg(context: number): string {
  return `-U${Math.min(MAX_CONTEXT, Math.max(0, Math.trunc(context)))}`
}

// `ignoreWhitespace` is git's --ignore-all-space. A file with only whitespace edits drops out of the patch, and
// whitespace-only lines inside a hunk become context. It also hides a space removed inside a line ("a b" to "ab").
// `paths` limits the diff to those files, as names, never patterns.
export async function commitDiff(repo: string, hash: string, context = 3, ignoreWhitespace = false, paths?: string[]): Promise<DiffFile[]> {
  assertHash(hash)
  const output = await git(repo, ['--literal-pathspecs', 'diff-tree', '-p', '--root', '-m', '--first-parent', '--find-renames', contextArg(context), ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', hash, ...pathspec(paths)])
  return parseDiff(output)
}

// Callers pass resolved commit hashes, so refs never reach git as raw input. With `paths`, only those files, always whole.
export async function compare(repo: string, from: string, to: string, ignoreWhitespace = false, paths?: string[]): Promise<Patch> {
  const files = parseDiff(await git(repo, ['--literal-pathspecs', 'diff', '--find-renames', '-U3', ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', from, to, ...pathspec(paths)]))
  return paths ? { files, moves: detectMoves(files) } : listOnly(files)
}

// Unstaged changes include untracked files. git diff never shows them, so each one becomes a file of added lines.
// `path` limits the diff to one file, so the view can widen its context or show one file of a large diff without
// refetching everything. A renamed file passes both its paths, so git still pairs them.
// Untracked files are whole-file additions, so `ignoreWhitespace` never hides them.
export async function workingDiff(repo: string, staged: boolean, context = 3, path?: string | string[], ignoreWhitespace = false): Promise<DiffFile[]> {
  // A file's own path is a name, never a pattern, so widening [ab].txt cannot load a.txt in its place.
  const args = ['--literal-pathspecs', 'diff', '--find-renames', contextArg(context), ...(ignoreWhitespace ? ['--ignore-all-space'] : []), '--no-color', '--no-ext-diff']
  if (staged) args.push('--cached')
  const paths = path === undefined ? undefined : [path].flat().filter(Boolean)
  args.push(...pathspec(paths))
  const output = await gitRaw(repo, args)
  if (output.code !== 0) throw new GitError(output.stderr || `git diff failed with code ${output.code}`, args, output.code, output.stderr)
  const files = parseDiff(output.stdout.toString('utf8'), output.stdout)
  return staged ? files : [...files, ...(await untrackedFiles(repo, paths))]
}

// The files' changes as a patch `git apply` takes, binary parts included. Unstaged untracked files diff against an empty file.
// The raw bytes, whatever the user's diff config: no textconv or external diff, and Git's standard a/ and b/ prefixes.
const PATCH_FORMAT = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/']
export async function filePatch(repo: string, staged: boolean, paths: string[]): Promise<Buffer> {
  const args = ['--literal-pathspecs', 'diff', ...PATCH_FORMAT, '--find-renames', ...(staged ? ['--cached'] : []), ...pathspec(paths)]
  const output = await gitRaw(repo, args)
  if (output.code !== 0) throw new GitError(output.stderr || `git diff failed with code ${output.code}`, args, output.code, output.stderr)
  const parts = [output.stdout]
  if (!staged) {
    const untracked = (await git(repo, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', ...pathspec(paths)])).split('\0').filter(Boolean)
    for (const name of untracked) {
      const extra = ['diff', '--no-index', ...PATCH_FORMAT, '--', '/dev/null', name]
      // --no-index exits 1 when the files differ, which they always do here.
      const result = await gitRaw(repo, extra)
      if (result.code > 1) throw new GitError(result.stderr || `git diff failed with code ${result.code}`, extra, result.code, result.stderr)
      parts.push(result.stdout)
    }
  }
  return Buffer.concat(parts)
}

// One unmerged file against HEAD: the change staging it would record. Plain `git diff` prints a combined diff for it.
export async function headDiff(repo: string, relPath: string): Promise<DiffFile[]> {
  const args = ['--literal-pathspecs', 'diff', '-U3', '--no-color', '--no-ext-diff', 'HEAD', '--', relPath]
  const output = await gitRaw(repo, args)
  if (output.code !== 0) throw new GitError(output.stderr || `git diff failed with code ${output.code}`, args, output.code, output.stderr)
  return parseDiff(output.stdout.toString('utf8'), output.stdout)
}

async function untrackedFiles(repo: string, only?: string[]): Promise<DiffFile[]> {
  const names = (await git(repo, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', ...pathspec(only)])).split('\0').filter(Boolean)
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
