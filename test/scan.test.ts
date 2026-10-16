import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { flattenRepos, scanFolder, type TreeNode } from '../src/main/scan'
import { cleanup, freshSample } from './helpers'

let root: string
let tree: TreeNode | null

beforeAll(async () => {
  root = await freshSample()
  tree = await scanFolder(root)
})

afterAll(() => cleanup(root))

const repoNames = () => flattenRepos(tree!).map((repo) => path.relative(root, repo.path)).sort()

describe('scanFolder on the sample workspace', () => {
  test('lists every repo, including nested and linked worktrees', () => {
    expect(repoNames()).toEqual([
      'oss/deep/nested/tooling',
      'oss/lib-host',
      'standalone-repo',
      'work/acme/api-service',
      'work/acme/conflict-demo',
      'work/acme/web-app',
      'work/acme/web-app-release',
      'work/personal/detached-head',
      'work/personal/empty-repo',
      'work/personal/with-stash',
    ])
  })

  test('skips node_modules, dot folders, and repos nested inside another repo', () => {
    const names = repoNames()
    expect(names.some((name) => name.includes('node_modules') || name.startsWith('.'))).toBe(false)
    expect(names).not.toContain('oss/lib-host/vendor/inner')
  })

  test('drops folders that hold no repos', () => {
    const folders = JSON.stringify(tree)
    expect(folders).not.toContain('empty-folder')
    expect(folders).not.toContain('notes-only')
  })
})
