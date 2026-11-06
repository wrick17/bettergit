import { promises as fs } from 'node:fs'
import path from 'node:path'
import { git, gitRaw, GitError, type GitOptions } from './exec'

// A staged file as Edit Staged Contents shows it. `blob` is the index entry it was read from, so a save can refuse an
// index that changed since.
export interface StagedText {
  text: string
  blob: string
}

// The editor takes UTF-8 text only, like the diff's inline editor.
const MAX_STAGED_BYTES = 1024 * 1024

// The one stage-0 index entry of a regular file at exactly this path. Symlinks, submodules, conflicts and paths not in
// the index are refused, so a save can only replace a regular file's staged bytes.
async function indexEntry(repo: string, relPath: string, options: GitOptions = {}): Promise<{ mode: string; blob: string }> {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0') || relPath.startsWith('/')) throw new Error('Invalid file path.')
  const listed = (await git(repo, ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', relPath], options)).split('\0').filter(Boolean)
  const entries = listed.map((line) => {
    const tab = line.indexOf('\t')
    const [mode, blob, stage] = line.slice(0, tab).split(' ')
    return { mode, blob, stage, path: line.slice(tab + 1) }
  }).filter((entry) => entry.path === relPath)
  if (!entries.length) throw new Error(`${relPath} is not in the index, so it has no staged contents to edit.`)
  if (entries.some((entry) => entry.stage !== '0')) throw new Error(`${relPath} has a merge conflict. Resolve it before editing its staged contents.`)
  const { mode, blob } = entries[0]
  if (mode === '120000') throw new Error(`${relPath} is staged as a symbolic link. Only regular files can be edited here.`)
  if (mode === '160000') throw new Error(`${relPath} is a submodule. Only regular files can be edited here.`)
  if (mode !== '100644' && mode !== '100755') throw new Error(`${relPath} is not a regular file in the index.`)
  return { mode, blob }
}

export async function readStagedFile(repo: string, relPath: string): Promise<StagedText> {
  const { blob } = await indexEntry(repo, relPath)
  const args = ['cat-file', 'blob', blob]
  const output = await gitRaw(repo, args)
  if (output.code !== 0) throw new GitError(output.stderr || `git cat-file failed with code ${output.code}`, args, output.code, output.stderr)
  const bytes = output.stdout
  const text = bytes.toString('utf8')
  if (bytes.length > MAX_STAGED_BYTES || bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(bytes.length > MAX_STAGED_BYTES
      ? `The staged ${relPath} is larger than 1 MB. Edit it in your editor and stage it again.`
      : `The staged ${relPath} is binary or not UTF-8 text, so it cannot be edited here.`)
  }
  // A text box turns CRLF into LF, which would rewrite every line ending on save.
  if (text.includes('\r')) throw new Error(`The staged ${relPath} has CR line endings, which this editor would change.`)
  return { text, blob }
}

// Replaces the file's staged bytes and leaves the working tree alone. Refused when the index entry is no longer the one
// the editor loaded. The blob is written as given, with no clean filter, since it was read from the index the same way.
// The check and the replacement hold Git's own index.lock, so no other Git process can stage in between. The change is
// made in a scratch copy of the index, which then replaces the index in one rename, as Git commits its own index writes.
export async function writeStagedFile(repo: string, relPath: string, expectedBlob: unknown, text: unknown): Promise<void> {
  if (typeof expectedBlob !== 'string' || typeof text !== 'string') throw new Error('Invalid staged contents.')
  if (text.includes('\r')) throw new Error('Staged contents cannot contain CR characters here.')
  // The index this checkout uses, which is the worktree's own in a linked worktree.
  const index = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'index'])).trim())
  const lock = `${index}.lock`
  try {
    await (await fs.open(lock, 'wx')).close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another Git process is changing the index. Nothing was saved to ${relPath}. Try again when it finishes.`)
    throw error
  }
  const scratch = `${index}.bettergit-${process.pid}-${Date.now()}`
  try {
    try {
      await fs.copyFile(index, scratch)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${relPath} is not in the index, so it has no staged contents to edit.`)
      throw error
    }
    const options = { indexFile: scratch }
    const { mode, blob } = await indexEntry(repo, relPath, options)
    if (blob !== expectedBlob) throw new Error(`The staged ${relPath} changed since it was opened. Nothing was saved. Open it again to edit the new version.`)
    const written = (await git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], { input: text })).trim()
    await git(repo, ['update-index', '--cacheinfo', `${mode},${written},${relPath}`], options)
    await fs.rename(scratch, index)
  } finally {
    await fs.rm(scratch, { force: true })
    await fs.rm(lock, { force: true })
  }
}
