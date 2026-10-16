import { git } from './exec'

// Counts uncommitted files per repo in the background, so a large sidebar never waits on git.
export class DirtyCounter {
  private counts = new Map<string, number>()
  private stale = new Set<string>()
  private queued = new Set<string>()
  private queue: string[] = []
  private running = 0

  constructor(private onCount: (path: string, count: number) => void, private concurrency = 4) {}

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

  private async count(repo: string) {
    try {
      const output = await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'], { optionalLocks: true })
      const count = output.split('\n').filter(Boolean).length
      this.counts.set(repo, count)
      this.onCount(repo, count)
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
