import { useSyncExternalStore } from 'react'
import type { RepoNode } from '../../main/scan'
import { busyKey, describeFailure, failureReason, runRepoWrite } from './repo-busy'

// The sidebar's one batch at a time: Refresh, Fetch All or Pull All. Its menu closes at once, so the sidebar shows the run
// and its result here. `folder` is the row that started it, or null for the app menu.
export interface BatchStatus {
  folder: string | null
  running: boolean
  text: string
  // Each repo that failed or was skipped, kept until the next batch or a dismiss.
  problems: string[]
  failed: boolean
}

let status: BatchStatus | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const set = (next: BatchStatus | null) => {
  status = next
  listeners.forEach((listener) => listener())
}

// The status text of a whole-sidebar Refresh, which the Repositories header's button spins for.
export const REFRESHING = 'Refreshing repositories…'

export const useBatchStatus = () => useSyncExternalStore(subscribe, () => status)
export const batchRunning = () => !!status?.running
export const dismissBatch = () => { if (!status?.running) set(null) }

// Rescans the sources. `refresh` may resolve to repos it could not read, which are named here and returned; the rest still
// count as refreshed. Returns false when a batch is already running. A failure shows here and rejects for the error popup.
export async function runRefresh(folder: string | null, refresh: () => Promise<{ repo: string; reason: string }[] | void>): Promise<{ repo: string; reason: string }[] | false> {
  if (batchRunning()) return false
  set({ folder, running: true, text: REFRESHING, problems: [], failed: false })
  let failures: { repo: string; reason: string }[]
  try {
    failures = (await refresh()) ?? []
  } catch (failure) {
    set({ folder, running: false, text: `Refresh failed: ${failureReason(failure)}`, problems: [], failed: true })
    throw failure
  }
  set({ folder, running: false, text: `Refreshed repositories${failures.length ? `, ${failures.length} failed` : ''}`, failed: failures.length > 0,
    problems: failures.map(({ repo, reason }) => `${repo.split('/').pop()}: ${describeFailure(reason).summary}`) })
  return failures
}

// Runs one write in each repo in turn. A busy repo is skipped and named, and every failure is kept with its repo.
// Returns each failed repo's path and reason, or null when a batch is already running.
export async function runBatch(folder: string | null, title: string, verb: string, key: string, discover: RepoNode[] | (() => Promise<RepoNode[]>),
  action: (path: string) => Promise<unknown>, reload: () => void): Promise<{ repo: string; reason: string }[] | null> {
  if (batchRunning()) return null
  // Claim before discovery too, so a delayed scan cannot queue a second batch behind the current one.
  set({ folder, running: true, text: `${title}: finding repositories…`, problems: [], failed: false })
  let repos: RepoNode[]
  try {
    repos = typeof discover === 'function' ? await discover() : discover
  } catch (failure) {
    set({ folder, running: false, text: `${title} failed: ${failureReason(failure)}`, problems: [], failed: true })
    throw failure
  }
  if (!repos.length) {
    set({ folder, running: false, text: `${title}: no repositories`, problems: [], failed: false })
    return []
  }
  const failures: { repo: string; reason: string }[] = []
  const skipped: string[] = []
  try {
    for (const [index, node] of repos.entries()) {
      set({ folder, running: true, text: `${title}: ${index} of ${repos.length}, ${verb} ${node.name}`, problems: [], failed: false })
      if (busyKey(node.path)) {
        skipped.push(`${node.name}: skipped, another action was running`)
        continue
      }
      await runRepoWrite(node.path, key, () => action(node.path), {
        onError: (failure) => failures.push({ repo: node.path, reason: failureReason(failure) }),
        reload: () => undefined,
      })
    }
  } finally {
    const ok = repos.length - failures.length - skipped.length
    const counts = [`${ok} succeeded`, skipped.length && `${skipped.length} skipped`, failures.length && `${failures.length} failed`].filter(Boolean)
    set({ folder, running: false, text: `${title} done: ${counts.join(', ')}`, problems: [...failures.map(({ repo, reason }) => `${repo.split('/').pop()}: ${describeFailure(reason).summary}`), ...skipped], failed: failures.length > 0 })
    reload()
  }
  return failures
}
