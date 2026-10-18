import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AppConfig, ThemeMode } from '../../main/config'
import { EDITORS, type EditorId } from '../../shared/editors'

const api = window.bettergit

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

// While a dialog is open the app root is inert, focus moves in, Tab wraps inside, and focus returns to the opener on close.
export function useDialogFocus(dialog: RefObject<HTMLElement | null>) {
  // Read on the first render, before autoFocus moves focus into the dialog.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const root = document.getElementById('root')!
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    root.toggleAttribute('inert', true)
    focusable()[0]?.focus()
    const wrap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', wrap)
    return () => {
      window.removeEventListener('keydown', wrap)
      root.toggleAttribute('inert', false)
      opener?.focus()
    }
  }, [dialog, opener])
}

function Modal({ title, subtitle, footer, onClose, children }: {
  title: string
  subtitle?: string
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portalled out of the app root, so the root can go inert while the dialog is open.
  return createPortal(
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="dialog-head">
          <h2>{title}</h2>
          {subtitle && <p className="dialog-sub">{subtitle}</p>}
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function CloneDialog({ defaultParent, onClose, onCloned }: {
  defaultParent: string
  onClose: () => void
  onCloned: (destination: string) => void
}) {
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(defaultParent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Typed text survives a stray Escape or scrim click until the user confirms discarding it.
  const dirty = url !== '' || parent !== defaultParent
  const requestClose = () => { if (!dirty || window.confirm('Discard this clone?')) onClose() }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim() || !parent) return
    setBusy(true)
    setError(null)
    try {
      const destination = await api.clone(url.trim(), parent)
      onCloned(String(destination))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  const choose = async () => {
    const picked = await api.pickFolder()
    if (picked) setParent(picked)
  }

  return (
    <Modal
      title="Clone repository"
      subtitle="Uses the Git and SSH credentials already on this Mac. BetterGit stores no tokens."
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="ghost" onClick={requestClose}>Cancel</button>
          <button type="submit" form="clone-form" className="primary" disabled={busy || !url.trim() || !parent}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </>
      )}
    >
      <form id="clone-form" onSubmit={submit} className="dialog-form">
        <label className="field">
          <span>Repository URL</span>
          <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" />
        </label>
        <label className="field">
          <span>Clone into</span>
          <div className="input-row">
            <input value={parent} onChange={(event) => setParent(event.target.value)} />
            <button type="button" onClick={choose}>Choose…</button>
          </div>
        </label>
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

const TEXT_SIZES = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Largest' },
]

// Reads "ts = typescript" lines. Blank or malformed lines are skipped.
function parseLanguages(text: string): Record<string, string> {
  const pairs = text.split('\n').map((line) => line.split('=').map((part) => part.trim().replace(/^\./, '').toLowerCase()))
  return Object.fromEntries(pairs.filter(([extension, language]) => extension && language).map(([extension, language]) => [extension, language]))
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

// A radio group with roving focus: one tab stop, and the arrow keys move and select.
function Segmented<T extends string | number>({ label, options, value, onChange }: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
        if (!step) return
        event.preventDefault()
        const index = (options.findIndex((option) => option.value === value) + step + options.length) % options.length
        onChange(options[index].value)
        const next = event.currentTarget.children[index] as HTMLElement
        next.focus()
      }}
    >
      {options.map((option) => (
        <button
          key={option.label}
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function SettingsDialog({ config, onUpdate, onClose }: {
  config: AppConfig
  onUpdate: (patch: Partial<AppConfig>) => void
  onClose: () => void
}) {
  const { settings } = config
  const set = (patch: Partial<AppConfig['settings']>) => onUpdate({ settings: { ...settings, ...patch } })
  const languagesText = Object.entries(settings.languages).map(([extension, language]) => `${extension} = ${language}`).join('\n')
  const languagesRef = useRef<HTMLTextAreaElement>(null)
  const commitLanguages = () => set({ languages: parseLanguages(languagesRef.current?.value ?? '') })
  // Closing is the one save point for syntax edits, so Escape and Done each write once.
  const close = () => { commitLanguages(); onClose() }

  return (
    <Modal
      title="Settings"
      onClose={close}
      footer={<button className="primary" onClick={close}>Done</button>}
    >
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="settings-group">
          <div className="setting">
            <span>Theme</span>
            <Segmented label="Appearance" options={THEMES} value={settings.theme} onChange={(theme) => set({ theme })} />
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>Editor</h3>
        <div className="settings-group">
          <div className="setting">
            <label htmlFor="editor-choice">Open files and repos in</label>
            <select id="editor-choice" value={settings.editor} onChange={(event) => set({ editor: event.target.value as EditorId })}>
              {(Object.keys(EDITORS) as EditorId[]).map((id) => <option key={id} value={id}>{EDITORS[id].label}</option>)}
            </select>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>Background fetch</h3>
        <div className="settings-group">
          <div className="setting">
            <label>
              <input type="checkbox" checked={settings.backgroundFetch} onChange={(event) => set({ backgroundFetch: event.target.checked })} />
              <span>
                Fetch while I am at the computer
                <small>Fetches every repository. Never pulls or pushes.</small>
              </span>
            </label>
          </div>
          <div className="setting">
            <label htmlFor="fetch-interval">Interval</label>
            <select id="fetch-interval" value={settings.fetchIntervalMinutes} disabled={!settings.backgroundFetch} onChange={(event) => set({ fetchIntervalMinutes: Number(event.target.value) })}>
              {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>Every {minutes} minutes</option>)}
            </select>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>Text size</h3>
        <div className="settings-group">
          <div className="setting">
            <span>
              Interface and code
              <small>Scales the whole window, so rows and dividers stay aligned.</small>
            </span>
            <Segmented label="Text size" options={TEXT_SIZES} value={settings.textZoom} onChange={(textZoom) => set({ textZoom })} />
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>Syntax highlighting</h3>
        <div className="settings-group">
          <div className="setting setting-stack">
            <span>
              Extension to language
              <small>One per line, like ts = typescript. Unlisted extensions use the built-in map. Ids come from Shiki.</small>
            </span>
            <textarea
              ref={languagesRef}
              key={languagesText}
              defaultValue={languagesText}
              spellCheck={false}
              aria-label="Extension to language mapping"
            />
          </div>
        </div>
      </section>
    </Modal>
  )
}
