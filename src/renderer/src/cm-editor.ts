import { ChangeSet, EditorState, RangeSetBuilder, Transaction, type Extension, type Text } from '@codemirror/state'
import { Decoration, drawSelection, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { getOriginalDoc, MergeView, originalDocChangeEffect, unifiedMergeView } from '@codemirror/merge'
import { tokenize } from './highlight'

// One mounted diff editor. `replace` is an undoable edit; `sync` brings in a reload without touching the undo history.
export interface Mounted {
  replace: (text: string) => void
  sync: (loaded: string, original: string) => void
  destroy: () => void
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
    destroy: () => view.destroy(),
  }
}

// Shared by both sides: line numbers, wrapped lines, and Shiki colours like the rest of the diff.
function common(language: string | null): Extension {
  return [lineNumbers(), EditorView.lineWrapping, shikiColours(language)]
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
        void tokenize(doc.toString(), language).then((lines) => {
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
