import { ChangeSet, Compartment, EditorSelection, EditorState, findClusterBreak, RangeSetBuilder, StateEffect, StateField, Text, Transaction, type Extension } from '@codemirror/state'
import { Decoration, drawSelection, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands'
import { Chunk, getChunks, getOriginalDoc, MergeView, originalDocChangeEffect, uncollapseUnchanged, unifiedMergeView } from '@codemirror/merge'
import { cachedTokens, tokenize, type Segment } from './highlight'
import { onRecolour } from './prefs'

// One mounted diff editor. `replace` is an undoable edit; `sync` brings in a reload without touching the undo history.
// `reveal` marks a find match: on the old side (split) or the current text, by 1-based line and offsets in that line.
// `near` is the current line shown for an old-side match in the unified editor, whose removed lines cannot be selected.
export interface Mounted {
  replace: (text: string) => void
  sync: (loaded: string, original: string) => void
  reveal: (side: 'old' | 'new', line: number, from: number, to: number, near: number) => void
  // Removes the find mark that `reveal` drew.
  unmark: () => void
  destroy: () => void
  // The current side's view, and every scroller (both columns in split), which sideways scrolling keeps in step.
  view: EditorView
  scrollers: HTMLElement[]
  setWrap: (wrap: boolean) => void
  // Opens the fold holding a line, so find can show it.
  unfold: (side: 'old' | 'new', line: number) => void
  // The drawn row of a removed line in the unified editor, after scrolling its block into view; null until drawn.
  deletedLine: (oldLine: number) => HTMLElement | null
}

// A fold the editor opened, named by its first line on the current side (and the old side, which split also folds).
export interface Fold { a: number; b: number; count: number }

// The current find match, drawn as a mark like the read-only diff's highlight. Edits move it with the text.
const setFindMark = StateEffect.define<{ from: number; to: number } | null>()
const findMark = Decoration.mark({ class: 'cm-find-current' })
const findField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes)
    for (const effect of tr.effects) {
      if (effect.is(setFindMark)) marks = effect.value && effect.value.to > effect.value.from ? Decoration.set([findMark.range(effect.value.from, effect.value.to)]) : Decoration.none
    }
    return marks
  },
  provide: (field) => EditorView.decorations.from(field),
})

function select(view: EditorView, line: number, from: number, to: number) {
  const { doc } = view.state
  const at = doc.line(Math.min(Math.max(line, 1), doc.lines))
  const start = Math.min(at.from + from, at.to)
  // Find scrolls the drawn mark into view itself: the editor's own scroll uses estimated heights for lines far away.
  view.dispatch({ effects: setFindMark.of({ from: start, to: Math.min(at.from + to, at.to) }) })
}

// Unified: one editor of the current file, with removed lines as read-only blocks. Split: the read-only old side on the
// left, the editable current side on the right. Unchanged stretches fold like the read-only diff.
export function mountEditor({ parent, layout, language, path, text, original, separator, onText, onSave, onEscape, wrap, folds, opened, onFold, at }: {
  parent: HTMLElement
  layout: 'unified' | 'split'
  language: string | null
  path: string
  text: string
  original: string
  // Line breaks the file uses, put back on every edit.
  separator: string
  onText: (text: string) => void
  onSave: () => void
  onEscape: () => boolean
  wrap: boolean
  // The folds the editor starts with (from previewOf), the ones already opened in the static rows, and a callback for
  // each fold opened in the editor, so the static rows match it after the editor goes.
  folds: Fold[]
  opened: Set<number>
  onFold: (b: number) => void
  // Where the caret starts, focused: 1-based line and column on the current side.
  at?: { line: number; column: number }
}): Mounted {
  const wrapping = new Compartment()
  // Fold starts as document positions, mapped through edits, so a fold can still be opened by position later.
  const foldsA = folds.map((fold) => ({ ...fold, from: -1 }))
  const current: Extension[] = [
    common(language, wrapping, wrap),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(uncollapseUnchanged)) continue
          const line = tr.state.doc.lineAt(effect.value).number
          const fold = foldsB.find((entry) => entry.from === effect.value)
          onFold(fold?.b ?? line)
        }
      }
      if (update.docChanged) for (const fold of foldsB) if (fold.from >= 0) fold.from = update.changes.mapPos(fold.from)
    }),
    history(),
    drawSelection(),
    keymap.of([
      { key: 'Mod-s', run: () => { onSave(); return true } },
      { key: 'Escape', run: onEscape },
      indentWithTab,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    EditorView.contentAttributes.of({ 'aria-label': `Contents of ${path}. Unsaved edits save with Command S and revert with Escape.` }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onText(update.state.doc.sliceString(0, update.state.doc.length, separator))
    }),
  ]
  const collapse = FOLD
  const quiet = Transaction.addToHistory.of(false)
  const foldsB = folds.map((fold) => ({ ...fold, from: -1 }))
  const doc = Text.of(text.split(/\r\n?|\n/))
  const selection = at ? EditorSelection.cursor(doc.line(Math.min(Math.max(at.line, 1), doc.lines)).from + at.column) : undefined
  const clampSelection = selection && EditorSelection.cursor(Math.min(selection.head, doc.line(Math.min(Math.max(at!.line, 1), doc.lines)).to))
  // Opens the folds the static rows already opened, then hands focus and the caret to the editor.
  const start = (a: EditorView | null, b: EditorView) => {
    foldsB.forEach((fold) => { if (fold.b <= b.state.doc.lines) fold.from = b.state.doc.line(fold.b).from })
    if (a) foldsA.forEach((fold) => { if (fold.a <= a.state.doc.lines) fold.from = a.state.doc.line(fold.a).from })
    const open = (view: EditorView, list: Array<Fold & { from: number }>) => {
      const effects = list.filter((fold) => opened.has(fold.b) && fold.from >= 0).map((fold) => uncollapseUnchanged.of(fold.from))
      if (effects.length) view.dispatch({ effects })
    }
    if (a) open(a, foldsA)
    open(b, foldsB)
    if (at) b.focus()
  }
  const unfold = (a: EditorView | null, b: EditorView, side: 'old' | 'new', line: number) => {
    const index = folds.findIndex((fold) => {
      const first = side === 'old' ? fold.a : fold.b
      return first <= line && line < first + fold.count
    })
    if (index < 0) return
    if (a && foldsA[index].from >= 0) a.dispatch({ effects: uncollapseUnchanged.of(foldsA[index].from) })
    if (foldsB[index].from >= 0) b.dispatch({ effects: uncollapseUnchanged.of(foldsB[index].from) })
  }
  const whole = (doc: Text, insert: string) => (doc.toString() === insert ? undefined : { from: 0, to: doc.length, insert })
  if (layout === 'split') {
    const merge = new MergeView({
      a: { doc: original, extensions: [common(language, wrapping, wrap), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': `Previous contents of ${path}` })] },
      b: { doc, selection: clampSelection, extensions: current },
      parent,
      gutter: true,
      collapseUnchanged: collapse,
    })
    start(merge.a, merge.b)
    return {
      view: merge.b,
      scrollers: [merge.a.scrollDOM, merge.b.scrollDOM],
      setWrap: (next) => { for (const side of [merge.a, merge.b]) side.dispatch({ effects: wrapping.reconfigure(next ? EditorView.lineWrapping : []) }) },
      unfold: (side, line) => unfold(merge.a, merge.b, side, line),
      deletedLine: () => null,
      replace: (next) => merge.b.dispatch({ changes: whole(merge.b.state.doc, next) }),
      sync: (loaded, old) => {
        const changes = whole(merge.a.state.doc, old)
        if (changes) merge.a.dispatch({ changes, annotations: quiet })
        const edits = whole(merge.b.state.doc, loaded)
        if (edits) merge.b.dispatch({ changes: edits, annotations: quiet })
      },
      reveal: (side, line, from, to) => select(side === 'old' ? merge.a : merge.b, line, from, to),
      unmark: () => { for (const side of [merge.a, merge.b]) if (side.dom.isConnected) side.dispatch({ effects: setFindMark.of(null) }) },
      destroy: () => merge.destroy(),
    }
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: clampSelection,
      extensions: [current, unifiedMergeView({ original, mergeControls: false, syntaxHighlightDeletions: false, collapseUnchanged: collapse, diffConfig: DIFF })],
    }),
  })
  start(null, view)
  // The block of removed lines that holds an old line, and that line's place in it.
  const deletion = (oldLine: number) => {
    const chunks = getChunks(view.state)?.chunks ?? []
    const old = getOriginalDoc(view.state)
    if (oldLine < 1 || oldLine > old.lines) return null
    const pos = old.line(oldLine).from
    const chunk = chunks.find((entry) => entry.fromA <= pos && pos < entry.toA)
    return chunk ? { chunk, index: oldLine - old.lineAt(chunk.fromA).number } : null
  }
  return {
    view,
    scrollers: [view.scrollDOM],
    setWrap: (next) => view.dispatch({ effects: wrapping.reconfigure(next ? EditorView.lineWrapping : []) }),
    unfold: (side, line) => {
      // An old line outside every change shows as the same current line, which is what folds.
      if (side === 'old') {
        const chunks = getChunks(view.state)?.chunks ?? []
        const old = getOriginalDoc(view.state)
        if (line < 1 || line > old.lines) return
        const pos = old.line(line).from
        let offset = 0
        for (const chunk of chunks) {
          if (chunk.fromA > pos) break
          offset = view.state.doc.lineAt(Math.min(chunk.toB, view.state.doc.length)).number - old.lineAt(Math.min(chunk.toA, old.length)).number
        }
        line += offset
      }
      unfold(null, view, 'new', line)
    },
    deletedLine: (oldLine) => {
      const found = deletion(oldLine)
      if (!found) return null
      const block = [...view.dom.querySelectorAll<HTMLElement>('.cm-deletedChunk')].find((element) => {
        try { return view.posAtDOM(element) === found.chunk.fromB } catch { return false }
      })
      const row = block?.querySelectorAll<HTMLElement>('.cm-deletedLine')[found.index] ?? null
      if (!row) view.dispatch({ effects: EditorView.scrollIntoView(found.chunk.fromB, { y: 'center' }) })
      return row
    },
    replace: (next) => view.dispatch({ changes: whole(view.state.doc, next) }),
    sync: (loaded, old) => {
      const before = getOriginalDoc(view.state)
      // An unchanged old side is left alone, so its chunks and opened folds stay as they are.
      const same = before.toString() === old.split(/\r?\n/).join('\n')
      const changes = whole(view.state.doc, loaded)
      if (same && !changes) return
      view.dispatch({
        changes,
        effects: same ? [] : originalDocChangeEffect(view.state, ChangeSet.of({ from: 0, to: before.length, insert: old }, before.length)),
        annotations: quiet,
      })
    },
    reveal: (side, line, from, to, near) => (side === 'old' ? select(view, near, 0, 0) : select(view, line, from, to)),
    unmark: () => { if (view.dom.isConnected) view.dispatch({ effects: setFindMark.of(null) }) },
    destroy: () => view.destroy(),
  }
}

// Shared by both sides: line numbers, wrapped lines (or sideways scrolling), and Shiki colours like the rest of the diff.
function common(language: string | null, wrapping: Compartment, wrap: boolean): Extension {
  return [lineNumbers(), wrapping.of(wrap ? EditorView.lineWrapping : []), shikiColours(language), findField]
}

// Colours the whole text with Shiki, after a pause in typing. Until fresh colours arrive, the old ones move with the text.
function shikiColours(language: string | null): Extension {
  if (!language) return []
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    timer: ReturnType<typeof setTimeout> | undefined
    gone = false
    // A new syntax theme re-colours the text; the old colours stay until the new ones arrive.
    offRecolour = onRecolour(() => this.schedule(0))
    constructor(readonly view: EditorView) {
      // Colours tokenised already (by the static rows shown before this editor) apply on its first frame.
      const cached = cachedTokens(view.state.doc.toString(), language)
      if (cached) this.decorations = colourDecorations(cached, view.state.doc)
      else this.schedule(0)
    }
    update(update: ViewUpdate) {
      if (!update.docChanged) return
      this.decorations = this.decorations.map(update.changes)
      this.schedule(150)
    }
    schedule(delay: number) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        const doc = this.view.state.doc
        void tokenize(doc.toString(), language, () => this.gone || this.view.state.doc !== doc).then((lines) => {
          if (!lines || this.gone || this.view.state.doc !== doc) return
          this.decorations = colourDecorations(lines, doc)
          // An empty transaction redraws the view with the new colours.
          this.view.dispatch({})
        })
      }, delay)
    }
    destroy() {
      this.gone = true
      clearTimeout(this.timer)
      this.offRecolour()
    }
  }, { decorations: (plugin) => plugin.decorations })
}

// Types keys that arrived before the editor did (see bufferedKey), at the caret, as the user would have.
export function typeKeys(target: { state: EditorState; dispatch: (tr: Transaction) => void }, keys: string[]) {
  for (const key of keys) {
    if (key === '\b') {
      const { state } = target
      const range = state.selection.main
      if (!range.empty) target.dispatch(state.update(state.replaceSelection(''), { userEvent: 'delete.backward' }))
      else if (range.head > 0) {
        const line = state.doc.lineAt(range.head)
        const from = range.head === line.from ? range.head - 1 : line.from + findClusterBreak(line.text, range.head - line.from, false)
        target.dispatch(state.update({ changes: { from, to: range.head }, selection: { anchor: from }, userEvent: 'delete.backward' }))
      }
    } else if (key === '\n') insertNewlineAndIndent(target)
    else target.dispatch(target.state.update(target.state.replaceSelection(key), { scrollIntoView: true, userEvent: 'input.type' }))
  }
}

function colourDecorations(lines: Segment[][], doc: Text): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  lines.forEach((segments, index) => {
    if (index >= doc.lines) return
    let at = doc.line(index + 1).from
    for (const { text, light, dark } of segments) {
      if ((light || dark) && text) builder.add(at, at + text.length, Decoration.mark({ class: 'tok', attributes: { style: `--tok-light: ${light}; --tok-dark: ${dark}` } }))
      at += text.length
    }
  })
  return builder.finish()
}

// What the editor would draw, as plain data, so a file can show as static rows that look exactly like its editor and
// only mount one when clicked. It runs CodeMirror's own diff and fold rules, so the two never disagree.
export type Marks = Array<[number, number]>
export type Stretch =
  // Unchanged lines that show: `count` lines from line `a` on the old side and line `b` on the current side (1-based).
  | { kind: 'same'; a: number; b: number; count: number }
  // Unchanged lines folded into one bar. `b` names the fold, the line CodeMirror starts it on.
  | { kind: 'fold'; a: number; b: number; count: number }
  // A changed block: old lines [a, a + countA) and current lines [b, b + countB), with the changed text of each line.
  | { kind: 'chunk'; a: number; countA: number; b: number; countB: number; marksA: Marks[]; marksB: Marks[] }
export interface Preview {
  old: string[]
  lines: string[]
  stretches: Stretch[]
}

// The editor's fold settings: unchanged runs keep 3 lines beside each change and fold when 4 or more lines are left.
const FOLD = { margin: 3, minSize: 4 }
const DIFF = { scanLimit: 500 }

export function previewOf(text: string, original: string): Preview {
  // The same documents the editors build: EditorState splits on any line break, unifiedMergeView's original on \r?\n.
  const b = Text.of(text.split(/\r\n?|\n/))
  const a = Text.of(original.split(/\r?\n/))
  const chunks = Chunk.build(a, b, DIFF)
  const stretches: Stretch[] = []
  // Unchanged run between two chunks, from (lineA, lineB) for `count` lines, folded like buildCollapsedRanges.
  const unchanged = (lineA: number, lineB: number, count: number, first: boolean, last: boolean) => {
    if (count <= 0) return
    const before = first ? 0 : FOLD.margin
    const after = last ? 0 : FOLD.margin
    const folded = count - before - after
    if (folded < FOLD.minSize) {
      stretches.push({ kind: 'same', a: lineA, b: lineB, count })
      return
    }
    if (before) stretches.push({ kind: 'same', a: lineA, b: lineB, count: before })
    stretches.push({ kind: 'fold', a: lineA + before, b: lineB + before, count: folded })
    if (after) stretches.push({ kind: 'same', a: lineA + before + folded, b: lineB + before + folded, count: after })
  }
  let lineA = 1
  let lineB = 1
  chunks.forEach((chunk, index) => {
    const startA = a.lineAt(chunk.fromA).number
    const startB = b.lineAt(chunk.fromB).number
    const countA = chunk.toA > chunk.fromA ? a.lineAt(chunk.endA).number - startA + 1 : 0
    const countB = chunk.toB > chunk.fromB ? b.lineAt(chunk.endB).number - startB + 1 : 0
    unchanged(lineA, lineB, startB - lineB, index === 0, false)
    stretches.push({ kind: 'chunk', a: startA, countA, b: startB, countB, marksA: marksOf(a, chunk, startA, countA, true), marksB: marksOf(b, chunk, startB, countB, false) })
    lineA = startA + countA
    lineB = startB + countB
  })
  unchanged(lineA, lineB, b.lines - lineB + 1, chunks.length === 0, true)
  const lines = (doc: Text) => Array.from({ length: doc.lines }, (_, index) => doc.line(index + 1).text)
  return { old: lines(a), lines: lines(b), stretches }
}

// The changed text of each line of a chunk side, as offsets in that line, like the editor's changed-text marks.
function marksOf(doc: Text, chunk: Chunk, start: number, count: number, isA: boolean): Marks[] {
  const out: Marks[] = Array.from({ length: count }, () => [])
  const base = isA ? chunk.fromA : chunk.fromB
  for (const change of chunk.changes) {
    const from = base + (isA ? change.fromA : change.fromB)
    const to = base + (isA ? change.toA : change.toB)
    for (let index = 0; index < count && from < to; index++) {
      const line = doc.line(start + index)
      const markFrom = Math.max(from, line.from)
      const markTo = Math.min(to, line.to)
      if (markFrom < markTo) out[index].push([markFrom - line.from, markTo - line.from])
    }
  }
  return out
}
