// Builds the synthetic benchmark repo: a long history and one commit (plus unstaged edits) with a large multi-file TS diff.
// Usage: bun scripts/perf/make-repo.ts [/tmp/bettergit-perf/bigrepo]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repo = process.argv[2] ?? '/tmp/bettergit-perf/bigrepo'
const COMMITS = 3000
const FILES = 30
const LINES = 400
const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo, input, maxBuffer: 1 << 28, env: { ...process.env, GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' } }).toString()

rmSync(repo, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.name', 'Perf Bench'])
git(['config', 'user.email', 'perf@example.com'])

// Long history through fast-import: one small file changes per commit, with a handful of authors.
let stream = ''
for (let i = 0; i < COMMITS; i++) {
  const body = `entry ${i}\n`
  const message = `chore: history entry ${i} touching the changelog`
  stream += `commit refs/heads/main\nmark :${i + 1}\nauthor Dev ${i % 7} <dev${i % 7}@example.com> ${1600000000 + i * 600} +0000\ncommitter Dev ${i % 7} <dev${i % 7}@example.com> ${1600000000 + i * 600} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`
  if (i > 0) stream += `from :${i}\n`
  stream += `M 100644 inline log/${i % 50}.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`
}
git(['fast-import', '--quiet'], stream)
git(['reset', '-q', '--hard', 'main'])

const line = (file: number, n: number) => `  export const value${file}_${n} = compute(${n}, 'alpha beta gamma', { index: ${n}, file: ${file} }) // note ${n}`
const base = (file: number) => Array.from({ length: LINES }, (_, n) => line(file, n))
for (let f = 0; f < FILES; f++) writeFileSync(path.join(repo, `src${f}.ts`), base(f).join('\n') + '\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'feat: add generated modules'])

// Each file: whitespace-only reindents, word edits, additions, deletions, and one moved block.
function edit(file: number, seed: number) {
  const lines = base(file)
  for (let n = 10 + seed; n < LINES; n += 10) lines[n] = '    ' + lines[n].trimStart()
  for (let n = 15 + seed; n < LINES; n += 10) lines[n] = lines[n].replace('alpha beta', 'alpha delta')
  const moved = lines.splice(40, 15)
  lines.splice(300, 0, ...moved)
  for (let n = 0; n < 30; n++) lines.splice(100 + n * 8, 0, `  export const added${file}_${n} = ${n} * factor // added`)
  lines.splice(200, 20)
  return lines.join('\n') + '\n'
}
for (let f = 0; f < FILES; f++) writeFileSync(path.join(repo, `src${f}.ts`), edit(f, 0))
git(['add', '-A'])
git(['commit', '-q', '-m', 'refactor: big multi-file change'])
for (let f = 0; f < 20; f++) writeFileSync(path.join(repo, `src${f}.ts`), edit(f, 3))
console.log(git(['rev-list', '--count', 'HEAD']).trim(), 'commits;', git(['diff', '--shortstat']).trim())
