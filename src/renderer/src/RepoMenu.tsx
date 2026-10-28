import type { RepoStatus } from '../../main/git/status'
import { PullFromDialog, StashDialog, type StashMode } from './StashDialog'
import type { BarItem } from './OverflowBar'
import { confirmOverBlur } from './confirm'
import { blockedReason, workingLabel } from './repo-busy'

const api = window.bettergit

export type Run = (label: string, action: () => Promise<unknown>) => Promise<boolean>

export type RepoDialog = 'pull-from' | StashMode

interface RepoActions {
  repo: string
  status: RepoStatus | null
  // The write running in this repo, or null. It comes from the repo-busy store, so every surface shows the same one.
  busy: string | null
  run: Run
  onTab: (tab: 'changes' | 'history') => void
  onNote: (note: string) => void
  onError: (error: unknown) => void
  onDialog: (dialog: RepoDialog) => void
}

// Repository actions for the toolbar, grouped as in Better Source Control. Dialogs open through onDialog.
// Shortcuts repeat the Repository menu's accelerators (main/menu.ts), which run the same actions.
export function repoItems({ repo, status, busy, run, onTab, onNote, onError, onDialog }: RepoActions): BarItem[] {
  // The running action shows its working label and spinner. Every other write in the repo is blocked and says why.
  // A toolbar button also runs for the options in its dropdown that have no button of their own.
  const state = (key: string, label: string, also: string[] = []) => {
    const running = busy !== null && (busy === key || also.includes(busy))
    return { label: running ? workingLabel(busy) : label, busy: running, blocked: busy !== null && !running ? blockedReason(busy) : undefined }
  }
  const blocked = busy !== null ? blockedReason(busy) : undefined
  const resetLabel = status?.upstream ? `Reset branch to ${status.upstream}…` : 'Reset branch (no upstream set)…'

  const copyBranch = () => {
    if (status?.head) navigator.clipboard.writeText(status.head).catch(onError)
  }

  const resetToUpstream = async () => {
    if (!status?.upstream) return
    // Uncommitted edits are discarded with no backup. The backup ref only keeps the commits that the reset moves past.
    const message = `Discard uncommitted changes and reset ${status.head} to ${status.upstream}?\n\nThis cannot be undone. Commits you move past are kept in a backup ref.`
    if (!(await confirmOverBlur(message))) return
    void run('reset', async () => onNote(`Backup kept at ${await api.resetToUpstream(repo)}`))
  }

  // The Fetch dropdown offers the two syncs the button stands for: the same fetch as the button, and Pull and Merge.
  const fetchMenu: BarItem[] = [
    { key: 'fetch', icon: 'refresh', ...state('fetch', 'fetch', ['background-fetch']), detail: 'Retrieves changes from every remote', group: 'fetch', onClick: () => void run('fetch', () => api.fetch(repo)) },
    { key: 'pull-merge', icon: 'pullMerge', ...state('pull-merge', 'pull'), detail: 'Retrieves changes from the remote and merges them into the current branch', group: 'fetch', onClick: () => void run('pull-merge', () => api.pull(repo, 'merge')) },
  ]

  // A force push replaces the upstream branch, so it names both and asks first. Main refuses it if either changed since.
  const forcePush = async (key: string, mode: 'force' | 'force-with-lease') => {
    if (!status?.head || !status.upstream) return
    const { head, upstream } = status
    const message = mode === 'force'
      ? `Force push ${head} to ${upstream}?\n\nCommits on ${upstream} that ${head} does not have are removed from the remote.`
      : `Force push ${head} to ${upstream} with lease?\n\nGit refuses if ${upstream} moved since your last fetch. Otherwise commits on it that ${head} does not have are removed from the remote.`
    if (!(await confirmOverBlur(message))) return
    void run(key, () => api.push(repo, mode, { branch: head, upstream }))
  }
  const noForce = !status?.head || !status.upstream
  const pushMenu: BarItem[] = [
    { key: 'push', icon: 'push', ...state('push', 'push'), detail: 'Sends changes from the current local branch to the remote', group: 'push', onClick: () => void run('push', () => api.push(repo)) },
    { key: 'push-force', icon: 'push', ...state('push-force', 'push --force'), detail: 'Replaces the branch on the remote with the current local branch', group: 'push', danger: true, disabled: noForce, onClick: () => void forcePush('push-force', 'force') },
    { key: 'push-lease', icon: 'push', ...state('push-lease', 'push --force-with-lease'), detail: 'push --force, but checks that the remote branch has not been updated since the last fetch', group: 'push', danger: true, disabled: noForce, onClick: () => void forcePush('push-lease', 'force-with-lease') },
    { key: 'push-no-verify', icon: 'push', ...state('push-no-verify', 'push --no-verify'), detail: 'Push without running the pre-push hook', group: 'push', onClick: () => void run('push-no-verify', () => api.push(repo, 'no-verify')) },
  ]

  return [
    { key: 'graph', icon: 'graph', label: 'Show Commit Graph', group: 'view', onClick: () => onTab('history') },
    { key: 'copy', icon: 'copy', label: 'Copy Branch Name', group: 'view', disabled: !status?.head, onClick: copyBranch },
    { key: 'fetch', icon: 'refresh', ...state('fetch', 'Fetch', ['background-fetch']), group: 'sync', shortcut: '⇧⌘F', menu: fetchMenu, onClick: () => void run('fetch', () => api.fetch(repo)) },
    { key: 'pullMerge', icon: 'pullMerge', ...state('pull-merge', 'Pull and Merge'), group: 'sync', shortcut: '⇧⌘L', onClick: () => void run('pull-merge', () => api.pull(repo, 'merge')) },
    { key: 'pullRebase', icon: 'pullRebase', ...state('pull-rebase', 'Pull and Rebase'), group: 'sync', onClick: () => void run('pull-rebase', () => api.pull(repo, 'rebase')) },
    { key: 'pullFrom', icon: 'pullFrom', ...state('pull', 'Pull from…'), group: 'sync', onClick: () => onDialog('pull-from') },
    { key: 'push', icon: 'push', ...state('push', 'Push', ['push-force', 'push-lease', 'push-no-verify']), group: 'sync', shortcut: '⇧⌘P', menu: pushMenu, onClick: () => void run('push', () => api.push(repo)) },
    { key: 'reset', icon: 'reset', ...state('reset', resetLabel), group: 'reset', danger: true, disabled: !status?.upstream, onClick: resetToUpstream },
    { key: 'stash', icon: 'stash', ...state('stash', 'Stash Changes'), group: 'stash', shortcut: '⇧⌘H', onClick: () => void run('stash', () => api.stash(repo, 'BetterGit stash')) },
    // Less common stash actions sit in their own group, after the stash itself. View Stash only reads, so it stays usable while busy.
    { key: 'stashList', icon: 'stashList', label: 'View Stash…', group: 'stashMore', onClick: () => onDialog('view') },
    { key: 'applyStash', icon: 'applyStash', label: 'Apply Stash…', group: 'stashMore', blocked, onClick: () => onDialog('apply') },
    { key: 'popStash', icon: 'popStash', label: 'Pop Stash…', group: 'stashMore', blocked, onClick: () => onDialog('pop') },
    { key: 'popLatest', icon: 'popLatest', ...state('pop', 'Pop Latest Stash'), group: 'stashMore', onClick: () => void run('pop', () => api.stashAction(repo, 'pop', 'stash@{0}')) },
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
