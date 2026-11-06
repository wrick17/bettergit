import { useEffect, useState } from 'react'
import type { Commit } from '../../main/git/history'
import type { StagedText } from '../../main/git/index-file'
import { confirmOverBlur } from './confirm'
import { Icon } from './Icons'
import { ActionError, REPO_WORKING_LABELS, runRepoWrite, useRepoBusy } from './repo-busy'
import { Sheet } from './StashDialog'

const api = window.bettergit

// The dialogs a changed file's menu opens: its history, its blame, and its staged contents.
export type FileSheet = { kind: 'history' | 'blame' | 'staged'; path: string }

// Unsaved Edit Staged Contents text, by repo and path, with the index entry it was made against. It lives outside the
// sheet, so closing the Changes tab, switching repo or a refresh keeps it, and an update restart waits for it.
interface StagedDraft { blob: string; loaded: string; text: string }
const stagedDrafts = new Map<string, StagedDraft>()
const draftKey = (repo: string, path: string) => `${repo}\0${path}`
export const hasUnsavedStagedDrafts = () => Array.from(stagedDrafts.values()).some((draft) => draft.text !== draft.loaded)
export const hasStagedDraft = (repo: string, path: string) => stagedDrafts.has(draftKey(repo, path))
// The paths of a repo's unsaved staged drafts, so a draft whose file has left the changes can still be opened.
export const stagedDraftPaths = (repo: string) => Array.from(stagedDrafts.entries())
  .filter(([key, draft]) => key.startsWith(`${repo}\0`) && draft.text !== draft.loaded).map(([key]) => key.slice(repo.length + 1))

// Blame draws every line, so a very long file shows its start and says so.
const MAX_BLAME_ROWS = 5000

export function FileSheets({ repo, sheet, onClose, onChanged, onError }: {
  repo: string
  sheet: FileSheet | null
  onClose: () => void
  onChanged: () => void
  onError: (error: unknown) => void
}) {
  if (!sheet) return null
  if (sheet.kind === 'history') return <HistorySheet key={sheet.path} repo={repo} path={sheet.path} onClose={onClose} onError={onError} />
  if (sheet.kind === 'blame') return <BlameSheet key={sheet.path} repo={repo} path={sheet.path} onClose={onClose} onError={onError} />
  return <StagedSheet key={sheet.path} repo={repo} path={sheet.path} onClose={onClose} onChanged={onChanged} onError={onError} />
}

// A failed read reports through the error banner, like the stash list, and closes the sheet unless `keepOpen`.
function useRead<T>(read: () => Promise<T>, action: string, onError: (error: unknown) => void, onClose: () => void, keepOpen = false): { value: T | null; failed: boolean } {
  const [result, setResult] = useState<{ value: T | null; failed: boolean }>({ value: null, failed: false })
  useEffect(() => {
    let stale = false
    read().then((value) => { if (!stale) setResult({ value, failed: false }) }).catch((failure: unknown) => {
      if (stale) return
      onError(new ActionError(action, failure))
      if (keepOpen) setResult({ value: null, failed: true })
      else onClose()
    })
    return () => { stale = true }
  }, [])
  return result
}

function HistorySheet({ repo, path, onClose, onError }: { repo: string; path: string; onClose: () => void; onError: (error: unknown) => void }) {
  const { value: commits } = useRead<Commit[]>(() => api.fileHistory(repo, path), `Reading the history of ${path}`, onError, onClose)
  return (
    <Sheet className="file-sheet" title="File History" subtitle={`Commits that changed ${path}, following renames, newest first.`} onClose={onClose}
      footer={<button type="button" className="ghost" onClick={onClose}>Close</button>}>
      {!commits && <p className="dialog-sub">Loading…</p>}
      {commits?.length === 0 && <p className="dialog-sub">No commits yet. The file has never been committed.</p>}
      {!!commits?.length && (
        <ul className="file-history">
          {commits.map((commit) => (
            <li key={commit.hash}>
              <b title={commit.hash}>{commit.hash.slice(0, 7)}</b>
              <span className="file-history-subject" title={commit.subject}>{commit.subject}</span>
              <span className="file-history-meta">{commit.author} · {new Date(commit.date * 1000).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

function BlameSheet({ repo, path, onClose, onError }: { repo: string; path: string; onClose: () => void; onError: (error: unknown) => void }) {
  const { value: rows } = useRead(() => api.blame(repo, path), `Reading the blame of ${path}`, onError, onClose)
  const shown = rows?.slice(0, MAX_BLAME_ROWS)
  return (
    <Sheet className="file-sheet blame-sheet" title="Blame" subtitle={`The commit that last changed each line of ${path} in the working copy.`} onClose={onClose}
      footer={<button type="button" className="ghost" onClick={onClose}>Close</button>}>
      {!rows && <p className="dialog-sub">Loading…</p>}
      {rows?.length === 0 && <p className="dialog-sub">The file is empty.</p>}
      {rows && rows.length > MAX_BLAME_ROWS && <p className="dialog-sub">Showing the first {MAX_BLAME_ROWS.toLocaleString()} of {rows.length.toLocaleString()} lines.</p>}
      {!!shown?.length && (
        <table className="blame">
          <thead><tr><th scope="col">Line</th><th scope="col">Commit</th><th scope="col">Author</th><th scope="col">Code</th></tr></thead>
          <tbody>
            {shown.map((row, index) => {
              // Git blames lines not yet committed to the all-zero hash.
              const uncommitted = /^0+$/.test(row.hash)
              return (
                <tr key={index}>
                  <td className="blame-no">{index + 1}</td>
                  <td className="blame-hash" title={uncommitted ? 'Not committed yet' : row.hash}>{uncommitted ? 'Uncommitted' : row.hash.slice(0, 7)}</td>
                  <td className="blame-author" title={row.author}>{uncommitted ? '' : row.author}</td>
                  <td className="blame-code"><code>{row.line}</code></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Sheet>
  )
}

// Edits the bytes staged for the next commit. The working copy keeps its own changes. Main refuses the save when the
// index entry changed since it was read here.
function StagedSheet({ repo, path, onClose, onChanged, onError }: {
  repo: string
  path: string
  onClose: () => void
  onChanged: () => void
  onError: (error: unknown) => void
}) {
  const key = draftKey(repo, path)
  // A draft left from an earlier opening comes back, even if the index moved on since or the file left it; its save is
  // then refused, and the sheet stays open so the text can be copied or discarded.
  const [draft, setDraftState] = useState<StagedDraft | null>(() => stagedDrafts.get(key) ?? null)
  const { value: staged, failed } = useRead<StagedText>(() => api.stagedRead(repo, path), `Reading the staged ${path}`, onError, onClose, !!draft)
  const busy = useRepoBusy(repo)
  const writeKey = `staged-write:${path}`
  const current = draft ?? (staged && { blob: staged.blob, loaded: staged.text, text: staged.text })
  const changed = !!current && current.text !== current.loaded
  const stale = !!draft && (failed || (!!staged && draft.blob !== staged.blob))
  const edit = (text: string) => {
    if (!current) return
    const next = { ...current, text }
    if (next.text === next.loaded) stagedDrafts.delete(key)
    else stagedDrafts.set(key, next)
    setDraftState(next)
  }
  const discard = () => { stagedDrafts.delete(key); onClose() }
  const requestClose = async () => { if (!changed || await confirmOverBlur(`Discard your edits to the staged ${path}?`)) discard() }
  // The text box is read-only while any write runs, so the text saved is the text on screen.
  const save = async () => {
    if (!current || !changed || busy !== null) return
    if (await runRepoWrite(repo, writeKey, () => api.stagedWrite(repo, path, current.blob, current.text), { onError, reload: onChanged })) discard()
  }
  return (
    <Sheet className="file-sheet" title="Edit Staged Contents" subtitle={`Changes what the next commit records for ${path}. The file in the working copy is not changed.`}
      onClose={() => void requestClose()}
      footer={(
        <>
          <button type="button" className="ghost" onClick={() => void requestClose()}>{changed ? 'Discard' : 'Cancel'}</button>
          <button type="button" className="primary" disabled={!changed || stale || (busy !== null && busy !== writeKey)} aria-busy={busy === writeKey || undefined} onClick={() => void save()}>
            {busy === writeKey && <Icon name="loader" className="action-spin" />}
            {busy === writeKey ? REPO_WORKING_LABELS['staged-write'] : 'Save to Index'}
          </button>
        </>
      )}>
      {stale && <p className="dialog-note">The staged {path} changed after these edits were made, so they cannot be saved. Copy what you need, then discard them.</p>}
      {!current
        ? <p className="dialog-sub">Loading…</p>
        : (
          <label className="field">
            <span>Staged contents</span>
            <textarea className="staged-text" spellCheck={false} autoFocus readOnly={busy !== null} aria-busy={busy === writeKey || undefined}
              value={current.text} onChange={(event) => edit(event.target.value)} />
          </label>
        )}
    </Sheet>
  )
}
