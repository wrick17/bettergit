import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

// Every git command and write action, one line when it starts and one when it ends, so a failure can be traced while the
// app runs. Lines go straight to a file, which rotates past MAX_BYTES, so memory and disk stay bounded. Stdout and stdin
// and stderr are recorded only as sizes; message arguments are hidden too.
const MAX_BYTES = 1024 * 1024
const MAX_TEXT = 2000

let file: string | null = null
let fd: number | null = null
let written = 0
let nextId = 0

// Starts logging to this file, or stops with null. Tests and other processes that never open a log write nothing.
export function openCommandLog(path: string | null): void {
  if (fd !== null) closeSync(fd)
  fd = null
  file = path
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  fd = openSync(path, 'a', 0o600)
  written = fstatSync(fd).size
}

export const commandLogPath = () => file

// Credentials in URLs, token-looking words and authorization headers become ***. Each value is JSON-quoted, so a
// newline or control character in a path or message cannot start a forged line.
export function redact(text: string): string {
  return text
    .replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\b(gh[pousr]_\w{16,}|github_pat_\w{16,}|glpat-[\w-]{16,})/g, '***')
    .replace(/(authorization:\s*(?:basic|bearer|token)?\s*)\S+/gi, '$1***')
}

// Redacted before it is cut, so a cut can never leave half a credential unmatched.
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)
const quote = (text: string) => JSON.stringify(clip(redact(text)))

function commandArgs(args: string[]): string[] {
  const messages = args.some((arg) => ['commit', 'commit-tree', 'merge', 'stash', 'tag', 'notes'].includes(arg))
  let message = false
  let paths = false
  return args.map((arg) => {
    if (message) { message = false; return '***' }
    if (arg === '--') paths = true
    if (messages && !paths) {
      if (arg === '-m' || arg === '--message') message = true
      else if (arg.startsWith('--message=') || /^-[^-]*m/.test(arg)) return '***'
    }
    return redact(arg)
  })
}

function write(line: string): void {
  if (fd === null || !file) return
  try {
    const bytes = Buffer.from(`${new Date().toISOString()} ${line}\n`)
    if (written + bytes.length > MAX_BYTES) {
      closeSync(fd)
      renameSync(file, `${file}.1`)
      fd = openSync(file, 'a', 0o600)
      written = 0
    }
    written += writeSync(fd, bytes)
  } catch {
    // A full disk or a removed folder must never fail the command being logged.
    fd = null
  }
}

// Logs a git command as it starts. The returned function logs how it ended: its exit code (null when git never ran or
// was stopped), and the sizes of its output and error. Hook output can contain arbitrary private file contents.
export function logCommand(cwd: string, args: string[], inputBytes: number) {
  if (fd === null) return () => {}
  const id = ++nextId
  const started = Date.now()
  write(`git#${id} start cwd=${quote(cwd)} args=${clip(JSON.stringify(commandArgs(args)))} in=${inputBytes}B`)
  return (code: number | null, outBytes: number, error?: string) => {
    write(`git#${id} exit=${code ?? 'none'} ${Date.now() - started}ms out=${outBytes}B${error ? ` err=${Buffer.byteLength(error)}B` : ''}`)
  }
}

// Logs one write action from the renderer. Error details remain in BetterGit's notification, outside the command log.
export async function logAction<T>(name: string, repo: string, run: () => Promise<T>): Promise<T> {
  if (fd === null) return run()
  const id = ++nextId
  const started = Date.now()
  write(`action#${id} start ${name} repo=${quote(repo)}`)
  try {
    const result = await run()
    write(`action#${id} ok ${Date.now() - started}ms`)
    return result
  } catch (error) {
    write(`action#${id} failed ${Date.now() - started}ms err=${Buffer.byteLength(error instanceof Error ? error.message : String(error))}B`)
    throw error
  }
}
