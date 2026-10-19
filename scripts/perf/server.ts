// Read-only stand-in for the main process: serves the renderer API over HTTP so a headless page can run the real App.
// Usage: bun scripts/perf/server.ts <repo>...   (port 5792)
import { commitDiff, compare, detectMoves, workingDiff } from '../../src/main/git/diff'
import { commitDetails, readAuthors, readHistory, searchHistory } from '../../src/main/git/history'
import { readStatus } from '../../src/main/git/status'
import * as ops from '../../src/main/git/ops'
import { repoNode } from '../../src/main/scan'
import { DEFAULT_CONFIG } from '../../src/main/config'
import { readWorkingFile } from '../../src/main/editor'

const sources = process.argv.slice(2)
const handlers: Record<string, (...args: any[]) => unknown> = {
  getConfig: () => ({ ...DEFAULT_CONFIG, sources, settings: { ...DEFAULT_CONFIG.settings, backgroundFetch: false } }),
  getTree: () => Promise.all(sources.map((source) => repoNode(source))),
  repoLocks: () => ({ seq: 0, holders: {}, identities: {} }),
  status: (repo: string) => readStatus(repo),
  history: (repo: string, skip: number, limit: number, authors: string[] = []) => readHistory(repo, skip, limit, authors),
  searchHistory: (repo: string, query: string, authors: string[] = []) => searchHistory(repo, query, authors),
  authors: (repo: string) => readAuthors(repo),
  commit: async (repo: string, hash: string, context: number, ignoreWhitespace = false) => {
    const files = await commitDiff(repo, hash, context, ignoreWhitespace === true)
    return { files, moves: detectMoves(files), details: await commitDetails(repo, hash) }
  },
  working: async (repo: string, staged: boolean, context: number, path?: string, ignoreWhitespace = false) => {
    const files = await workingDiff(repo, staged, context, path ?? undefined, ignoreWhitespace === true)
    return { files, moves: detectMoves(files) }
  },
  compare: async (repo: string, from: string, to: string, ignoreWhitespace = false) =>
    compare(repo, await ops.resolveCommit(repo, from), await ops.resolveCommit(repo, to), ignoreWhitespace === true),
  branches: (repo: string) => ops.readBranches(repo),
  remotes: (repo: string) => ops.readRemotes(repo),
  stashes: (repo: string) => ops.readStashes(repo),
  tags: (repo: string) => ops.readTags(repo),
  worktrees: (repo: string) => ops.readWorktrees(repo),
  mergeBase: (repo: string, a: string, b: string) => ops.mergeBase(repo, a, b),
  readFile: (repo: string, file: string) => readWorkingFile(repo, file),
}

Bun.serve({
  port: 5792,
  async fetch(request) {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (request.method === 'OPTIONS') return new Response(null, { headers })
    const name = new URL(request.url).pathname.slice(1)
    const handler = handlers[name]
    if (!handler) return Response.json({ error: `${name} is not available in the perf harness` }, { status: 400, headers })
    try {
      return Response.json({ value: (await handler(...(await request.json()))) ?? null }, { headers })
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500, headers })
    }
  },
})
console.log('perf api on :5792 for', sources.join(', '))
