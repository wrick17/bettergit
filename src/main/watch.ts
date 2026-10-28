import path from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
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
  // Whether each directory seen holds a .git, so a working file is credited to its own repo. Cleared when repos come or go.
  private isRepo = new Map<string, boolean>()

  constructor(private onChange: (event: WatchEvent) => void, private delayMs = 300) {}

  async watch(sources: string[]) {
    await this.stop()
    for (const source of sources) {
      // Events name real paths (/private/tmp for /tmp on macOS). They are read against the real source and reported
      // under the configured one, which is how the renderer names repos.
      const real = realpathSync(source)
      const subscription = await watcher.subscribe(source, (error, events) => {
        if (error) return
        for (const event of events) this.record(source, path.join(source, path.relative(real, event.path)))
      }, { ignore: IGNORED })
      this.subscriptions.push(subscription)
    }
  }

  private record(source: string, file: string) {
    const relative = path.relative(source, file)
    const parts = relative.split(path.sep)
    const gitIndex = parts.indexOf('.git')
    // A fetch with nothing new still rewrites FETCH_HEAD and takes ref locks; a real update also renames a ref or packed-refs.
    if (gitIndex !== -1 && (parts[gitIndex + 1] === 'FETCH_HEAD' || relative.endsWith('.lock'))) return
    // A .git entry appearing or disappearing means a repo was added or removed in the tree.
    // A checkout moves .git/HEAD, and the sidebar shows each repo's branch, so that also rebuilds the tree.
    const headChanged = gitIndex !== -1 && parts[gitIndex + 1] === 'HEAD'
    const repoRoots = gitIndex === -1 ? this.reposOf(source, path.dirname(file)) : [path.join(source, ...parts.slice(0, gitIndex))]
    // A folder moved in or out (mv, Finder) reports only the folder, not its .git. An entry outside every repo can be one.
    const outsideRepos = gitIndex === -1 && !repoRoots.length && relative !== '' && !path.basename(file).startsWith('.')
    const tree = (gitIndex !== -1 && gitIndex === parts.length - 1) || headChanged || outsideRepos
    if (tree) this.isRepo.clear()
    const bucket = this.pending.get('batch') ?? new Set<string>()
    if (tree) bucket.add(`tree:${source}`)
    for (const root of repoRoots) bucket.add(`repo:${root}`)
    if (!repoRoots.length && !tree) bucket.add(`repo:${source}`)
    this.pending.set('batch', bucket)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  // Every directory at or above `dir`, within the source, that holds a .git. A file in a nested repo or submodule also
  // changes the status of each repo around it.
  private reposOf(source: string, dir: string): string[] {
    const roots: string[] = []
    for (let current = dir; current.startsWith(source); current = path.dirname(current)) {
      let known = this.isRepo.get(current)
      if (known === undefined) this.isRepo.set(current, (known = existsSync(path.join(current, '.git'))))
      if (known) roots.push(current)
      if (current === source) break
    }
    return roots
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
