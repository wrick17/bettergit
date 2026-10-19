import { type FocusEvent, type ReactNode, useMemo, useState } from 'react'
import type { MovedBlock } from '../../main/git/diff'
import { applyChoices, conflictBlocks, type Choice, type ChoiceKind, type Combine, type ConflictDocument, type ConflictSave, type Part } from '../../shared/conflict'
import { conflictFile, isMarker } from './conflict-rows'
import { DiffView, LayoutToggles, useDiffLayout, type ConflictDecor } from './DiffView'
import { IconButton } from './Icons'
import { CONTEXT_OPTIONS, useContextLines } from './prefs'
import { blockedReason } from './repo-busy'
import './conflict.css'

const CHOICES: { kind: ChoiceKind; label: string; hint: string }[] = [
  { kind: 'current', label: 'Accept current', hint: 'Keep the current side only.' },
  { kind: 'incoming', label: 'Accept incoming', hint: 'Keep the incoming side only.' },
  { kind: 'both', label: 'Accept both', hint: 'Current, then incoming. No merge is attempted.' },
  { kind: 'combine', label: 'Accept combination', hint: 'Merge both edits from their common base.' },
]

const CHOICE_NAME: Record<ChoiceKind, string> = {
  current: 'current',
  incoming: 'incoming',
  both: 'both',
  combine: 'combination',
}

const NO_MOVES: MovedBlock[] = []
const NO_CHOICES: Choice[] = []

export interface ConflictViewProps {
  path: string
  model: ConflictDocument
  // The parent owns the choices, so they survive a reload of the file list.
  choices: readonly Choice[]
  onChoose: (index: number, choice: Choice) => void
  // Saves with the fingerprint from load, not a fresh one, so the write is bound to the file the user reviewed.
  onSave: (save: ConflictSave) => void
  // Asks, then replaces the whole file with the conflicts recreated from Git's index. The parent owns the confirmation.
  onReset: () => void
  // The write running in this repo, or null. Every control stops while it runs, and the running one says so.
  busy: string | null
}

// No hooks here: the diff below owns them, so this stays a plain function of its props.
export function ConflictView({ path, model, choices, onChoose, onSave, onReset, busy }: ConflictViewProps) {
  // The bar shows in every state, so a file with broken markers or none left can still be reset. With a diff below, it
  // also holds that diff's layout controls, so each file's controls stay in its own sticky bar.
  const bar = (middle: ReactNode, save?: ReactNode) => (
    <header className="conflict-bar">
      <span className="conflict-path" title={path}>{path}</span>
      {middle}
      {save && <LayoutToggles />}
      <IconButton
        icon="reset"
        label="Reset resolution"
        onClick={onReset}
        busy={busy === 'conflict-reset'}
        blocked={!model.reset.available ? model.reset.reason : busy !== null && busy !== 'conflict-reset' ? blockedReason(busy) : undefined}
      />
      {save}
    </header>
  )
  // An empty count keeps the reset button at the end of the bar, where it sits beside Save.
  const spacer = <span className="conflict-count" aria-hidden="true" />
  if (!model.supported) {
    return (
      <section className="conflict" aria-label={`Conflict in ${path}`} data-path={path}>
        {bar(spacer)}
        <p className="conflict-unsupported" role="status">{model.message}</p>
      </section>
    )
  }
  const { fingerprint } = model
  const blocks = conflictBlocks(model.parts)
  if (blocks.length === 0) {
    return (
      <section className="conflict" aria-label={`Conflict in ${path}`} data-path={path}>
        {bar(spacer)}
        <p className="conflict-note" role="status">No conflict markers remain in this file. Stage it to mark it resolved.</p>
      </section>
    )
  }
  const saving = busy === 'resolve'
  const resolved = blocks.filter((block) => choices[block.index] != null).length
  const result = applyChoices(model.parts, choices, model.combine)
  const canSave = busy === null && result.ok && resolved > 0

  return (
    <section className="conflict" aria-label={`Conflict in ${path}`} data-path={path} onFocus={keepFocusInView}>
      {bar(
        <span className="conflict-count" aria-live="polite">{resolved} of {blocks.length} resolved</span>,
        <button type="button" className="conflict-save" disabled={!canSave} aria-busy={saving || undefined} onClick={() => onSave({ fingerprint, choices: Array.from({ length: blocks.length }, (_, index) => choices[index] ?? null) })}>
          {saving ? 'Saving…' : 'Save resolution'}
        </button>,
      )}
      {!result.ok && <p className="conflict-unsupported" role="alert">{result.reason}</p>}
      <ConflictDiff
        path={path}
        parts={model.parts}
        combine={model.combine}
        choices={choices}
        shown={result.ok ? choices : NO_CHOICES}
        disabled={busy !== null}
        onChoose={onChoose}
      />
      <p className="conflict-note">The saved text is not compiled or tested.</p>
    </section>
  )
}

// The file in the ordinary diff viewer, with each conflict's controls inline above it. Unchanged lines fold like in any
// diff. Widening needs no Git read, since the whole file is already here. `shown` is what the rows preview: the choices,
// or none when they cannot be applied.
function ConflictDiff({ path, parts, combine, choices, shown, disabled, onChoose }: {
  path: string
  parts: Part[]
  combine: Combine[]
  choices: readonly Choice[]
  shown: readonly Choice[]
  disabled: boolean
  onChoose: (index: number, choice: Choice) => void
}) {
  const preferred = useContextLines()
  const layout = useDiffLayout()
  const [widened, setWidened] = useState<{ path: string; lines: number }>()
  const context = widened?.path === path ? widened.lines : preferred
  const view = useMemo(() => conflictFile(path, parts, shown, combine, context), [path, parts, shown, combine, context])
  const files = useMemo(() => [view.file], [view])
  const total = combine.length
  const controls = (index: number) => (
    <ConflictControls key={index} split={layout === 'split'} index={index} total={total} choice={choices[index] ?? null} combine={combine[index]} disabled={disabled} onChoose={onChoose} />
  )
  const decor: ConflictDecor = {
    splitRows: (hunk) => view.split.get(hunk) ?? [],
    row: (line) => {
      const kind = view.kinds.get(line)
      return kind && { className: `conflict-row ${kind}${isMarker(kind) ? ' marker' : ''}`, plain: isMarker(kind) }
    },
    controls: (hunk, index) => (index < hunk.lines.length
      ? view.before.get(hunk.lines[index])?.map(controls)
      : hunk === view.file.hunks[view.file.hunks.length - 1] ? view.end.map(controls) : null),
  }
  return (
    <DiffView
      files={files}
      moves={NO_MOVES}
      onExpand={() => setWidened({ path, lines: CONTEXT_OPTIONS.find((lines) => lines > context) ?? context })}
      conflict={decor}
      toolbar={false}
    />
  )
}

// Tab moves between conflicts whose rows may not be mounted yet. They mount around the focused control, and rows above
// it can come out taller than their estimate, so a keyboard focus is kept in view for a few frames while they settle.
function keepFocusInView(event: FocusEvent<HTMLElement>) {
  const target = event.target
  if (!target.matches(':focus-visible')) return
  let frames = 0
  const follow = () => {
    if (document.activeElement !== target) return
    target.scrollIntoView({ block: 'nearest' })
    if (++frames < 8) requestAnimationFrame(follow)
  }
  requestAnimationFrame(follow)
}

// Compact actions above a conflict's first line. They are controls, not source, so they carry no line numbers.
function ConflictControls({ index, total, choice, combine, disabled, onChoose, split }: {
  split: boolean
  index: number
  total: number
  choice: Choice
  combine: Combine
  disabled: boolean
  onChoose: (index: number, choice: Choice) => void
}) {
  const number = index + 1
  const label = `Resolution for conflict ${number} of ${total}`
  const actions = (side?: 'incoming' | 'current') => (
    <div className="conflict-lens" role="group" aria-label={side ? `${side === 'incoming' ? 'Incoming' : 'Current'} actions for conflict ${number} of ${total}` : label}>
      {CHOICES.filter(({ kind }) => (!side || kind === side || kind === 'both' || kind === 'combine') && (kind !== 'combine' || combine.state === 'ready')).map(({ kind, label, hint }) => (
        <button
          key={kind}
          type="button"
          className="conflict-choice"
          aria-pressed={choice === kind}
          disabled={disabled}
          title={choice === kind ? `${label}: chosen — click to clear this choice. ${hint}` : `${label}: not chosen — click to choose it. ${hint}`}
          onClick={() => onChoose(index, choice === kind ? null : kind)}
        >
          {label}
        </button>
      ))}
      {choice && <span className="conflict-state">{`Resolved with ${CHOICE_NAME[choice]}`}</span>}
      {choice && (
        <IconButton icon="undo" label={`Clear the choice for conflict ${number}`} onClick={() => onChoose(index, null)} disabled={disabled} />
      )}
      {combine.state !== 'ready' && <span className="conflict-hint">{combineNote(combine)}</span>}
    </div>
  )
  return split ? (
    <div className="split-row conflict-split-controls" role="group" aria-label={label}>
      {actions('incoming')}
      {actions('current')}
    </div>
  ) : actions()
}

function combineNote(combine: Combine): string {
  if (combine.state === 'overlap') return 'Both sides edit the same words, so only current, incoming, or both can be kept.'
  if (combine.state === 'unavailable') return combine.reason
  return 'Merges both edits from their common base.'
}
