import { useState, type FormEvent } from 'react'
import type { CommitIdentity, IdentityScope } from '../../shared/identity'
import { Modal } from './Dialogs'
import { confirmOverBlur } from './confirm'
import { failureReason } from './repo-busy'

const api = window.bettergit

export function IdentityDialog({ repo, identity, onSaved, onClose }: {
  repo: string
  identity: CommitIdentity | null
  onSaved: (identity: CommitIdentity) => void
  onClose: () => void
}) {
  const [name, setName] = useState(identity?.name ?? '')
  const [email, setEmail] = useState(identity?.email ?? '')
  const [scope, setScope] = useState<IdentityScope>('local')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestClose = async () => {
    if (busy) return
    if ((name === (identity?.name ?? '') && email === (identity?.email ?? '')) || await confirmOverBlur('Discard identity edits?')) onClose()
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const effective = await api.setCommitIdentity(repo, name.trim(), email.trim(), scope)
      onSaved(effective)
      if (effective.error || effective.name !== name.trim() || effective.email !== email.trim()) {
        setError(effective.error ?? `Configuration saved. Git still uses ${effective.name} <${effective.email}> because a pending cherry-pick, another setting or an environment variable takes precedence.`)
      } else onClose()
    } catch (failure) {
      setError(failureReason(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="Commit identity" onClose={requestClose}>
      <form onSubmit={save} aria-busy={busy}>
        <fieldset className="identity-fields" disabled={busy}>
          <label className="field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Email</span><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label><input type="radio" name="identity-scope" checked={scope === 'local'} onChange={() => setScope('local')} /> Local repository only</label>
          <label><input type="radio" name="identity-scope" checked={scope === 'global'} onChange={() => setScope('global')} /> Global Git configuration</label>
        </fieldset>
        <p className="dialog-note">Changes the default author for new commits. Pending cherry-picks keep their original author. Repository settings and environment variables can override global configuration.</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <footer className="dialog-foot">
          <button type="button" className="ghost" disabled={busy} onClick={requestClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !email.trim()}>{busy ? 'Saving…' : 'Update'}</button>
        </footer>
      </form>
    </Modal>
  )
}
