import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { conflictBlocks, parseConflicts } from '../../shared/conflict'
import { assertSupportedConflictFormat } from './conflict'
import { canonicalRepoPath } from '../repo-lock'
import { GitError, git, gitOk, gitRaw, type GitOptions } from './exec'
import { readStatus } from './status'

export interface Branch {
  name: string
  fullRef: string
  upstreamRef: string | null
  remote: boolean
  current: boolean
  upstream: string | null
  hash: string
  // Commits to push and to pull, counted from refs already fetched. Both are 0 without an upstream or when it is gone.
  ahead: number
  behind: number
  // The configured upstream ref no longer exists, as after its remote branch was deleted and pruned.
  gone: boolean
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
  await git(repo, ['--literal-pathspecs', 'add', '--', ...paths])
}

// Paths from the file list are names, never patterns, so a file named [ab].txt cannot also act on a.txt and b.txt.
// The unmerged paths that git add would touch for these paths, read with the same literal rule.
async function unmergedPaths(repo: string, paths: string[]): Promise<string[]> {
  const listed = await gitRaw(repo, ['--literal-pathspecs', 'ls-files', '-u', '-z', '--', ...paths])
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
    await git(repo, ['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...paths])
    return
  }
  // Status lists a staged rename only under its new path. Restoring that alone leaves the original's deletion staged.
  const originals = (await readStatus(repo)).changes.flatMap((change) =>
    change.staged && change.kind === 'renamed' && change.originalPath && paths.includes(change.path) ? [change.originalPath] : [])
  await git(repo, ['--literal-pathspecs', 'restore', '--staged', '--', ...new Set([...paths, ...originals])])
}

// Discards worktree changes for tracked files. Callers must confirm with the user first.
export async function discardPaths(repo: string, paths: string[]): Promise<void> {
  if (paths.length) await git(repo, ['--literal-pathspecs', 'restore', '--', ...paths])
}

// Deletes one untracked file. Callers must confirm with the user first. It is checked again here, under the repo lock:
// the path must still be exactly one untracked file in Git's list, reached through real folders, and be a file or a
// symlink. unlink removes a symlink itself, never its target, and never removes a folder.
export async function deleteUntracked(repo: string, file: string): Promise<void> {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file)) throw new Error('Invalid file path.')
  // Git lists normalised relative paths, so anything else (./a, a/../b, ../a) is refused, never resolved.
  const relative = path.relative(repo, path.resolve(repo, file))
  if (relative !== file || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(`Not a file path inside this repository: ${file}`)
  const listed = await git(repo, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', file])
  if (listed !== `${file}\0`) throw new Error(`${file} is no longer an untracked file. Nothing was deleted.`)
  let dir = repo
  for (const part of path.dirname(file).split(path.sep).filter((name) => name !== '.')) {
    dir = path.join(dir, part)
    if (!(await fs.lstat(dir)).isDirectory()) throw new Error(`${file} is behind a symbolic link. Nothing was deleted.`)
  }
  const target = path.join(repo, file)
  const info = await fs.lstat(target)
  if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`${file} is not a file. Nothing was deleted.`)
  await fs.unlink(target)
}

export async function commit(repo: string, message: string, amend = false): Promise<void> {
  const args = ['commit', '--cleanup=strip', '-F', '-']
  if (amend) args.push('--amend')
  await git(repo, args, { input: message })
}

export async function readBranches(repo: string): Promise<Branch[]> {
  // The track field reads "ahead 1, behind 2", "gone" or nothing. Git counts it from local refs, so it never fetches.
  const format = '%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(objectname)%1f%(refname)%1f%(upstream)%1f%(symref)%1f%(upstream:track,nobracket)'
  const output = await git(repo, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'])
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [, head, upstream, hash, fullRef, upstreamRef, symref, track = ''] = line.split('\x1f')
    const count = (word: string) => Number(new RegExp(`\\b${word} (\\d+)`).exec(track)?.[1] ?? 0)
    const remote = fullRef.startsWith('refs/remotes/')
    if (remote && symref) return []
    return [{
      // Strip the namespace, so ambiguous short-ref formatting never changes the displayed branch name.
      name: fullRef.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length),
      fullRef, upstreamRef: upstreamRef || null, remote, current: head === '*', upstream: upstream || null, hash,
      ahead: count('ahead'), behind: count('behind'), gone: track === 'gone',
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

// The branch menu's writes act on a local branch the picker showed, by exact ref and commit, so a branch moved or replaced
// since is refused. Names Git would read another way (HEAD, a leading dash) are refused too.
async function localBranch(repo: string, branches: Branch[], selection: BranchSelection): Promise<Branch> {
  const branch = selectedBranch(branches, selection)
  if (branch.remote) throw new Error(`${branch.name} is a remote branch. Only local branches can be changed here.`)
  await assertBranchName(repo, branch.name)
  return branch
}

// Never forced and never pushed. Git's -d itself refuses a branch with commits not merged into its upstream, or into HEAD
// when it has none, so no work is lost.
export async function deleteBranch(repo: string, selection: BranchSelection): Promise<void> {
  const branch = await localBranch(repo, await readBranches(repo), selection)
  if (branch.current) throw new Error(`${branch.name} is checked out. Switch to another branch before deleting it.`)
  const elsewhere = (await readWorktrees(repo)).find((worktree) => worktree.branch === branch.name)
  if (elsewhere) throw new Error(`${branch.name} is checked out in ${elsewhere.path}. Nothing was deleted.`)
  await git(repo, ['branch', '--delete', '--', branch.name])
}

// --move never overwrites an existing branch (that is -M). Git moves settings only in the repository config, so refuse
// tracking from other config sources rather than silently dropping it. The new name gets the same checks as a created branch.
export async function renameBranch(repo: string, selection: BranchSelection, name: string): Promise<void> {
  const branches = await readBranches(repo)
  const branch = await localBranch(repo, branches, selection)
  await assertNewBranch(repo, name, branches)
  await assertNoUpstreamConfig(repo, branch.name, undefined, true)
  for (const key of [`branch.${branch.name}.remote`, `branch.${branch.name}.merge`]) {
    const read = (scope: string[]) => git(repo, ['config', ...scope, '--null', '--get-all', key]).catch((error) => {
      if (error instanceof GitError && error.code === 1 && !error.stderr) return ''
      throw error
    })
    const [effective, local] = await Promise.all([read([]), read(['--local', '--no-includes'])])
    if (effective !== local) {
      throw new Error(`Branch ${branch.name} has upstream settings outside the repository config. Move them to the repository config before renaming it.`)
    }
  }
  await git(repo, ['branch', '--move', '--', branch.name, name])
}

// The upstream is a branch from the same refreshed list, passed by full ref so Git cannot resolve a look-alike name.
export async function setUpstream(repo: string, selection: BranchSelection, upstream: BranchSelection): Promise<void> {
  const branches = await readBranches(repo)
  const branch = await localBranch(repo, branches, selection)
  const target = selectedBranch(branches, upstream)
  if (target.fullRef === branch.fullRef) throw new Error(`${branch.name} cannot track itself. Choose another branch.`)
  await git(repo, ['branch', `--set-upstream-to=${target.fullRef}`, '--', branch.name])
}

export async function unsetUpstream(repo: string, selection: BranchSelection): Promise<void> {
  const branch = await localBranch(repo, await readBranches(repo), selection)
  if (!branch.upstreamRef) throw new Error(`${branch.name} has no upstream to unset.`)
  await git(repo, ['branch', '--unset-upstream', '--', branch.name])
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
    // A stash applies its working tree and its index against its base. Git checks its untracked part itself.
    const merged = [await previewMerge(repo, 'HEAD', ref, `${ref}^1`), await previewMerge(repo, 'HEAD', `${ref}^2`, `${ref}^1`)]
    await assertNoUntrackedOverwrite(repo, [...await treePaths(repo, merged[0].tree), ...await treePaths(repo, merged[1].tree)],
      [...merged[0].moved, ...merged[1].moved])
  }
  await git(repo, ['stash', action, ref])
}

export type FetchMode = 'fetch' | 'tags' | 'prune'
export type PullMode = 'merge' | 'ff-only' | 'rebase' | 'rebase-autostash'
export type PushMode = 'push' | 'force' | 'force-with-lease' | 'no-verify'

// Modes arrive from the renderer, so each is checked against its list before it picks Git arguments.
function assertMode<T extends string>(kind: string, mode: unknown, modes: readonly T[]): asserts mode is T {
  if (!modes.includes(mode as T)) throw new Error(`Unknown ${kind} mode: ${String(mode)}`)
}

const FETCH_ARGS: Record<FetchMode, string[]> = {
  fetch: ['fetch', '--all'],
  tags: ['fetch', '--all', '--tags'],
  prune: ['fetch', '--all', '--prune'],
}

// Linked worktrees share one set of remote refs, and the repo lock is per worktree. Two fetches into the same refs fail on
// each other's ref locks ("cannot lock ref"), so each fetch waits for the one before it in that repository.
const fetches = new Map<string, Promise<unknown>>()
async function fetchSerially(repo: string, args: string[], options?: GitOptions): Promise<void> {
  const refs = canonicalRepoPath((await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
  const run = (fetches.get(refs) ?? Promise.resolve()).catch(() => undefined).then(() => git(repo, args, options))
  fetches.set(refs, run)
  try {
    await run
  } finally {
    if (fetches.get(refs) === run) fetches.delete(refs)
  }
}

// With no mode, as the background fetch, native menu and Fetch All call it, every remote is fetched and pruned without tags.
export async function fetchAll(repo: string, mode?: FetchMode): Promise<void> {
  if (mode !== undefined) assertMode('fetch', mode, Object.keys(FETCH_ARGS) as FetchMode[])
  await fetchSerially(repo, mode === undefined ? ['fetch', '--all', '--prune', '--no-tags'] : FETCH_ARGS[mode])
}

// Git pull fetches and merges in one step, and takes no --no-overwrite-ignore. So this fetches once, then merges or
// rebases exactly the commit that fetch brought: a commit pushed after the fetch is never written unchecked.
export async function pull(repo: string, mode: PullMode = 'merge'): Promise<void> {
  assertMode('pull', mode, ['merge', 'ff-only', 'rebase', 'rebase-autostash'])
  const branch = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim()
  if (!branch) throw new Error('Pull needs a branch, not a detached HEAD.')
  const tracking = (await git(repo, ['rev-parse', '--symbolic-full-name', '@{u}']).catch(() => '')).trim()
  if (!tracking) throw new Error(`${branch} has no upstream branch to pull from.`)
  // Like git pull, a rebase starts from the fork point read before the fetch moves the remote branch.
  const forkPoint = mode.startsWith('rebase') ? (await git(repo, ['merge-base', '--fork-point', tracking, 'HEAD']).catch(() => '')).trim() : ''
  // With no arguments, fetch reads the branch's remote and marks its merge branch in FETCH_HEAD, as git pull does.
  await fetchSerially(repo, ['fetch'], { interactive: false })
  await integrateFetched(repo, mode, forkPoint)
}

export async function pullFrom(repo: string, remote: string, branch: string): Promise<void> {
  await assertRemote(repo, remote)
  await assertBranchName(repo, branch)
  await fetchSerially(repo, ['fetch', remote, branch], { interactive: false })
  await integrateFetched(repo, 'merge', '')
}

// Merges or rebases the one commit the last fetch marked for merging, by hash, after checking what that commit writes.
// A merge also passes Git's own --no-overwrite-ignore; a rebase has no such flag.
async function integrateFetched(repo: string, mode: PullMode, forkPoint: string): Promise<void> {
  const fetchHead = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim())
  const heads = (await fs.readFile(fetchHead, 'utf8')).split('\n').filter((line) => line && line.split('\t')[1] === '')
  if (heads.length !== 1) throw new Error(heads.length ? 'The fetch found several branches to merge. Pull one branch at a time.' : 'The fetch found no branch to merge.')
  const target = heads[0].split('\t')[0]
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target)) throw new Error('The fetch did not record a commit to merge.')
  // On a branch with no commits yet, git pull checks out the fetched commit in either mode. Git's merge does that too, but
  // replaces ignored files even with --no-overwrite-ignore, so the whole tree is checked first. --ff keeps merge.ff=false,
  // which git pull does not read here, from refusing it.
  if (!(await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim()) {
    await assertNoUntrackedOverwrite(repo, await treePaths(repo, target))
    await git(repo, ['merge', '--no-overwrite-ignore', '--ff', target])
    return
  }
  if (mode === 'rebase' || mode === 'rebase-autostash') {
    const writes = await rebaseWrites(repo, target, forkPoint || target)
    // --autostash stashes tracked edits and reapplies them after; a conflicting reapply leaves them in the stash list.
    // That reapply is a stash apply onto the rebased tree, which replaces ignored files too, so it is checked as one.
    // stash create makes the same stash commit the rebase will, without touching the index, the files or the stash list.
    const stash = mode === 'rebase-autostash' ? (await git(repo, ['stash', 'create'])).trim() : ''
    if (stash) {
      // A rebase that stops reapplies the stash only once the conflict is resolved, onto a tree nobody can know yet.
      if (writes.conflicted) throw new Error('This rebase would stop on a conflict, and Git would put your uncommitted changes back later without checking for ignored files. Commit or stash them first, or pull with merge.')
      for (const side of [stash, `${stash}^2`]) {
        const merged = await previewMerge(repo, writes.tree, side, `${stash}^1`)
        writes.paths.push(...await treePaths(repo, merged.tree))
        writes.moved.push(...merged.moved)
      }
    }
    await assertNoUntrackedOverwrite(repo, writes.paths, writes.moved)
    await git(repo, ['rebase', ...(mode === 'rebase-autostash' ? ['--autostash'] : []), '--onto', target, forkPoint || target])
    return
  }
  if (mode === 'ff-only') {
    // A branch that already has the fetched commit is up to date, as git pull --ff-only reports, and writes nothing.
    if (await gitOk(repo, ['merge-base', '--is-ancestor', target, 'HEAD'])) return
    // Refused before the untracked check, so a diverged branch gets the reason that matters.
    if (!(await gitOk(repo, ['merge-base', '--is-ancestor', 'HEAD', target]))) {
      throw new Error('Cannot fast-forward: the branch and its upstream have diverged. Pull with merge or rebase instead.')
    }
    await assertNoUntrackedOverwrite(repo, await treePaths(repo, target))
    await git(repo, ['merge', '--ff-only', '--no-overwrite-ignore', target])
    return
  }
  const merged = await previewMerge(repo, 'HEAD', target)
  await assertNoUntrackedOverwrite(repo, await treePaths(repo, merged.tree), merged.moved)
  // The message git pull would write, read from the same FETCH_HEAD line.
  const message = (await git(repo, ['fmt-merge-msg'], { input: `${heads[0]}\n` })).trim()
  await git(repo, ['merge', '--no-overwrite-ignore', '--no-edit', ...await pullFastForward(repo), '-m', message, target])
}

// git pull's pull.ff setting, which a plain merge would not read.
async function pullFastForward(repo: string): Promise<string[]> {
  const value = (await git(repo, ['config', '--get', 'pull.ff']).catch(() => '')).trim()
  if (!value) return []
  // git pull turns pull.ff=only into --ff when told --rebase or --no-rebase, as this app always tells it.
  if (value === 'only') return ['--ff']
  return (await git(repo, ['config', '--type=bool', '--get', 'pull.ff']).catch(() => '')).trim() === 'false' ? ['--no-ff'] : ['--ff']
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

// A branch with no upstream is pushed to origin and set to track it. A force push names the upstream ref explicitly, so
// push.default=matching can never force other branches too, and a lease checks it against its remote-tracking ref.
export async function push(repo: string, hasUpstream: boolean, branch: string, mode: PushMode = 'push'): Promise<void> {
  assertMode('push', mode, ['push', 'force', 'force-with-lease', 'no-verify'])
  if (mode === 'force' || mode === 'force-with-lease') {
    if (!hasUpstream) throw new Error(`${branch} has no upstream branch to force push to.`)
    const remote = (await git(repo, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim()
    const merge = (await git(repo, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim()
    if (!remote || remote.startsWith('-') || !merge.startsWith('refs/heads/')) throw new Error(`${branch} has no remote branch to force push to.`)
    await git(repo, ['push', mode === 'force' ? '--force' : '--force-with-lease', remote, `refs/heads/${branch}:${merge}`])
    return
  }
  const verify = mode === 'no-verify' ? ['--no-verify'] : []
  await git(repo, hasUpstream ? ['push', ...verify] : ['push', ...verify, '--set-upstream', 'origin', branch])
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
  // --keep refuses to overwrite local changes, so an undo never discards work. It would still replace ignored files.
  await assertNoUntrackedOverwrite(repo, await treePaths(repo, hash))
  await git(repo, ['reset', '--keep', hash])
}

// Returns the backup ref so the user can undo. Uncommitted edits are not backed up.
export async function resetToUpstream(repo: string): Promise<string> {
  const upstream = (await git(repo, ['rev-parse', '--verify', '--quiet', '@{u}^{commit}']).catch(() => '')).trim()
  if (!upstream) throw new Error('This HEAD has no upstream branch to reset to.')
  // Tracked edits are what the reset discards. Untracked and ignored files are not, though reset --hard replaces them.
  await assertNoUntrackedOverwrite(repo, await treePaths(repo, upstream))
  const backup = await createBackupRef(repo, 'reset')
  await git(repo, ['reset', '--hard', upstream])
  return backup
}

export async function cherryPick(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  // A root commit applies against the empty tree.
  const merged = await previewMerge(repo, 'HEAD', commit, await firstParent(repo, commit) ?? null)
  await assertNoUntrackedOverwrite(repo, await treePaths(repo, merged.tree), merged.moved)
  const backup = await createBackupRef(repo, 'cherry-pick')
  await git(repo, ['cherry-pick', commit])
  return backup
}

export async function revertCommit(repo: string, hash: string): Promise<string> {
  const commit = await resolveCommit(repo, hash)
  // A revert applies the parent against the commit. Reverting a root commit only deletes.
  const parent = await firstParent(repo, commit)
  if (parent) {
    const merged = await previewMerge(repo, 'HEAD', parent, commit)
    await assertNoUntrackedOverwrite(repo, await treePaths(repo, merged.tree), merged.moved)
  }
  const backup = await createBackupRef(repo, 'revert')
  await git(repo, ['revert', '--no-edit', commit])
  return backup
}

export async function checkoutDetached(repo: string, hash: string): Promise<void> {
  await git(repo, ['switch', '--detach', '--no-overwrite-ignore', await resolveCommit(repo, hash)])
}

// Git treats ignored files as expendable: reset, rebase, cherry-pick, revert and stash apply replace an ignored local
// file (a .env, say) with a tracked one without asking, and reset --hard does the same to any untracked file, including
// one just untracked with git rm --cached. Only switch and merge take --no-overwrite-ignore, so the other writes check here.
// A path is at risk when the write puts it in the working tree, it is not in the index, and something untracked is on
// disk there: a file, or a folder that a file replaces while it holds untracked or ignored files. A folder of tracked
// files only is Git's to replace. For each path in `moved`, every name on disk Git could move it aside to counts as written.
async function assertNoUntrackedOverwrite(repo: string, paths: string[], moved: string[] = []): Promise<void> {
  const list = async (args: string[]) => (await git(repo, args)).split('\0').filter(Boolean)
  const root = await fs.realpath(repo)
  // Matched across Unicode form and case, as the disk may match them.
  const loose = (name: string) => name.normalize('NFC').toLowerCase()
  const aside = await Promise.all(moved.map(async (file) => {
    const folder = path.posix.dirname(file), prefix = loose(`${path.posix.basename(file)}~`)
    const names = await fs.readdir(path.join(root, folder)).catch(() => [] as string[])
    return names.filter((name) => loose(name).startsWith(prefix)).map((name) => path.posix.join(folder, name))
  }))
  const indexed = new Set(await list(['ls-files', '-z']))
  const written = new Set([...paths, ...aside.flat()].filter((file) => !indexed.has(file)))
  if (!written.size) return
  // Git names a file on disk by NFC under core.precomposeUnicode and in any case under core.ignorecase.
  let tracked: Promise<(file: string) => boolean> | undefined
  const isTracked = (file: string) => (tracked ??= (async () => {
    const config = await git(repo, ['config', '--type=bool', '--get-regexp', '^core\\.(precomposeunicode|ignorecase)$']).catch(() => '')
    const precompose = /^core\.precomposeunicode true$/m.test(config), ignorecase = /^core\.ignorecase true$/m.test(config)
    const key = (name: string) => {
      const form = precompose ? name.normalize('NFC') : name
      return ignorecase ? form.toLowerCase() : form
    }
    const keys = new Set([...indexed].map(key))
    return (name: string) => keys.has(key(name))
  })()).then((has) => has(file))
  const blocked = new Set<string>()
  const folders = new Set<string>()
  await Promise.all([...written].map(async (file) => {
    const parts = file.split('/')
    for (let depth = 1; depth <= parts.length; depth++) {
      const at = parts.slice(0, depth).join('/')
      const stat = await fs.lstat(path.join(root, at)).catch(() => null)
      if (!stat) return
      if (stat.isDirectory()) {
        if (depth === parts.length) folders.add(at)
        continue
      }
      if (indexed.has(at)) return
      // A tracked file can answer to another spelling, as in a case-only rename. realpath gives its name on disk.
      const real = stat.isSymbolicLink() ? at : path.relative(root, await fs.realpath(path.join(root, at)).catch(() => path.join(root, at)))
      if (!await isTracked(real)) blocked.add(at)
      return
    }
  }))
  for (const folder of folders) {
    for (const file of await list(['--literal-pathspecs', 'ls-files', '-z', '--others', '--directory', '--', `${folder}/`])) blocked.add(file)
  }
  if (!blocked.size) return
  const sorted = [...blocked].sort()
  const shown = sorted.slice(0, 5).join(', ') + (sorted.length > 5 ? `, and ${sorted.length - 5} more` : '')
  throw new Error(`This would overwrite untracked or ignored files: ${shown}. Move or delete them first.`)
}

// Every path in a tree, which a reset to it, or a checkout of it, writes.
async function treePaths(repo: string, rev: string): Promise<string[]> {
  return (await git(repo, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev])).split('\0').filter(Boolean)
}

// The tree a three-way write of `theirs` onto `ours` leaves in the working tree, conflicts included, as merge-ort works
// it out. Renames can put a file where neither side has one, as into a folder one side renamed, so no list of paths
// from the change alone will do. With no base Git finds the merge bases, as a merge does. With one, as for a
// cherry-pick, two throwaway commits on `base` stand in for the sides, so `base` is their only merge base; this needs
// merge-tree --write-tree from Git 2.38, not --merge-base from 2.40. A null base is the empty tree a root commit applies
// against. When Git can't tell, the write is refused.
// In a file/folder or file-type conflict Git moves a file aside to path~<label>, where the label is the operation's own
// (HEAD, a commit's subject, Stashed changes), not this preview's. `moved` lists those paths, so the guard can match any label.
async function previewMerge(repo: string, ours: string, theirs: string, base?: string | null): Promise<{ tree: string; conflicted: boolean; moved: string[] }> {
  const commit = async (tree: string, parent?: string) => (await git(repo, ['-c', 'user.name=BetterGit', '-c', 'user.email=bettergit@localhost',
    'commit-tree', '--no-gpg-sign', ...(parent ? ['-p', parent] : []), '-m', 'BetterGit preview', tree])).trim()
  const root = base === null ? await commit((await git(repo, ['mktree'])).trim()) : base
  const sides = root ? [await commit(`${ours}^{tree}`, root), await commit(`${theirs}^{tree}`, root)] : [ours, theirs]
  const { code, stdout, stderr } = await gitRaw(repo, ['merge-tree', '--write-tree', '-z', ...sides])
  const [tree, ...records] = stdout.toString('utf8').split('\0')
  // Exit 1 is a conflicted merge, whose files Git still writes.
  if ((code !== 0 && code !== 1) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) {
    throw new Error(`Could not check which files this would write, so nothing changed. This needs Git 2.38 or newer.${stderr ? ` Git said: ${stderr}` : ''}`)
  }
  // Conflicted entries follow the tree as "<mode> <object> <stage>\t<path>", up to an empty record.
  const moved = new Set<string>()
  for (const record of code === 1 ? records.slice(0, records.indexOf('')) : []) {
    const file = record.slice(record.indexOf('\t') + 1)
    for (const label of sides) {
      const at = file.lastIndexOf(`~${label}`)
      if (at > 0 && /^(?:_\d+)?$/.test(file.slice(at + label.length + 1))) moved.add(file.slice(0, at))
    }
  }
  return { tree, conflicted: code === 1, moved: [...moved] }
}

// A rebase checks out `onto`, then replays each local commit onto it like a cherry-pick, stopping at a conflict. Each
// replay writes what it changes, so a file a later commit removes still lands on disk first. The commits and their order
// are those of Git's own todo list: parents first, no merges, none whose change the upstream side already has.
// `tree` is the tree the rebase ends on, or stops on when `conflicted`.
async function rebaseWrites(repo: string, onto: string, upstream: string): Promise<{ paths: string[]; moved: string[]; tree: string; conflicted: boolean }> {
  const commits = (await git(repo, ['rev-list', '--reverse', '--topo-order', '--right-only', '--cherry-pick', '--parents', `${upstream}...HEAD`]))
    .split('\n').filter(Boolean).map((line) => line.split(' '))
  if (commits.some((parents) => parents.length > 2)) {
    // rebase.rebaseMerges has Git replay each side of a merge on its own and then redo the merge, which is not modeled
    // here. Any value but false turns it on, a mode name included.
    const value = await git(repo, ['config', '--type=bool', '--get', 'rebase.rebaseMerges'])
      .catch((error) => error instanceof GitError && error.code === 1 && !error.stderr ? 'false' : 'true')
    if (value.trim() !== 'false') throw new Error('Could not check which files this rebase would write, so nothing changed: rebase.rebaseMerges would redo its merge commits. Pull with merge, or turn rebase.rebaseMerges off.')
  }
  if (commits.length) {
    // rebase.backend=apply replays commits as patches, without the rename handling of the merge modeled here, so a file
    // can land where this does not look. Git refuses any value but apply or merge.
    const backend = await git(repo, ['config', '--get', 'rebase.backend'])
      .catch((error) => error instanceof GitError && error.code === 1 && !error.stderr ? 'merge' : '')
    if (backend.trim() !== 'merge') {
      // A linear branch already based on onto is up to date, so Git does not replay it.
      if (upstream === onto && commits.every((parents) => parents.length === 2)
        && await gitOk(repo, ['merge-base', '--is-ancestor', onto, 'HEAD'])) return { paths: [], moved: [], tree: 'HEAD', conflicted: false }
      throw new Error('Could not check which files this rebase would write, so nothing changed: rebase.backend replays commits as patches. Pull with merge, or set rebase.backend to merge.')
    }
  }
  const paths = await treePaths(repo, onto)
  const moved: string[] = []
  let ours = onto
  let conflicted = false
  for (const [commit, parent, ...others] of commits) {
    if (others.length) continue
    if (!parent) throw new Error('Could not check which files this rebase would write, so nothing changed: it replays a root commit.')
    const merged = await previewMerge(repo, ours, commit, parent)
    paths.push(...(await git(repo, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=d', ours, merged.tree])).split('\0').filter(Boolean))
    moved.push(...merged.moved)
    ours = merged.tree
    conflicted = merged.conflicted
    if (conflicted) break
  }
  return { paths, moved, tree: ours, conflicted }
}

async function firstParent(repo: string, commit: string): Promise<string | undefined> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${commit}^1`]).catch(() => '')).trim() || undefined
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
