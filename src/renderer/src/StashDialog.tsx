import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Stash } from '../../main/git/ops'
import type { Run } from './RepoMenu'
import { confirmOverBlur } from './confirm'
import { useDialogFocus } from './Dialogs'
import { Icon } from './Icons'
import { REPO_WORKING_LABELS, useRepoBusy } from './repo-busy'

const api = window.bettergit

const COPY = {
  view: { title: 'Stashes', subtitle: 'Stashed changes in this repository.' },
  apply: { title: 'Apply Stash', subtitle: 'Apply a stash and keep it in the list.' },
  pop: { title: 'Pop Stash', subtitle: 'Apply a stash and remove it from the list.' },
} as const

export type StashMode = keyof typeof COPY

export function StashDialog({ repo, mode, run, onError, onClose }: {
  repo: string
  mode: StashMode
  run: Run
  onError: (error: unknown) => void
  onClose: () => void
}) {
  const [stashes, setStashes] = useState<Stash[] | null>(null)
  const busy = useRepoBusy(repo)

  useEffect(() => {
    api.stashes(repo).then(setStashes).catch(onError)
  }, [repo])

  // The list is read once on open, so each button passes the ref it was listed with. The dialog closes only on success.
  const act = async (ref: string) => {
    if (await run(`${mode}:${ref}`, () => api.stashAction(repo, mode, ref))) onClose()
  }

  return (
    <Sheet
      title={COPY[mode].title}
      subtitle={COPY[mode].subtitle}
      onClose={onClose}
      footer={<button type="button" className="ghost" onClick={onClose}>Close</button>}
    >
      {stashes?.length === 0 && <p className="dialog-sub">No stashes.</p>}
      <ul className="stash-list">
        {stashes?.map((stash) => (
          <li key={stash.ref}>
            <span title={stash.message}><b>{stash.ref}</b> {stash.message}</span>
            {mode !== 'view' && (() => {
              const key = `${mode}:${stash.ref}`
              const running = busy === key
              return (
                <button type="button" aria-label={`${mode === 'apply' ? 'Apply' : 'Pop'} ${stash.ref}: ${stash.message}`} aria-busy={running || undefined} disabled={busy !== null} onClick={() => void act(stash.ref)}>
                  {running && <Icon name="loader" className="action-spin" />}
                  {running ? REPO_WORKING_LABELS[mode] : mode === 'apply' ? 'Apply' : 'Pop'}
                </button>
              )
            })()}
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

export function PullFromDialog({ repo, branch, run, onError, onClose }: {
  repo: string
  branch: string
  run: Run
  onError: (error: unknown) => void
  onClose: () => void
}) {
  const [remotes, setRemotes] = useState<string[]>([])
  const [remote, setRemote] = useState('')
  const [name, setName] = useState(branch)
  const busy = useRepoBusy(repo)
  // A typed branch name survives a stray Escape or scrim click until the user confirms discarding it.
  const requestClose = async () => { if (name === branch || await confirmOverBlur('Discard this pull?')) onClose() }

  useEffect(() => {
    api.remotes(repo).then((list) => {
      setRemotes(list.map((item) => item.name))
      setRemote(list[0]?.name ?? '')
    }).catch(onError)
  }, [repo])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await run('pull', () => api.pullFrom(repo, remote, name.trim()))) onClose()
  }

  return (
    <Sheet
      title="Pull from…"
      subtitle="Pull a branch from a remote into the current branch."
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="ghost" onClick={requestClose}>Cancel</button>
          <button type="submit" form="pull-from" className="primary" disabled={busy !== null || !remote || !name.trim()} aria-busy={busy === 'pull' || undefined}>
            {busy === 'pull' && <Icon name="loader" className="action-spin" />}
            {busy === 'pull' ? REPO_WORKING_LABELS.pull : 'Pull'}
          </button>
        </>
      )}
    >
      <form id="pull-from" className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Remote</span>
          <select value={remote} onChange={(event) => setRemote(event.target.value)}>
            {remotes.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Branch</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
      </form>
    </Sheet>
  )
}

// The Dialogs.tsx shell, repeated here because that module does not export it.
// The portal keeps the sheet out of the drag-region toolbar, where inputs would not take clicks.
function Sheet({ title, subtitle, footer, onClose, children }: {
  title: string
  subtitle: string
  footer: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  return createPortal(
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <p className="dialog-sub">{subtitle}</p>
        </header>
        <div className="dialog-body">{children}</div>
        <footer className="dialog-foot">{footer}</footer>
      </div>
    </div>,
    document.body,
  )
}
