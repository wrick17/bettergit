import { git } from './exec'

// Uncommitted files, and commits to push and to pull against the upstream, which a fetch moves.
export interface RepoCounts {
  count: number
  ahead: number
  behind: number
}

// Counts uncommitted files and ahead/behind per repo in the background, so a large sidebar never waits on git.
export class DirtyCounter {
  private counts = new Map<string, RepoCounts>()
  private stale = new Set<string>()
  private queued = new Set<string>()
  private queue: string[] = []
  private running = 0

  constructor(private onCount: (path: string, counts: RepoCounts) => void, private concurrency = 4) {}

  request(paths: string[]) {
    for (const repo of paths) {
      const count = this.counts.get(repo)
      // A reloaded window has no counts yet, so cached counts are sent again without running git.
      if (count !== undefined && !this.stale.has(repo)) this.onCount(repo, count)
      else this.enqueue(repo)
    }
  }

  invalidate(paths: string[]) {
    for (const repo of paths) {
      this.stale.add(repo)
      this.enqueue(repo)
    }
  }

  private enqueue(repo: string) {
    if (this.queued.has(repo)) return
    this.queued.add(repo)
    this.queue.push(repo)
    this.drain()
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const repo = this.queue.shift()!
      this.running++
      // Cleared before git starts, so a change that lands mid-count marks the repo stale again.
      this.stale.delete(repo)
      void this.count(repo)
    }
  }

  // Counts a repo now, for an explicit Refresh. Rejects when Git cannot read it, so the caller can say which repo failed.
  async recount(repo: string) {
    const counts = await read(repo)
    this.counts.set(repo, counts)
    this.onCount(repo, counts)
  }

  private async count(repo: string) {
    try {
      const counts = await read(repo)
      this.counts.set(repo, counts)
      this.onCount(repo, counts)
    } catch {
      // A failed count emits nothing, so the sidebar keeps its last value.
    } finally {
      this.running--
      this.queued.delete(repo)
      if (this.stale.has(repo)) this.enqueue(repo)
      this.drain()
    }
  }
}

// Local only: status reads the refs already fetched, so it never touches the network.
async function read(repo: string): Promise<RepoCounts> {
  const [branch, ...files] = (await git(repo, ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], { optionalLocks: true })).split('\n')
  // The branch line ends like "## main...origin/main [ahead 1, behind 2]".
  return {
    count: files.filter(Boolean).length,
    ahead: Number(/\bahead (\d+)/.exec(branch)?.[1] ?? 0),
    behind: Number(/\bbehind (\d+)/.exec(branch)?.[1] ?? 0),
  }
}
