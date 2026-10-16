import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readHead } from './git/head'

export interface RepoNode {
  kind: 'repo'
  path: string
  name: string
  branch?: string
}

export interface FolderNode {
  kind: 'folder'
  path: string
  name: string
  children: TreeNode[]
}

export type TreeNode = RepoNode | FolderNode

// Folders that never contain projects worth listing.
const SKIPPED_DIRECTORIES = new Set(['node_modules'])
export const MAX_DEPTH = 16

// Recursively finds Git repositories under root. Repos are leaves: once a folder is a repo,
// its nested folders (submodules, vendored copies) are not listed separately.
// Folders with no repos below them are dropped so the sidebar only shows useful structure.
export async function scanFolder(root: string, maxDepth = MAX_DEPTH): Promise<TreeNode | null> {
  const resolved = path.resolve(root)
  if (await isRepo(resolved)) return repoNode(resolved)
  const children = await scanChildren(resolved, 0, maxDepth)
  if (!children.length) return null
  return { kind: 'folder', path: resolved, name: path.basename(resolved), children }
}

async function scanChildren(directory: string, depth: number, maxDepth: number): Promise<TreeNode[]> {
  if (depth >= maxDepth) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const entry of entries) {
    // Symlinks are skipped on purpose: following them can loop or pull in folders outside the tree.
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
    const child = path.join(directory, entry.name)
    if (await isRepo(child)) {
      nodes.push(await repoNode(child))
      continue
    }
    const grandchildren = await scanChildren(child, depth + 1, maxDepth)
    if (grandchildren.length) nodes.push({ kind: 'folder', path: child, name: entry.name, children: grandchildren })
  }
  return sortNodes(nodes)
}

export async function repoNode(repoPath: string): Promise<RepoNode> {
  return { kind: 'repo', path: repoPath, name: path.basename(repoPath), branch: (await readHead(repoPath)) ?? undefined }
}

// A worktree or submodule has a .git file instead of a directory, so both count.
export async function isRepo(directory: string): Promise<boolean> {
  try {
    await fs.stat(path.join(directory, '.git'))
    return true
  } catch {
    return false
  }
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

export function flattenRepos(node: TreeNode): RepoNode[] {
  if (node.kind === 'repo') return [node]
  return node.children.flatMap(flattenRepos)
}
