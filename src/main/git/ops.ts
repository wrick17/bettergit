import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { conflictBlocks, parseConflicts } from '../../shared/conflict'
import { assertSupportedConflictFormat } from './conflict'
import { canonicalRepoPath } from '../repo-lock'
import { GitError, git, gitOk, gitRaw } from './exec'
import { readStatus } from './status'

export interface Branch {
  name: string
  fullRef: string
  upstreamRef: string | null
  remote: boolean
  current: boolean
  upstream: string | null
  hash: string
}

// Only identities returned by readBranches, or a displayed HEAD snapshot for creation, cross IPC.
export interface BranchSelection {
  fullRef: string
  hash: string
}

// A tag's hash is the commit it peels to, so checking it out never depends on the tag moving later.
export interface Tag {
  name: string
  fullRef: string
  hash: string
}

export interface Stash {
  ref: string
  message: string
}

// Paths are canonical, so a repo opened through a symlink still finds its own worktree (`current`).
export interface Worktree {
  path: string
  branch: string | null
  hash: string
  locked: boolean
  current: boolean
}

// Staging a file that still holds conflict markers would commit the markers. Only unmerged paths are checked, so text
// that looks like a marker in a resolved or ordinary file is staged as written.
export async function stagePaths(repo: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  for (const file of await unmergedPaths(repo, paths)) {
    await assertSupportedConflictFormat(repo, file)
    if (await hasUnresolvedMarkers(repo, file)) {
      throw new Error(`${file} still has conflict markers. Resolve the conflict before staging it.`)
    }
  }
  await git(repo, ['add', '--', ...paths])
}

// The unmerged paths that git add would touch for these pathspecs. Git applies the same pathspec rules to both.
async function unmergedPaths(repo: string, paths: string[]): Promise<string[]> {
  const listed = await gitRaw(repo, ['ls-files', '-u', '-z', '--', ...paths])
  if (listed.code !== 0) throw new Error(listed.stderr || 'Git could not list the conflicts.')
  const files = listed.stdout.toString('utf8').split('\0').flatMap((record) => {
    const tab = record.indexOf('\t')
    return tab < 0 ? [] : [record.slice(tab + 1)]
  })
  return [...new Set(files)]
}

// The conflict loader's limit. Staging reads a file only this far, so a huge file is never buffered whole.
const MAX_MARKER_SCAN = 2 * 1024 * 1024

// A file counts as unresolved when its text parses into conflict blocks, or holds a marker that cannot be parsed.
// Binary files, found by a NUL byte in the part read, are not checked here, and the resolver reports them as
// unsupported. Text past the limit is refused, never taken as resolved.
async function hasUnresolvedMarkers(repo: string, file: string): Promise<boolean> {
  const full = path.join(repo, file)
  const info = await fs.lstat(full).catch(() => null)
  if (!info?.isFile()) return false
  const chunks: Buffer[] = []
  let size = 0
  // end is inclusive, so the read stops one byte past the limit, even for a file that grew after lstat.
  for await (const chunk of createReadStream(full, { end: MAX_MARKER_SCAN })) {
    if (chunk.includes(0)) return false
    chunks.push(chunk)
    size += chunk.length
  }
  if (size > MAX_MARKER_SCAN) throw new Error(`${file} is too large to check for conflict markers. Stage it outside BetterGit.`)
  const parsed = parseConflicts(new TextDecoder('utf-8').decode(Buffer.concat(chunks)))
  return parsed.ok ? conflictBlocks(parsed.parts).length > 0 : true
}

export async function unstagePaths(repo: string, paths: string[], hasHead: boolean): Promise<void> {
  if (!paths.length) return
  // Before the first commit there is no HEAD to restore from, so unstaging removes entries from the index.
  if (!hasHead) {
    await git(repo, ['rm', '--cached', '-q', '--', ...paths])
    return
  }
  // Status lists a staged rename only under its new path. Restoring that alone leaves the original's deletion staged.
  // Paths are literal, so an original name such as [ab].txt cannot also unstage a.txt.
  const originals = (await readStatus(repo)).changes.flatMap((change) =>
    change.staged && change.kind === 'renamed' && change.originalPath && paths.includes(change.path) ? [change.originalPath] : [])
  const literal = [...new Set([...paths, ...originals])].map((file) => `:(literal)${file}`)
  await git(repo, ['restore', '--staged', '--', ...literal])
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
  const format = '%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname)%1f%(refname)%1f%(upstream)%1f%(symref)'
  const output = await git(repo, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'])
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [, head, upstream, hash, fullRef, upstreamRef, symref] = line.split('\x1f')
    const remote = fullRef.startsWith('refs/remotes/')
    if (remote && symref) return []
    return [{
      // Strip the namespace, so ambiguous short-ref formatting never changes the displayed branch name.
      name: fullRef.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length),
      fullRef, upstreamRef: upstreamRef || null, remote, current: head === '*', upstream: upstream || null, hash,
    }]
  })
}

function assertSelection(selection: BranchSelection): void {
  if (!selection || typeof selection.fullRef !== 'string' || typeof selection.hash !== 'string'
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(selection.hash)) {
    throw new Error('Choose a branch from the refreshed list.')
  }
}

function selectedBranch(branches: Branch[], selection: BranchSelection): Branch {
  assertSelection(selection)
  const branch = branches.find((entry) => entry.fullRef === selection.fullRef)
  if (!branch || branch.hash !== selection.hash) {
    throw new Error('Selected branch disappeared or changed. Choices were refreshed; select it again.')
  }
  return branch
}

async function switchLocal(repo: string, branch: Branch): Promise<void> {
  // Git switch expects a local name. Refuse names that Git's revision parser would resolve differently.
  const resolved = await git(repo, ['rev-parse', '--symbolic-full-name', '--verify', '--end-of-options', branch.name]).catch(() => '')
  if (resolved.trim() !== branch.fullRef) throw new Error(`Ambiguous branch name: ${branch.name}`)
  await git(repo, ['switch', '--no-guess', '--no-overwrite-ignore', '--', branch.name])
}

// A remote ref can be mapped by more than one configured remote/refspec. Never let Git guess the source.
async function trackingName(repo: string, fullRef: string): Promise<{ name: string; remote: string }> {
  const mappings: { name: string; source: string }[] = []
  const match = (pattern: string, value: string): string | null => {
    const parts = pattern.split('*')
    if (parts.length === 1) return pattern === value ? '' : null
    if (parts.length !== 2 || !value.startsWith(parts[0]) || !value.endsWith(parts[1])
      || value.length < parts[0].length + parts[1].length) return null
    return value.slice(parts[0].length, value.length - parts[1].length)
  }
  for (const remote of (await git(repo, ['remote'])).split('\n').filter(Boolean)) {
    const specs = (await git(repo, ['config', '--get-all', `remote.${remote}.fetch`]).catch(() => '')).trim().split('\n')
    for (const spec of specs) {
      const [source, destination, extra] = spec.replace(/^\+/, '').split(':')
      if (!destination || extra) continue
      const wildcard = match(destination, fullRef)
      if (wildcard === null) continue
      const mapped = source.replace('*', wildcard)
      if (!mapped.startsWith('refs/heads/') || mapped.includes('*')
        || specs.some((excluded) => excluded.startsWith('^') && match(excluded.slice(1), mapped) !== null)) continue
      mappings.push({ name: remote, source: mapped })
    }
  }
  if (mappings.length !== 1) throw new Error('Ambiguous or unsupported remote fetch mapping. Select a local branch instead.')
  return { name: mappings[0].source.slice('refs/heads/'.length), remote: mappings[0].name }
}

async function assertNewBranch(repo: string, name: string, branches: Branch[], remote?: string): Promise<void> {
  await assertBranchName(repo, name)
  const fullRef = `refs/heads/${name}`
  const collision = branches.find((branch) => !branch.remote && (branch.fullRef === fullRef
    || branch.fullRef.startsWith(fullRef + '/') || fullRef.startsWith(branch.fullRef + '/')))
  if (collision) throw new Error(`Branch already exists or name conflicts with ${collision.name}. Choose another name.`)
  await assertNoUpstreamConfig(repo, name, remote)
}

// Git keeps branch.<name>.remote/merge after a branch ref vanishes (unborn or externally deleted)
// and a new branch with that name silently inherits them, even with --no-track.
// Include conditions such as onbranch and hasconfig can change once the new branch is checked out, and Git cannot
// evaluate them for that state ahead of time. So every reachable include file is read on its own and checked too,
// whatever its condition, except behind a gitdir include that does not apply to this repository. An include that Git
// would fail on once it applies is refused as well, since the switch would already have written the branch and HEAD by then.
// A new branch that tracks through a remote also needs that remote's URL and fetch mapping to stay the same after the switch.
// An existing tracker keeps its own upstream settings, so for it only those in includeIf files are refused, as they could
// change once it is checked out.
async function assertNoUpstreamConfig(repo: string, name: string, remote?: string, existing = false): Promise<void> {
  const unchecked = (reason: string) => new Error(`Could not read the Git config to check upstream settings for ${name}: ${reason}`)
  // A silent exit 1 is an absent key, no match or a missing include file. Git also exits 1 for a file it cannot
  // open, but with a warning, so that and anything else fails closed.
  const read = (args: string[]) => git(repo, ['config', ...args]).catch((error) => {
    if (error instanceof GitError && error.code === 1 && !error.stderr) return null
    throw unchecked(error.message)
  })
  // Start from the files Git always reads, without their includes, so depth counts nesting exactly as Git does.
  const sources = [{ args: ['--no-includes'], depth: 0, conditional: false, inert: false }]
  const seen = new Set<string>()
  // A gitdir condition does not depend on the branch, so Git's answer now also holds after the switch. Git expands an
  // include right where its directive is listed, so a directive applied when the next entry Git lists comes from its file.
  const listed = new Map<string, Promise<string[]>>()
  const gitdirApplies = async (origin: string, entry: string, file: string) => {
    // A command-line directive (-c or GIT_CONFIG_COUNT) has no file to replay, so Git's whole listing is read for it.
    const including = origin.startsWith('file:') ? origin.slice('file:'.length) : ''
    if (!listed.has(including)) {
      const source = including ? ['--file', including] : []
      listed.set(including, read([...source, '--includes', '-z', '--show-origin', '--list']).then((output) => (output ?? '').split('\0')))
    }
    const items = await listed.get(including)!
    // Identical directives share their condition and file. A directive that is not listed counts as applying.
    // A file's own entries follow its self include either way, but an applied self include recurses until the read fails.
    for (let j = 0; j + 1 < items.length; j += 2) {
      if (items[j] === origin && items[j + 1] === entry) return file !== including && items[j + 2] === `file:${file}`
    }
    return true
  }
  // Once any hasconfig:remote.*.url include applies, Git fails on remote.*.url in a file it reached through includeIf.
  // Files behind a gitdir include that does not apply to this repository are never read by Git, so they count for neither.
  let hasconfig = false
  let conditionalUrl = false
  while (sources.length) {
    const { args, depth, conditional, inert } = sources.pop()!
    for (const key of inert || (existing && !conditional) ? [] : [`branch.${name}.remote`, `branch.${name}.merge`]) {
      if ((await read([...args, '--get-all', key])) !== null) {
        throw new Error(existing
          ? `Branch ${name} has upstream settings (${key}) in a Git config file reached through includeIf, so its tracking could change once it is checked out. Move them to the repository config first.`
          : `Branch ${name} could inherit upstream settings (${key}) from the Git config. Choose another name, or remove those settings first.`)
      }
    }
    // Conditions are not evaluated, so any includeIf file Git could read may add, remove or reorder them once the branch changes.
    for (const key of remote && conditional && !inert ? [`remote.${remote}.url`, `remote.${remote}.fetch`] : []) {
      if ((await read([...args, '--get-all', key])) !== null) {
        throw new Error(`Remote ${remote} has settings (${key}) in a Git config file reached through includeIf, so tracking could break once ${name} is checked out. Move them to the repository config first.`)
      }
    }
    if (conditional && !inert && (await read([...args, '--name-only', '--get-regexp', '^remote\\..*\\.url$'])) !== null) conditionalUrl = true
    const entries = ((await read([...args, '-z', '--show-origin', '--get-regexp', '^include(if\\..*)?\\.path$'])) ?? '').split('\0')
    for (let j = 0; j + 1 < entries.length; j += 2) {
      const [origin, entry] = [entries[j], entries[j + 1]]
      // Nothing in a file Git never reads is checked. Its includes are still opened up to Git's depth, so an unreadable one fails closed.
      if (inert && (depth === 10 || !entry.includes('\n'))) continue
      // Git prints a key without a value with no newline, and fails on such an include.
      if (!entry.includes('\n')) throw unchecked('an include path has no value')
      // Git fails on an 11th nested include. One whose file is missing would be skipped, but is refused here too.
      if (depth === 10) throw unchecked('includes are nested more than 10 deep')
      hasconfig ||= !inert && entry.startsWith('includeif.hasconfig:remote.*.url:')
      const raw = entry.slice(entry.indexOf('\n') + 1)
      // Git expands ~ and %(prefix)/ in include paths but, unlike --type=path, keeps :(optional) as part of the name.
      const value = raw.startsWith(':(optional)') ? raw
        : (await read(['--file', '/dev/null', '--type=path', '-z', '--default', raw, '--get', 'include.path']))!.slice(0, -1)
      // Git fails on relative includes that do not come from a file.
      if (!path.isAbsolute(value) && !origin.startsWith('file:')) throw unchecked('a relative include path is not in a config file')
      // Like Git, append a relative path to the including file's folder as written and let the kernel resolve it.
      // Normalizing link/.. here would read a different file from the one Git opens. Relative local config origins
      // and later --file reads both start from the worktree top level, which canonical repo paths are.
      const including = origin.slice('file:'.length)
      const file = path.isAbsolute(value) ? value : including.slice(0, including.lastIndexOf('/') + 1) + value
      const viaIncludeIf = conditional || entry.startsWith('includeif.')
      const childInert = inert || (/^includeif\.gitdir(\/i)?:/.test(entry) && (origin.startsWith('file:') || origin === 'command line:')
        && !(await gitdirApplies(origin, entry, file)))
      // The same path at the same depth and kind of edge leads to the same checks. Otherwise it can hit the depth limit
      // or the remote URL rule, so it is read again.
      const visit = `${depth + 1}\0${viaIncludeIf}\0${childInert}\0${file}`
      if (!seen.has(visit)) {
        seen.add(visit)
        sources.push({ args: ['--file', file, '--no-includes'], depth: depth + 1, conditional: viaIncludeIf, inert: childInert })
      }
    }
    // Other conditions are not evaluated, so any other hasconfig include and includeIf edge count, as they could apply after the switch.
    if (hasconfig && conditionalUrl) throw unchecked('a remote URL is set in a file reached through includeIf, which Git refuses once a hasconfig:remote.*.url include applies')
  }
}

export async function switchBranch(repo: string, selection: BranchSelection): Promise<void> {
  const branches = await readBranches(repo)
  const branch = selectedBranch(branches, selection)
  if (!branch.remote) return switchLocal(repo, branch)
  // Git already resolved an existing tracker's upstream, so only a new branch needs a mapping derived here.
  const tracking = branches.filter((entry) => !entry.remote && entry.upstreamRef === branch.fullRef)
  if (tracking.length > 1) throw new Error(`Multiple local branches track ${branch.name}: ${tracking.map((entry) => entry.name).join(', ')}. Select a local branch explicitly.`)
  if (tracking.length === 1) {
    // Its upstream must still resolve once it is checked out, which includes that could change would not guarantee.
    const remote = (await git(repo, ['for-each-ref', '--format=%(upstream:remotename)', tracking[0].fullRef])).trim()
    await assertNoUpstreamConfig(repo, tracking[0].name, remote || undefined, true)
    return switchLocal(repo, tracking[0])
  }
  const { name, remote } = await trackingName(repo, branch.fullRef)
  await assertNewBranch(repo, name, branches, remote)
  await git(repo, ['switch', '--no-guess', '--no-overwrite-ignore', '--track=direct', '-c', name, branch.fullRef, '--'])
}

export async function createBranch(repo: string, name: string, base: BranchSelection): Promise<void> {
  assertSelection(base)
  const branches = await readBranches(repo)
  await assertNewBranch(repo, name, branches)
  if (base.fullRef === 'HEAD') {
    const head = (await git(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim()
    if (!head) throw new Error('Create a commit first, or choose another base branch.')
    if (head !== base.hash) throw new Error('Current HEAD changed. Choices were refreshed; select the base again.')
  } else {
    selectedBranch(branches, base)
  }
  // Pin independent creation to the displayed commit and suppress branch.autoSetupMerge.
  await git(repo, ['switch', '--no-guess', '--no-overwrite-ignore', '--no-track', '-c', name, base.hash, '--'])
}

export async function deleteBranch(repo: string, name: string, force = false): Promise<void> {
  await git(repo, ['branch', force ? '-D' : '-d', name])
}

// Newest version first, which is the order a tag picker is read in.
export async function readTags(repo: string): Promise<Tag[]> {
  const output = await git(repo, ['for-each-ref', '--sort=-v:refname', '--format=%(refname)%1f%(objectname)%1f%(*objectname)', 'refs/tags'])
  return output.split('\n').filter(Boolean).map((line) => {
    const [fullRef, hash, peeled] = line.split('\x1f')
    return { name: fullRef.slice('refs/tags/'.length), fullRef, hash: peeled || hash }
  })
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
  if (!ref || ref.startsWith('-')) throw new Error(`Invalid stash: ${ref}`)
  if (action !== 'drop') {
    // A stash writes what it changed from its base, in its working tree and its index. Its untracked part Git checks itself.
    await assertNoUntrackedOverwrite(repo, [...await changedPaths(repo, `${ref}^1`, ref), ...await changedPaths(repo, `${ref}^1`, `${ref}^2`)])
  }
  await git(repo, ['stash', action, ref])
}

export async function fetchAll(repo: string): Promise<void> {
  await git(repo, ['fetch', '--all', '--prune', '--no-tags'])
}

// Pull takes no --no-overwrite-ignore, so it fetches first and checks what the upstream adds since the merge base.
// Pull's own fetch then finds nothing new. No upstream is left to pull's own error.
export async function pull(repo: string, mode: 'merge' | 'rebase' = 'merge'): Promise<void> {
  if (mode !== 'merge' && mode !== 'rebase') throw new Error(`Unknown pull mode: ${mode}`)
  await git(repo, ['fetch'], { interactive: false })
  if (await gitOk(repo, ['rev-parse', '--verify', '--quiet', '@{u}^{commit}'])) {
    await assertNoUntrackedOverwrite(repo, await changedPaths(repo, 'HEAD...@{u}'))
  }
  await git(repo, ['pull', mode === 'rebase' ? '--rebase' : '--no-rebase'], { interactive: false })
}

export async function pullFrom(repo: string, remote: string, branch: string): Promise<void> {
  await assertRemote(repo, remote)
  await assertBranchName(repo, branch)
  await git(repo, ['fetch', remote, branch], { interactive: false })
  await assertNoUntrackedOverwrite(repo, await changedPaths(repo, 'HEAD...FETCH_HEAD'))
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
      current = { path: line.slice('worktree '.length), branch: null, hash: '', locked: false, current: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('HEAD ')) current.hash = line.slice(5)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length)
    else if (line.startsWith('locked')) current.locked = true
  }
  if (current?.path) entries.push(current as Worktree)
  const self = canonicalRepoPath(repo)
  return entries.map((entry) => {
    // A pruned worktree's folder is gone, so it keeps the path Git listed.
    let canonical = entry.path
    try { canonical = canonicalRepoPath(entry.path) } catch {}
    return { ...entry, path: canonical, current: canonical === self }
  })
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
  // --keep refuses to overwrite local changes, so an undo never discards work. It still replaces ignored files.
  await assertNoUntrackedOverwrite(repo, await changedPaths(repo, 'HEAD', hash))
  await git(repo, ['reset', '--keep', hash])
}

// Returns the backup ref so the user can undo. Uncommitted edits are not backed up.
export async function resetToUpstream(repo: string): Promise<string> {
  const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '')
  if (!upstream.trim()) throw new Error('This HEAD has no upstream branch to reset to.')
  // Uncommitted tracked edits are the point of the reset; untracked and ignored files are not.
  await assertNoUntrackedOverwrite(repo, await changedPaths(repo, 'HEAD', '@{u}'))
  const backup = await createBackupRef(repo, 'reset')
  await git(repo, ['reset', '--hard', '@{u}'])
  return backup
}

export async function cherryPick(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  await assertNoUntrackedOverwrite(repo, await commitPaths(repo, commit, 'd'))
  const backup = await createBackupRef(repo, 'cherry-pick')
  await git(repo, ['cherry-pick', commit])
  return backup
}

export async function revertCommit(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  // A revert writes back what the commit modified or deleted.
  await assertNoUntrackedOverwrite(repo, await commitPaths(repo, commit, 'a'))
  const backup = await createBackupRef(repo, 'revert')
  await git(repo, ['revert', '--no-edit', commit])
  return backup
}

export async function checkoutDetached(repo: string, hash: string): Promise<void> {
  await git(repo, ['switch', '--detach', '--no-overwrite-ignore', await resolveCommit(repo, hash)])
}

// Git treats ignored files as expendable: reset, pull, cherry-pick, revert and stash apply replace an ignored local file
// (a .env, say) with a tracked one without asking, and reset --hard does the same to any untracked file. Only switch and
// merge take --no-overwrite-ignore, so the other writes pass the paths they could write here first. A path counts when
// it, or a parent that is not a folder, exists on disk and is not in the index.
async function assertNoUntrackedOverwrite(repo: string, paths: string[]): Promise<void> {
  const present = new Set<string>()
  await Promise.all(paths.map(async (file) => {
    const parts = file.split('/')
    for (let depth = 1; depth <= parts.length; depth++) {
      const stat = await fs.lstat(path.join(repo, ...parts.slice(0, depth))).catch(() => null)
      if (!stat) return
      if (depth === parts.length || !stat.isDirectory()) return void present.add(parts.slice(0, depth).join('/'))
    }
  }))
  if (!present.size) return
  const tracked = new Set((await git(repo, ['ls-files', '-z'])).split('\0'))
  const blocked = [...present].filter((file) => !tracked.has(file)).sort()
  if (!blocked.length) return
  const shown = blocked.slice(0, 5).join(', ') + (blocked.length > 5 ? `, and ${blocked.length - 5} more` : '')
  throw new Error(`This would overwrite untracked or ignored files: ${shown}. Move or delete them first.`)
}

// Paths that differ between two revisions (or across a ... range), leaving out deletions, which never write a file.
async function changedPaths(repo: string, ...revisions: string[]): Promise<string[]> {
  return (await git(repo, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', ...revisions, '--'])).split('\0').filter(Boolean)
}

// Paths one commit touched against its first parent, filtered with a --diff-filter value.
async function commitPaths(repo: string, commit: string, filter: string): Promise<string[]> {
  return (await git(repo, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-z', '--no-renames', `--diff-filter=${filter}`, commit])).split('\0').filter(Boolean)
}

export async function branchFromCommit(repo: string, name: string, hash: string): Promise<void> {
  await assertBranchName(repo, name)
  // An existing name is left to Git's own "already exists" refusal.
  if (!(await gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]))) await assertNoUpstreamConfig(repo, name)
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
  if (typeof name !== 'string' || name === '@' || name.startsWith('-')
    || !(await gitOk(repo, ['check-ref-format', `refs/heads/${name}`]))
    || !(await gitOk(repo, ['check-ref-format', '--branch', name]))) throw new Error(`Invalid branch name: ${name}`)
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
