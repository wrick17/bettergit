import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { EDITORS, isEditorId, type EditorId } from '../shared/editors'

const run = promisify(execFile)

// Fixed system tool. No shell runs, so each path is one argument and is never parsed.
const OPEN_TOOL = '/usr/bin/open'

// Returns the exact command for an editor. Kept separate from the run so tests can check it without starting an editor.
export function openCommand(editor: EditorId, absPath: string): { file: string; args: string[] } {
  // Config writes are not validated yet, so a stored unknown id must fail readably here.
  if (!isEditorId(editor)) throw new Error(`Unknown editor: ${String(editor)}`)
  if (!path.isAbsolute(absPath)) throw new Error(`Editor needs an absolute path: ${absPath}`)
  return { file: OPEN_TOOL, args: ['-b', EDITORS[editor].bundleId, absPath] }
}

// The repo-relative path must stay inside the repo, even through symlinks. Returns the real absolute path.
export async function resolveFileTarget(repo: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) throw new Error('Invalid file path.')
  if (path.isAbsolute(relPath)) throw new Error(`Path must be relative to the repository: ${relPath}`)
  const lexical = path.relative(repo, path.resolve(repo, relPath))
  if (lexical === '' || lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
    throw new Error(`Path leaves the repository: ${relPath}`)
  }
  let target: string
  try {
    target = await fs.realpath(path.join(repo, relPath))
  } catch (error) {
    // A missing or dangling file is reported, never created.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Not in the working copy: ${relPath}`)
    throw error
  }
  const root = await fs.realpath(repo)
  if (!target.startsWith(root + path.sep)) throw new Error(`Path leaves the repository: ${relPath}`)
  // Directories and FIFOs would block or misbehave in the editor.
  if (!(await fs.stat(target)).isFile()) throw new Error(`Not a regular file: ${relPath}`)
  return target
}

// The diff's inline editor takes UTF-8 text only. Binary, invalid UTF-8 and very large files stay with a real editor.
const MAX_EDIT_BYTES = 1024 * 1024

export async function readWorkingFile(repo: string, relPath: string): Promise<string> {
  const bytes = await fs.readFile(await resolveFileTarget(repo, relPath))
  const text = bytes.toString('utf8')
  if (bytes.length > MAX_EDIT_BYTES || bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${relPath} is binary, not UTF-8, or too large to edit here.`)
  }
  return text
}

// `expected` is the text the editor loaded. A file changed on disk since then is refused, never overwritten.
export async function writeWorkingFile(repo: string, relPath: string, expected: string, text: string): Promise<void> {
  if (typeof expected !== 'string' || typeof text !== 'string') throw new Error('Invalid file contents.')
  const target = await resolveFileTarget(repo, relPath)
  if ((await fs.readFile(target)).toString('utf8') !== expected) {
    throw new Error(`${relPath} changed on disk since it was opened. Cancel and edit it again.`)
  }
  await fs.writeFile(target, text, 'utf8')
}

export async function resolveRepoTarget(repo: string): Promise<string> {
  const target = await fs.realpath(repo)
  if (!(await fs.stat(target)).isDirectory()) throw new Error(`Not a folder: ${repo}`)
  return target
}

// The editor is the only input to the command, and it comes from validated config, never from the renderer.
export async function openWithEditor(editor: EditorId, absPath: string): Promise<void> {
  const { file, args } = openCommand(editor, absPath)
  try {
    await run(file, args, { timeout: 15_000 })
  } catch {
    const { label } = EDITORS[editor]
    throw new Error(`${label} could not open ${path.basename(absPath)}. Check that ${label} is installed.`)
  }
}

export async function openFileInEditor(editor: EditorId, repo: string, relPath: string): Promise<void> {
  await openWithEditor(editor, await resolveFileTarget(repo, relPath))
}

export async function openRepoInEditor(editor: EditorId, repo: string): Promise<void> {
  await openWithEditor(editor, await resolveRepoTarget(repo))
}
