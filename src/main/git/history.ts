import { git } from './exec'

export interface Commit {
  hash: string
  parents: string[]
  refs: string[]
  author: string
  date: number
  subject: string
}

const FIELD = '\x1f'
const RECORD = '\x1e'

export function parseLog(output: string): Commit[] {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, parents, refs, author, date, subject] = record.split(FIELD)
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        author,
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

// Commits from every local and remote ref, newest topological first. Pages are offset-based and count only matching commits.
export async function readHistory(repo: string, skip: number, limit: number, authors: string[] = []): Promise<Commit[]> {
  const format = `%H${FIELD}%P${FIELD}%D${FIELD}%an${FIELD}%at${FIELD}%s${RECORD}`
  // Branches only: checkpoint and backup refs stay out of the list.
  const output = await git(repo, ['log', '--branches', '--remotes', '--topo-order', ...authorArgs(authors), `--skip=${skip}`, `-n`, String(limit), `--format=${format}`], {
    optionalLocks: true,
  })
  return parseLog(output)
}

// The full message, subject included. Renderers must use it as-is, not prepend the subject again.
export async function commitDetails(repo: string, hash: string): Promise<{ body: string }> {
  const format = `%B${FIELD}`
  const body = await git(repo, ['show', '-s', `--format=${format}`, hash])
  return { body: body.split(FIELD)[0].trim() }
}

export async function fileHistory(repo: string, path: string, limit = 200): Promise<Commit[]> {
  const format = `%H${FIELD}%P${FIELD}%D${FIELD}%an${FIELD}%at${FIELD}%s${RECORD}`
  const output = await git(repo, ['log', '--follow', '--topo-order', `-n`, String(limit), `--format=${format}`, '--', path], {
    optionalLocks: true,
  })
  return parseLog(output)
}

export async function searchHistory(repo: string, query: string, authors: string[] = [], limit = 200): Promise<Commit[]> {
  const format = `%H${FIELD}%P${FIELD}%D${FIELD}%an${FIELD}%at${FIELD}%s${RECORD}`
  // -F/--fixed-strings keeps user text literal; -i matches case-insensitively in messages.
  // With an author filter, the message is matched as an escaped basic regexp instead, since -F would also apply to the author patterns.
  const grep = authors.length ? ['--regexp-ignore-case', `--grep=${query.replace(/[\\.[\]*^$]/g, '\\$&')}`, ...authorArgs(authors)] : ['-i', '-F', `--grep=${query}`]
  const output = await git(repo, ['log', '--branches', '--remotes', ...grep, `-n`, String(limit), `--format=${format}`], {
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
