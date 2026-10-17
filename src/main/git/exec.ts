import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  input?: string
  // Maximum bytes of stdout kept in memory. Diffs of huge files are truncated, not buffered whole.
  maxBuffer?: number
  // Reads that run in the background pass this so they never take the index lock.
  optionalLocks?: boolean
  // Prompts (credentials, host keys) must never block the app; they fail instead.
  interactive?: boolean
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // Node reports a missing working folder as "spawn git ENOENT", which looks like git is missing.
    if (!existsSync(cwd)) return reject(new GitError(`Folder not found: ${cwd}`, args, null, ''))
    const child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
      cwd,
      env: gitEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const limit = options.maxBuffer ?? DEFAULT_MAX_BUFFER
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // Fail loudly: a silently truncated diff or log would parse into wrong data.
        child.kill()
        return reject(new GitError(`git ${args[0]} output exceeds ${limit} bytes`, args, null, ''))
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => reject(new GitError(error.message, args, null, '')))
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8').trim()
      if (code === 0) return resolve(stdout)
      reject(new GitError(stderr || `git ${args[0]} failed with code ${code}`, args, code, stderr))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

export async function gitOk(cwd: string, args: string[], options?: GitOptions): Promise<boolean> {
  try {
    await git(cwd, args, options)
    return true
  } catch {
    return false
  }
}

function gitEnv(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Apps launched from Finder get a minimal PATH, which can hide Homebrew or Xcode git.
    PATH: [process.env.PATH, '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).join(':'),
    LC_ALL: 'C',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: options.optionalLocks === false ? '1' : '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
  }
  if (options.interactive) delete env.GIT_TERMINAL_PROMPT
  return env
}

export interface RawResult {
  // The exit code, or -1 when the process ended without one.
  code: number
  stdout: Buffer
  stderr: string
}

// For commands whose answer is the exit code, such as merge-file, where a non-zero exit is a result, not a failure.
// Output stays raw bytes. Spawn failures still reject.
export function gitRaw(cwd: string, args: string[], input?: Buffer): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(cwd)) return reject(new GitError(`Folder not found: ${cwd}`, args, null, ''))
    const child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
      cwd,
      env: gitEnv({}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > DEFAULT_MAX_BUFFER) {
        child.kill()
        return reject(new GitError(`git ${args[0]} output exceeds ${DEFAULT_MAX_BUFFER} bytes`, args, null, ''))
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => reject(new GitError(error.message, args, null, '')))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').trim() }))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? Buffer.alloc(0))
  })
}
