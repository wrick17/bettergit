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
