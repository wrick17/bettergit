import { git, gitOk } from './exec'

export interface Branch {
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
  hash: string
}

export interface Stash {
  ref: string
  message: string
}

export interface Worktree {
  path: string
  branch: string | null
  hash: string
  locked: boolean
}

export async function stagePaths(repo: string, paths: string[]): Promise<void> {
  if (paths.length) await git(repo, ['add', '--', ...paths])
}

export async function unstagePaths(repo: string, paths: string[], hasHead: boolean): Promise<void> {
  if (!paths.length) return
  // Before the first commit there is no HEAD to restore from, so unstaging removes entries from the index.
  if (hasHead) await git(repo, ['restore', '--staged', '--', ...paths])
  else await git(repo, ['rm', '--cached', '-q', '--', ...paths])
}

// Discards worktree changes for tracked files. Callers must confirm with the user first.
export async function discardPaths(repo: string, paths: string[]): Promise<void> {
  if (paths.length) await git(repo, ['restore', '--', ...paths])
}

export async function commit(repo: string, message: string, amend = false): Promise<void> {
  const args = ['commit', '--cleanup=strip', '-F', '-']
  if (amend) args.push('--amend')
  await git(repo, args, { input: message })
}

export async function readBranches(repo: string): Promise<Branch[]> {
  const format = '%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname)%1f%(refname)'
  const output = await git(repo, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'])
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream, hash, fullRef] = line.split('\x1f')
      return {
        name,
        remote: fullRef.startsWith('refs/remotes/'),
        current: head === '*',
        upstream: upstream || null,
        hash,
      }
    })
    .filter((branch) => !branch.name.endsWith('/HEAD'))
}

export async function switchBranch(repo: string, name: string): Promise<void> {
  await git(repo, ['switch', name])
}

export async function createBranch(repo: string, name: string, start?: string): Promise<void> {
  await git(repo, ['switch', '-c', name, ...(start ? [start] : [])])
}

export async function deleteBranch(repo: string, name: string, force = false): Promise<void> {
  await git(repo, ['branch', force ? '-D' : '-d', name])
}

export async function readStashes(repo: string): Promise<Stash[]> {
  const output = await git(repo, ['stash', 'list', '--format=%gd%x1f%s'])
  return output.split('\n').filter(Boolean).map((line) => {
    const [ref, message] = line.split('\x1f')
    return { ref, message }
  })
}

export async function stashPush(repo: string, message: string, includeUntracked: boolean): Promise<void> {
  const args = ['stash', 'push', '-m', message]
  if (includeUntracked) args.push('--include-untracked')
  await git(repo, args)
}

export async function stashAction(repo: string, action: 'pop' | 'apply' | 'drop', ref: string): Promise<void> {
  await git(repo, ['stash', action, ref])
}

export async function fetchAll(repo: string): Promise<void> {
  await git(repo, ['fetch', '--all', '--prune', '--no-tags'])
}

export async function pull(repo: string, mode: 'merge' | 'rebase' = 'merge'): Promise<void> {
  if (mode !== 'merge' && mode !== 'rebase') throw new Error(`Unknown pull mode: ${mode}`)
  await git(repo, ['pull', mode === 'rebase' ? '--rebase' : '--no-rebase'], { interactive: false })
}

export async function pullFrom(repo: string, remote: string, branch: string): Promise<void> {
  await assertRemote(repo, remote)
  await assertBranchName(repo, branch)
  await git(repo, ['pull', '--no-rebase', remote, branch], { interactive: false })
}

// Fetch URLs only: push URLs are rarely set, and listing each remote once keeps the picker simple.
export async function readRemotes(repo: string): Promise<{ name: string; url: string }[]> {
  const remotes = new Map<string, string>()
  for (const line of (await git(repo, ['remote', '-v'])).split('\n')) {
    const match = /^(\S+)\t(.+) \(fetch\)$/.exec(line)
    if (match && !remotes.has(match[1])) remotes.set(match[1], match[2])
  }
  return [...remotes].map(([name, url]) => ({ name, url }))
}

export async function push(repo: string, hasUpstream: boolean, branch: string): Promise<void> {
  const args = hasUpstream ? ['push'] : ['push', '--set-upstream', 'origin', branch]
  await git(repo, args)
}

export async function clone(url: string, destination: string): Promise<void> {
  // Runs from the parent folder so the clone lands at the chosen destination.
  const parent = destination.replace(/\/[^/]+\/?$/, '') || '/'
  await git(parent, ['clone', '--', url, destination])
}

export async function readWorktrees(repo: string): Promise<Worktree[]> {
  const output = await git(repo, ['worktree', 'list', '--porcelain'])
  const entries: Worktree[] = []
  let current: Partial<Worktree> | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.path) entries.push(current as Worktree)
      current = { path: line.slice('worktree '.length), branch: null, hash: '', locked: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) current.hash = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length)
    else if (line.startsWith('locked')) current.locked = true
  }
  if (current?.path) entries.push(current as Worktree)
  return entries
}

export async function addWorktree(repo: string, path: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'add', path, branch])
}

// Records the current HEAD under refs/bettergit/backup so a history rewrite can be undone.
export async function createBackupRef(repo: string, label: string): Promise<string> {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const ref = `refs/bettergit/backup/${stamp}-${label.replace(/[^a-zA-Z0-9-]/g, '-')}`
  await git(repo, ['update-ref', ref, head])
  return ref
}

export async function restoreBackup(repo: string, ref: string): Promise<void> {
  const hash = (await git(repo, ['rev-parse', ref])).trim()
  // --keep refuses to overwrite local changes, so an undo never discards work.
  await git(repo, ['reset', '--keep', hash])
}

// Returns the backup ref so the user can undo. Uncommitted edits are not backed up.
export async function resetToUpstream(repo: string): Promise<string> {
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')
  if (!upstream.trim()) throw new Error('This HEAD has no upstream branch to reset to.')
  const backup = await createBackupRef(repo, 'reset')
  await git(repo, ['reset', '--hard', '@{u}'])
  return backup
}

export async function cherryPick(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  const backup = await createBackupRef(repo, 'cherry-pick')
  await git(repo, ['cherry-pick', commit])
  return backup
}

export async function revertCommit(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  const backup = await createBackupRef(repo, 'revert')
  await git(repo, ['revert', '--no-edit', commit])
  return backup
}

export async function checkoutDetached(repo: string, hash: string): Promise<void> {
  await git(repo, ['switch', '--detach', await resolveCommit(repo, hash)])
}

export async function branchFromCommit(repo: string, name: string, hash: string): Promise<void> {
  await assertBranchName(repo, name)
  await git(repo, ['branch', name, await resolveCommit(repo, hash)])
}

export async function tagFromCommit(repo: string, name: string, hash: string): Promise<void> {
  if (!(await gitOk(repo, ['check-ref-format', `refs/tags/${name}`]))) throw new Error(`Invalid tag name: ${name}`)
  await git(repo, ['tag', name, await resolveCommit(repo, hash)])
}

// --only with no paths commits HEAD's tree, so staged changes stay staged for the next commit.
// expectedHash is the commit the dialog showed; amending a different HEAD would rewrite the wrong commit.
export async function amendMessage(repo: string, message: string, expectedHash: string): Promise<void> {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
  if (head !== expectedHash) throw new Error(`HEAD is now ${head.slice(0, 7)}, not ${expectedHash.slice(0, 7)}. Reopen Amend to edit the current commit.`)
  await git(repo, ['commit', '--amend', '--only', '-m', message])
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string> {
  const left = await resolveCommit(repo, a)
  const right = await resolveCommit(repo, b)
  const base = await git(repo, ['merge-base', left, right]).catch(() => '')
  if (!base.trim()) throw new Error('These commits have no common ancestor.')
  return base.trim()
}

// Hashes and refs both go through rev-parse, so git never receives malformed or option-like input.
export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (!ref || ref.startsWith('-')) throw new Error(`Invalid commit: ${ref}`)
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    throw new Error(`Unknown commit: ${ref}`)
  }
}

async function assertRemote(repo: string, remote: string): Promise<void> {
  if (!(await git(repo, ['remote'])).split('\n').includes(remote)) throw new Error(`Unknown remote: ${remote}`)
}

async function assertBranchName(repo: string, name: string): Promise<void> {
  if (!(await gitOk(repo, ['check-ref-format', '--branch', name]))) throw new Error(`Invalid branch name: ${name}`)
}

export async function blame(repo: string, path: string): Promise<{ hash: string; author: string; line: string }[]> {
  const output = await git(repo, ['blame', '--line-porcelain', '--', path], { optionalLocks: true })
  const rows: { hash: string; author: string; line: string }[] = []
  let hash = ''
  let author = ''
  for (const row of output.split('\n')) {
    if (/^[0-9a-f]{40} /.test(row)) hash = row.slice(0, 40)
    else if (row.startsWith('author ')) author = row.slice(7)
    else if (row.startsWith('\t')) rows.push({ hash, author, line: row.slice(1) })
  }
  return rows
}
