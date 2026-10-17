import { describe, expect, test } from 'bun:test'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConflictView } from '../src/renderer/src/ConflictView'
import { conflictBlocks, parseConflicts, type Choice, type Combine, type ConflictDocument, type ConflictSave } from '../src/shared/conflict'

const unavailable: Combine = { state: 'unavailable', reason: 'The base could not be matched.' }
const fingerprint = { working: 'working-bytes-1', stages: 'stage-ids-1' }

// The model the parent builds from a parse. Combine defaults to unavailable, as it is before the backend merge.
function modelFor(text: string, combine: Combine[] = []): ConflictDocument {
  const parsed = parseConflicts(text)
  if (!parsed.ok) return { supported: false, message: parsed.failure.message }
  const blocks = conflictBlocks(parsed.parts)
  return { supported: true, fingerprint, parts: parsed.parts, combine: blocks.map((_, index) => combine[index] ?? unavailable) }
}

// Finds the first element in the tree whose props match. The save control is rendered by ConflictView itself,
// so walking its element tree reaches the callback without a DOM.
function find(node: ReactNode, match: (element: ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }>) => boolean): ReactElement<{ onClick?: () => void }> | undefined {
  for (const child of Array.isArray(node) ? node : [node]) {
    if (!isValidElement<{ className?: string; onClick?: () => void; children?: ReactNode }>(child)) continue
    if (match(child)) return child
    const found = find(child.props.children, match)
    if (found) return found
  }
  return undefined
}

const twoBlocks = 'x\n<<<<<<< HEAD\nalpha\n=======\nbeta\n>>>>>>> topic\n'
  + 'y\n<<<<<<< HEAD\ngamma\n=======\ndelta\n>>>>>>> topic\n'

function render(overrides: Partial<Parameters<typeof ConflictView>[0]> = {}) {
  return renderToStaticMarkup(
    <ConflictView
      path="src/app.ts"
      model={modelFor(twoBlocks)}
      choices={[]}
      onChoose={() => {}}
      onSave={() => {}}
      saving={false}
      {...overrides}
    />,
  )
}

describe('ConflictView', () => {
  test('shows both sides of every conflict and a count of unresolved ones, with save disabled', () => {
    const markup = render()
    for (const code of ['alpha', 'beta', 'gamma', 'delta']) expect(markup).toContain(code)
    expect(markup).toContain('0 of 2 resolved')
    expect(markup).toMatch(/class="conflict-save" disabled=""/)
  })

  test('marks the chosen resolution and enables save once one block is resolved', () => {
    const choices: Choice[] = ['incoming', null]
    const markup = render({ choices })
    expect(markup).toContain('Resolved with incoming')
    expect(markup).toContain('1 of 2 resolved')
    expect(markup).not.toMatch(/class="conflict-save" disabled/)
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Accept incoming</)
  })

  test('an unavailable combination shows its reason and cannot be chosen', () => {
    const markup = render()
    expect(markup).toContain('The base could not be matched.')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Accept combination<\/button>/)
  })

  test('a ready combination can be chosen', () => {
    const combine: Combine[] = [{ state: 'ready', text: 'merged\n' }, unavailable]
    const markup = render({ model: modelFor(twoBlocks, combine), choices: ['combine', null] })
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Accept combination</)
    expect(markup).toContain('merged')
    // Only the second block, whose base is unavailable, keeps its combination disabled.
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Accept combination<\/button>/g)).toHaveLength(1)
  })

  test('an unsupported file shows its reason and no controls', () => {
    const markup = render({ model: modelFor('a\0b') })
    expect(markup).toContain('NUL bytes')
    expect(markup).not.toContain('Accept current')
    expect(markup).not.toContain('Save resolution')
  })

  test('carriage returns never reach the page', () => {
    const crlf = 'x\r\n<<<<<<< HEAD\r\nalpha\r\n=======\r\nbeta\r\n>>>>>>> topic\r\n'
    const markup = render({ model: modelFor(crlf) })
    expect(markup).toContain('alpha')
    expect(markup).not.toContain('\r')
  })

  test('saving stops every control and says so', () => {
    const markup = render({ choices: ['current', null], saving: true })
    expect(markup).toContain('Saving…')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Accept current<\/button>/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Accept incoming<\/button>/)
  })

  test('save hands back the fingerprint from load with the current choices', () => {
    const saved: ConflictSave[] = []
    const tree = ConflictView({
      path: 'src/app.ts',
      model: modelFor(twoBlocks),
      choices: ['current', null],
      onChoose: () => {},
      onSave: (save) => { saved.push(save) },
      saving: false,
    })
    find(tree, (element) => element.props.className === 'conflict-save')?.props.onClick?.()
    expect(saved).toEqual([{ fingerprint, choices: ['current', null] }])
  })
})
