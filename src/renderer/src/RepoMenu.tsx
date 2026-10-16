import type { RepoStatus } from '../../main/git/status'
import { PullFromDialog, StashDialog, type StashMode } from './StashDialog'
import type { BarItem } from './OverflowBar'

const api = window.bettergit

export type Run = (label: string, action: () => Promise<unknown>) => Promise<boolean>

export type RepoDialog = 'pull-from' | StashMode

interface RepoActions {
  repo: string
  status: RepoStatus | null
  // The label of the running action, or null. Run sets it, so it names the action that is running.
  busy: string | null
  run: Run
  onTab: (tab: 'changes' | 'history') => void
  onNote: (note: string) => void
  onError: (error: unknown) => void
  onDialog: (dialog: RepoDialog) => void
}

// The label each action shows while it runs. The keys are the labels that run receives.
const WORKING: Record<string, string> = {
  fetch: 'Fetching…',
  'pull-merge': 'Pulling…',
  'pull-rebase': 'Pulling…',
  push: 'Pushing…',
  reset: 'Resetting…',
  stash: 'Stashing…',
  pop: 'Popping stash…',
}

// Repository actions for the toolbar, grouped as in Better Source Control. Dialogs open through onDialog.
export function repoItems({ repo, status, busy, run, onTab, onNote, onError, onDialog }: RepoActions): BarItem[] {
  const working = busy !== null
  const shown = (key: string, label: string) => (busy === key ? WORKING[key] : label)
  const resetLabel = status?.upstream ? `Reset branch to ${status.upstream}…` : 'Reset branch (no upstream set)…'

  const copyBranch = () => {
    if (status?.head) navigator.clipboard.writeText(status.head).catch(onError)
  }

  const resetToUpstream = () => {
    if (!status?.upstream) return
    // Uncommitted edits are discarded with no backup. The backup ref only keeps the commits that the reset moves past.
    const message = `Discard uncommitted changes and reset ${status.head} to ${status.upstream}?\n\nThis cannot be undone. Commits you move past are kept in a backup ref.`
    if (!window.confirm(message)) return
    void run('reset', async () => onNote(`Backup kept at ${await api.resetToUpstream(repo)}`))
  }

  return [
    { key: 'graph', icon: 'graph', label: 'Show Commit Graph', group: 'view', onClick: () => onTab('history') },
    { key: 'copy', icon: 'copy', label: 'Copy Branch Name', group: 'view', disabled: !status?.head, onClick: copyBranch },
    { key: 'fetch', icon: 'refresh', label: shown('fetch', 'Fetch'), group: 'sync', disabled: working, onClick: () => void run('fetch', () => api.fetch(repo)) },
    { key: 'pullMerge', icon: 'pullMerge', label: shown('pull-merge', 'Pull and Merge'), group: 'sync', disabled: working, onClick: () => void run('pull-merge', () => api.pull(repo, 'merge')) },
    { key: 'pullRebase', icon: 'pullRebase', label: shown('pull-rebase', 'Pull and Rebase'), group: 'sync', disabled: working, onClick: () => void run('pull-rebase', () => api.pull(repo, 'rebase')) },
    { key: 'pullFrom', icon: 'pullFrom', label: 'Pull from…', group: 'sync', disabled: working, onClick: () => onDialog('pull-from') },
    { key: 'push', icon: 'push', label: shown('push', 'Push'), group: 'sync', disabled: working, onClick: () => void run('push', () => api.push(repo)) },
    { key: 'reset', icon: 'reset', label: shown('reset', resetLabel), group: 'reset', danger: true, disabled: working || !status?.upstream, onClick: resetToUpstream },
    { key: 'stash', icon: 'stash', label: shown('stash', 'Stash Changes'), group: 'stash', disabled: working, onClick: () => void run('stash', () => api.stash(repo, 'BetterGit stash')) },
    // Less common stash actions sit in their own group, after the stash itself.
    { key: 'stashList', icon: 'stashList', label: 'View Stash…', group: 'stashMore', disabled: working, onClick: () => onDialog('view') },
    { key: 'applyStash', icon: 'applyStash', label: 'Apply Stash…', group: 'stashMore', disabled: working, onClick: () => onDialog('apply') },
    { key: 'popStash', icon: 'popStash', label: 'Pop Stash…', group: 'stashMore', disabled: working, onClick: () => onDialog('pop') },
    { key: 'popLatest', icon: 'popLatest', label: shown('pop', 'Pop Latest Stash'), group: 'stashMore', disabled: working, onClick: () => void run('pop', () => api.stashAction(repo, 'pop', 'stash@{0}')) },
  ]
}

// The owner keeps the open dialog in state, since the toolbar items only report which one to open.
export function RepoDialogs({ repo, branch, dialog, run, onError, onClose }: {
  repo: string
  branch: string
  dialog: RepoDialog | null
  run: Run
  onError: (error: unknown) => void
  onClose: () => void
}) {
  if (!dialog) return null
  if (dialog === 'pull-from') return <PullFromDialog repo={repo} branch={branch} run={run} onError={onError} onClose={onClose} />
  return <StashDialog repo={repo} mode={dialog} run={run} onError={onError} onClose={onClose} />
}
