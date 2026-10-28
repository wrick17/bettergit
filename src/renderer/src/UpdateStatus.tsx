import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateState } from '../../main/update'
import { hasUnsavedChoices } from './ChangesView'
import { hasUnsavedDrafts } from './DiffEditor'
import { Icon, IconButton, type IconName } from './Icons'

const api = window.bettergit
const UNSAVED = 'Save or discard your unsaved edits and conflict choices, then restart.'
const unsaved = () => hasUnsavedDrafts() || hasUnsavedChoices()
// Set from an accepted Restart until the app quits or the quit is cancelled. Only then does closing check for edits.
let restarting = false

// BetterGit's own update, in the notification corner: a found update, its download, and the restart. Nothing downloads
// or restarts until the user clicks. A silent check shows only a found update; Check for Updates also shows the rest.
export function UpdateStatus() {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState<UpdateState | null>(null)
  // Why the last Restart did not go ahead.
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const off = api.onEvent('update:state', (payload) => { setState(payload as UpdateState); setNotice(null) })
    void api.updateState().then(setState)
    return off
  }, [])

  // The restart's quit closes the window. An edit typed since the click cancels it here; main then opens the repos again
  // and keeps the update staged.
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!restarting || !unsaved()) return
      restarting = false
      event.preventDefault()
      event.returnValue = false
      setNotice(UNSAVED)
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  if (state.kind === 'idle' || state === dismissed) return null
  const restart = async () => {
    if (unsaved()) return setNotice(UNSAVED)
    restarting = true
    const refused = await api.installUpdate().catch((failure: unknown) => String(failure))
    if (refused) restarting = false
    setNotice(refused)
  }
  const dismiss = state.kind === 'checking' || state.kind === 'downloading'
    ? null
    : <IconButton icon="close" label="Dismiss update status" onClick={() => setDismissed(state)} />
  const percent = state.kind === 'downloading' ? Math.floor((state.received / state.total) * 100) : 0
  const [icon, text, action]: [IconName, string, ReactNode] =
    state.kind === 'checking' ? ['loader', 'Checking for updates…', null]
    : state.kind === 'current' ? ['done', `BetterGit ${state.version} is up to date.`, null]
    : state.kind === 'available' && state.blocked ? ['refresh', `BetterGit ${state.version} is available. ${state.blocked}`, <button type="button" onClick={() => void api.openUpdatePage()}>Download</button>]
    : state.kind === 'available' ? ['refresh', `BetterGit ${state.version} is available.`, <button type="button" onClick={() => void api.downloadUpdate()}>Update</button>]
    : state.kind === 'downloading' ? ['loader', `Downloading BetterGit ${state.version}… ${percent}%`, null]
    : state.kind === 'ready' ? ['refresh', `BetterGit ${state.version} is ready to install.`, <button type="button" onClick={() => void restart()}>Restart to Update</button>]
    : ['warning', state.message, <button type="button" onClick={() => void api.openUpdatePage()}>Open releases page</button>]

  return (
    <div className={`notify-toast update-toast${state.kind === 'failed' ? ' failed' : ''}`}>
      <Icon name={icon} className={icon === 'loader' ? 'action-spin' : undefined} />
      <span>
        {text}
        {notice && <em>{notice}</em>}
      </span>
      {action}
      {dismiss}
    </div>
  )
}
