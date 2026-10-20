import { hunkId } from './diff'
import { gitRaw } from './exec'

// Stage, unstage or discard one hunk of one file. The renderer sends the hunk it showed; the patch applied is always cut
// from a fresh git diff, so renderer text never reaches the index or the working tree.
export type HunkAction = 'stage' | 'unstage' | 'discard'

export interface HunkRequest {
  path: string
  // The section the hunk was shown in: the staged diff (index against HEAD) or the unstaged one (worktree against index).
  staged: boolean
  // The -U level the file was shown at, which decides how git groups its changes into hunks.
  context: number
  header: string
  lines: { type: 'context' | 'add' | 'del' | 'note'; text: string }[]
  // The id main gave the hunk it showed. A byte that changed but decodes to the same text changes it.
  id: string
}

// The UI's "All" level, as in diff.ts.
const MAX_CONTEXT = 100000
const LINE_TYPES = new Set(['context', 'add', 'del', 'note'])

// Validates an IPC request. Anything else is refused before git runs.
export function parseHunk(action: unknown, request: unknown): [HunkAction, HunkRequest] {
  if (action !== 'stage' && action !== 'unstage' && action !== 'discard') throw new Error('Unknown hunk action.')
  const value = request as Partial<HunkRequest> | null
  if (typeof value !== 'object' || value === null) throw new Error('Invalid hunk request.')
  const { path, staged, context, header, lines, id } = value
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\0\n]/.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Invalid file path.')
  }
  if (typeof staged !== 'boolean') throw new Error('Invalid hunk section.')
  // Staging and discarding take hunks of the unstaged diff; unstaging takes hunks of the staged one.
  if (staged !== (action === 'unstage')) throw new Error(`A ${staged ? 'staged' : 'unstaged'} hunk cannot be ${action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'discarded'}.`)
  if (typeof context !== 'number' || !Number.isInteger(context) || context < 0 || context > MAX_CONTEXT) throw new Error('Invalid context level.')
  if (typeof header !== 'string' || !header.startsWith('@@ ') || header.includes('\n')) throw new Error('Invalid hunk header.')
  if (!Array.isArray(lines) || !lines.length) throw new Error('Invalid hunk lines.')
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid hunk id.')
  const clean = lines.map((line) => {
    if (typeof line !== 'object' || line === null || !LINE_TYPES.has(line.type) || typeof line.text !== 'string' || line.text.includes('\n')) {
      throw new Error('Invalid hunk lines.')
    }
    return { type: line.type, text: line.text }
  })
  return [action, { path, staged, context, header, lines: clean, id }]
}

interface RawLine { start: number; end: number; text: string }

// Lines of git's raw output, each with its byte range (newline included) and its text decoded the way the renderer's
// diff was, so a Latin-1 byte compares as the same replacement character.
function rawLines(output: Buffer): RawLine[] {
  const lines: RawLine[] = []
  let start = 0
  while (start < output.length) {
    const newline = output.indexOf(0x0a, start)
    const end = newline < 0 ? output.length : newline + 1
    lines.push({ start, end, text: output.toString('utf8', start, newline < 0 ? end : newline) })
    start = end
  }
  return lines
}

// The renderer's view of a hunk body line, as parseDiff builds it. Other lines are skipped there, so they are here.
function shownLine(text: string): HunkRequest['lines'][number] | null {
  const marker = text[0]
  if (marker === ' ') return { type: 'context', text: text.slice(1) }
  if (marker === '-') return { type: 'del', text: text.slice(1) }
  if (marker === '+') return { type: 'add', text: text.slice(1) }
  if (marker === '\\') return { type: 'note', text }
  return null
}

const KEPT_HEADERS = /^(diff --git |index |--- |\+\+\+ )/

export async function applyHunk(repo: string, action: HunkAction, request: HunkRequest): Promise<void> {
  const { path, staged, context } = request
  const pathspec = `:(literal)${path}`
  const unmerged = await gitRaw(repo, ['ls-files', '-u', '-z', '--', pathspec])
  if (unmerged.code !== 0) throw new Error(unmerged.stderr || 'Git could not read the index.')
  if (unmerged.stdout.length) throw new Error(`${path} has a merge conflict. Resolve it before changing its hunks.`)

  // Never -w: a hunk shown with whitespace hidden does not match this diff, so it is refused as stale.
  const diff = await gitRaw(repo, ['diff', ...(staged ? ['--cached'] : []), `-U${context}`, '--no-color', '--no-ext-diff', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '--', pathspec])
  if (diff.code !== 0) throw new Error(diff.stderr || 'Git could not read the diff.')
  const lines = rawLines(diff.stdout)

  const header: RawLine[] = []
  let first = -1
  for (let index = 0; index < lines.length; index++) {
    const { text } = lines[index]
    if (text.startsWith('@@ ')) {
      first = index
      break
    }
    if (text.startsWith('diff --git ') && header.length) throw new Error(`${path} matched more than one file.`)
    if (text.startsWith('old mode ') || text.startsWith('new mode ')) {
      if (text.endsWith(' 160000')) throw new Error(`${path} is a submodule. Hunks apply only to text files.`)
      // A mode change belongs to the file, not to any hunk, so it is left out of the patch.
      continue
    }
    if (!KEPT_HEADERS.test(text) || / 160000$/.test(text)) {
      throw new Error(`${path} is not a modified text file. Its hunks cannot be changed one at a time.`)
    }
    header.push(lines[index])
  }
  if (first < 0 || !header.some((line) => line.text.startsWith('diff --git '))) throw new Error(`${path} changed since it was shown. Try again on the refreshed diff.`)

  // Each hunk runs from its @@ line to the next one. Its shown lines must match the request exactly.
  let found: RawLine[] | null = null
  for (let start = first; start < lines.length && !found;) {
    let end = start + 1
    while (end < lines.length && !lines[end].text.startsWith('@@ ')) end++
    const hunk = lines.slice(start, end)
    const shown = hunk.slice(1).flatMap((line) => shownLine(line.text) ?? [])
    if (hunk[0].text === request.header && shown.length === request.lines.length
      && shown.every((line, index) => line.type === request.lines[index].type && line.text === request.lines[index].text)
      && hunkId(diff.stdout.subarray(hunk[0].start, hunk[hunk.length - 1].end)) === request.id) found = hunk
    start = end
  }
  if (!found) throw new Error(`${path} changed since it was shown. Try again on the refreshed diff.`)

  const patch = Buffer.concat([...header, ...found].map((line) => diff.stdout.subarray(line.start, line.end)))
  const flags = action === 'stage' ? ['--cached'] : action === 'unstage' ? ['--cached', '--reverse'] : ['--reverse']
  // nowarn keeps the bytes as they are; apply.whitespace=fix would change them, =error would refuse them.
  const applied = await gitRaw(repo, ['apply', ...flags, ...(context === 0 ? ['--unidiff-zero'] : []), '--whitespace=nowarn', '-'], patch)
  if (applied.code !== 0) throw new Error(applied.stderr || `Git could not ${action} the hunk.`)
}
