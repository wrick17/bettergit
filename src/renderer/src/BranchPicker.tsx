import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Branch, BranchSelection } from '../../main/git/ops'
import { useDialogFocus } from './Dialogs'
import { blockedReason, busyKey, runRepoWrite, useRepoBusy, workingLabel } from './repo-busy'
import './branch-picker.css'

const api = window.bettergit

type Choice = { selection: BranchSelection | null; label: string; detail?: string; current?: boolean; group: string }

// Controlled so filtering, keyboard activation and exact identities share one list.
export function BranchChoices({ branches, current, query, active, onQuery, onActive, onPick, id, disabled }: {
  branches: Branch[]
  current?: BranchSelection | null
  query: string
  active: number
  onQuery: (query: string) => void
  onActive: (index: number) => void
  onPick: (selection: BranchSelection) => void
  id: string
  disabled: boolean
}) {
  const choices: Choice[] = [
    ...(current === undefined ? [] : [{ selection: current, label: 'Current HEAD', detail: current ? current.hash.slice(0, 7) : 'Create a commit first', group: 'Current' }]),
    ...branches.filter((branch) => !branch.remote).map((branch) => ({ selection: branch, label: branch.name, detail: branch.upstream ?? undefined, current: branch.current, group: 'Local' })),
    ...branches.filter((branch) => branch.remote).map((branch) => ({ selection: branch, label: branch.name, group: 'Remote' })),
  ].filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase()))
  const selected = Math.min(active, choices.length - 1)
  const activate = (index: number) => {
    const choice = choices[index]
    if (!disabled && choice?.selection) onPick({ fullRef: choice.selection.fullRef, hash: choice.selection.hash })
  }
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return
    event.preventDefault()
    if (disabled || !choices.length) return
    if (event.key === 'Enter') return activate(selected)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : Math.max(0, Math.min(choices.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)))
    onActive(index)
    document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: 'nearest' })
  }
  return <div className="branch-search">
    <input
      type="search" role="combobox" aria-label="Search branches" aria-autocomplete="list" aria-expanded="true"
      aria-controls={`${id}-list`} aria-activedescendant={selected >= 0 ? `${id}-option-${selected}` : undefined}
      value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={navigate}
      placeholder="Search local and remote branches" disabled={disabled} autoComplete="off" spellCheck={false}
    />
    <div className="branch-choices" role="listbox" id={`${id}-list`} aria-label="Branches" aria-busy={disabled || undefined}>
      {['Current', 'Local', 'Remote'].map((group) => {
        const entries = choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.group === group)
        if (!entries.length) return null
        return <div role="group" aria-label={group} key={group}>
          <div className="branch-group" aria-hidden="true">
            <span>{group === 'Current' ? 'Starting point' : group}</span>
            {group !== 'Current' && <span className="count">{entries.length}</span>}
          </div>
          {entries.map(({ choice, index }) => <div
            key={choice.selection?.fullRef ?? 'unborn-head'} id={`${id}-option-${index}`} role="option"
            aria-selected={index === selected} aria-disabled={!choice.selection || disabled || undefined}
            className={`branch-choice${index === selected ? ' selected' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => activate(index)}
          >
            <span className="branch-choice-name">{choice.label}</span>
            {choice.current && <span className="branch-current">Current</span>}
            {choice.detail && <small>{choice.detail}</small>}
          </div>)}
        </div>
      })}
      {!choices.length && <p className="branch-empty" role="status">No matching branches</p>}
    </div>
  </div>
}

export function BranchPicker({ repo, branches, headHash, onRefresh, onChanged, onClose }: {
  repo: string
  branches: Branch[]
  headHash: string | null
  onRefresh: () => Promise<void>
  onChanged: () => void
  onClose: () => void
}) {
  const id = useId()
  const dialog = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const initialHead = useRef(headHash ?? '')
  const busy = useRepoBusy(repo)
  const [mode, setMode] = useState<'switch' | 'create' | 'base'>('switch')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [name, setName] = useState('')
  const [base, setBase] = useState<BranchSelection>({ fullRef: 'HEAD', hash: headHash ?? '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useDialogFocus(dialog)
  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>(mode === 'create' ? '[name="branch-name"]' : '[role="combobox"]')?.focus()
  }, [mode])

  useEffect(() => { if (submitting) dialog.current?.focus() }, [submitting])

  const changeMode = (next: typeof mode) => { setMode(next); setQuery(''); setActive(0) }
  const draftChanged = name !== '' || base.fullRef !== 'HEAD' || base.hash !== initialHead.current
  const requestClose = () => {
    if (inFlight.current) return
    if (mode === 'base') return changeMode('create')
    if (draftChanged && !window.confirm('Discard this branch draft?')) return
    onClose()
  }
  const run = async (key: 'switch' | 'create-branch', action: () => Promise<void>) => {
    if (inFlight.current) return
    const reason = blockedReason(busyKey(repo))
    if (reason) return setError(reason)
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    let failed = false
    const ok = await runRepoWrite(repo, key, action, {
      onError: (failure) => { failed = true; setError(failure instanceof Error ? failure.message : String(failure)) },
      reload: onChanged,
    })
    if (ok) return onClose()
    if (!failed) setError(blockedReason(busyKey(repo)) ?? 'The branch action could not start. Try again.')
    // Refusals may mean the selection became stale. Keep the name and selected identity until the user picks again.
    try { await onRefresh() } catch (failure) {
      setError((message) => `${message ?? ''} Could not refresh branches: ${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }
  const baseLabel = base.fullRef === 'HEAD' ? 'Current HEAD'
    : branches.find((branch) => branch.fullRef === base.fullRef)?.name ?? base.fullRef
  const unavailable = base.fullRef === 'HEAD' && (!base.hash || !headHash)
  const pick = (selection: BranchSelection) => {
    if (mode === 'switch' && draftChanged
      && !window.confirm('Discard this branch draft and switch?')) return
    if (mode === 'base') { setBase(selection); changeMode('create') }
    else void run('switch', () => api.switchBranch(repo, selection))
  }
  return createPortal(
    <div className="scrim branch-picker-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
      <form ref={dialog} className="dialog branch-picker" role="dialog" aria-modal="true"
        aria-labelledby={`${id}-title`} aria-busy={submitting || undefined} tabIndex={-1}
        onKeyDown={(event) => {
          // Tab must reach useDialogFocus's window listener to wrap within the sheet.
          if (event.key === 'Tab') {
            if (submitting) event.preventDefault()
            return
          }
          event.stopPropagation()
          if (event.key === 'Escape') { event.preventDefault(); requestClose() }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (mode === 'create' && name && !unavailable) void run('create-branch', () => api.createBranch(repo, name, base))
        }}
      >
        <header className="dialog-head">
          <h2 id={`${id}-title`}>{mode === 'switch' ? 'Switch branch' : mode === 'base' ? 'Choose a base branch' : 'Create branch'}</h2>
          <p className="dialog-sub">{mode === 'switch' ? 'Remote branches create or reuse a local tracking branch.' : 'Creates an independent local branch and switches to it.'}</p>
        </header>
        <div className="dialog-body">
          {mode === 'create' ? <>
            <label className="field"><span>Branch name</span>
              <input name="branch-name" value={name} onChange={(event) => setName(event.target.value)} disabled={submitting} autoComplete="off" spellCheck={false} />
            </label>
            <div className="field"><span>Starting point</span>
              <button type="button" className="branch-base" onClick={() => changeMode('base')} disabled={submitting}>
                <span>{baseLabel}</span><small>{base.hash ? base.hash.slice(0, 7) : 'Create a commit first'}</small>
                <span>Choose base…</span>
              </button>
            </div>
            {unavailable && <p className="dialog-sub">Create a commit first, or choose another base branch.</p>}
            <p className="dialog-sub">The new branch will have no upstream.</p>
          </> : <BranchChoices
            id={id} branches={branches} current={mode === 'base' ? (headHash ? { fullRef: 'HEAD', hash: headHash } : null) : undefined}
            query={query} active={active} onQuery={(value) => { setQuery(value); setActive(0) }} onActive={setActive}
            onPick={pick} disabled={submitting || busy !== null}
          />}
          {(error || busy) && <p className={error ? 'dialog-error' : 'dialog-sub'} role={error ? 'alert' : 'status'}>{error ?? (submitting ? workingLabel(busy!) : blockedReason(busy))}</p>}
        </div>
        <footer className="dialog-foot">
          {mode === 'switch' && <div className="branch-create-actions">
            <button type="button" onClick={() => changeMode('create')} disabled={submitting}>Create Branch…</button>
            <button type="button" onClick={() => changeMode('base')} disabled={submitting}>Create Branch From…</button>
          </div>}
          {mode === 'create' && <button type="button" className="ghost" onClick={() => changeMode('switch')} disabled={submitting}>Back</button>}
          <button type="button" className="ghost" onClick={requestClose} disabled={submitting}>{mode === 'base' ? 'Back' : 'Cancel'}</button>
          {mode === 'create' && <button type="submit" className="primary" disabled={submitting || busy !== null || !name || unavailable}>
            {submitting ? 'Creating branch…' : 'Create and Switch'}
          </button>}
        </footer>
      </form>
    </div>, document.body,
  )
}
