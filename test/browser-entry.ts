// Bundled by browser.test.ts for a real Chromium page: the pieces whose behaviour depends on layout or live DOM.
import { EditorState, EditorSelection } from '@codemirror/state'
import { createElement, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { EditableDiff, bufferedKey, lineColumnAt, mountedEditors } from '../src/renderer/src/DiffEditor'
import { FindBar } from '../src/renderer/src/FindBar'
import { clearHighlight, revealMatch, setFindQuery, useFindSource, watchFind } from '../src/renderer/src/find'
import { typeKeys } from '../src/renderer/src/cm-editor'
import { SettingsDialog } from '../src/renderer/src/Dialogs'
import { applyAppearance } from '../src/renderer/src/appearance'
import { DiffView, setDiffLayout } from '../src/renderer/src/DiffView'
import { setContextLines } from '../src/renderer/src/prefs'

// A diff container that registers its files with find, as DiffView does.
function FindDiff({ files }: { files: Parameters<typeof useFindSource>[1] }) {
  const ref = useRef<HTMLDivElement>(null)
  useFindSource(ref, files, () => undefined)
  return createElement('div', { ref, className: 'diff' }, 'diff')
}

Object.assign(window, {
  under: { bufferedKey, lineColumnAt, setFindQuery, watchFind, typeKeys, EditorState, EditorSelection, createElement, flushSync, createRoot, EditableDiff, FindBar, FindDiff, revealMatch, clearHighlight, mountedEditors, SettingsDialog, applyAppearance, DiffView, setDiffLayout, setContextLines },
})
