import { git } from './exec'

export interface Commit {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  email: string
  date: number
  subject: string
  // Set on a stash row, as stash@{n}. Its parents hold only its base, never Git's index and untracked commits.
  stash?: string
}

// Git's %G? result for a commit's signature: G good, B bad, U good with unknown validity, X good but expired, Y good by
// an expired key, R good by a revoked key, E cannot be checked (such as a missing key), N no signature.
export type SignatureCode = 'G' | 'B' | 'U' | 'X' | 'Y' | 'R' | 'E' | 'N'

export interface CommitDetails {
  // The full message, subject included. Renderers must use it as-is, not prepend the subject again.
  body: string
  hash: string
  tree: string
  parents: string[]
  author: { name: string; email: string }
  committer: { name: string; email: string }
  // Strict ISO 8601 with the author's and committer's own offsets.
  authorDate: string
  committerDate: string
  // Null when the check itself failed, so a broken GPG setup is not shown as a bad or missing signature.
  signature: { code: SignatureCode; signer: string } | null
  // The commit's own change against its first parent (or the empty tree for a root), never filtered. Binary files count
  // as files without lines. Null when it could not be read.
  stats: { files: number; additions: number; deletions: number } | null
}

const FIELD = '\x1f'
const RECORD = '\x1e'
const LOG_FORMAT = `%H${FIELD}%P${FIELD}%D${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${RECORD}`

export function parseLog(output: string): Commit[] {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, parents, refs, author, email, date, subject] = record.split(FIELD)
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        author,
        email,
        date: Number(date),
        subject,
      }
    })
}

// One --author pattern per name, matching that exact author name. Git ORs repeated --author options.
// --basic-regexp overrides a grep.patternType config, so the escaping below always applies.
function authorArgs(authors: string[]): string[] {
  if (!authors.length) return []
  return ['--basic-regexp', ...authors.map((name) => `--author=^${name.replace(/[\\.[\]*^$]/g, '\\$&')} <`)]
}

// The tips History walks from: every local and remote branch, less those hidden in the app by full ref. Tags, stashes, a
// detached HEAD, and checkpoint or backup refs are never tips. Hiding a branch drops only the commits no shown branch
// reaches, so history it shares with a shown branch stays. Null when every branch is hidden. `hidden` is only compared
// against Git's own ref list, never passed to Git.
async function historyTips(repo: string, hidden: string[]): Promise<{ args: string[]; input?: string } | null> {
  if (!hidden.length) return { args: ['--branches', '--remotes'] }
  const skip = new Set(hidden)
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)%1f%(symref)', 'refs/heads', 'refs/remotes'], { optionalLocks: true }))
    .split('\n').flatMap((line) => {
      const [ref, symref] = line.split('\x1f')
      // A remote's HEAD names a branch listed on its own, as in the branch list, so hiding that branch hides it here too.
      return ref && !skip.has(ref) && !(symref && ref.startsWith('refs/remotes/')) ? [ref] : []
    })
  // Read from stdin, so thousands of shown branches never meet the argument length limit.
  return refs.length ? { args: ['--stdin'], input: `${refs.join('\n')}\n` } : null
}

// Commits from every shown local and remote branch, newest first. --date-order still lists every child before its parents
// but keeps concurrent branches interleaved by time, like Sublime Merge, so a merge sits near the commits it brings in and
// the graph holds few lines open at once. Pages are offset-based and count only matching commits.
export async function readHistory(repo: string, skip: number, limit: number, authors: string[] = [], hidden: string[] = []): Promise<Commit[]> {
  const tips = await historyTips(repo, hidden)
  if (!tips) return []
  const [output, stashes] = await Promise.all([
    git(repo, ['log', ...tips.args, '--date-order', ...authorArgs(authors), `--skip=${skip}`, `-n`, String(limit), `--format=${LOG_FORMAT}`], {
      optionalLocks: true, input: tips.input,
    }),
    // A stash that cannot be read must not hide the history around it.
    readStashCommits(repo).catch(() => []),
  ])
  const shown = authors.length ? stashes.filter((stash) => authors.includes(stash.author)) : stashes
  // A stash row's only parent is the commit it was made on.
  return placeStashes(parseLog(output), shown.map((stash) => ({ ...stash, parents: stash.parents.slice(0, 1) })))
}

// Every stash, newest first, with all its parents. This is the one place that decides what a stash is: an entry in the
// stash list whose commit has a base and an index commit, and is on no branch, so a commit that git stash store listed
// stays an ordinary commit. Rows are keyed by hash, so a stash listed twice under one hash is one row, named by its newest entry.
async function readStashCommits(repo: string): Promise<Commit[]> {
  const output = await git(repo, ['stash', 'list', `--format=%gd${FIELD}${LOG_FORMAT}`], { optionalLocks: true })
  const seen = new Set<string>()
  const stashes = output.split(RECORD).flatMap((record) => {
    const cut = record.indexOf(FIELD)
    const [commit] = cut < 0 ? [] : parseLog(`${record.slice(cut + 1)}${RECORD}`)
    if (!commit || commit.parents.length < 2 || seen.has(commit.hash)) return []
    seen.add(commit.hash)
    return [{ ...commit, refs: [], stash: record.slice(0, cut).trim() }]
  })
  const off = await offBranches(repo, stashes.map((stash) => stash.hash))
  return stashes.filter((stash) => off.has(stash.hash))
}

// The given commits that no local or remote branch reaches. It walks back to where they meet a branch, so callers pass
// only stash commits.
async function offBranches(repo: string, hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set()
  return new Set((await git(repo, ['rev-list', ...hashes, '--not', '--branches', '--remotes'], { optionalLocks: true })).split('\n'))
}

// Each stash goes directly above its base, newest first, so it shows only with its base, never brings in history a hidden
// branch alone reaches, and sits in the same place whatever the page size. Stash rows are extra rows: callers page by the
// commits Git listed, not by rows.
function placeStashes(commits: Commit[], stashes: Commit[]): Commit[] {
  if (!stashes.length) return commits
  const above = new Map<string, Commit[]>()
  for (const stash of stashes) above.set(stash.parents[0], [...(above.get(stash.parents[0]) ?? []), stash])
  return commits.flatMap((commit) => [...(above.get(commit.hash) ?? []), commit])
}

export type StashParts = { base: string; untracked?: string } | null

// A stash's base, and the commit holding its untracked files when it has one. Null for any other commit.
// The same rule as readStashCommits, but the branch walk runs only for a hash the stash list holds, so selecting an
// ordinary commit costs one cheap stash list read.
export async function stashParts(repo: string, hash: string): Promise<StashParts> {
  const line = (await git(repo, ['stash', 'list', '--format=%H %P'], { optionalLocks: true })).split('\n').find((entry) => entry.startsWith(`${hash} `))
  const parents = line?.split(' ').slice(1) ?? []
  if (parents.length < 2 || !(await offBranches(repo, [hash])).has(hash)) return null
  return { base: parents[0], untracked: parents[2] }
}

// The diff-tree revisions for a commit's own change: its first parent, or the empty tree for a root. A stash's change is
// its base to its saved working tree, then its untracked files as additions, never Git's internal index commit. Callers
// keep a path once, from the first part that has it: a tracked path is compared with its base, which the untracked copy is not.
export function changeRevisions(hash: string, stash: StashParts): string[][] {
  if (!stash) return [['--root', '-m', '--first-parent', hash]]
  return [[stash.base, hash], ...(stash.untracked ? [['--root', stash.untracked]] : [])]
}

// The selected commit's metadata. The message is last, so a field separator inside it cannot shift the other fields.
// The signature and stats are separate reads, so a failing GPG check or a huge commit still shows the rest.
export async function commitDetails(repo: string, hash: string, known?: StashParts): Promise<CommitDetails> {
  assertHash(hash)
  const format = ['%H', '%T', '%P', '%an', '%ae', '%cn', '%ce', '%aI', '%cI', '%B'].join(FIELD)
  const stash = known === undefined ? await stashParts(repo, hash) : known
  const [meta, signature, stats] = await Promise.all([
    git(repo, ['show', '-s', '--no-show-signature', `--format=${format}`, hash]),
    readSignature(repo, hash).catch(() => null),
    readStats(repo, hash, stash).catch(() => null),
  ])
  const fields = meta.split(FIELD)
  const [full, tree, parents, authorName, authorEmail, committerName, committerEmail, authorDate, committerDate] = fields
  return {
    body: fields.slice(9).join(FIELD).trim(),
    hash: full,
    tree,
    // A stash's other parents are Git's internal index and untracked commits.
    parents: stash ? [stash.base] : parents ? parents.split(' ') : [],
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
    authorDate,
    committerDate,
    signature,
    stats,
  }
}

// Only a full commit hash reaches git here, so no renderer text can be read as an option or a revision range.
export function assertHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error('Invalid commit hash.')
}

// The local branches, remote branches and tags that point at a commit now. Refs move while a commit's hash stays, so
// this is read again on every refresh instead of being kept with the commit. An annotated tag counts by its commit.
export async function commitRefs(repo: string, hash: string): Promise<{ branches: string[]; remotes: string[]; tags: string[] }> {
  assertHash(hash)
  const output = await git(repo, ['for-each-ref', `--points-at=${hash}`, '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { optionalLocks: true })
  const refs = { branches: [] as string[], remotes: [] as string[], tags: [] as string[] }
  for (const name of output.split('\n')) {
    if (name.startsWith('refs/heads/')) refs.branches.push(name.slice('refs/heads/'.length))
    // A remote's HEAD only names its default branch, which is listed already.
    else if (name.startsWith('refs/remotes/') && !name.endsWith('/HEAD')) refs.remotes.push(name.slice('refs/remotes/'.length))
    else if (name.startsWith('refs/tags/')) refs.tags.push(name.slice('refs/tags/'.length))
  }
  return refs
}

const SIGNATURE_MS = 5_000
const SIGNATURE_CODES = new Set<string>(['G', 'B', 'U', 'X', 'Y', 'R', 'E', 'N'])

async function readSignature(repo: string, hash: string): Promise<CommitDetails['signature']> {
  // GPG can stall, as when its first run starts its key daemon, so the check is bounded and the rest never waits on it.
  const [code, signer = ''] = (await git(repo, ['show', '-s', '--no-show-signature', `--format=%G?${FIELD}%GS`, hash], { timeoutMs: SIGNATURE_MS })).split(FIELD)
  return SIGNATURE_CODES.has(code) ? { code: code as SignatureCode, signer: signer.trim() } : null
}

// Same comparison as the commit's diff (commitDiff), with renames found.
async function readStats(repo: string, hash: string, stash: StashParts): Promise<CommitDetails['stats']> {
  const outputs = await Promise.all(changeRevisions(hash, stash).map((revisions) =>
    git(repo, ['diff-tree', '--numstat', '-r', '--find-renames', '--no-commit-id', '--no-color', ...revisions])))
  // A numstat line is added, deleted, then the path.
  const seen = new Set<string>()
  return parseNumstat(outputs.map((output) => {
    const lines = output.split('\n').filter((line) => !seen.has(line.split('\t').slice(2).join('\t')))
    for (const line of lines) seen.add(line.split('\t').slice(2).join('\t'))
    return lines.join('\n')
  }).join('\n'))
}

export function parseNumstat(output: string): NonNullable<CommitDetails['stats']> {
  const stats = { files: 0, additions: 0, deletions: 0 }
  for (const line of output.split('\n')) {
    const [added, deleted] = line.split('\t')
    if (deleted === undefined) continue
    stats.files++
    // A binary file shows '-' for both counts.
    stats.additions += Number(added) || 0
    stats.deletions += Number(deleted) || 0
  }
  return stats
}


// The path is a file name, never a pattern, so `[ab].txt` cannot match `a.txt`. --follow still tracks its renames.
export async function fileHistory(repo: string, path: string, limit = 200): Promise<Commit[]> {
  const output = await git(repo, ['--literal-pathspecs', 'log', '--follow', '--topo-order', `-n`, String(limit), `--format=${LOG_FORMAT}`, '--', path], {
    optionalLocks: true,
  })
  return parseLog(output)
}

export async function searchHistory(repo: string, query: string, authors: string[] = [], hidden: string[] = [], limit = 200): Promise<Commit[]> {
  const tips = await historyTips(repo, hidden)
  if (!tips) return []
  // -F/--fixed-strings keeps user text literal; -i matches case-insensitively in messages.
  // With an author filter, the message is matched as an escaped basic regexp instead, since -F would also apply to the author patterns.
  const grep = authors.length ? ['--regexp-ignore-case', `--grep=${query.replace(/[\\.[\]*^$]/g, '\\$&')}`, ...authorArgs(authors)] : ['-i', '-F', `--grep=${query}`]
  const output = await git(repo, ['log', ...tips.args, ...grep, `-n`, String(limit), `--format=${LOG_FORMAT}`], {
    optionalLocks: true, input: tips.input,
  })
  return parseLog(output)
}

// Every author name on the branches History lists, most commits first.
export async function readAuthors(repo: string): Promise<{ name: string; count: number }[]> {
  const output = await git(repo, ['log', '--branches', '--remotes', '--format=%an'], { optionalLocks: true })
  const counts = new Map<string, number>()
  for (const name of output.split('\n')) if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
