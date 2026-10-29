import type { CommitIdentity } from '../../shared/identity'
import { git, gitRaw, GitError } from './exec'

export async function readCommitIdentity(repo: string): Promise<CommitIdentity> {
  const pending = await gitRaw(repo, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
  if (pending.code === 0) {
    // Resolving a cherry-pick keeps the picked commit's author, even when defaults or environment change.
    const [name, email] = (await git(repo, ['show', '-s', '--format=%an%x00%ae', pending.stdout.toString('utf8').trim(), '--'])).trim().split('\0')
    return { name, email, error: null }
  }
  if (pending.code !== 1) throw new GitError(pending.stderr, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], pending.code, pending.stderr)
  const author = await gitRaw(repo, ['var', 'GIT_AUTHOR_IDENT'])
  const match = /^(.*) <([^<>]*)> -?\d+ [+-]\d{4}$/.exec(author.stdout.toString('utf8').trim())
  if (author.code === 0 && match) return { name: match[1], email: match[2], error: null }
  const configured = await Promise.all(['user.name', 'user.email'].map(async (key) => {
    const result = await gitRaw(repo, ['config', '--get', key])
    if (result.code > 1) throw new GitError(result.stderr, ['config', '--get', key], result.code, result.stderr)
    return result.stdout.toString('utf8').trim()
  }))
  return { name: configured[0], email: configured[1], error: author.stderr || 'Git could not determine a commit author.' }
}

export async function setCommitIdentity(repo: string, name: unknown, email: unknown, scope: unknown): Promise<CommitIdentity> {
  if (scope !== 'local' && scope !== 'global') throw new Error('Choose repository or global configuration.')
  if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\x00-\x1f\x7f<>]/.test(name)) throw new Error('Enter a valid author name.')
  if (typeof email !== 'string' || email.length > 320 || !/^[^\s<>@]+@[^\s<>@]+$/.test(email) || /[\x00-\x1f\x7f]/.test(email)) throw new Error('Enter a valid author email.')
  await git(repo, ['config', `--${scope}`, '--replace-all', 'user.name', name.trim()])
  await git(repo, ['config', `--${scope}`, '--replace-all', 'user.email', email])
  return readCommitIdentity(repo)
}
