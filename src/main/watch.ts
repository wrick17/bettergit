import path from 'node:path'
import watcher from '@parcel/watcher'

// Directories whose churn would drown out real changes. Git internals are watched selectively below.
const IGNORED = ['**/node_modules/**', '**/.git/objects/**', '**/.git/logs/**', '**/.git/lfs/**']

export interface WatchEvent {
  // Repo roots (paths) whose files changed, or the sources root when a repo appeared or vanished.
  repos: string[]
  tree: boolean
}

// Batches bursts of file events (a save, a checkout, a fetch) into one notification.
export class SourceWatcher {
  private subscriptions: watcher.AsyncSubscription[] = []
  private pending = new Map<string, Set<string>>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private onChange: (event: WatchEvent) => void, private delayMs = 300) {}

  async watch(sources: string[]) {
    await this.stop()
    for (const source of sources) {
      const subscription = await watcher.subscribe(source, (error, events) => {
        if (error) return
        for (const event of events) this.record(source, event.path)
      }, { ignore: IGNORED })
      this.subscriptions.push(subscription)
    }
  }

  private record(source: string, file: string) {
    const relative = path.relative(source, file)
    const parts = relative.split(path.sep)
    const gitIndex = parts.indexOf('.git')
    // A .git entry appearing or disappearing means a repo was added or removed in the tree.
    // A checkout moves .git/HEAD, and the sidebar shows each repo's branch, so that also rebuilds the tree.
    const headChanged = gitIndex !== -1 && parts[gitIndex + 1] === 'HEAD'
    const tree = (gitIndex !== -1 && gitIndex === parts.length - 1) || headChanged
    const repoRoot = gitIndex === -1 ? null : path.join(source, ...parts.slice(0, gitIndex))
    const bucket = this.pending.get('batch') ?? new Set<string>()
    if (tree) bucket.add(`tree:${source}`)
    if (repoRoot) bucket.add(`repo:${repoRoot}`)
    else if (!tree) bucket.add(`repo:${source}`)
    this.pending.set('batch', bucket)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  private flush() {
    const items = [...(this.pending.get('batch') ?? [])]
    this.pending.clear()
    this.timer = null
    const repos = items.filter((item) => item.startsWith('repo:')).map((item) => item.slice(5))
    const tree = items.some((item) => item.startsWith('tree:'))
    if (repos.length || tree) this.onChange({ repos: [...new Set(repos)], tree })
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await Promise.all(this.subscriptions.map((subscription) => subscription.unsubscribe()))
    this.subscriptions = []
  }
}
