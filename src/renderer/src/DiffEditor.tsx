import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import type { DiffHunk } from '../../main/git/diff'
import type { Marks, Mounted, Preview, Stretch } from './cm-editor'
import { wholeLine } from './intraline'
import { hunkStarts } from './hunk-rows'
import { confirmOverBlur } from './confirm'
import { Code } from './DiffView'
import { cachedTokens, tokenize, type Segment } from './highlight'
import { charWidth, codeLine, columns, hscrollOf, useCodeMetrics } from './hscroll'
import { useLanguageOverrides, useWordWrap } from './prefs'
import { originalText } from './original-text'
import { RowChunk } from './row-chunk'
import { suspendHold } from './scroll-anchor'
import { IconButton } from './Icons'
import './diff-editor.css'

// Reads and saves a repo-relative working file. `save` resolves false when the write failed and was already reported.
export interface EditBridge {
  // The repo the paths belong to. A draft shows only in diffs of its own repo.
  repo: string
  load: (path: string) => Promise<string>
  save: (path: string, loaded: string, text: string) => Promise<boolean>
  onError: (error: unknown) => void
  disabled?: boolean
}

// The text of each loaded working file, by repo and path. It lives outside every DiffView, so a reload, remount or layout
// switch keeps unsaved text. A clean entry leaves with its editor; a dirty one stays until it is saved or discarded.
interface Draft {
  path: string
  loaded: string
  text: string
  saving?: boolean
  // Set while an editor shows the draft, so a discard goes through its undo history.
  revert?: () => void
}
const drafts = new Map<string, Draft>()
// The editor mounted in each `.diff-editor` host, so find can reveal a line in it.
export const mountedEditors = new WeakMap<Element, Mounted>()
const draftListeners = new Set<() => void>()
const keyOf = (repo: string, path: string) => `${repo}\0${path}`
const dirty = (draft: Draft | undefined) => !!draft && draft.text !== draft.loaded

function setDraft(key: string, draft: Draft | null) {
  if (draft) drafts.set(key, draft)
  else drafts.delete(key)
  for (const listener of draftListeners) listener()
}

function useDraft(key: string) {
  return useSyncExternalStore((listener) => {
    draftListeners.add(listener)
    return () => { draftListeners.delete(listener) }
  }, () => drafts.get(key))
}

// Whether a working file has unsaved edits. False without an edit bridge.
export function useUnsaved(edit: EditBridge | undefined, path: string) {
  const draft = useDraft(edit ? keyOf(edit.repo, path) : '')
  return !!edit && dirty(draft)
}

// Drafts outlive their editors, so selecting, scrolling or switching views keeps them. Staging or discarding a file takes
// it out of the working diff, where its draft can no longer show, so those ask first. False when the user keeps the edits.
export async function confirmDropEdits(repo: string, paths: string[]): Promise<boolean> {
  const lost = paths.flatMap((path) => (dirty(drafts.get(keyOf(repo, path))) ? [path] : []))
  if (!lost.length) return true
  if (!(await confirmOverBlur(`Discard your unsaved edits to ${lost.join(', ')}?`))) return false
  for (const path of lost) {
    const draft = drafts.get(keyOf(repo, path))!
    draft.revert ? draft.revert() : setDraft(keyOf(repo, path), null)
  }
  return true
}

async function saveDraft(edit: EditBridge, path: string) {
  const key = keyOf(edit.repo, path)
  const draft = drafts.get(key)
  if (!draft || !dirty(draft) || draft.saving || edit.disabled) return
  setDraft(key, { ...draft, saving: true })
  const ok = await edit.save(path, draft.loaded, draft.text).catch((error) => (edit.onError(error), false))
  const now = drafts.get(key)
  // Text typed while the save ran stays in the draft, and stays unsaved.
  if (now) setDraft(key, { ...now, saving: false, loaded: ok ? draft.text : now.loaded })
}

// Save and discard, in the file header, only while the file has unsaved text.
export function DraftActions({ edit, path }: { edit: EditBridge; path: string }) {
  const key = keyOf(edit.repo, path)
  const draft = useDraft(key)
  if (!draft || !dirty(draft)) return null
  const discard = async () => {
    if (draft.revert) draft.revert()
    else if (await confirmOverBlur(`Discard your edits to ${path}?`)) setDraft(key, null)
  }
  return (
    <>
      <span className="diff-file-open"><IconButton icon="undo" label={`Discard edits to ${path}`} disabled={draft.saving} onClick={discard} /></span>
      <span className="diff-file-open">
        <IconButton icon="save" label={draft.saving ? `Saving ${path}…` : `Save ${path} (⌘S)`} busy={draft.saving} disabled={edit.disabled} onClick={() => void saveDraft(edit, path)} />
      </span>
    </>
  )
}

type Loaded = { loaded: string; original: string; preview: Preview | null }
type Source = Loaded | { error: string }
type At = { line: number; column: number }
type CodeMirror = typeof import('./cm-editor')

// CodeMirror loads on first use, so the rest of the app, and its tests, never load it. Once a file is near the screen it
// loads in idle time, so the first click mounts an editor at once.
let cm: CodeMirror | null = null
let cmLoad: Promise<CodeMirror> | null = null
const loadCodeMirror = () => (cmLoad ??= import('./cm-editor').then((module) => (cm = module)))
const whenIdle = (run: () => void) => {
  const idle = window.requestIdleCallback
  if (!idle) {
    const timer = setTimeout(run, 1)
    return () => clearTimeout(timer)
  }
  const handle = idle(run, { timeout: 300 })
  return () => window.cancelIdleCallback?.(handle)
}

// Colours a loaded file's editor-look rows before they show, so they paint coloured. Within tokenize's limits.
async function colouredSource(loaded: string, hunks: DiffHunk[], language: string | null, module: CodeMirror, stale?: () => boolean): Promise<Source> {
  const original = originalText(loaded, hunks)
  if (original === null) return { error: 'This diff is out of date. It refreshes when the file is reloaded.' }
  const preview = module.previewOf(loaded, original)
  if (preview) await Promise.all([tokenize(preview.lines.join('\n'), language, stale), tokenize(preview.old.join('\n'), language, stale)])
  return { loaded, original, preview }
}

// Sources loaded ahead of a refresh, by file key. A file that mounts with the same hunks starts on its editor-look rows,
// so it appears once at its final height instead of on its read-only rows first.
const prepared = new Map<string, { hunks: DiffHunk[]; source: Source }>()

export function prepareSource(edit: EditBridge, path: string, hunks: DiffHunk[], language: string | null): Promise<void> {
  const key = keyOf(edit.repo, path)
  if (dirty(drafts.get(key))) return Promise.resolve()
  return Promise.all([edit.load(path), loadCodeMirror()])
    .then(([loaded, module]) => colouredSource(loaded, hunks, language, module))
    .then((source) => { if (!('error' in source)) prepared.set(key, { hunks, source }) }, () => undefined)
}

// The folds a user opened, per file, by their first current-side line. Shared by the static rows and the editor, so
// opening a fold in one shows in the other.
const openedFolds = new Map<string, Set<number>>()
// Lets find open a fold or scroll a part of a file's static rows into view, so a match in it mounts.
export const previewReveals = new WeakMap<Element, (side: 'old' | 'new', line: number) => void>()

// One key typed before the editor could take it: text, '\n' for Enter, '\b' for Backspace. Null for keys left alone.
export function bufferedKey(event: { key: string; metaKey: boolean; ctrlKey: boolean }): string | null {
  if (event.metaKey || event.ctrlKey) return null
  if (event.key === 'Enter') return '\n'
  if (event.key === 'Backspace') return '\b'
  return [...event.key].length === 1 ? event.key : null
}

// Keys are kept for a file that is still loading for at most this long, so a load that never ends cannot keep taking them.
const TYPE_AHEAD_MS = 3000

// The current-side line and column a caret position (from caretPositionFromPoint) falls on, or null when it is not on an
// editable line: removed lines, the old side and folds stay read-only. A position in the gutter starts the line.
export function lineColumnAt(node: Node | null, offset: number): At | null {
  let row: Element | null = node?.nodeType === 1 ? node as Element : node?.parentElement ?? null
  while (row && !(row.classList?.contains('ed-line'))) row = row.parentElement
  const line = Number(row?.getAttribute('data-new'))
  if (!row || !line) return null
  const code = row.querySelector('code')
  if (!code || !node || !code.contains(node)) return { line, column: 0 }
  let column = 0
  const walk = (current: Node): boolean => {
    if (current === node) {
      column += current.nodeType === 3 ? offset : [...current.childNodes].slice(0, offset).reduce((sum, child) => sum + (child.textContent?.length ?? 0), 0)
      return true
    }
    if (current.nodeType === 3) {
      column += (current as Text).data.length
      return false
    }
    for (const child of current.childNodes) if (walk(child)) return true
    return false
  }
  walk(code)
  return { line, column }
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = (document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

// The working-tree diff of one text file. It shows as static rows drawn like its editor, and the editor mounts only when
// a line is clicked (the caret lands where the click was) or the file gets keyboard focus. Context and added lines are
// the editable text; removed lines and the old side are read-only. Until the file loads, or when it cannot be edited,
// `fallback` (the read-only diff) shows instead. A clean editor goes back to static rows once it loses focus and leaves
// the screen; one with unsaved text stays.
export function EditableDiff({ edit, path, hunks, layout, language, context = 3, fallback, fileIndex, onExtent, hunkActions, readOnly = false }: {
  edit: EditBridge
  path: string
  hunks: DiffHunk[]
  layout: 'unified' | 'split'
  language: string | null
  context?: number
  fallback: ReactNode
  fileIndex: number
  onExtent: (pixels: number) => void
  // Each Git hunk's stage and discard controls, above its first change while the file has no unsaved edits.
  hunkActions?: (hunk: DiffHunk) => ReactNode
  // The same rows, never opened as an editor: a file with only staged changes, so staging it does not re-render it.
  readOnly?: boolean
}) {
  const key = keyOf(edit.repo, path)
  const wrap = useWordWrap()
  const wrapRef = useRef(wrap)
  wrapRef.current = wrap
  const contextRef = useRef(context)
  contextRef.current = context
  const editRef = useRef(edit)
  editRef.current = edit
  const [source, setSource] = useState<Source | null>(() => {
    const ready = prepared.get(key)
    prepared.delete(key)
    return ready?.hunks === hunks ? ready.source : null
  })
  // The hunks the source on screen was loaded for, so a prepared source is not loaded again.
  const sourceFor = useRef<DiffHunk[] | null>(source ? hunks : null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const [editing, setActive] = useState(() => !readOnly && dirty(drafts.get(key)))
  // An open editor closes when its file turns read-only, and stays closed after.
  const active = editing && !readOnly
  useEffect(() => { if (readOnly) setActive(false) }, [readOnly])
  const [opened, setOpened] = useState(() => openedFolds.get(key) ?? new Set<number>())
  const openedRef = useRef(opened)
  openedRef.current = opened
  const openFold = useCallback((b: number) => setOpened((prev) => {
    if (prev.has(b)) return prev
    const next = new Set(prev).add(b)
    openedFolds.set(key, next)
    return next
  }), [key])
  const host = useRef<HTMLDivElement>(null)
  const mounted = useRef<Mounted | null>(null)
  // What the next mount starts with: the caret, the clicked row's place on screen, and keys typed before it was ready.
  const startAt = useRef<At | null>(null)
  const anchor = useRef<{ line: number; top: number } | null>(null)
  const typed = useRef<string[] | null>(null)
  // Ends the key capture and drops its keys. Only the editor mount it was waiting for takes the keys first.
  const stopTyping = useRef<(() => void) | null>(null)
  const dropTyping = () => stopTyping.current?.()
  useEffect(() => dropTyping, [key])
  useEffect(() => { if (source && 'error' in source) dropTyping() }, [source])
  const [near, setNear] = useState(() => dirty(drafts.get(key)))
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const file = probe.current?.parentElement
    if (near || !file) return
    const margin = '800px 0px'
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true) }, { rootMargin: margin, scrollMargin: margin })
    observer.observe(file)
    return () => observer.disconnect()
  }, [near])

  // Each new diff of the file reloads it, in idle time, with CodeMirror, and works out the static rows. A dirty draft
  // keeps the text and the old side it was typed against, and its editor.
  useEffect(() => {
    if (!near) return
    let stale = false
    const draft = drafts.get(key)
    if (dirty(draft)) {
      void loadCodeMirror().then((module) => {
        if (stale || (sourceRef.current && !('error' in sourceRef.current))) return
        const original = originalText(draft!.loaded, hunks)
        // The static rows show the file as loaded, for when the draft is saved or discarded and the editor goes.
        setSource(original === null ? { error: `${path} changed on disk since your edits began. Discard them to edit it again.` } : { loaded: draft!.loaded, original, preview: module.previewOf(draft!.loaded, original) })
      })
      return () => { stale = true }
    }
    if (sourceFor.current === hunks) return
    // The rows on screen stay until the new ones are loaded and coloured.
    const cancel = whenIdle(() => {
      Promise.all([editRef.current.load(path), loadCodeMirror()])
        .then(([loaded, module]) => colouredSource(loaded, hunks, language, module, () => stale))
        .then(
          (next) => {
            if (stale || dirty(drafts.get(key))) return
            sourceFor.current = hunks
            setSource(next)
          },
          (error) => { if (!stale) setSource({ error: messageOf(error) }) },
        )
    })
    return () => {
      stale = true
      cancel()
    }
  }, [key, path, hunks, near])

  const loaded = source && !('error' in source) ? source : null
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const preview = useMemo(() => loaded?.preview?.context === context ? loaded.preview
    : loaded && cm ? cm.previewOf(loaded.loaded, loaded.original, context) : loaded?.preview ?? null, [loaded, context])
  const hunkWidgets = useMemo(() => active && preview && hunkActions && sourceFor.current === hunks
    ? [...hunkStarts(preview, hunks)].map(([stretch, index]) => {
      const dom = document.createElement('div')
      dom.className = 'ed-hunk-actions'
      return { line: stretch.b, dom, hunk: hunks[index] }
    }) : [], [active, preview, hunks, !!hunkActions])
  const tokens = usePreviewTokens(preview, language, layout)
  const metrics = useCodeMetrics()
  // Layout effect: a font change repaints with the new extent, not a frame of the old one.
  useLayoutEffect(() => {
    if (preview && !wrap) onExtent(Math.max(columns(preview.lines, 4) * charWidth() + 28, columns(preview.old, 4) * charWidth() + 90))
  }, [preview, onExtent, wrap, metrics])

  // Builds the editor in place, in the same frame as the click: CodeMirror and the text are already loaded.
  // Built once per layout and language; a reload updates it in place (below), so the caret survives a save.
  useLayoutEffect(() => {
    const start = loadedRef.current
    if (!active || !start || !cm || !host.current) return
    const draft = drafts.get(key)
    const base = dirty(draft) ? draft!.loaded : start.loaded
    const revert = () => {
      const entry = drafts.get(key)
      if (!entry || !mounted.current) return
      mounted.current.replace(entry.loaded)
      setDraft(key, { ...drafts.get(key)!, text: entry.loaded })
    }
    setDraft(key, { path, loaded: base, text: dirty(draft) ? draft!.text : base, revert })
    const parent = host.current
    const text = drafts.get(key)!.text
    const model = preview && text === start.loaded ? preview : cm.previewOf(text, start.original, contextRef.current)
    const at = startAt.current
    const place = anchor.current
    startAt.current = null
    anchor.current = null
    const editor = cm.mountEditor({
      parent,
      layout,
      language,
      path,
      text,
      original: start.original,
      separator: base.includes('\r\n') ? '\r\n' : '\n',
      onText: (next) => {
        const entry = drafts.get(key)
        if (entry) setDraft(key, { ...entry, text: next })
      },
      onSave: () => void saveDraft(editRef.current, path),
      onEscape: () => {
        if (!dirty(drafts.get(key))) return false
        revert()
        return true
      },
      wrap: wrapRef.current,
      context: contextRef.current,
      folds: model.stretches.flatMap((stretch) => (stretch.kind === 'fold' ? [stretch] : [])),
      opened: openedRef.current,
      onFold: openFold,
      at: at ?? undefined,
    })
    mounted.current = editor
    mountedEditors.set(parent, editor)
    const section = parent.closest<HTMLElement>('.diff-file')
    const unfollow = section ? editor.scrollers.map((element) => hscrollOf(section).follow(element)) : []
    // Keys typed before the editor was ready go in now, at the caret.
    const keys = typed.current
    dropTyping()
    if (keys?.length) cm.typeKeys(editor.view, keys)
    // The editor draws on its next measure, before the frame paints. The clicked line is kept where it was on screen,
    // since lines above it that the editor has not drawn yet are estimated.
    const pane = parent.closest<HTMLElement>('.diff-pane')
    if (place && pane) {
      editor.view.requestMeasure({
        read: (view) => (place.line <= view.state.doc.lines ? view.documentTop + view.lineBlockAt(view.state.doc.line(place.line).from).top : null),
        write: (top) => { if (top !== null) pane.scrollTop += top - place.top },
      })
    }
    return () => {
      unfollow.forEach((stop) => stop())
      editor.destroy()
      mounted.current = null
      const entry = drafts.get(key)
      if (entry) setDraft(key, dirty(entry) ? { ...entry, revert: undefined } : null)
    }
  }, [key, path, layout, language, !!loaded, active])

  useEffect(() => { mounted.current?.setWrap(wrap) }, [wrap])
  const previousContext = useRef(context)
  useLayoutEffect(() => {
    if (previousContext.current === context) return
    previousContext.current = context
    openedFolds.delete(key)
    setOpened(new Set())
    mounted.current?.setContext(context)
  }, [key, context])

  // A reload of a clean file brings the editor up to date: the old side always, and the text when it changed on disk.
  useEffect(() => {
    if (!mounted.current || !loaded || dirty(drafts.get(key))) return
    const entry = drafts.get(key)
    if (entry) setDraft(key, { ...entry, loaded: loaded.loaded, text: loaded.loaded })
    mounted.current.sync(loaded.loaded, loaded.original)
  }, [key, loaded])

  // Reuse the preview's hunk mapping and buttons without replacing the editor, its selection or undo history.
  useEffect(() => { mounted.current?.setHunkActions(hunkWidgets) }, [hunkWidgets, layout, language])

  // A clean editor that has lost focus goes back to static rows once it leaves the screen.
  useEffect(() => {
    const element = host.current
    if (!active || !element) return
    let focused = element.contains(document.activeElement)
    let visible = true
    const check = () => { if (!focused && !visible && !dirty(drafts.get(key))) setActive(false) }
    const onIn = () => { focused = true }
    const onOut = (event: FocusEvent) => {
      if (element.contains(event.relatedTarget as Node | null)) return
      focused = false
      check()
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      check()
    })
    observer.observe(element)
    element.addEventListener('focusin', onIn)
    element.addEventListener('focusout', onOut)
    draftListeners.add(check)
    return () => {
      observer.disconnect()
      element.removeEventListener('focusin', onIn)
      element.removeEventListener('focusout', onOut)
      draftListeners.delete(check)
    }
  }, [active, key])

  // Synchronous from an input event, so the editor exists, focused, before the next key arrives.
  const activate = (at: At | null, row: Element | null, sync = true) => {
    if (mounted.current || readOnly) return
    startAt.current = at
    anchor.current = at && row ? { line: at.line, top: row.getBoundingClientRect().top } : null
    if (sync) flushSync(() => setActive(true))
    else setActive(true)
  }

  // A click on the read-only rows shown before the file loaded asks for the editor too. Keys typed until it mounts are kept.
  useEffect(() => {
    if (!typed.current || active || !preview) return
    activate(startAt.current, null, false)
  })
  const fallbackClick = (event: ReactMouseEvent) => {
    if (readOnly || dragged(event)) return
    const row = (event.target as Element).closest<HTMLElement>('[data-source-row]')
    const [, hunk, index] = (row?.dataset.sourceRow ?? '').split(':').map(Number)
    const line = hunks[hunk]?.lines[index]
    if (!line?.newNo || row?.dataset.sourceSide === 'old' || row?.classList.contains('del')) return
    const caret = caretAt(event.clientX, event.clientY)
    const code = row!.querySelector('code')
    let column = 0
    if (caret && code?.contains(caret.node)) {
      const range = document.createRange()
      range.setStart(code, 0)
      range.setEnd(caret.node, caret.offset)
      column = range.toString().length
    }
    startAt.current = { line: line.newNo, column }
    if (stopTyping.current) return
    const keys: string[] = []
    typed.current = keys
    const file = event.currentTarget as HTMLElement
    const onKey = (key: KeyboardEvent) => {
      // Keys typed into a field are that field's.
      const target = key.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))) return
      const value = bufferedKey(key)
      if (value === null) return
      key.preventDefault()
      keys.push(value)
    }
    // A click anywhere else gives up the edit, so its keys never land in this file.
    const onDown = (down: PointerEvent) => {
      if (!file.contains(down.target as Node)) dropTyping()
    }
    const stop = () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', stop)
      clearTimeout(timer)
      if (stopTyping.current === stop) stopTyping.current = null
      if (typed.current === keys) typed.current = null
    }
    const timer = setTimeout(stop, TYPE_AHEAD_MS)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', stop)
    stopTyping.current = stop
  }

  if (!loaded || (!preview && !active)) {
    return (
      <>
        {!near && <span ref={probe} hidden />}
        {source && 'error' in source && <p className="hint diff-edit-note">Read-only: {source.error}</p>}
        {loaded || !source ? <div onMouseDown={rememberDown} onMouseUp={fallbackClick}>{fallback}</div> : fallback}
      </>
    )
  }
  if (active) return <><div className="diff-editor" ref={host} />{hunkWidgets.map(({ dom, hunk }, index) => createPortal(hunkActions?.(hunk), dom, index))}</>
  return (
    <EditorPreview model={preview!} tokens={tokens} layout={layout} opened={opened} onOpen={openFold} fileIndex={fileIndex} hunks={hunks} path={path}
      onActivate={activate} hunkActions={hunkActions} readOnly={readOnly} />
  )
}

// A press and release in about the same place, with no text selected, is a click; anything else is a drag that selects.
let down = { x: 0, y: 0 }
const rememberDown = (event: ReactMouseEvent) => { down = { x: event.clientX, y: event.clientY } }
function dragged(event: ReactMouseEvent) {
  return event.button !== 0 || Math.abs(event.clientX - down.x) > 3 || Math.abs(event.clientY - down.y) > 3 || !!window.getSelection()?.toString()
}

// Shiki colours for the static rows, in the same cache the editor reads, so it is coloured on its first frame.
function usePreviewTokens(preview: Preview | null, language: string | null, layout: 'unified' | 'split') {
  const [tokens, setTokens] = useState<{ preview: Preview; old: Segment[][] | null; new: Segment[][] | null } | null>(null)
  // A new identity on a syntax theme change, so the rows re-colour; the last colours stay until the new ones land.
  const recoloured = useLanguageOverrides()
  // Rows coloured before they showed (or seen before) have their colours on their first frame.
  const cached = useMemo(() => {
    if (!preview || !language) return null
    const next = cachedTokens(preview.lines.join('\n'), language)
    const old = layout === 'split' ? cachedTokens(preview.old.join('\n'), language) : null
    return next && (layout !== 'split' || old) ? { preview, new: next, old: old ?? null } : null
  }, [preview, language, layout, recoloured])
  useEffect(() => {
    if (!preview || !language || cached) return
    let stale = false
    const gone = () => stale
    void Promise.all([tokenize(preview.lines.join('\n'), language, gone), layout === 'split' ? tokenize(preview.old.join('\n'), language, gone) : null]).then(([next, old]) => {
      if (!stale) setTokens({ preview, new: next, old })
    })
    return () => { stale = true }
  }, [preview, language, layout, cached])
  return cached ?? (tokens?.preview === preview ? tokens : null)
}

type Row =
  | { kind: 'same'; a: number; b: number }
  | { kind: 'add'; b: number; marks: Marks; whole: boolean }
  | { kind: 'del'; a: number; marks: Marks; whole: boolean }
  | { kind: 'fold'; a: number; b: number; count: number }
  // Split only: a stretch of a change, each side's lines stacked, so the shorter side ends in blank space like the editor.
  | { kind: 'block'; a: number; countA: number; b: number; countB: number; marksA: Marks[]; marksB: Marks[]; wholeA: boolean[]; wholeB: boolean[] }
  // A Git hunk's actions, above the change it starts with. `a` and `b` are that change's, so find can address the row.
  | { kind: 'hunk'; a: number; b: number; hunk: number }

const BLOCK_LINES = 50
const HUNK_ROW = 28

function previewRows(model: Preview, layout: 'unified' | 'split', opened: Set<number>, starts: Map<Stretch, number>): Row[] {
  const rows: Row[] = []
  for (const stretch of model.stretches) {
    const hunk = starts.get(stretch)
    if (hunk !== undefined) rows.push({ kind: 'hunk', a: stretch.a, b: stretch.b, hunk })
    if (stretch.kind === 'same' || (stretch.kind === 'fold' && opened.has(stretch.b))) {
      for (let index = 0; index < stretch.count; index++) rows.push({ kind: 'same', a: stretch.a + index, b: stretch.b + index })
    } else if (stretch.kind === 'fold') {
      rows.push(stretch)
    }
    if (stretch.kind !== 'chunk') continue
    const wholeA = stretch.marksA.map((marks, index) => wholeLine((model.old[stretch.a + index - 1] ?? '').length, marks, stretch.countB))
    const wholeB = stretch.marksB.map((marks, index) => wholeLine((model.lines[stretch.b + index - 1] ?? '').length, marks, stretch.countA))
    if (layout === 'unified') {
      for (let index = 0; index < stretch.countA; index++) rows.push({ kind: 'del', a: stretch.a + index, marks: stretch.marksA[index], whole: wholeA[index] })
      for (let index = 0; index < stretch.countB; index++) rows.push({ kind: 'add', b: stretch.b + index, marks: stretch.marksB[index], whole: wholeB[index] })
    } else {
      // shortcut: a change longer than BLOCK_LINES lines lines its sides up again every BLOCK_LINES lines, where the editor
      // aligns only at the change's end; they differ only when long lines wrap differently, upgrade if that shows.
      for (let at = 0; at < Math.max(stretch.countA, stretch.countB); at += BLOCK_LINES) {
        const countA = Math.max(0, Math.min(BLOCK_LINES, stretch.countA - at))
        const countB = Math.max(0, Math.min(BLOCK_LINES, stretch.countB - at))
        rows.push({ kind: 'block', a: stretch.a + at, countA, b: stretch.b + at, countB, marksA: stretch.marksA.slice(at, at + countA), marksB: stretch.marksB.slice(at, at + countB),
          wholeA: wholeA.slice(at, at + countA), wholeB: wholeB.slice(at, at + countB) })
      }
    }
  }
  return rows
}

const rowLines = (row: Row) => (row.kind === 'block' ? Math.max(row.countA, row.countB) : row.kind === 'hunk' ? 0 : 1)
const rowHeight = (row: Row, line: number) => (row.kind === 'fold' ? 28 : row.kind === 'hunk' ? HUNK_ROW : rowLines(row) * line)

// The editor's look as plain rows: its gutter, change bar, tints, changed text, folds, font and wrapping, so the editor
// can replace it without anything moving. Rows mount in chunks near the screen, like the read-only diff.
function EditorPreview({ model, tokens, layout, opened, onOpen, onActivate, fileIndex, hunks, path, hunkActions, readOnly }: {
  model: Preview
  tokens: { old: Segment[][] | null; new: Segment[][] | null } | null
  layout: 'unified' | 'split'
  opened: Set<number>
  onOpen: (b: number) => void
  onActivate: (at: At | null, row: Element | null) => void
  fileIndex: number
  hunks: DiffHunk[]
  path: string
  hunkActions?: (hunk: DiffHunk) => ReactNode
  readOnly: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const actions = !!hunkActions
  const starts = useMemo(() => (actions ? hunkStarts(model, hunks) : new Map<Stretch, number>()), [model, hunks, actions])
  const rows = useMemo(() => previewRows(model, layout, opened, starts), [model, layout, opened, starts])
  // The diff's own row for each file line, so find and the layout switch can address these rows like the read-only diff.
  const sources = useMemo(() => {
    const map = new Map<string, string>()
    hunks.forEach((hunk, hunkIndex) => hunk.lines.forEach((line, index) => {
      const value = `${fileIndex}:${hunkIndex}:${index}`
      if (line.type === 'del' && line.oldNo) map.set(`o${line.oldNo}`, value)
      else if (line.newNo) map.set(`n${line.newNo}`, value)
    }))
    return map
  }, [hunks, fileIndex])
  // Chunk estimates follow the code line height, so they are computed again when it changes.
  const metrics = useCodeMetrics()
  const parts = useMemo(() => {
    const out: Array<{ start: number; end: number; height: number; range: [number, number, number, number] }> = []
    const lineHeight = codeLine()
    let start = 0
    let lines = 0
    let height = 0
    rows.forEach((row, index) => {
      lines += rowLines(row)
      height += rowHeight(row, lineHeight)
      if (lines >= BLOCK_LINES || index === rows.length - 1) {
        const first = rows[start]
        const last = row
        const aOf = (entry: Row, end: boolean) => ('a' in entry ? entry.a + (end && entry.kind === 'block' ? Math.max(0, entry.countA - 1) : end && entry.kind === 'fold' ? entry.count - 1 : 0) : 0)
        const bOf = (entry: Row, end: boolean) => ('b' in entry ? entry.b + (end && entry.kind === 'block' ? Math.max(0, entry.countB - 1) : end && entry.kind === 'fold' ? entry.count - 1 : 0) : 0)
        out.push({ start, end: index + 1, height, range: [aOf(first, false), aOf(last, true), bOf(first, false), bOf(last, true)] })
        start = index + 1
        lines = 0
        height = 0
      }
    })
    return out
  }, [rows, metrics])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    previewReveals.set(element, (side, line) => {
      const fold = model.stretches.find((stretch) => stretch.kind === 'fold' && (side === 'old' ? stretch.a : stretch.b) <= line && line < (side === 'old' ? stretch.a : stretch.b) + stretch.count)
      if (fold && !opened.has(fold.b)) onOpen(fold.b)
      const part = [...element.querySelectorAll<HTMLElement>('[data-range]')].find((chunk) => {
        const [a1, a2, b1, b2] = chunk.dataset.range!.split(':').map(Number)
        return side === 'old' ? a1 <= line && line <= a2 && a1 > 0 : b1 <= line && line <= b2 && b1 > 0
      })
      if (part) {
        const pane = part.closest<HTMLElement>('.diff-pane')
        if (pane) suspendHold(pane)
        part.scrollIntoView({ block: 'center' })
      }
    })
  }, [model, opened, onOpen])

  const numberStyle = { '--digits-a': String(model.old.length).length, '--digits-b': String(model.lines.length).length } as CSSProperties
  const code = (side: 'old' | 'new', line: number, marks?: Marks, coloured = true) => {
    const text = (side === 'old' ? model.old : model.lines)[line - 1] ?? ''
    const segments = coloured ? (side === 'old' ? tokens?.old : tokens?.new)?.[line - 1] : undefined
    return <Code text={text} segments={segments} changed={marks} changedClass="ed-changed" />
  }
  const fold = (row: Extract<Row, { kind: 'fold' }>, side: 'a' | 'b') => (
    <div className={`ed-fold side-${side}`}>
      <span className="ed-num" />
      <span className="ed-bar" />
      <button type="button" className="ed-fold-bar" onClick={() => onOpen(row.b)}>{row.count} unchanged lines</button>
    </div>
  )
  const line = (side: 'a' | 'b', kind: string, number: number, body: ReactNode, editable: boolean, whole = false) => (
    <div className={`ed-line ${kind} side-${side}${whole ? ' full' : ''}`} data-new={editable ? number : undefined} data-old={side === 'a' ? number : undefined}
      data-source-row={sources.get(`${side === 'a' ? 'o' : 'n'}${number}`) ?? (side === 'a' ? sources.get(`n${number}`) : undefined)}
      data-source-side={layout === 'split' ? (side === 'a' ? 'old' : 'new') : undefined}>
      <span className="ed-num">{kind === 'del' ? '' : number}</span>
      <span className="ed-bar" />
      {body}
    </div>
  )
  const render = (row: Row, index: number): ReactNode => {
    if (row.kind === 'hunk') return <div key={index} className="ed-hunk-actions">{hunkActions?.(hunks[row.hunk])}</div>
    if (layout === 'unified') {
      if (row.kind === 'fold') return <Fragment key={index}>{fold(row, 'b')}</Fragment>
      if (row.kind === 'del') return <Fragment key={index}>{line('a', 'del', row.a, code('old', row.a, row.marks, false), false, row.whole)}</Fragment>
      if (row.kind === 'add') return <Fragment key={index}>{line('b', 'add', row.b, code('new', row.b, row.marks), true, row.whole)}</Fragment>
      if (row.kind === 'same') {
        return (
          <div key={index} className="ed-line same side-b" data-new={row.b} data-old={row.a} data-source-row={sources.get(`n${row.b}`)}>
            <span className="ed-num">{row.b}</span>
            <span className="ed-bar" />
            {code('new', row.b)}
          </div>
        )
      }
      return null
    }
    if (row.kind === 'fold') return <div key={index} className="ed-pair">{fold(row, 'a')}{fold(row, 'b')}</div>
    if (row.kind === 'same') {
      return <div key={index} className="ed-pair">{line('a', 'same', row.a, code('old', row.a), false)}{line('b', 'same', row.b, code('new', row.b), true)}</div>
    }
    if (row.kind !== 'block') return null
    return (
      <div key={index} className="ed-pair">
        <div className="ed-side">{Array.from({ length: row.countA }, (_, offset) => <Fragment key={offset}>{line('a', 'old', row.a + offset, code('old', row.a + offset, row.marksA[offset]), false, row.wholeA[offset])}</Fragment>)}</div>
        <div className="ed-side">{Array.from({ length: row.countB }, (_, offset) => <Fragment key={offset}>{line('b', 'add', row.b + offset, code('new', row.b + offset, row.marksB[offset]), true, row.wholeB[offset])}</Fragment>)}</div>
      </div>
    )
  }

  // The first changed line, where keyboard activation puts the caret.
  const firstChange = () => {
    const chunk = model.stretches.find((stretch) => stretch.kind === 'chunk')
    return { line: chunk?.kind === 'chunk' ? chunk.b : 1, column: 0 }
  }
  return (
    <div ref={ref} className={`ed-preview ed-${layout}`} style={numberStyle} tabIndex={0} role="textbox" aria-multiline="true" aria-readonly={readOnly}
      aria-label={readOnly ? `Contents of ${path}.` : `Contents of ${path}. Click a line or press Enter to edit it.`}
      onMouseDown={rememberDown}
      onMouseUp={(event) => {
        if (dragged(event) || (event.target as Element).closest('.ed-fold, .ed-hunk-actions')) return
        const caret = caretAt(event.clientX, event.clientY)
        const at = caret && lineColumnAt(caret.node, caret.offset)
        if (at) onActivate(at, (caret!.node instanceof Element ? caret!.node : caret!.node.parentElement)?.closest('.ed-line') ?? null)
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === 'Enter') {
          event.preventDefault()
          onActivate(firstChange(), null)
        }
      }}
      onFocus={(event) => { if (event.target === event.currentTarget && event.currentTarget.matches(':focus-visible')) onActivate(firstChange(), null) }}>
      {parts.map((part) => (
        <RowChunk key={`${part.start}:${part.end}`} rows={part.end - part.start} estimate={part.height} range={part.range.join(':')}
          pinned={false} render={() => rows.slice(part.start, part.end).map((row, offset) => render(row, part.start + offset))} />
      ))}
    </div>
  )
}

// IPC errors arrive wrapped as "Error invoking remote method '…': Error: <message>".
function messageOf(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
