import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import { clearLatest, isFetchFailure, markAllRead, markRead, useLatestNotification, useNotifications } from './notifications'
import { describeFailure } from './repo-busy'

const ANNOUNCE_MS = 6000

// The failures the user has not marked as read. A bell with the unread count opens the list, where each failure can take
// the user to its repo, retry a failed fetch there, and be marked read. Each shows a plain summary and next step, with Git's
// own text under Details. The newest failure is also announced briefly, without taking focus.
// Portalled out of the app root, which goes inert under a dialog, so the hub stays usable while a dialog is open.
export function NotificationHub({ onGo, onRetryFetch, children }: {
  // Opens the repo in this window. False when it is no longer in the sidebar.
  onGo: (repo: string) => boolean
  // Fetches the repo again. True when it succeeded, which marks the entry read.
  onRetryFetch: (repo: string) => Promise<boolean>
  // Other status that shares the corner, such as BetterGit's own update.
  children?: ReactNode
}) {
  const list = useNotifications()
  const latest = useLatestNotification()
  const [open, setOpen] = useState(false)
  // Why Go to repository could not open a repo, by entry.
  const [notices, setNotices] = useState<Record<string, string>>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  // Where focus was before the hub opened, for when the last entry is marked read and the bell goes.
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!latest) return
    const timer = window.setTimeout(clearLatest, ANNOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [latest])

  useEffect(() => {
    if (list.length || !open) return
    setOpen(false)
    opener.current?.focus()
  }, [list.length, open])

  useLayoutEffect(() => {
    if (open) panel.current?.focus()
  }, [open])

  const show = () => {
    if (!open) opener.current = document.activeElement as HTMLElement | null
    clearLatest()
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  // Focus moves to the next entry's Mark as read, so the keyboard stays in the list.
  const read = (id: string, index: number) => {
    markRead(id)
    requestAnimationFrame(() => {
      const buttons = panel.current?.querySelectorAll<HTMLElement>('.notify-read')
      buttons?.[Math.min(index, buttons.length - 1)]?.focus()
    })
  }
  const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return createPortal(
    // Escape anywhere in the hub, the bell included, closes the list and not a dialog under it.
    <div className="notify-layer" onKeyDown={(event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }}>
      {/* Mounted while empty, so a new failure or update is announced when it fills. The two stack, never overlap. */}
      <div className="notify-toast-region" role="status" aria-live="polite">
        {children}
        {latest && !open && (
          <div className="notify-toast">
            <Icon name="warning" />
            <span><strong>{latest.action} failed</strong> {describeFailure(latest.reason).summary}</span>
            <button type="button" onClick={show}>View</button>
          </div>
        )}
      </div>
      {open && list.length > 0 && (
        <section
          ref={panel}
          id="notify-panel"
          className="notify-panel"
          aria-label="Notifications"
          tabIndex={-1}
        >
          <header>
            <h2>Notifications</h2>
            {/* The panel and its bell show only while something is unread, so this never acts on an empty list. */}
            <button type="button" onClick={markAllRead}>Mark all as read</button>
            <button type="button" className="icon-button" aria-label="Close notifications" onClick={close}><Icon name="close" /></button>
          </header>
          <ul>
            {list.map((entry, index) => {
              const name = entry.repo?.split('/').pop()
              const { summary, hint } = describeFailure(entry.reason)
              return (
                <li key={entry.id}>
                  <div className="notify-head">
                    <strong>{entry.action} failed</strong>
                    {entry.count > 1 && <span className="notify-count" aria-label={`${entry.count} times`}>×{entry.count}</span>}
                    <time dateTime={new Date(entry.time).toISOString()}>{time(entry.time)}</time>
                  </div>
                  {name && <span className="notify-repo">{name}</span>}
                  <p>{summary}</p>
                  {hint && <p className="notify-hint">{hint}</p>}
                  {summary !== entry.reason && <details><summary>Details</summary><pre>{entry.reason}</pre></details>}
                  {notices[entry.id] && <em>{notices[entry.id]}</em>}
                  <div className="notify-actions">
                    {isFetchFailure(entry) && (
                      <button type="button" aria-label={`Retry fetch in ${name}`} onClick={() => void onRetryFetch(entry.repo!).then((ok) => { if (ok) markRead(entry.id) })}>Retry fetch</button>
                    )}
                    {entry.repo && (
                      <button type="button" aria-label={`Go to repository ${name}`} onClick={() => {
                        if (!onGo(entry.repo!)) setNotices((prev) => ({ ...prev, [entry.id]: `${name} is no longer in the sidebar.` }))
                      }}>Go to repository</button>
                    )}
                    <button type="button" className="notify-read" aria-label={`Mark "${entry.action} failed" as read`} onClick={() => read(entry.id, index)}>Mark as read</button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {list.length > 0 && (
        <button
          ref={trigger}
          type="button"
          className={`notify-trigger${open ? ' on' : ''}`}
          aria-label={`Notifications: ${list.length} unread`}
          aria-expanded={open}
          aria-controls={open ? 'notify-panel' : undefined}
          onClick={() => (open ? close() : show())}
        >
          <Icon name="bell" />
          <span className="notify-badge" aria-hidden="true">{list.length}</span>
        </button>
      )}
    </div>,
    document.body,
  )
}
