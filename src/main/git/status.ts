import { promises as fs } from 'node:fs'
import path from 'node:path'
import { git } from './exec'

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechanged' | 'unmerged' | 'untracked'

// A history operation stopped part way, as on a conflict. Named as the git subcommand that continues or aborts it.
export type RepoOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert'
export const REPO_OPERATIONS: readonly RepoOperation[] = ['rebase', 'merge', 'cherry-pick', 'revert']

export interface FileChange {
  path: string
  originalPath?: string
  kind: ChangeKind
  staged: boolean
  unstaged: boolean
  conflicted: boolean
}

export interface RepoStatus {
  head: string | null
  headHash: string | null
  upstream: string | null
  ahead: number
  behind: number
  detached: boolean
  changes: FileChange[]
  // Set by readStatus from the git dir, so a stopped rebase shows even with nothing left to change.
  operation?: RepoOperation | null
}

const KIND: Record<string, ChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechanged',
  U: 'unmerged',
}

export function parseStatus(output: string): RepoStatus {
  const status: RepoStatus = {
    head: null,
    headHash: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    changes: [],
  }
  const records = output.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length)
      status.headHash = oid === '(initial)' ? null : oid
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length)
      status.detached = head === '(detached)'
      status.head = status.detached ? null : head
    } else if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice('# branch.ab '.length).split(' ')
      status.ahead = Number(ahead.slice(1))
      status.behind = Math.abs(Number(behind))
    } else if (record.startsWith('1 ')) {
      status.changes.push(...entryChanges(afterSpaces(record, 8), record.split(' ')[1]))
    } else if (record.startsWith('2 ')) {
      const originalPath = records[++index]
      status.changes.push(...entryChanges(afterSpaces(record, 9), record.split(' ')[1], originalPath))
    } else if (record.startsWith('u ')) {
      status.changes.push({ path: afterSpaces(record, 10), kind: 'unmerged', staged: false, unstaged: true, conflicted: true })
    } else if (record.startsWith('? ')) {
      status.changes.push({ path: record.slice(2), kind: 'untracked', staged: false, unstaged: true, conflicted: false })
    }
  }
  return status
}

// Porcelain v2 fields are space-separated, but the path is last and may contain spaces.
function afterSpaces(record: string, count: number): string {
  let index = -1
  for (let i = 0; i < count; i++) index = record.indexOf(' ', index + 1)
  return record.slice(index + 1)
}

// XY: X is the index (staged) side, Y is the worktree (unstaged) side. '.' means unchanged.
function entryChanges(path: string, xy: string, originalPath?: string): FileChange[] {
  const [x, y] = xy
  const kindOf = (code: string) => KIND[code] ?? 'modified'
  const base = { path, originalPath, conflicted: false }
  const changes: FileChange[] = []
  if (x !== '.') changes.push({ ...base, kind: kindOf(x), staged: true, unstaged: false })
  if (y !== '.') changes.push({ ...base, kind: kindOf(y), staged: false, unstaged: true })
  return changes
}

export async function readStatus(repo: string): Promise<RepoStatus> {
  const [output, operation] = await Promise.all([
    git(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { optionalLocks: true }),
    readOperation(repo),
  ])
  return { ...parseStatus(output), operation }
}

// The state files git keeps per worktree while an operation is stopped. REBASE_HEAD outlives a finished rebase, so a
// rebase is read from its directory. rebase-apply with an applying file is git am, which BetterGit does not drive.
export async function readOperation(repo: string): Promise<RepoOperation | null> {
  const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'], { optionalLocks: true })).trim()
  const has = (name: string) => fs.access(path.join(gitDir, name)).then(() => true, () => false)
  if (await has('rebase-merge') || (await has('rebase-apply') && !await has('rebase-apply/applying'))) return 'rebase'
  if (await has('MERGE_HEAD')) return 'merge'
  if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (await has('REVERT_HEAD')) return 'revert'
  return null
}
