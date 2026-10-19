import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Branch, BranchSelection, Stash, Tag, Worktree } from '../../main/git/ops'
import { buildSections, flattenRows, parentIndex, type RefItem, type Row } from './branch-tree'
import { useDialogFocus } from './Dialogs'
import { Icon } from './Icons'
import { blockedReason, busyKey, runRepoWrite, useRepoBusy, workingLabel } from './repo-busy'
import './branch-picker.css'

const api = window.bettergit

// Rows have one fixed height, so the list renders only what is on screen even with thousands of tags.
const ROW = 28
const OVERSCAN = 8

// Controlled so filtering, keyboard activation and exact identities share one list. `active` is a row key, so a
// background refresh or a fold keeps the highlight on the same ref.
export function BranchChoices({ branches, current, tags, stashes, worktrees, query, active, onQuery, onActive, onPick, id, disabled }: {
  branches: Branch[]
  current?: BranchSelection | null
  tags?: Tag[] | null
  stashes?: Stash[] | null
  worktrees?: Worktree[] | null
  query: string
  active: string | null
  onQuery: (query: string) => void
  onActive: (key: string) => void
  onPick: (item: RefItem) => void
  id: string
  disabled: boolean
}) {
  const sections = useMemo(() => buildSections({ branches, head: current, tags, stashes, worktrees }), [branches, current, tags, stashes, worktrees])
  // Folds flipped while browsing persist; folds flipped while filtering last only for that query.
  const [browseToggled, setBrowseToggled] = useState<ReadonlySet<string>>(() => new Set())
  const [filterToggled, setFilterToggled] = useState<{ query: string; keys: ReadonlySet<string> }>({ query: '', keys: new Set() })
  const filtering = query.trim() !== ''
  const toggled = filtering ? (filterToggled.query === query ? filterToggled.keys : EMPTY) : browseToggled
  const rows = useMemo(() => flattenRows(sections, query, toggled), [sections, query, toggled])
  const list = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 560 })
  useLayoutEffect(() => { if (list.current) list.current.scrollTop = 0 }, [query])

  const found = active === null ? -1 : rows.findIndex((row) => row.key === active)
  const selected = found >= 0 ? found : Math.max(0, rows.findIndex((row) => row.type === 'item'))
  const toggle = (key: string) => {
    const flip = (keys: ReadonlySet<string>) => { const next = new Set(keys); if (!next.delete(key)) next.add(key); return next }
    if (filtering) setFilterToggled({ query, keys: flip(toggled) })
    else setBrowseToggled(flip)
  }
  const activate = (index: number) => {
    const row = rows[index]
    if (!row) return
    if (row.type !== 'item') return toggle(row.key)
    if (!disabled && !row.entry.disabled) onPick(row.entry.item)
  }
  const reveal = (index: number) => {
    const box = list.current
    if (!box) return
    if (index * ROW < box.scrollTop) box.scrollTop = index * ROW
    else if ((index + 1) * ROW > box.scrollTop + box.clientHeight) box.scrollTop = (index + 1) * ROW - box.clientHeight
  }
  const move = (index: number) => { onActive(rows[index].key); reveal(index) }
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    const row = rows[selected]
    // Left and right fold the tree only while the box is empty, so they still move the caret in a typed query.
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && (filtering || !row)) return
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
    event.preventDefault()
    if (disabled || !rows.length) return
    if (event.key === 'Enter') return activate(selected)
    if (event.key === 'ArrowRight') {
      if (row.type !== 'item' && !row.expanded) toggle(row.key)
      else if (row.type !== 'item' && rows[selected + 1]?.level > row.level) move(selected + 1)
      return
    }
    if (event.key === 'ArrowLeft') {
      if (row.type !== 'item' && row.expanded) return toggle(row.key)
      const parent = parentIndex(rows, selected)
      if (parent >= 0) move(parent)
      return
    }
    move(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : Math.max(0, Math.min(rows.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))))
  }
  const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN)
  const optionId = (index: number) => `${id}-option-${index}`
  const label = tags === undefined ? 'Search local and remote branches' : 'Search branches, tags, stashes and worktrees'
  return <div className="branch-search">
    <input
      type="search" role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded="true"
      aria-controls={`${id}-list`} aria-activedescendant={rows.length ? optionId(selected) : undefined}
      value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={navigate}
      placeholder={label} disabled={disabled} autoComplete="off" spellCheck={false}
    />
    <div className="branch-choices" role="tree" id={`${id}-list`} aria-label="Branches and refs" aria-busy={disabled || undefined} ref={list}
      onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      <div style={{ height: rows.length * ROW, paddingTop: start * ROW }}>
        {rows.slice(start, end).map((row, offset) => <RowView key={row.key} row={row} id={optionId(start + offset)}
          selected={start + offset === selected} disabled={disabled} onClick={() => { onActive(row.key); activate(start + offset) }} />)}
      </div>
      {!rows.length && <p className="branch-empty" role="status">No matching refs</p>}
    </div>
  </div>
}

const EMPTY: ReadonlySet<string> = new Set()

function RowView({ row, id, selected, disabled, onClick }: { row: Row; id: string; selected: boolean; disabled: boolean; onClick: () => void }) {
  const entry = row.type === 'item' ? row.entry : null
  const inert = entry ? entry.disabled || disabled : false
  return <div
    id={id} role="treeitem" aria-level={row.level} aria-selected={selected}
    aria-expanded={row.type === 'item' ? undefined : row.expanded} aria-disabled={inert || undefined}
    className={`branch-choice ${row.type}${selected ? ' selected' : ''}${entry?.current ? ' current' : ''}`}
    style={{ paddingLeft: 10 + (row.level - 1) * 16 }} title={entry ? `${entry.path}${entry.detail ? `\n${entry.detail}` : ''}` : undefined}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}
  >
    {row.type === 'item' ? <span className="branch-twisty" /> : <Icon name={row.expanded ? 'chevronDown' : 'chevron'} className="branch-twisty" />}
    <span className="branch-choice-name">{row.label}</span>
    {row.type === 'section' && <span className="count">{row.count ?? '…'}</span>}
    {entry?.current && <span className="branch-current">Current</span>}
    {entry?.detail && <small>{entry.detail}</small>}
  </div>
}

type Extras = { tags: Tag[] | null; stashes: Stash[] | null; worktrees: Worktree[] | null }

export function BranchPicker({ repo, branches, headHash, onRefresh, onChanged, onClose, onOpenRepo }: {
  repo: string
  branches: Branch[]
  headHash: string | null
  onRefresh: () => Promise<void>
  onChanged: () => void
  onClose: () => void
  onOpenRepo?: (path: string) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLFormElement>(null)
  const inFlight = useRef(false)
  const initialHead = useRef(headHash ?? '')
  const busy = useRepoBusy(repo)
  const [mode, setMode] = useState<'switch' | 'create' | 'base'>('switch')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [base, setBase] = useState<BranchSelection>({ fullRef: 'HEAD', hash: headHash ?? '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Branches arrive with the repo pane; the other sections load on open and show a count of … until then.
  const [extras, setExtras] = useState<Extras>({ tags: null, stashes: null, worktrees: null })
  const loadExtras = () => {
    const read = <K extends keyof Extras>(key: K, label: string, load: () => Promise<Extras[K]>) => load().then(
      (value) => setExtras((prev) => ({ ...prev, [key]: value })),
      (failure) => {
        setExtras((prev) => ({ ...prev, [key]: [] }))
        setError(`Could not read ${label}: ${failure instanceof Error ? failure.message : String(failure)}`)
      },
    )
    return Promise.all([read('tags', 'tags', () => api.tags(repo)), read('stashes', 'stashes', () => api.stashes(repo)),
      read('worktrees', 'worktrees', () => api.worktrees(repo))])
  }
  useEffect(() => { void loadExtras() }, [repo])
  useDialogFocus(dialog)
  useEffect(() => {
    dialog.current?.querySelector<HTMLInputElement>(mode === 'create' ? '[name="branch-name"]' : '[role="combobox"]')?.focus()
  }, [mode])

  useEffect(() => { if (submitting) dialog.current?.focus() }, [submitting])

  const changeMode = (next: typeof mode) => { setMode(next); setQuery(''); setActive(null) }
  const draftChanged = name !== '' || base.fullRef !== 'HEAD' || base.hash !== initialHead.current
  const requestClose = () => {
    if (inFlight.current) return
    if (mode === 'base') return changeMode('create')
    if (draftChanged && !window.confirm('Discard this branch draft?')) return
    onClose()
  }
  const run = async (key: string, action: () => Promise<unknown>) => {
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
    try { await Promise.all([onRefresh(), mode === 'switch' && loadExtras()]) } catch (failure) {
      setError((message) => `${message ?? ''} Could not refresh branches: ${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }
  const baseLabel = base.fullRef === 'HEAD' ? 'Current HEAD'
    : branches.find((branch) => branch.fullRef === base.fullRef)?.name ?? base.fullRef
  const unavailable = base.fullRef === 'HEAD' && (!base.hash || !headHash)
  // Kept stable, so the choices' memoised sections survive re-renders.
  const baseHead = useMemo(() => headHash ? { fullRef: 'HEAD', hash: headHash } : null, [headHash])
  const pick = (item: RefItem) => {
    const selection = item.kind === 'head' ? item.selection : item.kind === 'branch' ? { fullRef: item.branch.fullRef, hash: item.branch.hash } : null
    if (mode === 'base') {
      if (selection) { setBase(selection); changeMode('create') }
      return
    }
    if (draftChanged && !window.confirm('Discard this branch draft and switch?')) return
    // Tags check out detached, as Checkout Detached does from a commit, without a prompt.
    if (selection) void run('switch', () => api.switchBranch(repo, selection))
    else if (item.kind === 'tag') void run('detach', () => api.checkoutDetached(repo, item.tag.hash))
    else if (item.kind === 'stash') void run(`apply:${item.stash.ref}`, () => api.stashAction(repo, 'apply', item.stash.ref))
    else if (item.kind === 'worktree' && onOpenRepo) { onOpenRepo(item.worktree.path); onClose() }
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
          <h2 id={`${id}-title`}>{mode === 'switch' ? 'Checkout' : mode === 'base' ? 'Choose a base branch' : 'Create branch'}</h2>
          <p className="dialog-sub">{mode === 'switch'
            ? 'Remote branches create or reuse a local tracking branch. Tags check out detached. Stashes apply and stay listed. Worktrees open.'
            : 'Creates an independent local branch and switches to it.'}</p>
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
            id={id} branches={branches} current={mode === 'base' ? baseHead : undefined}
            {...(mode === 'switch' ? { ...extras, worktrees: onOpenRepo ? extras.worktrees : undefined } : {})}
            query={query} active={active} onQuery={(value) => { setQuery(value); setActive(null) }} onActive={setActive}
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
