import { useEffect, useState } from 'react'
import type { Commit } from '../../main/git/history'
import { confirmOverBlur } from './confirm'
import type { BarItem } from './OverflowBar'
import { PromptDialog } from './PromptDialog'
import { blockedReason, busyKey, REPO_WORKING_LABELS, runRepoWrite } from './repo-busy'

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
function runGit({ repo, onChanged, onError }: CommitInput, key: string, action: () => Promise<unknown>) {
  return runRepoWrite(repo, key, action, { onError, reload: () => onChanged?.() })
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
  const copy = (text: string) => navigator.clipboard.writeText(text).catch(onError)
  const openRemote = () => api.openExternal(`${webBase}/commit/${hash}`).catch(onError)
  const compareRemote = () => { if (upstream) onCompare(upstream, upstream) }
  const compareBase = () => {
    if (head) api.mergeBase(repo, head, hash).then((base: string) => onCompare(`merge base ${base.slice(0, 7)}`, base)).catch(onError)
  }
  const revert = async () => {
    if (await confirmOverBlur(`Revert "${subject}"? This adds a new commit that undoes it.`)) run('revert', () => api.revertCommit(repo, hash))
  }
  const cherryPick = () => run('cherry', () => api.cherryPick(repo, hash).then((backup: string) => ui.setNotice(`Cherry-picked. Backup saved as ${backup}.`)))

  return [
    { key: 'changes', icon: 'diff', label: 'Show diff', group: 'open', onClick: onOpenChanges },
    { key: 'remote', icon: 'externalLink', label: 'Open Changes on Remote', disabled: !webBase, group: 'open', onClick: openRemote },
    { key: 'hash', icon: 'hash', label: 'Copy Commit Hash', group: 'copy', onClick: () => copy(hash) },
    { key: 'message', icon: 'copy', label: 'Copy Commit Message', group: 'copy', onClick: () => copy(message) },
    { key: 'link', icon: 'link', label: 'Copy Commit Remote Link', disabled: !webBase, group: 'copy', onClick: () => copy(`${webBase}/commit/${hash}`) },
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
