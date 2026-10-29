import { powerMonitor } from 'electron'
import { git } from './git/exec'
import { fetchAll } from './git/ops'
import { readStatus } from './git/status'
import { canonicalRepoPath, repoLockHolder, withRepoLock } from './repo-lock'

export interface FetchReport {
  fetched: string[]
  skipped: { repo: string; reason: string }[]
  failed: { repo: string; reason: string }[]
}

interface Options {
  intervalMinutes: number
  idleThresholdSeconds: number
  enabled: boolean
  repos: () => Promise<string[]>
  onReport: (report: FetchReport) => void
}

// Fetches every visible repo on an interval, but only while the user is at the machine.
// Fetch never pulls or pushes, and it never prompts for credentials, so it cannot block the user.
export class BackgroundFetcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private failures = new Map<string, { attempts: number; next: number; reported: boolean }>()

  constructor(private options: Options) {}

  start() {
    this.stop()
    if (!this.options.enabled) return
    // runOnce reports its own failures; one that escapes (the report send) must not become an unhandled rejection.
    this.timer = setInterval(() => void this.runOnce().catch((failure) => console.error('Background fetch failed:', failure)), this.options.intervalMinutes * 60_000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Skips the run if a previous one is still going or the user has been idle too long.
  async runOnce(): Promise<FetchReport | null> {
    if (this.running) return null
    if (powerMonitor.getSystemIdleTime() > this.options.idleThresholdSeconds) {
      return { fetched: [], skipped: [{ repo: '*', reason: 'user idle' }], failed: [] }
    }
    this.running = true
    const report: FetchReport = { fetched: [], skipped: [], failed: [] }
    try {
      // A failed scan is reported like a failed repo, under '*', so the run still ends with a report.
      const repos = await this.options.repos().catch((failure: unknown) => {
        report.failed.push({ repo: '*', reason: `Could not list repositories: ${failure instanceof Error ? failure.message : String(failure)}` })
        return [] as string[]
      })
      const seen = new Set<string>()
      for (const repo of repos) {
        let canonical = repo
        try {
          canonical = canonicalRepoPath(repo)
          if (seen.has(canonical)) continue
          seen.add(canonical)
          if ((this.failures.get(canonical)?.next ?? 0) > Date.now()) {
            report.skipped.push({ repo, reason: 'retry backoff' })
            continue
          }
          // The check and claim are synchronous, including through a symlink alias.
          if (repoLockHolder(canonical)) {
            report.skipped.push({ repo, reason: 'busy' })
            continue
          }
          await withRepoLock(repo, 'background-fetch', async (lockedRepo) => {
            const status = await readStatus(lockedRepo)
            if (!status.upstream && !(await hasRemote(lockedRepo))) {
              report.skipped.push({ repo, reason: 'no remote' })
              return
            }
            await fetchAll(lockedRepo)
            this.failures.delete(canonical)
            report.fetched.push(repo)
          })
        } catch (failure) {
          const previous = this.failures.get(canonical)
          const attempts = Math.min((previous?.attempts ?? 0) + 1, 6)
          // Three quiet failures, then at most one notification until a successful fetch. Never remove Git locks.
          const reported = previous?.reported || attempts > 3
          const wait = Math.min(Math.max(60_000, this.options.intervalMinutes * 60_000) * 2 ** (attempts - 1), 30 * 60_000)
          this.failures.set(canonical, { attempts, next: Date.now() + wait, reported })
          if (reported && !previous?.reported) report.failed.push({ repo, reason: failure instanceof Error ? failure.message : String(failure) })
        }
      }
    } finally {
      this.running = false
    }
    this.options.onReport(report)
    return report
  }
}

async function hasRemote(repo: string): Promise<boolean> {
  return (await git(repo, ['remote'])).trim().length > 0
}
