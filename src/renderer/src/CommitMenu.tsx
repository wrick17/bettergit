import { useEffect, useState } from 'react'
import type { Commit } from '../../main/git/history'
import { confirmOverBlur } from './confirm'
import type { BarItem } from './OverflowBar'
import { hiddenBranches, setHiddenBranches } from './prefs'
import { PromptDialog } from './PromptDialog'
import { ActionError, blockedReason, busyKey, REPO_WORKING_LABELS, runRepoWrite } from './repo-busy'

const api = window.bettergit

export type Prompt = 'branch' | 'tag' | 'amend' | 'ref'
// Whether the commit is already on the upstream. "unknown" means the check failed.
type PushCheck = 'checking' | 'pushed' | 'local' | 'unknown'

export interface CommitInput {
  repo: string
  commit: Commit
  // The full commit message, subject and body, as git stores it.
  message: string
  head: string | null
  // The checked-out branch's name, or null when HEAD is detached.
  branch?: string | null
  // The branches at this commit now, by short name, as commitRefs reads them. Null until they are read.
  refs?: { branches: string[]; remotes: string[] } | null
  upstream: string | null
  webBase: string | null
  onOpenChanges: () => void
  onCompare: (label: string, ref: string) => void
  onChanged?: () => void
  onError: (error: unknown) => void
}

// The caller owns the prompt and notice, because it renders the dialogs and the notice.
export interface CommitUi {
  setPrompt: (prompt: Prompt) => void
  setNotice: (notice: string) => void
  // The write running in this repo, or null. The state changes wait for it, and the read-only items do not.
  pending: string | null
}

// Turns a git remote into the https base of its web page. Covers git@host:owner/repo and https://host/owner/repo.
export function remoteWebBase(remotes: { name: string; url: string }[]): string | null {
  const remote = remotes.find((item) => item.name === 'origin') ?? remotes[0]
  const match = remote?.url.trim().match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/)
  return match ? `https://${match[1]}/${match[2]}` : null
}

// Git changes the repository, so the parent reloads after a successful write. Failures go to the error banner.
// `always` reloads after a failure too, for writes that can stop part way on a conflict.
function runGit({ repo, onChanged, onError }: CommitInput, key: string, action: () => Promise<unknown>, always = false) {
  return runRepoWrite(repo, key, action, { onError, reload: () => onChanged?.(), always })
}

export function commitItems(input: CommitInput, ui: CommitUi): BarItem[] {
  const { repo, commit, message, head, upstream, webBase, onOpenChanges, onCompare, onError } = input
  const { hash, subject } = commit
  const { pending } = ui
  // The running state change shows its working label and spinner. The others wait for it and say why.
  const state = (key: string, label: string) => {
    const running = pending === key
    return { label: running ? REPO_WORKING_LABELS[key] : label, busy: running, blocked: pending !== null && !running ? blockedReason(pending) : undefined }
  }

  const run = (key: string, action: () => Promise<unknown>) => runGit(input, key, action)
  const copy = (what: string, text: string) => navigator.clipboard.writeText(text).catch((failure: unknown) => onError(new ActionError(`Copying the ${what}`, failure)))
  const openRemote = () => api.openExternal(`${webBase}/commit/${hash}`).catch((failure: unknown) => onError(new ActionError('Opening the commit on the remote', failure)))
  const compareRemote = () => { if (upstream) onCompare(upstream, upstream) }
  const compareBase = () => {
    if (head) api.mergeBase(repo, head, hash).then((base: string) => onCompare(`merge base ${base.slice(0, 7)}`, base)).catch((failure: unknown) => onError(new ActionError('Finding the merge base', failure)))
  }
  const revert = async () => {
    if (await confirmOverBlur(`Revert "${subject}"? This adds a new commit that undoes it.`)) run('revert', () => api.revertCommit(repo, hash))
  }
  const cherryPick = () => run('cherry', () => api.cherryPick(repo, hash).then((backup: string) => ui.setNotice(`Cherry-picked. Backup saved as ${backup}.`)))

  // Each branch at this commit, by exact ref at this commit, so main refuses one that moved or was replaced since.
  const deleteLocal = async (name: string) => {
    const fullRef = `refs/heads/${name}`
    if (!(await confirmOverBlur(`Delete the local branch ${name}?\n\nGit refuses if it has commits not merged into its upstream, or into HEAD when it has none. No remote branch is deleted.`))) return
    if (await run('delete-branch', () => api.deleteBranch(repo, { fullRef, hash }))) setHiddenBranches(repo, hiddenBranches(repo).filter((ref) => ref !== fullRef))
  }
  // The remote is named from the configured remotes, longest match first, since a remote's name may hold a slash.
  const deleteRemote = async (name: string) => {
    let remote = name.slice(0, name.indexOf('/'))
    try {
      remote = (await api.remotes(repo)).map((entry) => entry.name).filter((entry) => name.startsWith(`${entry}/`))
        .sort((a, b) => b.length - a.length)[0] ?? remote
    } catch { /* the first path segment is Git's default layout; main resolves the exact remote again */ }
    const branchName = name.slice(remote.length + 1)
    const message = `Delete the branch ${branchName} from the remote ${remote}?\n\nThis pushes a deletion of refs/heads/${branchName} on ${remote} (refs/remotes/${name} here), for everyone who uses that remote. Git refuses if it moved since your last fetch. Local branches, including any that track it, are kept.`
    if (await confirmOverBlur(message)) void run('delete-remote-branch', () => api.deleteRemoteBranch(repo, { fullRef: `refs/remotes/${name}`, hash }))
  }
  const into = input.branch ?? 'HEAD'
  // Both stop on a conflict, so they reload on failure too, which shows the Continue and Abort bar.
  const merge = async (name: string, fullRef: string) => {
    if (!(await confirmOverBlur(`Merge ${name} into ${into}?\n\nGit fast-forwards when it can, or adds a merge commit. On a conflict the merge stops, so you can resolve the files in Changes, then Continue or Abort. A backup ref of ${into} is kept.`))) return
    void runGit(input, 'merge-branch', () => api.mergeBranch(repo, { fullRef, hash }).then((backup: string) => ui.setNotice(`Merged ${name}. Backup saved as ${backup}.`)), true)
  }
  const rebase = async (name: string, fullRef: string) => {
    if (!(await confirmOverBlur(`Rebase ${into} onto ${name}?\n\nIts commits not on ${name} are replayed on top of it with new hashes, so pushing them again after an earlier push needs a force push. On a conflict the rebase stops, so you can resolve the files in Changes, then Continue or Abort. A backup ref of ${into} is kept.`))) return
    void runGit(input, 'rebase-branch', () => api.rebaseBranch(repo, { fullRef, hash }).then((backup: string) => ui.setNotice(`Rebased onto ${name}. Backup saved as ${backup}.`)), true)
  }
  const integrate = (name: string, fullRef: string, group: string): BarItem[] => [
    { key: `merge:${fullRef}`, icon: 'pullMerge', ...state('merge-branch', `Merge ${name} into ${into}…`), group, onClick: () => void merge(name, fullRef) },
    { key: `rebase:${fullRef}`, icon: 'pullRebase', ...state('rebase-branch', `Rebase ${into} onto ${name}…`), group, onClick: () => void rebase(name, fullRef) },
  ]
  const branchItems: BarItem[] = [
    ...(input.refs?.branches ?? []).filter((name) => name !== input.branch).flatMap((name): BarItem[] => [
      { key: `checkout:${name}`, icon: 'branch', ...state('switch', `Checkout ${name}`), group: `ref:${name}`,
        onClick: () => void run('switch', () => api.switchBranch(repo, { fullRef: `refs/heads/${name}`, hash })) },
      ...integrate(name, `refs/heads/${name}`, `ref:${name}`),
      { key: `delete:${name}`, icon: 'trash', ...state('delete-branch', `Delete ${name}`), danger: true, group: `ref:${name}`, onClick: () => void deleteLocal(name) },
      { key: `copy:${name}`, icon: 'copy', label: `Copy '${name}'`, group: `ref:${name}`, onClick: () => copy('branch name', name) },
    ]),
    // As Sublime Merge's remote ref menu: create its local branch, merge, rebase, delete, copy. Creating checks out a local
    // branch that tracks it, or reuses the one that already tracks it exactly.
    ...(input.refs?.remotes ?? []).flatMap((name): BarItem[] => [
      { key: `track:${name}`, icon: 'branch', ...state('switch', `Create Local Branch from ${name}`), group: `remote:${name}`,
        onClick: () => void run('switch', () => api.switchBranch(repo, { fullRef: `refs/remotes/${name}`, hash })) },
      ...integrate(name, `refs/remotes/${name}`, `remote:${name}`),
      { key: `delete-remote:${name}`, icon: 'trash', ...state('delete-remote-branch', `Delete ${name}…`), danger: true, group: `remote:${name}`, onClick: () => void deleteRemote(name) },
      { key: `copy-remote:${name}`, icon: 'copy', label: `Copy '${name}'`, group: `remote:${name}`, onClick: () => copy('branch name', name) },
    ]),
  ]

  return [
    ...branchItems,
    { key: 'changes', icon: 'diff', label: 'Show diff', group: 'open', onClick: onOpenChanges },
    { key: 'remote', icon: 'externalLink', label: 'Open Changes on Remote', disabled: !webBase, group: 'open', onClick: openRemote },
    { key: 'hash', icon: 'hash', label: 'Copy Commit Hash', group: 'copy', onClick: () => copy('commit hash', hash) },
    { key: 'message', icon: 'copy', label: 'Copy Commit Message', group: 'copy', onClick: () => copy('commit message', message) },
    { key: 'link', icon: 'link', label: 'Copy Commit Remote Link', disabled: !webBase, group: 'copy', onClick: () => copy('commit link', `${webBase}/commit/${hash}`) },
    { key: 'compareRemote', icon: 'compare', label: 'Compare with Remote', disabled: !upstream, group: 'compare', onClick: compareRemote },
    { key: 'compareBase', icon: 'mergeBase', label: 'Compare with Merge Base', disabled: !head, group: 'compare', onClick: compareBase },
    { key: 'compareRef', icon: 'compareRef', label: 'Compare with Ref…', group: 'compare', onClick: () => ui.setPrompt('ref') },
    // State changes come last and are rare, so the "…" menu takes them first when the bar is narrow.
    { key: 'detach', icon: 'locate', ...state('detach', 'Checkout Detached'), group: 'checkout', onClick: () => run('detach', () => api.checkoutDetached(repo, hash)) },
    { key: 'branch', icon: 'branch', ...state('branch', 'Create Branch from Commit…'), group: 'checkout', onClick: () => ui.setPrompt('branch') },
    { key: 'tag', icon: 'tag', ...state('tag', 'Create Tag from Commit…'), group: 'checkout', onClick: () => ui.setPrompt('tag') },
    { key: 'cherry', icon: 'cherry', ...state('cherry', 'Cherry Pick'), group: 'change', onClick: cherryPick },
    { key: 'revert', icon: 'undo', ...state('revert', 'Revert Commit…'), group: 'change', onClick: revert },
    { key: 'amend', icon: 'edit', ...state('amend', 'Amend Commit Message…'), disabled: hash !== head, group: 'change', onClick: () => ui.setPrompt('amend') },
  ]
}

export function CommitDialogs({ input, prompt, onClose }: {
  input: CommitInput
  prompt: Prompt | null
  onClose: () => void
}) {
  const { repo, commit, message, upstream, onCompare, onError } = input
  const { hash, subject } = commit
  const short = hash.slice(0, 7)
  // The dialog closes only when its write can start, so a refused submit keeps the typed text and says why.
  const submit = (key: string, action: () => Promise<unknown>) => {
    const reason = blockedReason(busyKey(repo))
    if (reason) return onError(new Error(reason))
    onClose()
    void runGit(input, key, action)
  }
  // Keyed to the commit it checked, so a reply for an earlier commit is never shown for this one.
  const [check, setCheck] = useState<{ hash: string; state: PushCheck }>({ hash, state: 'checking' })
  const checkState = check.hash === hash ? check.state : 'checking'

  // An amended commit that is already on the upstream needs a force push. Until the check resolves, the note says so.
  useEffect(() => {
    if (prompt !== 'amend') return
    if (!upstream) {
      setCheck({ hash, state: 'local' })
      return
    }
    let stale = false
    setCheck({ hash, state: 'checking' })
    api.mergeBase(repo, upstream, hash).then((base: string) => {
      if (!stale) setCheck({ hash, state: base === hash ? 'pushed' : 'local' })
    }).catch(() => {
      if (!stale) setCheck({ hash, state: 'unknown' })
    })
    return () => { stale = true }
  }, [prompt, repo, upstream, hash])

  return (
    <>
      {prompt === 'branch' && (
        <PromptDialog
          title={`Create Branch from ${short}`}
          label="Branch name"
          submitLabel="Create"
          onClose={onClose}
          onSubmit={(name) => submit('branch', () => api.branchFromCommit(repo, name, hash))}
        />
      )}
      {prompt === 'tag' && (
        <PromptDialog
          title={`Create Tag from ${short}`}
          label="Tag name"
          submitLabel="Create"
          onClose={onClose}
          onSubmit={(name) => submit('tag', () => api.tagFromCommit(repo, name, hash))}
        />
      )}
      {prompt === 'amend' && (
        <PromptDialog
          title="Amend Commit Message"
          label="Message"
          initial={message}
          multiline
          note={(
            <>
              <p>Amending rewrites history: {short} “{subject}” is replaced by a commit with a new hash.</p>
              {checkState === 'checking' && upstream && <p>Checking whether this commit is on {upstream}…</p>}
              {checkState === 'pushed' && <p>This commit is already on {upstream}. Pushing the amended commit will need a force push.</p>}
              {checkState === 'unknown' && <p>Could not check whether this commit is on its upstream. If it is pushed, pushing the amended commit will need a force push.</p>}
            </>
          )}
          submitLabel="Amend commit"
          onClose={onClose}
          onSubmit={(text) => submit('amend', () => api.amendMessage(repo, text, hash))}
        />
      )}
      {prompt === 'ref' && (
        <PromptDialog
          title="Compare with Ref"
          label="Ref"
          submitLabel="Compare"
          onClose={onClose}
          onSubmit={(ref) => { onClose(); onCompare(ref, ref) }}
        />
      )}
    </>
  )
}
