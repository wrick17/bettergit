import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useActiveFile, useKeepInView, type ActiveFiles } from './active-file'
import type { DiffFile } from '../../main/git/diff'
import { buildTree, type Folder } from './commit-tree'
import { countLines } from './DiffView'
import { FileIcon, FolderIcon } from './FileIcon'
import { Icon, IconButton, toggleLabel } from './Icons'
import { splitPath } from './paths'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

type View = 'list' | 'tree'
const VIEW_KEY = 'bettergit.commitFilesView'
const BADGE: Record<DiffFile['status'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' }

// One changed file and its place in the patch. The index keys the row, since a patch can name a path twice.
interface Entry {
  file: DiffFile
  index: number
  path: string
}

// Counts come from the parsed patch, not the --stat text: --stat lists a rename as a delete plus an add.
// A row picks its file by path: a renamed file by its new path, a deleted one by its old path.
// `activeFiles` names the file at the top of the code diff. Its row is marked and kept on screen, without selecting it.
export function CommitStat({ files, onSelect, activeFiles }: { files: DiffFile[]; onSelect: (path: string) => void; activeFiles?: ActiveFiles }) {
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'))
  // Folders are open unless their path is here. Kept while the view stays mounted, so moving between commits keeps them.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const entries = useMemo(() => files.map((file, index): Entry => ({ file, index, path: file.newPath ?? file.oldPath ?? '' })), [files])
  const tree = useMemo(() => (view === 'tree' ? buildTree(entries, (entry) => entry.path) : null), [entries, view])
  // Counted once per patch, since the mark re-renders the list as the diff scrolls.
  const counts = useMemo(() => files.map(countLines), [files])
  const blockRef = useRef<HTMLDivElement>(null)
  const inView = useActiveFile(activeFiles)?.path ?? null
  useKeepInView(blockRef, inView === null ? null : `${view}:${inView}`)
  if (!files.length) return null
  const insertions = counts.reduce((sum, count) => sum + count.adds, 0)
  const deletions = counts.reduce((sum, count) => sum + count.dels, 0)
  const chooseView = (next: View) => {
    localStorage.setItem(VIEW_KEY, next)
    setView(next)
  }
  const toggleFolder = (path: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const row = ({ file, index, path }: Entry, className: string, showDir: boolean) => {
    const { name, dir } = splitPath(path)
    const { adds, dels } = counts[index]
    const label = file.status === 'renamed' && file.oldPath && file.oldPath !== path ? `${file.oldPath} → ${path}` : path
    return (
      <button className={`${className}${inView === path ? ' in-view' : ''}`} onClick={() => onSelect(path)} title={label} aria-label={`Show diff for ${label}, ${file.status}`}>
        <FileIcon name={name} />
        <span className="path">
          <span className="path-name">{name}</span>
          {showDir && dir && <span className="path-dir">{dir}</span>}
        </span>
        {file.binary ? (
          <span className="commit-stat-note">binary</span>
        ) : (
          <span className="row-stat">
            <span className="add">+{adds}</span>
            <span className="del">−{dels}</span>
          </span>
        )}
        <span className={`kind kind-${file.status}`} aria-hidden="true">{BADGE[file.status]}</span>
      </button>
    )
  }
  return (
    <div className="commit-stat-block" ref={blockRef}>
      <div className="commit-stat-head">
        <span className="file-list-title">Files</span>
        <div className="changes-view-toggle" role="group" aria-label="Commit file layout">
          <IconButton icon="listFlat" label={view === 'list' ? 'List view: on' : toggleLabel('List view: off', 'show files as a flat list')} active={view === 'list'} onClick={() => chooseView('list')} />
          <IconButton icon="listTree" label={view === 'tree' ? 'Tree view: on' : toggleLabel('Tree view: off', 'show files in folders')} active={view === 'tree'} onClick={() => chooseView('tree')} />
        </div>
      </div>
      {tree ? (
        <div className="tree commit-stat-tree" role="tree" aria-label="Changed files">
          <TreeLevel folder={tree} collapsed={collapsed} onToggleFolder={toggleFolder} renderFile={(entry) => (
            <div key={entry.index} role="treeitem">
              {row(entry, 'tree-row commit-stat-row', false)}
            </div>
          )} />
        </div>
      ) : (
        <ul className="commit-stat-list">
          {entries.map((entry) => <li key={`${entry.index}-${entry.path}`}>{row(entry, 'commit-stat-row', true)}</li>)}
        </ul>
      )}
      <p className="commit-stat-summary" title={`${plural(files.length, 'file')} changed, ${plural(insertions, 'insertion')}, ${plural(deletions, 'deletion')}`}>
        <span>{plural(files.length, 'file')}</span>
        <span className="add">+{insertions}</span>
        <span className="del">−{deletions}</span>
      </p>
    </div>
  )
}

// The Changes tree's folder rows and keys: Enter or Space toggles, Right opens, Left closes. A closed folder's contents are not rendered.
function TreeLevel({ folder, collapsed, onToggleFolder, renderFile }: {
  folder: Folder<Entry>
  collapsed: Set<string>
  onToggleFolder: (path: string) => void
  renderFile: (entry: Entry) => ReactNode
}) {
  return (
    <>
      {[...folder.folders.values()].map((child) => {
        const expanded = !collapsed.has(child.path)
        return (
          <div
            key={child.path}
            role="treeitem"
            aria-expanded={expanded}
            aria-label={`${child.path}, ${plural(child.count, 'file')}`}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowRight' && !expanded) || (event.key === 'ArrowLeft' && expanded)) {
                event.preventDefault()
                onToggleFolder(child.path)
              }
            }}
          >
            <div className="tree-row folder" onClick={() => onToggleFolder(child.path)}>
              <span className={`chevron${expanded ? ' open' : ''}`}><Icon name="chevron" /></span>
              <span className="row-icon"><FolderIcon open={expanded} /></span>
              <span className="tree-label">{child.name}</span>
              <span className="folder-count">{child.count}</span>
            </div>
            {expanded && (
              <div role="group" className="tree-children">
                <TreeLevel folder={child} collapsed={collapsed} onToggleFolder={onToggleFolder} renderFile={renderFile} />
              </div>
            )}
          </div>
        )
      })}
      {folder.files.map(renderFile)}
    </>
  )
}
