import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DiffHunk } from '../../main/git/diff'
import type { Mounted } from './cm-editor'
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

// Rebuilds the old side of a working-tree diff from the current file: lines outside the hunks are unchanged, and each hunk
// swaps its new lines for its old ones. Null when the diff no longer describes this text, such as after a change on disk.
// Context lines come from the file, so with whitespace hidden a whitespace-only change stays hidden.
// shortcut: a final newline added or removed on one side only is not rebuilt; upgrade if that one-line diff confuses.
export function originalText(current: string, hunks: DiffHunk[]): string | null {
  const lines = current.split('\n')
  const out: string[] = []
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
  let next = 1
  for (const hunk of hunks) {
    const match = /\+(\d+)(?:,(\d+))? @@/.exec(hunk.header)
    if (!match) return null
    // A hunk with no new lines sits after its start line; any other hunk starts on it.
    const before = Number(match[1]) - (match[2] === '0' ? 0 : 1)
    if (before < next - 1 || before > lines.length) return null
    while (next <= before) out.push(lines[next++ - 1])
    for (const line of hunk.lines) {
      if (line.type === 'del') out.push(line.text)
      else if (line.type !== 'note') {
        const actual = lines[next++ - 1]
        if (actual === undefined || (line.type === 'add' ? actual.replace(/\r$/, '') !== line.text.replace(/\r$/, '') : !same(actual, line.text))) return null
        if (line.type === 'context') out.push(actual)
      }
    }
  }
  return [...out, ...lines.slice(next - 1)].join('\n')
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

// Drafts outlive their editors, so selecting, scrolling or switching views keeps them. Staging or discarding a file takes
// it out of the working diff, where its draft can no longer show, so those ask first. False when the user keeps the edits.
export function confirmDropEdits(repo: string, paths: string[]): boolean {
  const lost = paths.flatMap((path) => (dirty(drafts.get(keyOf(repo, path))) ? [path] : []))
  if (!lost.length) return true
  if (!window.confirm(`Discard your unsaved edits to ${lost.join(', ')}?`)) return false
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
  const discard = () => {
    if (draft.revert) draft.revert()
    else if (window.confirm(`Discard your edits to ${path}?`)) setDraft(key, null)
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

type Source = { loaded: string; original: string } | { error: string }

// The working-tree diff of one text file, as an editor of the file itself. Context and added lines are the editable
// text; removed lines and the old side are read-only. Until the file loads, or when it cannot be edited, `fallback`
// (the read-only diff) shows instead.
export function EditableDiff({ edit, path, hunks, layout, language, fallback }: {
  edit: EditBridge
  path: string
  hunks: DiffHunk[]
  layout: 'unified' | 'split'
  language: string | null
  fallback: ReactNode
}) {
  const key = keyOf(edit.repo, path)
  const editRef = useRef(edit)
  editRef.current = edit
  const [source, setSource] = useState<Source | null>(null)
  const sourceRef = useRef(source)
  sourceRef.current = source
  const host = useRef<HTMLDivElement>(null)
  const mounted = useRef<Mounted | null>(null)
  // A stacked diff can hold many files, so each loads, highlights and builds its editor only once its file nears the
  // screen; until then the read-only diff holds its place. A dirty draft starts at once so its text shows.
  // shortcut: an editor stays built after it scrolls away; unmount offscreen editors if very long sessions grow heavy.
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

  // Each new diff of the file reloads it. A dirty draft keeps the text and the old side it was typed against.
  useEffect(() => {
    if (!near) return
    let stale = false
    const draft = drafts.get(key)
    if (dirty(draft)) {
      if (!sourceRef.current || 'error' in sourceRef.current) {
        const original = originalText(draft!.loaded, hunks)
        setSource(original === null ? { error: `${path} changed on disk since your edits began. Discard them to edit it again.` } : { loaded: draft!.loaded, original })
      }
      return
    }
    editRef.current.load(path).then(
      (loaded) => {
        if (stale || dirty(drafts.get(key))) return
        const original = originalText(loaded, hunks)
        setSource(original === null ? { error: 'This diff is out of date. It refreshes when the file is reloaded.' } : { loaded, original })
      },
      (error) => { if (!stale) setSource({ error: messageOf(error) }) },
    )
    return () => { stale = true }
  }, [key, path, hunks, near])

  const ready = !!source && !('error' in source)

  // The editor is built once per layout and language. Later loads update it in place, so the caret survives a save.
  // CodeMirror loads on first use, so the rest of the app, and its tests, never load it.
  useEffect(() => {
    if (!ready) return
    let gone = false
    void import('./cm-editor').then(({ mountEditor }) => {
      const start = sourceRef.current
      if (gone || !host.current || !start || 'error' in start) return
      const draft = drafts.get(key)
      const loaded = dirty(draft) ? draft!.loaded : start.loaded
      const revert = () => {
        const entry = drafts.get(key)
        if (!entry || !mounted.current) return
        mounted.current.replace(entry.loaded)
        setDraft(key, { ...drafts.get(key)!, text: entry.loaded })
      }
      setDraft(key, { path, loaded, text: dirty(draft) ? draft!.text : loaded, revert })
      mounted.current = mountEditor({
        parent: host.current,
        layout,
        language,
        path,
        text: drafts.get(key)!.text,
        original: start.original,
        separator: loaded.includes('\r\n') ? '\r\n' : '\n',
        onText: (text) => {
          const entry = drafts.get(key)
          if (entry) setDraft(key, { ...entry, text })
        },
        onSave: () => void saveDraft(editRef.current, path),
        onEscape: () => {
          if (!dirty(drafts.get(key))) return false
          revert()
          return true
        },
      })
    })
    return () => {
      gone = true
      mounted.current?.destroy()
      mounted.current = null
      const entry = drafts.get(key)
      if (entry) setDraft(key, dirty(entry) ? { ...entry, revert: undefined } : null)
    }
  }, [key, path, layout, language, ready])

  // A reload of a clean file brings the editor up to date: the old side always, and the text when it changed on disk.
  useEffect(() => {
    if (!mounted.current || !source || 'error' in source || dirty(drafts.get(key))) return
    const entry = drafts.get(key)
    if (entry) setDraft(key, { ...entry, loaded: source.loaded, text: source.loaded })
    mounted.current.sync(source.loaded, source.original)
  }, [key, source])

  if (!source || 'error' in source) {
    return (
      <>
        {!near && <span ref={probe} hidden />}
        {source && <p className="hint diff-edit-note">Read-only: {source.error}</p>}
        {fallback}
      </>
    )
  }
  return <div className="diff-editor" ref={host} />
}

// IPC errors arrive wrapped as "Error invoking remote method '…': Error: <message>".
function messageOf(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
