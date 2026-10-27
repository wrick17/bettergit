import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Branch, BranchSelection, Stash, Tag, Worktree } from '../../main/git/ops'
import { buildSections, flattenRows, parentIndex, type RefItem, type Row } from './branch-tree'
import { confirmOverBlur } from './confirm'
import { useDialogFocus } from './Dialogs'
import { Icon } from './Icons'
import { ActionMenu, type BarItem } from './OverflowBar'
import { hiddenBranches, setHiddenBranches, useHiddenBranches } from './prefs'
import { blockedReason, busyKey, runRepoWrite, useRepoBusy, workingLabel } from './repo-busy'
import './branch-picker.css'

const api = window.bettergit

// Rows have one fixed height, so the list renders only what is on screen even with thousands of tags.
const ROW = 28
const OVERSCAN = 8

// Controlled so filtering, keyboard activation and exact identities share one list. `active` is a row key, so a
// background refresh or a fold keeps the highlight on the same ref.
export function BranchChoices({ branches, current, tags, stashes, worktrees, hidden, conflicts = 0, query, active, onQuery, onActive, onPick, onMenu, id, disabled }: {
  branches: Branch[]
  current?: BranchSelection | null
  tags?: Tag[] | null
  stashes?: Stash[] | null
  worktrees?: Worktree[] | null
  hidden?: ReadonlySet<string>
  // Unresolved conflicts in this working tree, from the live repo status. Only the checked-out branch owns them.
  conflicts?: number
  query: string
  active: string | null
  onQuery: (query: string) => void
  onActive: (key: string) => void
  onPick: (item: RefItem) => void
  // Opens the branch menu for a branch row, at a point in the window. Without it, rows have no menu.
  onMenu?: (branch: Branch, at: { x: number; y: number }) => void
  id: string
  disabled: boolean
}) {
  const sections = useMemo(() => buildSections({ branches, head: current, tags, stashes, worktrees, hidden }), [branches, current, tags, stashes, worktrees, hidden])
  // The local branches that track each remote branch, matched by exact upstream ref, never by name or commit.
  const trackers = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const branch of branches) if (!branch.remote && branch.upstreamRef) map.set(branch.upstreamRef, [...map.get(branch.upstreamRef) ?? [], branch.name])
    return map
  }, [branches])
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
  const menuFor = (index: number, at: { x: number; y: number }) => {
    const row = rows[index]
    if (!onMenu || row?.type !== 'item' || row.entry.item.kind !== 'branch') return
    onActive(row.key)
    onMenu(row.entry.item.branch, at)
  }
  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    const row = rows[selected]
    // The keyboard route to the branch menu. It opens below the active row, or at the list's top when that row is
    // scrolled out of the mounted window.
    if (onMenu && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault()
      const box = (document.getElementById(optionId(selected)) ?? list.current)?.getBoundingClientRect()
      if (box) menuFor(selected, { x: box.left + 24, y: box.bottom })
      return
    }
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
        {rows.slice(start, end).map((row, offset) => <RowView key={row.key} row={row} id={optionId(start + offset)} conflicts={conflicts}
          tracking={row.type === 'item' && row.entry.item.kind === 'branch' ? trackers.get(row.entry.item.branch.fullRef) : undefined}
          selected={start + offset === selected} disabled={disabled} onClick={() => { onActive(row.key); activate(start + offset) }}
          onMenu={onMenu && row.type === 'item' && row.entry.item.kind === 'branch' ? (at) => menuFor(start + offset, at) : undefined} />)}
      </div>
      {!rows.length && <p className="branch-empty" role="status">No matching refs</p>}
    </div>
  </div>
}

const EMPTY: ReadonlySet<string> = new Set()

function RowView({ row, id, conflicts, tracking, selected, disabled, onClick, onMenu }: {
  row: Row; id: string; conflicts: number; tracking?: string[]; selected: boolean; disabled: boolean; onClick: () => void
  onMenu?: (at: { x: number; y: number }) => void
}) {
  const entry = row.type === 'item' ? row.entry : null
  const branch = entry?.item.kind === 'branch' ? entry.item.branch : null
  const inert = entry ? entry.disabled || disabled : false
  return <div
    id={id} role="treeitem" aria-level={row.level} aria-selected={selected}
    aria-expanded={row.type === 'item' ? undefined : row.expanded} aria-disabled={inert || undefined}
    className={`branch-choice ${row.type}${selected ? ' selected' : ''}${entry?.current ? ' current' : ''}`}
    style={{ paddingLeft: 10 + (row.level - 1) * 16 }} title={entry ? `${entry.path}${entry.detail ? `\n${entry.detail}` : ''}` : undefined}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}
    onContextMenu={onMenu && ((event) => { event.preventDefault(); onMenu({ x: event.clientX, y: event.clientY }) })}
  >
    {row.type === 'item' ? <span className="branch-twisty" /> : <Icon name={row.expanded ? 'chevronDown' : 'chevron'} className="branch-twisty" />}
    <span className="branch-choice-name">{row.label}</span>
    {row.type === 'section' && <span className="count">{row.count ?? '…'}</span>}
    {branch && <TrackBadges branch={branch} conflicts={entry!.current ? conflicts : 0} />}
    {branch && <LocalBadge branch={branch} tracking={tracking} />}
    {entry?.current && <span className="branch-current">Current</span>}
    {entry?.detail && <small>{entry.detail}</small>}
    {/* Its own click never reaches the row, so opening the menu never checks the branch out. Keyboard users press
        ContextMenu or Shift+F10 in the search field instead, so it takes no Tab stop. */}
    {onMenu && <button type="button" className="icon-button branch-menu-trigger" tabIndex={-1} aria-haspopup="menu"
      aria-label={`Actions for ${entry!.path}`} title="Branch actions"
      onClick={(event) => {
        event.stopPropagation()
        const box = event.currentTarget.getBoundingClientRect()
        onMenu({ x: box.left, y: box.bottom })
      }}><Icon name="more" /></button>}
  </div>
}

// Every local branch is local. A remote branch is too when a local branch tracks exactly its ref, and the tooltip names them.
function LocalBadge({ branch, tracking }: { branch: Branch; tracking?: string[] }) {
  if (branch.remote && !tracking?.length) return null
  const title = branch.remote ? `Tracked by local branch${tracking!.length === 1 ? '' : 'es'} ${tracking!.join(', ')}`
    : branch.upstream ? `Local branch, tracking ${branch.upstream}` : 'Local branch'
  return <span className="branch-local" title={title}>Local</span>
}

// A local branch's sync with its upstream, counted from refs already fetched: ↑ commits to push, ↓ fetched commits to
// pull, both when they have diverged. A branch in sync or with no upstream shows nothing; a deleted upstream says gone.
// The checked-out branch also shows the working tree's unresolved conflicts. Divergence alone never implies one.
function TrackBadges({ branch, conflicts }: { branch: Branch; conflicts: number }) {
  if (branch.remote) return null
  const commits = (count: number) => `${count} commit${count === 1 ? '' : 's'}`
  const tracked = branch.upstream !== null && !branch.gone
  if (!conflicts && !branch.gone && !(tracked && (branch.ahead || branch.behind))) return null
  return <span className="branch-track">
    {conflicts > 0 && <span className="conflicts" title={conflictTitle(conflicts)}>{conflictLabel(conflicts)}</span>}
    {branch.gone && <span title={`Upstream ${branch.upstream} is gone`}>gone</span>}
    {tracked && branch.ahead > 0 && <span title={`${commits(branch.ahead)} to push to ${branch.upstream}`}>↑{branch.ahead}</span>}
    {tracked && branch.behind > 0 && <span title={`${commits(branch.behind)} to pull from ${branch.upstream}`}>↓{branch.behind}</span>}
  </span>
}

const conflictLabel = (count: number) => `${count} conflict${count === 1 ? '' : 's'}`
const conflictTitle = (count: number) => `${count} unresolved conflicted file${count === 1 ? '' : 's'} in the working tree. Resolve them in Changes.`

type Extras = { tags: Tag[] | null; stashes: Stash[] | null; worktrees: Worktree[] | null }

export function BranchPicker({ repo, branches, headHash, conflicts, onRefresh, onChanged, onClose, onOpenRepo }: {
  repo: string
  branches: Branch[]
  headHash: string | null
  conflicts: number
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
  // Rename and upstream act on `target`, a local branch picked from the branch menu.
  const [mode, setMode] = useState<'switch' | 'create' | 'base' | 'rename' | 'upstream'>('switch')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [base, setBase] = useState<BranchSelection>({ fullRef: 'HEAD', hash: headHash ?? '' })
  const [target, setTarget] = useState<Branch | null>(null)
  const [newName, setNewName] = useState('')
  // The branch menu: the branch as shown when it opened, and the point it opened at.
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hidden = useHiddenBranches(repo)
  const hiddenSet = useMemo(() => new Set(hidden), [hidden])
  // Branches hide by full ref. A ref no longer listed drops out on the next change, so a deleted branch's name
  // does not hide a new branch created with it later.
  const saveHidden = (refs: string[]) => {
    const listed = new Set(branches.map((branch) => branch.fullRef))
    setHiddenBranches(repo, refs.filter((ref) => listed.has(ref)))
  }
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
  const field = () => dialog.current?.querySelector<HTMLInputElement>(mode === 'create' ? '[name="branch-name"]'
    : mode === 'rename' ? '[name="branch-new-name"]' : '[role="combobox"]')
  useEffect(() => { field()?.focus() }, [mode])

  // While a write runs, focus parks on the sheet. It returns to the field once the write settles, as after a menu write
  // that keeps the picker open.
  useEffect(() => { if (submitting) dialog.current?.focus(); else field()?.focus() }, [submitting])

  // The branch menu closes on a press outside it. Rows keep focus in the search field, so a blur alone would not close it.
  useEffect(() => {
    if (!menu) return
    const press = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.branch-menu')) setMenu(null) }
    document.addEventListener('pointerdown', press)
    return () => document.removeEventListener('pointerdown', press)
  }, [menu])

  const changeMode = (next: typeof mode) => { setMenu(null); setMode(next); setQuery(''); setActive(null) }
  const draftChanged = name !== '' || base.fullRef !== 'HEAD' || base.hash !== initialHead.current
  const requestClose = async () => {
    if (inFlight.current) return
    if (mode === 'base') return changeMode('create')
    if (mode === 'rename' || mode === 'upstream') return changeMode('switch')
    if (draftChanged && !(await confirmOverBlur('Discard this branch draft?'))) return
    // A branch action may have started while the sheet was opening. The picker stays until that action settles.
    if (!inFlight.current) onClose()
  }
  // Switching and creating end the picker's job, so success closes it. A branch menu write passes `done` instead and
  // keeps the picker open on the refreshed list.
  const run = async (key: string, action: () => Promise<unknown>, done?: () => void) => {
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
    if (ok && !done) return onClose()
    if (ok) done!()
    else if (!failed) setError(blockedReason(busyKey(repo)) ?? 'The branch action could not start. Try again.')
    // Refusals may mean the selection became stale. Keep the name and selected identity until the user picks again.
    try { await Promise.all([onRefresh(), (mode === 'switch' || !!done) && loadExtras()]) } catch (failure) {
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
  // A branch cannot track itself, so it is left out of its own upstream choices.
  const upstreamChoices = useMemo(() => branches.filter((branch) => branch.fullRef !== target?.fullRef), [branches, target])
  const pick = async (item: RefItem) => {
    const selection = item.kind === 'head' ? item.selection : item.kind === 'branch' ? { fullRef: item.branch.fullRef, hash: item.branch.hash } : null
    if (mode === 'base') {
      if (selection) { setBase(selection); changeMode('create') }
      return
    }
    if (mode === 'upstream') {
      if (target && item.kind === 'branch') void run('set-upstream', () => api.setUpstream(repo, identity(target), identity(item.branch)), () => changeMode('switch'))
      return
    }
    if (draftChanged && !(await confirmOverBlur('Discard this branch draft and switch?'))) return
    // Tags check out detached, as Checkout Detached does from a commit, without a prompt.
    if (selection) void run('switch', () => api.switchBranch(repo, selection))
    else if (item.kind === 'tag') void run('detach', () => api.checkoutDetached(repo, item.tag.hash))
    else if (item.kind === 'stash') void run(`apply:${item.stash.ref}`, () => api.stashAction(repo, 'apply', item.stash.ref))
    else if (item.kind === 'worktree' && onOpenRepo) { onOpenRepo(item.worktree.path); onClose() }
  }
  const remove = async (branch: Branch) => {
    if (!(await confirmOverBlur(`Delete the local branch ${branch.name}?\n\nGit refuses if it has commits not merged into its upstream, or into HEAD when it has none. No remote branch is deleted.`))) return
    void run('delete-branch', () => api.deleteBranch(repo, identity(branch)),
      () => setHiddenBranches(repo, hiddenBranches(repo).filter((ref) => ref !== branch.fullRef)))
  }
  const rename = () => {
    if (!target || !newName || newName === target.name) return
    const renamed = newName
    void run('rename-branch', () => api.renameBranch(repo, identity(target), renamed), () => {
      // A hidden branch stays hidden under its new name.
      const refs = hiddenBranches(repo)
      if (refs.includes(target.fullRef)) setHiddenBranches(repo, refs.map((ref) => ref === target.fullRef ? `refs/heads/${renamed}` : ref))
      changeMode('switch')
    })
  }
  // Fills the search with the branch's name, which lists it beside its remote or local counterpart, and selects the
  // text so typing replaces it.
  const searchFor = (branch: Branch) => {
    setQuery(branch.name)
    setActive(`i:${branch.fullRef}`)
    requestAnimationFrame(() => { const input = field(); input?.focus(); input?.select() })
  }
  const branchItems = (branch: Branch): BarItem[] => {
    const writing = blockedReason(busy)
    const shown = !hiddenSet.has(branch.fullRef)
    return [
      { key: 'checkout', group: 'checkout', icon: 'branch', label: `Checkout ${branch.name}`, blocked: branch.current ? 'Already checked out' : writing,
        onClick: () => void pick({ kind: 'branch', branch }) },
      { key: 'create-from', group: 'checkout', icon: 'plus', label: `Create Branch From ${branch.name}…`,
        onClick: () => { setBase(identity(branch)); changeMode('create') } },
      // A remote branch is never renamed, deleted or given an upstream from here: each would need a push.
      ...(branch.remote ? [] : [
        { key: 'rename', group: 'edit', icon: 'edit', label: `Rename ${branch.name}…`,
          onClick: () => { setTarget(branch); setNewName(branch.name); changeMode('rename') } },
        { key: 'delete', group: 'edit', icon: 'trash', danger: true, label: `Delete ${branch.name}`,
          blocked: branch.current ? 'Checked out. Switch to another branch before deleting it.' : writing, onClick: () => void remove(branch) },
        { key: 'set-upstream', group: 'upstream', icon: 'link', label: 'Set Upstream…',
          detail: branch.upstream ? `Tracking ${branch.upstream}${branch.gone ? ' (gone)' : ''}` : undefined,
          onClick: () => { setTarget(branch); changeMode('upstream') } },
        { key: 'unset-upstream', group: 'upstream', icon: 'unlink', label: 'Unset Upstream', disabled: !branch.upstreamRef, blocked: writing,
          onClick: () => void run('unset-upstream', () => api.unsetUpstream(repo, identity(branch)), () => {}) },
      ] satisfies BarItem[]),
      shown
        ? { key: 'hide', group: 'visibility', icon: 'eyeOff', label: `Hide ${branch.name}`, onClick: () => saveHidden([...hidden, branch.fullRef]) }
        : { key: 'show', group: 'visibility', icon: 'eye', label: `Show ${branch.name}`, onClick: () => saveHidden(hidden.filter((ref) => ref !== branch.fullRef)) },
      { key: 'hide-others', group: 'visibility', icon: 'eyeOff', label: `Hide All Branches Except ${branch.name}`,
        onClick: () => saveHidden(branches.flatMap((other) => other.fullRef === branch.fullRef ? [] : [other.fullRef])) },
      ...(hidden.length ? [{ key: 'show-all', group: 'visibility', icon: 'eye', label: 'Show All Hidden Branches',
        detail: 'In this picker and History', onClick: () => setHiddenBranches(repo, []) } satisfies BarItem] : []),
      { key: 'copy', group: 'find', icon: 'copy', label: `Copy '${branch.name}'`,
        onClick: () => { navigator.clipboard.writeText(branch.name).catch((failure) => setError(`Could not copy: ${failure instanceof Error ? failure.message : String(failure)}`)) } },
      { key: 'search', group: 'find', icon: 'search', label: 'Search…', onClick: () => searchFor(branch) },
    ]
  }
  const title = mode === 'switch' ? 'Checkout' : mode === 'base' ? 'Choose a base branch' : mode === 'create' ? 'Create branch'
    : mode === 'rename' ? 'Rename branch' : `Set upstream for ${target?.name ?? ''}`
  const subtitle = mode === 'switch'
    ? 'Remote branches create or reuse a local tracking branch. Tags check out detached. Stashes apply and stay listed. Worktrees open. Right-click a branch for more.'
    : mode === 'rename' ? 'Renames the local branch. It never replaces another branch, and nothing changes on a remote.'
    : mode === 'upstream' ? `Choose the branch ${target?.name ?? ''} pulls from. ${target?.upstream ? `Now: ${target.upstream}.` : 'It has none now.'}`
    : 'Creates an independent local branch and switches to it.'
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
          if (event.key !== 'Escape') return
          event.preventDefault()
          // Escape closes the branch menu first, back to the search field, and only then the sheet.
          if (menu) { setMenu(null); field()?.focus() }
          else requestClose()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (mode === 'create' && name && !unavailable) void run('create-branch', () => api.createBranch(repo, name, base))
          else if (mode === 'rename') rename()
        }}
      >
        <header className="dialog-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <p className="dialog-sub">{subtitle}</p>
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
          </> : mode === 'rename' ? <>
            <label className="field"><span>New name for {target?.name}</span>
              <input name="branch-new-name" value={newName} onChange={(event) => setNewName(event.target.value)} disabled={submitting} autoComplete="off" spellCheck={false} />
            </label>
            <p className="dialog-sub">Its upstream setting and reflog move with it.</p>
          </> : <BranchChoices
            id={id} branches={mode === 'upstream' ? upstreamChoices : branches} current={mode === 'base' ? baseHead : undefined}
            {...(mode === 'switch' ? { ...extras, worktrees: onOpenRepo ? extras.worktrees : undefined, hidden: hiddenSet } : {})}
            conflicts={conflicts} query={query} active={active} onQuery={(value) => { setQuery(value); setActive(null) }} onActive={setActive}
            onPick={pick} onMenu={mode === 'switch' ? (branch, at) => setMenu({ branch, ...at }) : undefined} disabled={submitting || busy !== null}
          />}
          {/* A detached HEAD, as during a rebase, has no branch row to carry the count. */}
          {mode !== 'create' && mode !== 'rename' && conflicts > 0 && !branches.some((branch) => branch.current) &&
            <p className="dialog-sub" role="status" title={conflictTitle(conflicts)}>Detached HEAD has {conflictLabel(conflicts)} unresolved in the working tree.</p>}
          {(error || busy) && <p className={error ? 'dialog-error' : 'dialog-sub'} role={error ? 'alert' : 'status'}>{error ?? (submitting ? workingLabel(busy!) : blockedReason(busy))}</p>}
        </div>
        <footer className="dialog-foot">
          {mode === 'switch' && <div className="branch-create-actions">
            <button type="button" onClick={() => changeMode('create')} disabled={submitting}>Create Branch…</button>
            <button type="button" onClick={() => changeMode('base')} disabled={submitting}>Create Branch From…</button>
          </div>}
          {mode === 'create' && <button type="button" className="ghost" onClick={() => changeMode('switch')} disabled={submitting}>Back</button>}
          <button type="button" className="ghost" onClick={requestClose} disabled={submitting}>{mode === 'switch' || mode === 'create' ? 'Cancel' : 'Back'}</button>
          {mode === 'create' && <button type="submit" className="primary" disabled={submitting || busy !== null || !name || unavailable}>
            {submitting ? 'Creating branch…' : 'Create and Switch'}
          </button>}
          {mode === 'rename' && <button type="submit" className="primary" disabled={submitting || busy !== null || !newName || newName === target?.name}>
            {submitting ? 'Renaming…' : 'Rename'}
          </button>}
        </footer>
        {/* One menu for the whole list, outside its scroller, inside the sheet's focus trap. */}
        {menu && <ActionMenu className="context-menu branch-menu" label={`Actions for ${menu.branch.name}`} at={menu} items={branchItems(menu.branch)}
          onPick={(item) => { setMenu(null); field()?.focus(); item.onClick() }} onDismiss={() => setMenu(null)} />}
      </form>
    </div>, document.body,
  )
}

const identity = (branch: Branch): BranchSelection => ({ fullRef: branch.fullRef, hash: branch.hash })
