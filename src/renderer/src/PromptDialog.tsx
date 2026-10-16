import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from './Dialogs'

interface Props {
  title: string
  label: string
  initial?: string
  multiline?: boolean
  // Shown above the field, for a warning about what the action does.
  note?: ReactNode
  submitLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}

// A one-field dialog. The value is trimmed, and an empty value cannot be submitted.
export function PromptDialog({ title, label, initial = '', multiline, note, submitLabel, onSubmit, onClose }: Props) {
  const [value, setValue] = useState(initial)
  const text = value.trim()
  const dialogRef = useRef<HTMLFormElement>(null)
  useDialogFocus(dialogRef)
  // Typed text survives a stray Escape or scrim click until the user confirms discarding it.
  const requestClose = () => { if (value === initial || window.confirm('Discard this text?')) onClose() }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') requestClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (text) onSubmit(text)
  }

  return createPortal(
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
      <form ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
        <header className="dialog-head">
          <h2>{title}</h2>
        </header>
        <div className="dialog-body">
          {note && <div className="dialog-note">{note}</div>}
          <label className="field">
            <span>{label}</span>
            {multiline
              ? <textarea autoFocus rows={6} value={value} onChange={(event) => setValue(event.target.value)} />
              : <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />}
          </label>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="ghost" onClick={requestClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!text}>{submitLabel}</button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
