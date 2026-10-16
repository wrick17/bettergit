#!/usr/bin/env bun
// Builds a sample projects folder that exercises BetterGit's sidebar and Git views.
// Usage: bun scripts/create-sample-workspace.ts [directory] [--bulk=N] [--large=N] [--force]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import path from 'node:path'

export interface SampleOptions {
  bulk: number
  largeCommits: number
}

const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Sample Author',
  GIT_AUTHOR_EMAIL: 'sample@example.com',
  GIT_COMMITTER_NAME: 'Sample Author',
  GIT_COMMITTER_EMAIL: 'sample@example.com',
  GIT_TERMINAL_PROMPT: '0',
}
const GIT_ARGS = ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false']

let clock = Date.parse('2026-01-05T09:00:00Z') / 1000

// Commits are dated one hour apart so history and graphs look stable across runs.
function tick(): string {
  clock += 3600
  return `${clock} +0000`
}

export function git(cwd: string, args: string[], { date = true, input }: { date?: boolean; input?: string } = {}): string {
  const stamp = date ? tick() : undefined
  return execFileSync('git', [...GIT_ARGS, ...args], {
    cwd,
    env: stamp ? { ...BASE_ENV, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : BASE_ENV,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function append(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, content)
}

function commitAll(repo: string, message: string) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', message])
}

function initRepo(repo: string) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'], { date: false })
}

const FORMAT_TS = `export function formatDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return \`\${value.getFullYear()}-\${pad(value.getMonth() + 1)}-\${pad(value.getDate())}\`
}
`

const DATE_BLOCK = `export function formatTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours = pad(value.getHours())
  const minutes = pad(value.getMinutes())
  return \`\${hours}:\${minutes}\`
}
`

function buildWebApp(root: string) {
  const repo = path.join(root, 'work', 'acme', 'web-app')
  initRepo(repo)
  write(path.join(repo, 'README.md'), '# web-app\n\nSample Next-style front end used for BetterGit tests.\n')
  write(path.join(repo, 'package.json'), '{\n  "name": "web-app",\n  "version": "1.0.0"\n}\n')
  write(path.join(repo, 'src', 'app.ts'), 'export function start() {\n  console.log("starting")\n}\n')
  write(path.join(repo, 'src', 'utils', 'format.ts'), FORMAT_TS + '\n' + DATE_BLOCK)
  write(path.join(repo, 'notes', 'meeting notes.md'), '- kickoff\n')
  commitAll(repo, 'chore: initial scaffold')

  // Many small commits on main so the history page has real depth.
  for (let i = 1; i <= 30; i++) {
    append(path.join(repo, 'CHANGELOG.md'), `- change ${i}\n`)
    commitAll(repo, `docs: changelog entry ${i}`)
  }

  git(repo, ['switch', '-q', '-c', 'feature/search'])
  write(path.join(repo, 'src', 'search.ts'), 'export function search(query: string, items: string[]) {\n  const needle = query.toLowerCase()\n  return items.filter((item) => item.toLowerCase().includes(needle))\n}\n')
  commitAll(repo, 'feat: add search helper')
  write(path.join(repo, 'src', 'search.ts'), 'export function search(query: string, items: string[]) {\n  const needle = query.trim().toLowerCase()\n  return items.filter((item) => item.toLowerCase().includes(needle))\n}\n')
  commitAll(repo, 'fix: trim search query')

  git(repo, ['switch', '-q', 'main'])
  git(repo, ['switch', '-q', '-c', 'fix/typo'])
  write(path.join(repo, 'README.md'), '# web-app\n\nSample front end used for BetterGit tests.\n')
  commitAll(repo, 'docs: fix typo in readme')
  git(repo, ['switch', '-q', 'main'])
  git(repo, ['merge', '-q', '--no-ff', 'fix/typo', '-m', 'Merge branch fix/typo'])

  // Cross-file move in one commit: formatTime leaves format.ts and lands in app.ts.
  write(path.join(repo, 'src', 'utils', 'format.ts'), FORMAT_TS)
  write(path.join(repo, 'src', 'app.ts'), 'export function start() {\n  console.log("starting")\n}\n\n' + DATE_BLOCK)
  commitAll(repo, 'refactor: move formatTime into app')

  git(repo, ['switch', '-q', 'feature/search'])
  git(repo, ['switch', '-q', 'main'])
  git(repo, ['mv', 'README.md', 'docs-readme.md'])
  git(repo, ['commit', '-q', '-m', 'docs: rename readme'])

  // Working tree: staged, unstaged, deleted, untracked, and an uncommitted move.
  write(path.join(repo, 'src', 'app.ts'), 'export function start() {\n  console.log("starting web app")\n}\n\n' + DATE_BLOCK)
  git(repo, ['add', 'src/app.ts'])
  write(path.join(repo, 'package.json'), '{\n  "name": "web-app",\n  "version": "1.1.0"\n}\n')
  write(path.join(repo, 'src', 'scratch.ts'), '// untracked draft\n')
  // Unstaged deletion of a tracked file.
  rmSync(path.join(repo, 'CHANGELOG.md'))
  // Uncommitted cross-file move: formatTime leaves app.ts (unstaged) and lands in format.ts.
  write(path.join(repo, 'src', 'app.ts'), 'export function start() {\n  console.log("starting web app")\n}\n')
  append(path.join(repo, 'src', 'utils', 'format.ts'), '\n' + DATE_BLOCK)
}

function buildApiService(root: string) {
  const remotes = path.join(root, '.remotes')
  const bare = path.join(remotes, 'api-service.git')
  mkdirSync(remotes, { recursive: true })
  git(remotes, ['init', '-q', '--bare', '-b', 'main', bare], { date: false })

  const repo = path.join(root, 'work', 'acme', 'api-service')
  initRepo(repo)
  git(repo, ['remote', 'add', 'origin', bare], { date: false })
  write(path.join(repo, 'server.ts'), 'export const port = 3000\n')
  commitAll(repo, 'feat: initial server')
  git(repo, ['push', '-q', '-u', 'origin', 'main'], { date: false })

  // Someone else pushes one commit: local will be behind by 1 after fetch.
  const other = path.join(remotes, 'tmp-clone')
  git(remotes, ['clone', '-q', bare, other], { date: false })
  write(path.join(other, 'routes.ts'), 'export const routes = ["/health"]\n')
  commitAll(other, 'feat: health route from teammate')
  git(other, ['push', '-q', 'origin', 'main'], { date: false })
  rmSync(other, { recursive: true, force: true })

  git(repo, ['fetch', '-q', 'origin'], { date: false })
  // Two local commits not on the remote: local is ahead by 2 and behind by 1.
  write(path.join(repo, 'server.ts'), 'export const port = 8080\n')
  commitAll(repo, 'chore: change default port')
  write(path.join(repo, 'auth.ts'), 'export const requireAuth = () => true\n')
  commitAll(repo, 'feat: auth stub')
}

function buildConflictDemo(root: string) {
  const repo = path.join(root, 'work', 'acme', 'conflict-demo')
  initRepo(repo)
  write(path.join(repo, 'config.txt'), 'mode = a\n')
  commitAll(repo, 'init config')
  git(repo, ['switch', '-q', '-c', 'other'])
  write(path.join(repo, 'config.txt'), 'mode = b\n')
  commitAll(repo, 'set mode b')
  git(repo, ['switch', '-q', 'main'])
  write(path.join(repo, 'config.txt'), 'mode = c\n')
  commitAll(repo, 'set mode c')
  try {
    git(repo, ['merge', '--no-edit', 'other'])
  } catch {
    // Expected: the merge stops with conflict markers left in the working tree.
  }
}

function buildEmptyRepo(root: string) {
  const repo = path.join(root, 'work', 'personal', 'empty-repo')
  initRepo(repo)
  write(path.join(repo, 'todo.txt'), 'untracked before the first commit\n')
}

function buildDetached(root: string) {
  const repo = path.join(root, 'work', 'personal', 'detached-head')
  initRepo(repo)
  write(path.join(repo, 'a.txt'), 'one\n')
  commitAll(repo, 'first')
  const first = git(repo, ['rev-parse', 'HEAD'])
  write(path.join(repo, 'a.txt'), 'two\n')
  commitAll(repo, 'second')
  git(repo, ['checkout', '-q', '--detach', first])
}

function buildStashed(root: string) {
  const repo = path.join(root, 'work', 'personal', 'with-stash')
  initRepo(repo)
  write(path.join(repo, 'login.ts'), 'export const login = () => false\n')
  commitAll(repo, 'feat: login stub')
  write(path.join(repo, 'login.ts'), 'export const login = () => true\n')
  git(repo, ['stash', 'push', '-q', '-m', 'wip on login'])
  write(path.join(repo, 'login.ts'), 'export const login = () => "todo"\n')
  write(path.join(repo, 'session.ts'), 'export const session = {}\n')
  git(repo, ['stash', 'push', '-q', '--include-untracked', '-m', 'session draft'])
  write(path.join(repo, 'login.ts'), 'export const login = () => "dirty"\n')
}

function buildWorktreeParent(root: string) {
  // The worktree is a sibling folder, so the scanner lists it as its own repo.
  const repo = path.join(root, 'work', 'acme', 'web-app')
  git(repo, ['branch', '-q', 'release/1.0'])
  git(repo, ['worktree', 'add', '-q', path.join(root, 'work', 'acme', 'web-app-release'), 'release/1.0'], { date: false })
}

function buildOss(root: string) {
  const deep = path.join(root, 'oss', 'deep', 'nested', 'tooling')
  initRepo(deep)
  write(path.join(deep, 'lint.json'), '{ "rules": {} }\n')
  commitAll(deep, 'init tooling')

  const host = path.join(root, 'oss', 'lib-host')
  initRepo(host)
  write(path.join(host, 'index.ts'), 'export {}\n')
  commitAll(host, 'init lib host')
  // A vendored repo inside another repo. Scanning must not list it separately.
  const vendored = path.join(host, 'vendor', 'inner')
  initRepo(vendored)
  write(path.join(vendored, 'x.txt'), 'x\n')
  commitAll(vendored, 'vendored')

  mkdirSync(path.join(root, 'oss', 'empty-folder'), { recursive: true })
  mkdirSync(path.join(root, 'oss', 'notes-only'), { recursive: true })
  write(path.join(root, 'oss', 'notes-only', 'ideas.md'), '- nothing to see here\n')
}

function buildIgnored(root: string) {
  // Skipped by name, so the scanner never reaches these.
  mkdirSync(path.join(root, 'node_modules', 'fake-pkg', '.git'), { recursive: true })
  mkdirSync(path.join(root, '.hidden-project', '.git'), { recursive: true })
}

function buildStandalone(root: string) {
  const repo = path.join(root, 'standalone-repo')
  initRepo(repo)
  write(path.join(repo, 'notes.md'), '# standalone\n')
  commitAll(repo, 'init standalone')
}

// Large history built with fast-import: thousands of commits in seconds, one branch per 500 commits.
async function buildLargeHistory(root: string, count: number): Promise<void> {
  if (count <= 0) return
  const repo = path.join(root, 'large', 'history-heavy')
  initRepo(repo)
  const lines: string[] = []
  let parent = ''
  for (let i = 1; i <= count; i++) {
    const when = clock + i * 60
    const message = `chore: step ${i}`
    lines.push('commit refs/heads/main')
    lines.push(`mark :${i}`)
    lines.push(`author Sample Author <sample@example.com> ${when} +0000`)
    lines.push(`committer Sample Author <sample@example.com> ${when} +0000`)
    lines.push(`data ${Buffer.byteLength(message)}`)
    lines.push(message)
    if (parent) lines.push(`from :${parent}`)
    lines.push('M 644 inline counter.txt')
    const body = `step ${i}`
    lines.push(`data ${Buffer.byteLength(body)}`)
    lines.push(body)
    lines.push('')
    parent = String(i)
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...GIT_ARGS, 'fast-import', '--quiet', '--force'], { cwd: repo, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `fast-import exited ${code}`))))
    child.stdin.end(lines.join('\n') + '\n')
  })
  git(repo, ['reset', '-q', '--hard', 'main'], { date: false })
}

function buildBulk(root: string, count: number) {
  for (let i = 1; i <= count; i++) {
    const group = String(Math.ceil(i / 50)).padStart(2, '0')
    const repo = path.join(root, 'bulk', `group-${group}`, `repo-${String(i).padStart(4, '0')}`)
    initRepo(repo)
    write(path.join(repo, 'README.md'), `# repo ${i}\n`)
    commitAll(repo, `init repo ${i}`)
  }
}

const README = `# BetterGit sample workspace

Generated by \`bun scripts/create-sample-workspace.ts\`. Each folder tests one case.

| Path | What it tests |
| --- | --- |
| work/acme/web-app | Long history, merge, branches, rename, moved code, staged + unstaged + untracked changes |
| work/acme/web-app-release | Linked worktree (appears as its own repo) |
| work/acme/api-service | Ahead 2, behind 1 relative to origin |
| work/acme/conflict-demo | Merge stopped with a conflict |
| work/personal/empty-repo | No commits yet (unborn HEAD) |
| work/personal/detached-head | Detached HEAD |
| work/personal/with-stash | Two stash entries, one with untracked files |
| oss/deep/nested/tooling | Repo three folders deep |
| oss/lib-host | Vendored repo inside another repo (not listed separately) |
| oss/empty-folder, oss/notes-only | Folders without repos (hidden in the sidebar) |
| standalone-repo | A single repo added directly |
| node_modules, .hidden-project | Skipped by the scanner |
| .remotes | Bare remote for api-service (dot folder, hidden) |
| large/history-heavy | Thousands of commits for graph performance (--large=N) |
| bulk | Many repos for sidebar performance (--bulk=N) |
`

// Uncommitted work across several repos: small one-line edits and large rewrites, staged and unstaged,
// plus small and large untracked files. api-service is left alone so its ahead/behind state stays exact.
function buildWorkingChanges(root: string) {
  const standalone = path.join(root, 'standalone-repo')
  write(path.join(standalone, 'notes.md'), '# standalone\n\nSecond line added for a small diff.\n')
  write(path.join(standalone, 'todo.md'), '- [ ] write tests\n')
  git(standalone, ['add', 'todo.md'])

  const tooling = path.join(root, 'oss', 'deep', 'nested', 'tooling')
  const rules = Array.from({ length: 320 }, (_, i) =>
    `  "rule-${String(i).padStart(3, '0')}": { "severity": "${i % 3 === 0 ? 'error' : 'warn'}", "enabled": true }`)
  write(path.join(tooling, 'lint.json'), '{\n' + rules.join(',\n') + '\n}\n')
  write(path.join(tooling, 'generated', 'rules-index.json'),
    JSON.stringify(Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `rule-${i}`, group: i % 7 })), null, 2) + '\n')

  write(path.join(root, 'oss', 'lib-host', 'index.ts'), 'export const version = "1.0.1"\n')
  write(path.join(root, 'work', 'personal', 'detached-head', 'a.txt'), 'two (edited)\n')

  const web = path.join(root, 'work', 'acme', 'web-app')
  write(path.join(web, 'src', 'data', 'table.ts'),
    Array.from({ length: 600 }, (_, i) => `export const row${i} = { id: ${i}, label: "item ${i}" }`).join('\n') + '\n')
  append(path.join(web, 'docs-readme.md'),
    Array.from({ length: 200 }, (_, i) => `- Added documentation line ${i + 1}.`).join('\n') + '\n')
}

export async function createSampleWorkspace(root: string, options: SampleOptions): Promise<void> {
  mkdirSync(root, { recursive: true })
  buildStandalone(root)
  buildWebApp(root)
  buildWorktreeParent(root)
  buildApiService(root)
  buildConflictDemo(root)
  buildEmptyRepo(root)
  buildDetached(root)
  buildStashed(root)
  buildOss(root)
  buildIgnored(root)
  await buildLargeHistory(root, options.largeCommits)
  buildBulk(root, options.bulk)
  buildWorkingChanges(root)
  write(path.join(root, 'README.md'), README)
}

function parseArgs(argv: string[]) {
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const flag = (name: string, fallback: number) => {
    const match = argv.find((arg) => arg.startsWith(`--${name}=`))
    return match ? Number(match.split('=')[1]) : fallback
  }
  return {
    directory: positional[0] ?? path.resolve(import.meta.dir, '..', 'fixtures', 'sample-workspace'),
    bulk: flag('bulk', 0),
    largeCommits: flag('large', 0),
    force: argv.includes('--force'),
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const target = path.resolve(args.directory)
  if (existsSync(target)) {
    if (!args.force) {
      console.error(`${target} already exists. Pass --force to replace it.`)
      process.exit(1)
    }
    // Moved aside instead of deleted, so a mistaken path never loses a folder.
    const aside = `${target}.previous-${Date.now()}`
    renameSync(target, aside)
    console.log(`Moved existing folder to ${aside}`)
  }
  await createSampleWorkspace(target, { bulk: args.bulk, largeCommits: args.largeCommits })
  console.log(`Sample workspace ready at ${target}`)
}
