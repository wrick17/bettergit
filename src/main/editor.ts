import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { EDITORS, isEditorId, type EditorId, type InstalledApp } from '../shared/editors'

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

// Terminals that ignore a folder passed through `open -a` take their documented working-directory flag instead.
const DIRECTORY_FLAGS: Record<string, (dir: string) => string[]> = {
  alacritty: (dir) => ['--working-directory', dir],
  kitty: (dir) => ['--directory', dir],
  wezterm: (dir) => ['start', '--cwd', dir],
  rio: (dir) => ['--working-dir', dir],
  // Tabby has no open-file handler. Its CLI `open [directory]` starts a shell there, and a running Tabby takes it over.
  tabby: (dir) => ['open', dir],
}

// Apps in EDITORS keep their bundle ID launch. Others open by bundle path, so no CLI has to be on PATH.
export function appCommand(app: InstalledApp, absPath: string): { file: string; args: string[] } {
  if (!path.isAbsolute(absPath)) throw new Error(`Editor needs an absolute path: ${absPath}`)
  if (!app.custom && isEditorId(app.id)) return openCommand(app.id, absPath)
  const flags = app.custom ? undefined : DIRECTORY_FLAGS[app.id]
  return { file: OPEN_TOOL, args: flags ? ['-na', app.path, '--args', ...flags(absPath)] : ['-a', app.path, absPath] }
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

// Git diffs a symlink as its link text, so the editor must never read or write through it to the target.
async function editTarget(repo: string, relPath: string): Promise<string> {
  const target = await resolveFileTarget(repo, relPath)
  if ((await fs.lstat(path.join(repo, relPath))).isSymbolicLink()) throw new Error(`${relPath} is a symbolic link. Open it in your editor instead.`)
  return target
}

export async function readWorkingFile(repo: string, relPath: string): Promise<string> {
  const bytes = await fs.readFile(await editTarget(repo, relPath))
  const text = bytes.toString('utf8')
  if (bytes.length > MAX_EDIT_BYTES || bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${relPath} is binary, not UTF-8, or too large to edit here.`)
  }
  return text
}

// `expected` is the text the editor loaded. A file changed on disk since then is refused, never overwritten.
export async function writeWorkingFile(repo: string, relPath: string, expected: string, text: string): Promise<void> {
  if (typeof expected !== 'string' || typeof text !== 'string') throw new Error('Invalid file contents.')
  const target = await editTarget(repo, relPath)
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

// The app is the only input to the command, and it comes from validated config, never from the renderer.
export async function openWithApp(app: InstalledApp, absPath: string): Promise<void> {
  const { file, args } = appCommand(app, absPath)
  try {
    await run(file, args, { timeout: 15_000 })
  } catch {
    throw new Error(`${app.name} could not open ${path.basename(absPath)}. Check that ${app.name} is installed.`)
  }
}

export async function openFileInApp(app: InstalledApp, repo: string, relPath: string): Promise<void> {
  await openWithApp(app, await resolveFileTarget(repo, relPath))
}

export async function openRepoInApp(app: InstalledApp, repo: string): Promise<void> {
  await openWithApp(app, await resolveRepoTarget(repo))
}
