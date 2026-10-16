import { useEffect, useState } from 'react'
import type { Commit } from '../../main/git/history'
import type { BarItem } from './OverflowBar'
import { PromptDialog } from './PromptDialog'

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

// The caller owns the prompt, notice, and pending state, because it renders the dialogs and the notice.
export interface CommitUi {
  setPrompt: (prompt: Prompt) => void
  setNotice: (notice: string) => void
  // The key of the running state change, or null. While one runs, the other state changes are disabled.
  pending: string | null
  setPending: (key: string | null) => void
}

// The label each state change shows while it runs.
const WORKING: Record<string, string> = {
  detach: 'Checking out…',
  branch: 'Creating branch…',
  tag: 'Creating tag…',
  cherry: 'Cherry-picking…',
  revert: 'Reverting…',
  amend: 'Amending…',
}

// Turns a git remote into the https base of its web page. Covers git@host:owner/repo and https://host/owner/repo.
export function remoteWebBase(remotes: { name: string; url: string }[]): string | null {
  const remote = remotes.find((item) => item.name === 'origin') ?? remotes[0]
  const match = remote?.url.trim().match(/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/)
  return match ? `https://${match[1]}/${match[2]}` : null
}

// Git changes the repository, so the parent reloads. Failures go to the error banner. `key` stays pending until both finish.
function runGit({ onChanged, onError }: CommitInput, setPending: (key: string | null) => void, key: string, action: () => Promise<unknown>) {
  setPending(key)
  return action().then(() => onChanged?.()).catch(onError).finally(() => setPending(null))
}

export function commitItems(input: CommitInput, ui: CommitUi): BarItem[] {
  const { repo, commit, message, head, upstream, webBase, onOpenChanges, onCompare, onError } = input
  const { hash, subject } = commit
  const { pending } = ui
  const shown = (key: string, label: string) => (pending === key ? WORKING[key] : label)

  const run = (key: string, action: () => Promise<unknown>) => runGit(input, ui.setPending, key, action)
  const copy = (text: string) => navigator.clipboard.writeText(text).catch(onError)
  const openRemote = () => api.openExternal(`${webBase}/commit/${hash}`).catch(onError)
  const compareRemote = () => { if (upstream) onCompare(upstream, upstream) }
  const compareBase = () => {
    if (head) api.mergeBase(repo, head, hash).then((base: string) => onCompare(`merge base ${base.slice(0, 7)}`, base)).catch(onError)
  }
  const revert = () => {
    if (window.confirm(`Revert "${subject}"? This adds a new commit that undoes it.`)) run('revert', () => api.revertCommit(repo, hash))
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
    { key: 'detach', icon: 'locate', label: shown('detach', 'Checkout Detached'), disabled: !!pending, group: 'checkout', onClick: () => run('detach', () => api.checkoutDetached(repo, hash)) },
    { key: 'branch', icon: 'branch', label: shown('branch', 'Create Branch from Commit…'), disabled: !!pending, group: 'checkout', onClick: () => ui.setPrompt('branch') },
    { key: 'tag', icon: 'tag', label: shown('tag', 'Create Tag from Commit…'), disabled: !!pending, group: 'checkout', onClick: () => ui.setPrompt('tag') },
    { key: 'cherry', icon: 'cherry', label: shown('cherry', 'Cherry Pick'), disabled: !!pending, group: 'change', onClick: cherryPick },
    { key: 'revert', icon: 'undo', label: shown('revert', 'Revert Commit…'), disabled: !!pending, group: 'change', onClick: revert },
    { key: 'amend', icon: 'edit', label: shown('amend', 'Amend Commit Message…'), disabled: !!pending || hash !== head, group: 'change', onClick: () => ui.setPrompt('amend') },
  ]
}

export function CommitDialogs({ input, prompt, onClose, setPending }: {
  input: CommitInput
  prompt: Prompt | null
  onClose: () => void
  setPending: (key: string | null) => void
}) {
  const { repo, commit, message, upstream, onCompare } = input
  const { hash, subject } = commit
  const short = hash.slice(0, 7)
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
          onSubmit={(name) => { onClose(); runGit(input, setPending, 'branch', () => api.branchFromCommit(repo, name, hash)) }}
        />
      )}
      {prompt === 'tag' && (
        <PromptDialog
          title={`Create Tag from ${short}`}
          label="Tag name"
          submitLabel="Create"
          onClose={onClose}
          onSubmit={(name) => { onClose(); runGit(input, setPending, 'tag', () => api.tagFromCommit(repo, name, hash)) }}
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
          onSubmit={(text) => { onClose(); runGit(input, setPending, 'amend', () => api.amendMessage(repo, text, hash)) }}
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
