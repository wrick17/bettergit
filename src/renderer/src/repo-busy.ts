import { useSyncExternalStore } from 'react'

// One write per repo at a time, which matches the main process guard. The slot lives at module level,
// so it survives a pane remount (repo switch) and a tab unmount.
const running = new Map<string, string>()
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

// Holders that main reports for writes this window did not start, such as a background fetch or another window's write.
// Their IDs match the IPC channel names, minus the 'repo:' prefix.
export interface RepoLockSnapshot {
  seq: number
  holders: Record<string, string>
  identities?: Record<string, string>
}

let remote: RepoLockSnapshot = { seq: -1, holders: {} }

// The canonical path main reported for a sidebar path, or the path itself before main has reported it.
export function repoIdentity(displayPath: string): string {
  return remote.identities?.[displayPath] ?? displayPath
}

// A local claim wins over main's report, so a write this window started stays busy until its own finally runs.
export function busyKey(repo: string): string | null {
  const canonical = repoIdentity(repo)
  for (const [displayPath, local] of running) {
    if (repoIdentity(displayPath) === canonical) return local
  }
  const holder = remote.holders[canonical]
  return holder ? holder.replace(/^repo:/, '') : null
}

// Applies a main snapshot. An older reply, such as the initial read that lands after a newer event, is dropped.
export function applyRepoLockSnapshot(snapshot: RepoLockSnapshot): void {
  if (snapshot.seq <= remote.seq) return
  remote = snapshot
  notify()
}

// Subscribes before reading the first snapshot, so no change between the two is missed. Failing to read it is reported.
export function connectRepoLocks(bridge: {
  snapshot: () => Promise<RepoLockSnapshot>
  subscribe: (listener: (snapshot: RepoLockSnapshot) => void) => () => void
}, onError: (failure: unknown) => void): () => void {
  const off = bridge.subscribe(applyRepoLockSnapshot)
  bridge.snapshot().then(applyRepoLockSnapshot).catch(onError)
  return off
}

export function subscribeRepoBusy(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useRepoBusy(repo: string): string | null {
  return useSyncExternalStore(subscribeRepoBusy, () => busyKey(repo))
}

// Runs one write for a repo. A second write to the same repo returns false without calling its action.
// The result reports only the write, so a later status reload cannot turn a finished write into a failure.
export async function runRepoAction(
  repo: string,
  key: string,
  action: () => Promise<unknown>,
  onError: (failure: unknown) => void,
): Promise<boolean> {
  // Refused while this window or main holds the repo. The caller shows the reason where it can.
  if (busyKey(repo) !== null) return false
  running.set(repo, key)
  notify()
  try {
    await action()
    return true
  } catch (failure) {
    onError(failure instanceof ActionError ? failure : new ActionError(`${workingLabel(key).replace('…', '')} in ${repo.split('/').pop()}`, failure, repo))
    return false
  } finally {
    running.delete(repo)
    notify()
  }
}

// IPC failures arrive as "Error invoking remote method '…': Error: <reason>". The reason alone is what the user reads.
export function failureReason(failure: unknown): string {
  return (failure instanceof Error ? failure.message : String(failure)).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

// Plain words and a next step for the Git failures people meet most, matched on Git's own text. Only what the text shows is
// claimed: "Repository not found" is also what hosts say for a private repo the account cannot see. Any other failure keeps
// its first line, without Git's "fatal:" prefix. Callers keep the full text for Details.
const KNOWN_FAILURES: [RegExp, string, string][] = [
  [/repository not found|repository '[^']*' not found|could not be found or you don't have permission/i,
    'The remote repository was not found, or this account cannot access it.',
    'Check the remote URL and that your Git account has access. Git hosts also report a private repository you cannot see as not found.'],
  [/Permission denied \(publickey/i, 'The remote refused this SSH key.',
    'Check that your SSH key is loaded (ssh-add -l in Terminal) and added to your account on the Git host, then retry.'],
  [/Host key verification failed/i, "The remote's SSH host key is not trusted on this Mac.",
    'Connect to the host once with ssh in Terminal to check and accept its key, then retry.'],
  [/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/i,
    'The remote did not accept your credentials.',
    'BetterGit cannot ask for a password. Update the token or password your Git credential helper saved, then retry.'],
  [/Could not resolve host|Network is unreachable|Connection (?:timed out|refused|reset)|Operation timed out|Failed to connect to|timed out after \d+ seconds/i,
    'Could not reach the remote.', 'Check your network or VPN connection, then retry.'],
  [/does not appear to be a git repository|No such remote/i, "This repository's remote is not set up correctly.",
    'Check the remote name and URL with git remote -v in Terminal.'],
  [/Could not read from remote repository/i, 'Could not read from the remote repository.',
    'Check the remote URL, your network and your access to the repository, then retry.'],
]

export function describeFailure(reason: string): { summary: string; hint?: string } {
  const known = KNOWN_FAILURES.find(([pattern]) => pattern.test(reason))
  if (known) return { summary: known[1], hint: known[2] }
  const lines = reason.split('\n').map((line) => line.trim()).filter(Boolean)
  return { summary: lines.length > 1 ? lines[0].replace(/^(?:fatal|error|remote): /i, '') : reason }
}

// A failure with the action it belongs to, such as "Pulling in bettergit", so the error popup can say what failed and why.
// `repo` is the sidebar path of the repo it happened in, for the popup's Go to repository. The message stays the bare
// reason, for callers that show it inline.
export class ActionError extends Error {
  constructor(readonly action: string, failure: unknown, readonly repo?: string) {
    super(failureReason(failure))
    this.name = 'ActionError'
  }
}

// The label each write shows while it runs. The keys are the operation names that callers pass to runRepoAction.
export const REPO_WORKING_LABELS: Record<string, string> = {
  fetch: 'Fetching…',
  'pull-merge': 'Pulling…',
  'pull-rebase': 'Pulling…',
  'pull-ff': 'Pulling…',
  'pull-autostash': 'Pulling…',
  pull: 'Pulling…',
  'fetch-plain': 'Fetching…',
  'fetch-tags': 'Fetching…',
  'fetch-prune': 'Fetching…',
  push: 'Pushing…',
  'push-force': 'Force pushing…',
  'push-lease': 'Force pushing…',
  'push-no-verify': 'Pushing…',
  switch: 'Switching…',
  'create-branch': 'Creating branch…',
  'delete-branch': 'Deleting branch…',
  'rename-branch': 'Renaming branch…',
  'set-upstream': 'Setting upstream…',
  'unset-upstream': 'Unsetting upstream…',
  reset: 'Resetting…',
  stash: 'Stashing…',
  pop: 'Popping stash…',
  apply: 'Applying stash…',
  stage: 'Staging…',
  unstage: 'Unstaging…',
  discard: 'Discarding…',
  delete: 'Deleting…',
  hunk: 'Updating hunk…',
  'hunk-stage': 'Staging hunk…',
  'hunk-unstage': 'Unstaging hunk…',
  'hunk-discard': 'Discarding hunk…',
  commit: 'Committing…',
  detach: 'Checking out…',
  branch: 'Creating branch…',
  tag: 'Creating tag…',
  cherry: 'Cherry-picking…',
  revert: 'Reverting…',
  amend: 'Amending…',
  'background-fetch': 'Fetching…',
  'pull-from': 'Pulling…',
  'stash-action': 'Updating stash…',
  'delete-untracked': 'Deleting…',
  'commit-changes': 'Committing…',
  'reset-upstream': 'Resetting…',
  'checkout-detached': 'Checking out…',
  'branch-from': 'Creating branch…',
  'tag-from': 'Creating tag…',
  'cherry-pick': 'Cherry-picking…',
  'amend-message': 'Amending…',
  backup: 'Saving backup…',
  restore: 'Restoring…',
  // Saving a conflict resolution. The conflict writer uses this key.
  resolve: 'Saving resolution…',
  'conflict-save': 'Saving resolution…',
  'conflict-reset': 'Resetting resolution…',
  'file-save': 'Saving file…',
}

// A key can name a target after a colon, such as discard:<path>. The label depends only on the operation.
export function workingLabel(busy: string): string {
  return REPO_WORKING_LABELS[busy.split(':')[0]] ?? 'Working…'
}

// The reason a control gives when a write is running in its repo. Undefined when nothing runs.
export function blockedReason(busy: string | null): string | undefined {
  return busy === null ? undefined : `Another action is running: ${workingLabel(busy)}`
}

// A write, then a reload. A failed write goes to onError and returns false, and the reload does not run.
// A failed reload also goes to onError, but the write still returns true, so a refresh cannot fail a finished Git write.
export async function runRepoWrite(
  repo: string,
  key: string,
  action: () => Promise<unknown>,
  { onError, reload }: { onError: (failure: unknown) => void; reload: () => void },
): Promise<boolean> {
  const ok = await runRepoAction(repo, key, action, onError)
  if (!ok) return false
  try {
    reload()
  } catch (failure) {
    onError(failure)
  }
  return true
}
