import type { DiffFile } from '../../main/git/diff'
import { countLines } from './DiffView'
import { FileIcon } from './FileIcon'
import { splitPath } from './paths'

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// Counts come from the parsed patch, not the --stat text: --stat lists a rename as a delete plus an add.
export function CommitStat({ files, onSelect }: { files: DiffFile[]; onSelect: (path: string) => void }) {
  if (!files.length) return null
  const counts = files.map(countLines)
  const insertions = counts.reduce((sum, count) => sum + count.adds, 0)
  const deletions = counts.reduce((sum, count) => sum + count.dels, 0)
  return (
    <div className="commit-stat-block">
      <ul className="commit-stat-list">
        {files.map((file, index) => {
          const path = file.newPath ?? file.oldPath ?? ''
          const { name, dir } = splitPath(path)
          const { adds, dels } = counts[index]
          return (
            <li key={`${index}-${path}`}>
              <button className="commit-stat-row" onClick={() => onSelect(path)} title={path} aria-label={`Show diff for ${path}`}>
                <FileIcon name={name} />
                <span className="path" title={path}>
                  <span className="path-name">{name}</span>
                  {dir && <span className="path-dir">{dir}</span>}
                </span>
                {file.binary ? (
                  <span className="commit-stat-note">binary</span>
                ) : (
                  <span className="row-stat">
                    <span className="add">+{adds}</span>
                    <span className="del">−{dels}</span>
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="commit-stat-summary">
        {plural(files.length, 'file')} changed, <span className="add">{plural(insertions, 'insertion')}(+)</span>,{' '}
        <span className="del">{plural(deletions, 'deletion')}(-)</span>
      </p>
    </div>
  )
}
