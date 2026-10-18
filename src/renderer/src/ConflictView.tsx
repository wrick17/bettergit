import { applyChoices, conflictBlocks, splitLines, type Choice, type ChoiceKind, type Combine, type ConflictBlock, type ConflictDocument, type ConflictSave } from '../../shared/conflict'
import { IconButton } from './Icons'
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

export interface ConflictViewProps {
  path: string
  model: ConflictDocument
  // The parent owns the choices, so they survive a reload of the file list.
  choices: readonly Choice[]
  onChoose: (index: number, choice: Choice) => void
  // Saves with the fingerprint from load, not a fresh one, so the write is bound to the file the user reviewed.
  onSave: (save: ConflictSave) => void
  // True while the save runs. Every control stops, and the save button says so.
  saving: boolean
}

export function ConflictView({ path, model, choices, onChoose, onSave, saving }: ConflictViewProps) {
  if (!model.supported) {
    return (
      <section className="conflict" aria-label={`Conflict in ${path}`}>
        <p className="conflict-unsupported" role="status">{model.message}</p>
      </section>
    )
  }
  const { fingerprint } = model
  const blocks = conflictBlocks(model.parts)
  if (blocks.length === 0) {
    return (
      <section className="conflict" aria-label={`Conflict in ${path}`}>
        <p className="conflict-note" role="status">No conflict markers remain in this file. Stage it to mark it resolved.</p>
      </section>
    )
  }
  const resolved = blocks.filter((block) => choices[block.index] != null).length
  const result = applyChoices(model.parts, choices, model.combine)
  const canSave = !saving && result.ok && resolved > 0

  return (
    <section className="conflict" aria-label={`Conflict in ${path}`}>
      <header className="conflict-bar">
        <span className="conflict-path" title={path}>{path}</span>
        <span className="conflict-count" aria-live="polite">{resolved} of {blocks.length} resolved</span>
        <button type="button" className="conflict-save" disabled={!canSave} aria-busy={saving || undefined} onClick={() => onSave({ fingerprint, choices: Array.from({ length: blocks.length }, (_, index) => choices[index] ?? null) })}>
          {saving ? 'Saving…' : 'Save resolution'}
        </button>
      </header>
      {blocks.map((block) => (
        <ConflictBlockView
          key={block.index}
          block={block}
          total={blocks.length}
          choice={choices[block.index] ?? null}
          combine={model.combine[block.index]}
          disabled={saving}
          onChoose={onChoose}
        />
      ))}
      <section className="conflict-result" aria-label="Result">
        <h3>Result</h3>
        {result.ok
          ? <CodeLines text={result.text} />
          : <p className="conflict-unsupported" role="alert">{result.reason}</p>}
        <p className="conflict-note">The saved text is not compiled or tested.</p>
      </section>
    </section>
  )
}

function ConflictBlockView({ block, total, choice, combine, disabled, onChoose }: {
  block: ConflictBlock
  total: number
  choice: Choice
  combine: Combine
  disabled: boolean
  onChoose: (index: number, choice: Choice) => void
}) {
  const number = block.index + 1
  const titleId = `conflict-title-${block.index}`
  return (
    <article className="conflict-block" aria-labelledby={titleId}>
      <header className="conflict-block-head">
        <h3 id={titleId}>Conflict {number} of {total}</h3>
        <span className={`conflict-state${choice ? ' done' : ''}`}>
          {choice ? `Resolved with ${CHOICE_NAME[choice]}` : 'Unresolved'}
        </span>
        {choice && (
          <IconButton icon="undo" label={`Clear the choice for conflict ${number}`} onClick={() => onChoose(block.index, null)} disabled={disabled} />
        )}
      </header>
      <div className="conflict-actions" role="group" aria-label={`Resolution for conflict ${number}`}>
        {CHOICES.map(({ kind, label, hint }) => {
          const available = kind !== 'combine' || combine.state === 'ready'
          return (
            <button
              key={kind}
              type="button"
              className="conflict-choice"
              aria-pressed={choice === kind}
              disabled={disabled || !available}
              title={available ? hint : combineNote(combine)}
              onClick={() => onChoose(block.index, choice === kind ? null : kind)}
            >
              {label}
            </button>
          )
        })}
      </div>
      {combine.state !== 'ready' && <p className="conflict-note">{combineNote(combine)}</p>}
      <div className="conflict-sides">
        <SideView tone="current" title="Current" label={block.currentLabel} text={block.current} />
        <SideView tone="incoming" title="Incoming" label={block.incomingLabel} text={block.incoming} />
      </div>
      {block.fileBase !== null && (
        <details className="conflict-base">
          <summary>Base</summary>
          <CodeLines text={block.fileBase} />
        </details>
      )}
    </article>
  )
}

function SideView({ tone, title, label, text }: {
  tone: 'current' | 'incoming'
  title: string
  label: string
  text: string
}) {
  return (
    <section className={`conflict-side ${tone}`} aria-label={title}>
      <h4>{title}{label && <span className="conflict-label">{label}</span>}</h4>
      <CodeLines text={text} />
    </section>
  )
}

function combineNote(combine: Combine): string {
  if (combine.state === 'overlap') return 'Both sides edit the same words, so only current, incoming, or both can be kept.'
  if (combine.state === 'unavailable') return combine.reason
  return 'Merges both edits from their common base.'
}

// One row per line. The line terminator is not shown. A carriage return inside a line shows as a visible glyph,
// so no text is hidden and no control character reaches the page.
const displayLine = (line: string) => line.replace(/\r?\n?$/, '').replace(/\r/g, '␍')

function CodeLines({ text }: { text: string }) {
  const lines = splitLines(text)
  if (lines.length === 0) return <p className="conflict-empty">Empty</p>
  return (
    <div className="conflict-code">
      {lines.map((line, index) => (
        <div key={index} className="conflict-line">
          <span className="conflict-gutter" aria-hidden="true">{index + 1}</span>
          <code>{displayLine(line)}</code>
        </div>
      ))}
    </div>
  )
}
