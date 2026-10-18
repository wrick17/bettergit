import { ChangeSet, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension, type Text } from '@codemirror/state'
import { Decoration, drawSelection, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { getOriginalDoc, MergeView, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge'
import { tokenize } from './highlight'

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
}

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
export function mountEditor({ parent, layout, language, path, text, original, separator, onText, onSave, onEscape }: {
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
}): Mounted {
  const current: Extension[] = [
    common(language),
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
  const collapse = { margin: 3, minSize: 4 }
  const quiet = Transaction.addToHistory.of(false)
  const whole = (doc: Text, insert: string) => (doc.toString() === insert ? undefined : { from: 0, to: doc.length, insert })
  if (layout === 'split') {
    const merge = new MergeView({
      a: { doc: original, extensions: [common(language), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': `Previous contents of ${path}` })] },
      b: { doc: text, extensions: current },
      parent,
      gutter: true,
      collapseUnchanged: collapse,
    })
    return {
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
    doc: text,
    extensions: [current, unifiedMergeView({ original, mergeControls: false, syntaxHighlightDeletions: false, collapseUnchanged: collapse })],
  })
  return {
    replace: (next) => view.dispatch({ changes: whole(view.state.doc, next) }),
    sync: (loaded, old) => {
      const before = getOriginalDoc(view.state)
      view.dispatch({
        changes: whole(view.state.doc, loaded),
        effects: originalDocChangeEffect(view.state, ChangeSet.of({ from: 0, to: before.length, insert: old }, before.length)),
        annotations: quiet,
      })
    },
    reveal: (side, line, from, to, near) => (side === 'old' ? select(view, near, 0, 0) : select(view, line, from, to)),
    unmark: () => { if (view.dom.isConnected) view.dispatch({ effects: setFindMark.of(null) }) },
    destroy: () => view.destroy(),
  }
}

// Shared by both sides: line numbers, wrapped lines, and Shiki colours like the rest of the diff.
function common(language: string | null): Extension {
  return [lineNumbers(), EditorView.lineWrapping, shikiColours(language), findField]
}

// Colours the whole text with Shiki, after a pause in typing. Until fresh colours arrive, the old ones move with the text.
function shikiColours(language: string | null): Extension {
  if (!language) return []
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    timer: ReturnType<typeof setTimeout> | undefined
    gone = false
    constructor(readonly view: EditorView) { this.schedule(0) }
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
          const builder = new RangeSetBuilder<Decoration>()
          lines.forEach((segments, index) => {
            if (index >= doc.lines) return
            let at = doc.line(index + 1).from
            for (const { text, light, dark } of segments) {
              if ((light || dark) && text) builder.add(at, at + text.length, Decoration.mark({ class: 'tok', attributes: { style: `--tok-light: ${light}; --tok-dark: ${dark}` } }))
              at += text.length
            }
          })
          this.decorations = builder.finish()
          // An empty transaction redraws the view with the new colours.
          this.view.dispatch({})
        })
      }, delay)
    }
    destroy() {
      this.gone = true
      clearTimeout(this.timer)
    }
  }, { decorations: (plugin) => plugin.decorations })
}
