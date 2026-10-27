// Bundled by browser.test.ts for a real Chromium page: the pieces whose behaviour depends on layout or live DOM.
import { EditorState, EditorSelection } from '@codemirror/state'
import { StrictMode, createElement, useEffect, useMemo, useRef } from 'react'
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
import { CommitStat, inListOrder, useFilesView } from '../src/renderer/src/CommitStat'
import { useActiveFiles } from '../src/renderer/src/active-file'
import type { DiffFile } from '../src/main/git/diff'

// A diff container that registers its files with find, as DiffView does.
function FindDiff({ files }: { files: Parameters<typeof useFindSource>[1] }) {
  const ref = useRef<HTMLDivElement>(null)
  useFindSource(ref, files, () => undefined)
  return createElement('div', { ref, className: 'diff' }, 'diff')
}

// History's pairing: the commit's file list beside a code diff pane in the list's order, joined by the file at the pane's top.
function ActiveDiff({ files: patchFiles }: { files: DiffFile[] }) {
  const pane = useRef<HTMLDivElement>(null)
  const active = useActiveFiles(pane)
  const [view, setView] = useFilesView()
  const { files } = useMemo(() => inListOrder({ files: patchFiles, moves: [] }, view), [patchFiles, view])
  useEffect(active.probe, [active, files])
  return createElement('div', { style: { display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', height: '400px' } },
    createElement('div', { className: 'commit-info' }, createElement(CommitStat, { files, view, onView: setView, onSelect: () => undefined, activeFiles: active })),
    createElement('div', { ref: pane, className: 'diff-pane', style: { overflow: 'auto' }, onScroll: active.probe }, createElement(DiffView, { files, moves: [] })))
}

Object.assign(window, {
  under: { bufferedKey, lineColumnAt, setFindQuery, watchFind, typeKeys, EditorState, EditorSelection, createElement, flushSync, createRoot, EditableDiff, FindBar, FindDiff, revealMatch, clearHighlight, mountedEditors, SettingsDialog, applyAppearance, DiffView, setDiffLayout, setContextLines, ActiveDiff, StrictMode },
})
