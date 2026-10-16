import { promises as fs } from 'node:fs'
import path from 'node:path'

// Reads HEAD from disk instead of spawning git: the sidebar can list about 1000 repos.
export async function readHead(repoPath: string): Promise<string | null> {
  try {
    const gitDir = await resolveGitDir(repoPath)
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return /^[0-9a-f]{40}/.test(head) ? head.slice(0, 7) : null
  } catch {
    return null
  }
}

// Worktrees and submodules have a .git file whose gitdir path is relative to the repo folder.
async function resolveGitDir(repoPath: string): Promise<string> {
  const dotGit = path.join(repoPath, '.git')
  if ((await fs.stat(dotGit)).isDirectory()) return dotGit
  const pointer = /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))
  if (!pointer) throw new Error(`No gitdir pointer in ${dotGit}`)
  return path.resolve(repoPath, pointer[1])
}
