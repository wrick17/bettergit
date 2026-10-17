import { realpathSync } from 'node:fs'

// One Git write or network fetch per repo at a time. The claim is synchronous, so two calls cannot both pass the check,
// and the release runs in finally, so a failed write frees the repo. A second caller is refused, not queued.
// Holders are IDs (the IPC channel or 'background-fetch'). Only messages and snapshots show people a name.
const held = new Map<string, string>()
const identities = new Map<string, string>()
let seq = 0
const listeners = new Set<(snapshot: RepoLockSnapshot) => void>()

// Human names for holder IDs. An unknown ID falls back to a generic name, so a new channel never shows raw text.
const OPERATION_NAMES: Record<string, string> = {
  'background-fetch': 'Fetching in the background',
  'repo:fetch': 'Fetching',
  'repo:pull': 'Pulling',
  'repo:pull-from': 'Pulling',
  'repo:push': 'Pushing',
  'repo:stage': 'Staging',
  'repo:unstage': 'Unstaging',
  'repo:discard': 'Discarding',
  'repo:commit-changes': 'Committing',
  'repo:switch': 'Switching branch',
  'repo:create-branch': 'Creating branch',
  'repo:stash': 'Stashing',
  'repo:stash-action': 'Updating stash',
  'repo:reset-upstream': 'Resetting',
  'repo:checkout-detached': 'Checking out',
  'repo:branch-from': 'Creating branch',
  'repo:tag-from': 'Creating tag',
  'repo:cherry-pick': 'Cherry-picking',
  'repo:revert': 'Reverting',
  'repo:amend-message': 'Amending',
  'repo:backup': 'Saving backup',
  'repo:restore': 'Restoring',
  'repo:conflict-save': 'Saving resolution',
}

export function describeOperation(holder: string): string {
  return OPERATION_NAMES[holder] ?? 'Another Git action'
}

export interface RepoLockSnapshot {
  // Rises with every change, so a renderer can drop a reply that arrives after a newer event.
  seq: number
  // Canonical working-root path to holder ID.
  holders: Record<string, string>
  // Display paths stay unchanged in config and the sidebar.
  identities?: Record<string, string>
}

export class RepoBusyError extends Error {
  constructor(readonly repo: string, readonly holder: string) {
    super(`Another action is running in ${repo.split(/[\\/]/).pop()}: ${describeOperation(holder)}. Try again when it finishes.`)
    this.name = 'RepoBusyError'
  }
}

// Use the working root, not the common Git directory: linked worktrees have separate locks.
export function canonicalRepoPath(repo: string): string {
  return realpathSync.native(repo)
}

// Discovery supplies accepted display paths before the renderer selects a repo.
export function registerRepoLockPaths(repos: string[]): void {
  let updated = false
  for (const repo of repos) {
    const canonical = canonicalRepoPath(repo)
    if (identities.get(repo) === canonical) continue
    identities.set(repo, canonical)
    updated = true
  }
  if (updated) changed()
}

// The holder ID, for logic, or null when the repo is free.
export function repoLockHolder(repo: string): string | null {
  return held.get(canonicalRepoPath(repo)) ?? null
}

export function repoLockSnapshot(): RepoLockSnapshot {
  return { seq, holders: Object.fromEntries(held), identities: Object.fromEntries(identities) }
}

// Calls the listener after every claim and release. Returns the unsubscribe function.
export function subscribeRepoLocks(listener: (snapshot: RepoLockSnapshot) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function changed() {
  seq += 1
  const snapshot = repoLockSnapshot()
  for (const listener of listeners) listener(snapshot)
}

export async function withRepoLock<T>(
  repo: string, operation: string, run: (canonical: string) => T | Promise<T>, displayPath = repo,
): Promise<T> {
  const canonical = canonicalRepoPath(repo)
  const updated = identities.get(displayPath) !== canonical
  identities.set(displayPath, canonical)
  const holder = held.get(canonical)
  if (holder) {
    if (updated) changed()
    throw new RepoBusyError(displayPath, holder)
  }
  held.set(canonical, operation)
  changed()
  try {
    return await run(canonical)
  } finally {
    held.delete(canonical)
    changed()
  }
}
