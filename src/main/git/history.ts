import { git } from './exec'

export interface Commit {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  email: string
  date: number
  subject: string
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

// Commits from every local and remote ref, newest first. --date-order still lists every child before its parents but keeps
// concurrent branches interleaved by time, like Sublime Merge, so a merge sits near the commits it brings in and the graph
// holds few lines open at once. Pages are offset-based and count only matching commits.
export async function readHistory(repo: string, skip: number, limit: number, authors: string[] = []): Promise<Commit[]> {
  // Branches only: checkpoint and backup refs stay out of the list.
  const output = await git(repo, ['log', '--branches', '--remotes', '--date-order', ...authorArgs(authors), `--skip=${skip}`, `-n`, String(limit), `--format=${LOG_FORMAT}`], {
    optionalLocks: true,
  })
  return parseLog(output)
}

// The selected commit's metadata. The message is last, so a field separator inside it cannot shift the other fields.
// The signature and stats are separate reads, so a failing GPG check or a huge commit still shows the rest.
export async function commitDetails(repo: string, hash: string): Promise<CommitDetails> {
  assertHash(hash)
  const format = ['%H', '%T', '%P', '%an', '%ae', '%cn', '%ce', '%aI', '%cI', '%B'].join(FIELD)
  const [meta, signature, stats] = await Promise.all([
    git(repo, ['show', '-s', '--no-show-signature', `--format=${format}`, hash]),
    readSignature(repo, hash).catch(() => null),
    readStats(repo, hash).catch(() => null),
  ])
  const fields = meta.split(FIELD)
  const [full, tree, parents, authorName, authorEmail, committerName, committerEmail, authorDate, committerDate] = fields
  return {
    body: fields.slice(9).join(FIELD).trim(),
    hash: full,
    tree,
    parents: parents ? parents.split(' ') : [],
    author: { name: authorName, email: authorEmail },
    committer: { name: committerName, email: committerEmail },
    authorDate,
    committerDate,
    signature,
    stats,
  }
}

// Only a full commit hash reaches git here, so no renderer text can be read as an option or a revision range.
function assertHash(hash: unknown): asserts hash is string {
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

// Same comparison as the commit's diff (commitDiff): the first parent, or the empty tree for a root, with renames found.
async function readStats(repo: string, hash: string): Promise<CommitDetails['stats']> {
  const output = await git(repo, ['diff-tree', '--numstat', '-r', '--root', '-m', '--first-parent', '--find-renames', '--no-commit-id', '--no-color', hash])
  return parseNumstat(output)
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


export async function fileHistory(repo: string, path: string, limit = 200): Promise<Commit[]> {
  const output = await git(repo, ['log', '--follow', '--topo-order', `-n`, String(limit), `--format=${LOG_FORMAT}`, '--', path], {
    optionalLocks: true,
  })
  return parseLog(output)
}

export async function searchHistory(repo: string, query: string, authors: string[] = [], limit = 200): Promise<Commit[]> {
  // -F/--fixed-strings keeps user text literal; -i matches case-insensitively in messages.
  // With an author filter, the message is matched as an escaped basic regexp instead, since -F would also apply to the author patterns.
  const grep = authors.length ? ['--regexp-ignore-case', `--grep=${query.replace(/[\\.[\]*^$]/g, '\\$&')}`, ...authorArgs(authors)] : ['-i', '-F', `--grep=${query}`]
  const output = await git(repo, ['log', '--branches', '--remotes', ...grep, `-n`, String(limit), `--format=${LOG_FORMAT}`], {
    optionalLocks: true,
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
