import { afterAll, expect, test } from 'bun:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanup } from './helpers'
import { download, installTarget, isNewer, pickRelease, settleUpdates, stage, SWAP_SCRIPT, type Release } from '../src/main/update'

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'bettergit-update-')))
afterAll(() => {
  chmodSync(root, 0o755)
  cleanup(root)
})
let count = 0
const fresh = (name: string) => {
  const dir = path.join(root, `${name}-${count++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const digest = 'a'.repeat(64)
const reply = (tag: string, assets: unknown[], extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets, ...extra })
const asset = (name: string, extra = {}) => ({ name, size: 1000, digest: `sha256:${digest}`, state: 'uploaded', ...extra })

test('silent and manual update checks share one claim and cannot overwrite a download', async () => {
  let answer!: (release: Release) => void
  let finish!: () => void
  let checks = 0, downloads = 0
  const check = new Promise<Release>((resolve) => { answer = resolve })
  const downloadDone = new Promise<void>((resolve) => { finish = resolve })
  const compiled = await Bun.build({ entrypoints: [path.join(import.meta.dir, '../src/main/updater.ts')], target: 'node', format: 'cjs', external: ['*'] })
  expect(compiled.success).toBe(true)
  const module = { exports: {} as any }
  const imports: Record<string, unknown> = {
    electron: { app: Object.assign(new EventEmitter(), { getPath: () => root, getVersion: () => '0.1.8', isPackaged: true }), net: { fetch: () => {} }, shell: {} },
    'node:path': path, 'node:fs': { mkdtempSync: () => fresh('check-temp'), rmSync: () => {} },
    './repo-lock': {},
    './update': {
      installTarget: () => ({ bundle: path.join(root, 'BetterGit.app'), blocked: null }),
      latestRelease: () => { checks++; return check },
      download: () => { downloads++; return downloadDone },
      workFolder: () => fresh('check-stage'), teamOf: async () => null, stage: async () => {},
    },
  }
  runInNewContext(await compiled.outputs[0].text(), { module, exports: module.exports, require: (id: string) => imports[id] })
  const updater = module.exports.createUpdater(() => {})
  const silent = updater.check(false)
  const manual = updater.check(true)
  expect(checks).toBe(1)
  answer({ version: '0.1.9', name: 'update.dmg', size: 1, sha256: digest, url: 'unused' })
  await silent
  await manual
  const running = updater.update()
  await updater.check(false)
  await updater.update()
  expect(checks).toBe(1)
  expect(downloads).toBe(1)
  expect(updater.state().kind).toBe('downloading')
  finish()
  await running
  expect(updater.state().kind).toBe('ready')
})

test('takes only a higher stable version with exactly one verifiable arm64 DMG', () => {
  expect(isNewer('0.1.10', '0.1.9')).toBe(true)
  expect(isNewer('0.1.8', '0.1.8')).toBe(false)
  expect(isNewer('0.2.0-beta.1', '0.1.8')).toBe(false)
  expect(isNewer('1.0.0', '0.1.8-beta')).toBe(false)

  const release = pickRelease(reply('v0.1.9', [asset('BetterGit-0.1.9-arm64.dmg'), asset('notes.txt')]), '0.1.8')
  expect(release).toEqual({
    version: '0.1.9', name: 'BetterGit-0.1.9-arm64.dmg', size: 1000, sha256: digest,
    url: 'https://github.com/wrick17/bettergit/releases/download/v0.1.9/BetterGit-0.1.9-arm64.dmg',
  })
  // The download URL is built from the tag, never taken from the reply.
  expect(pickRelease(reply('v0.1.9', [asset('BetterGit-0.1.9-arm64.dmg', { browser_download_url: 'https://evil.example/x.dmg' })]), '0.1.8')?.url)
    .toStartWith('https://github.com/wrick17/bettergit/')
  expect(pickRelease(reply('v0.1.8', [asset('BetterGit-0.1.8-arm64.dmg')]), '0.1.8')).toBeNull()
  expect(pickRelease(reply('v0.1.7', [asset('BetterGit-0.1.7-arm64.dmg')]), '0.1.8')).toBeNull()
  expect(pickRelease(reply('v0.1.9', [], { prerelease: true }), '0.1.8')).toBeNull()
  expect(pickRelease(reply('v0.1.9', [], { draft: true }), '0.1.8')).toBeNull()
  expect(pickRelease(null, '0.1.8')).toBeNull()

  for (const assets of [
    [],
    [asset('BetterGit-0.1.9-x64.dmg')],
    [asset('BetterGit-0.1.9-arm64.dmg', { digest: null })],
    [asset('BetterGit-0.1.9-arm64.dmg', { digest: `sha512:${digest}` })],
    [asset('BetterGit-0.1.9-arm64.dmg', { state: 'starter' })],
    [asset('BetterGit-0.1.9-arm64.dmg', { size: 0 })],
    [asset('BetterGit-0.1.9-arm64.dmg', { size: 2 * 1024 ** 3 })],
    [asset('BetterGit-0.1.9-arm64.dmg'), asset('BetterGit-0.1.9-arm64.dmg')],
  ]) {
    expect(() => pickRelease(reply('v0.1.9', assets), '0.1.8')).toThrow('BetterGit 0.1.9 has no verifiable download')
  }
})

// An installed app at `folder/name`, and the path of its executable.
function installed(folder: string, name = 'BetterGit.app') {
  const bundle = path.join(folder, name)
  mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true })
  return { bundle, exe: path.join(bundle, 'Contents/MacOS/BetterGit') }
}

test('the update target is the running app at its own installed path and name', () => {
  // Wherever the app runs from: the user's own Applications, the system one, or any writable folder under any name.
  const home = installed(fresh('Users/me/Applications'))
  expect(installTarget(home.exe, true)).toEqual({ bundle: home.bundle, blocked: null })
  const custom = installed(fresh('My Tools'), 'Better Git (work).app')
  expect(installTarget(custom.exe, true)).toEqual({ bundle: custom.bundle, blocked: null })
  expect(installTarget('/Applications/BetterGit.app/Contents/MacOS/BetterGit', false).bundle).toBe('/Applications/BetterGit.app')

  // A folder reached through a link resolves to the real one, so the swap renames the real app.
  const link = path.join(root, `linked-${count++}`)
  symlinkSync(path.dirname(custom.bundle), link)
  expect(installTarget(path.join(link, 'Better Git (work).app/Contents/MacOS/BetterGit'), true)).toEqual({ bundle: custom.bundle, blocked: null })
})

test('a development, translocated, misplaced or read-only app cannot replace itself', () => {
  const app = installed(fresh('Applications'))
  expect(installTarget(app.exe, false).blocked).toBe('Development builds do not install updates.')
  expect(installTarget('/private/var/folders/x/AppTranslocation/ABC/d/BetterGit.app/Contents/MacOS/BetterGit', true).blocked).toStartWith('macOS is running BetterGit from a temporary copy.')
  expect(installTarget(path.join(root, 'bin/electron'), true).blocked).toBe('BetterGit is not running from an installed app.')
  // A disk image mounts read-only; a folder this user cannot write behaves the same.
  chmodSync(path.dirname(app.bundle), 0o555)
  try {
    expect(installTarget(app.exe, true).blocked).toStartWith('BetterGit cannot replace itself in the folder it is installed in')
  } finally {
    chmodSync(path.dirname(app.bundle), 0o755)
  }
})

function fakeFetch(body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response(new Blob([body]).stream(), { status: 200, headers })) as unknown as typeof fetch
}
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const releaseOf = (data: Uint8Array, extra: Partial<Release> = {}): Release =>
  ({ version: '0.1.9', name: 'x.dmg', url: 'https://github.com/x', size: data.length, sha256: sha(data), ...extra })

test('streams the download and keeps it only when the size and digest match', async () => {
  const dir = fresh('download')
  const data = new Uint8Array(300_000).map((_, index) => index % 251)
  const progress: number[] = []
  await download(fakeFetch(data), releaseOf(data), path.join(dir, 'ok.dmg'), (received) => progress.push(received))
  expect(sha(readFileSync(path.join(dir, 'ok.dmg')))).toBe(sha(data))
  expect(progress.at(-1)).toBe(data.length)

  await expect(download(fakeFetch(data), releaseOf(data, { sha256: digest }), path.join(dir, 'bad.dmg'), () => {}))
    .rejects.toThrow('does not match the checksum')
  await expect(download(fakeFetch(data), releaseOf(data, { size: 1000 }), path.join(dir, 'big.dmg'), () => {}))
    .rejects.toThrow('larger than GitHub reported')
  await expect(download(fakeFetch(data, { 'content-length': '5' }), releaseOf(data), path.join(dir, 'len.dmg'), () => {}))
    .rejects.toThrow('not the size GitHub reported')
  await expect(download(fakeFetch(data), releaseOf(data, { size: data.length + 1 }), path.join(dir, 'short.dmg'), () => {}))
    .rejects.toThrow('ended early')
  // An existing file is never written through.
  await expect(download(fakeFetch(data), releaseOf(data), path.join(dir, 'ok.dmg'), () => {})).rejects.toThrow()
})

// An installed app and a work folder holding the staged one, each marked with its version.
function swapFixture(name = 'BetterGit.app') {
  const apps = fresh('swap')
  const target = path.join(apps, name)
  const work = path.join(apps, '.BetterGit-update-abc123')
  for (const [app, version] of [[target, 'old'], [path.join(work, 'BetterGit.app'), 'new']]) {
    mkdirSync(app, { recursive: true })
    writeFileSync(path.join(app, 'version'), version)
  }
  return { apps, target, work, version: (app: string) => readFileSync(path.join(app, 'version'), 'utf8') }
}
const deadPid = () => spawnSync('/usr/bin/true').pid!
const swap = (pid: number, target: string, work: string, opener: string) =>
  spawnSync('/bin/sh', ['-c', SWAP_SCRIPT, 'bettergit-update', String(pid), target, work, opener]).status

test('the swap replaces the app and keeps the old one until the next launch', () => {
  const { target, work, version } = swapFixture()
  expect(swap(deadPid(), target, work, '/usr/bin/true')).toBe(0)
  expect(version(target)).toBe('new')
  expect(version(path.join(work, 'previous.app'))).toBe('old')
  expect(existsSync(path.join(work, 'BetterGit.app'))).toBe(false)
})

test('the swap installs at the same path and name it replaces, and opens exactly that path', () => {
  const { apps, target, work, version } = swapFixture('Better Git (work).app')
  const opened = path.join(apps, 'opened')
  const opener = path.join(apps, 'opener.sh')
  writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`, { mode: 0o755 })
  expect(swap(deadPid(), target, work, opener)).toBe(0)
  expect(version(target)).toBe('new')
  expect(readFileSync(opened, 'utf8')).toBe(target)
  // No other copy appears next to it.
  expect(readdirSync(apps).sort()).toEqual(['.BetterGit-update-abc123', 'Better Git (work).app', 'opened', 'opener.sh'])
})

test('the swap puts the old app back when the new one fails to open', () => {
  const { target, work, version } = swapFixture()
  expect(swap(deadPid(), target, work, '/usr/bin/false')).toBe(1)
  expect(version(target)).toBe('old')
  expect(version(path.join(work, 'failed.app'))).toBe('new')
  expect(existsSync(path.join(work, 'previous.app'))).toBe(false)
})

test('the swap leaves the app alone when the staged copy is missing or a link', () => {
  const missing = swapFixture()
  cleanup(path.join(missing.work, 'BetterGit.app'))
  expect(swap(deadPid(), missing.target, missing.work, '/usr/bin/true')).toBe(1)
  expect(missing.version(missing.target)).toBe('old')

  const linked = swapFixture()
  const elsewhere = path.join(linked.apps, 'Elsewhere.app')
  mkdirSync(elsewhere)
  cleanup(path.join(linked.work, 'BetterGit.app'))
  symlinkSync(elsewhere, path.join(linked.work, 'BetterGit.app'))
  expect(swap(deadPid(), linked.target, linked.work, '/usr/bin/true')).toBe(1)
  expect(linked.version(linked.target)).toBe('old')
  expect(existsSync(elsewhere)).toBe(true)
})

test('the swap waits for the app to exit first', async () => {
  const { target, work, version } = swapFixture()
  const app = spawn('/bin/sleep', ['0.6'])
  const started = Date.now()
  const status = await new Promise<number | null>((resolve) => {
    spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'bettergit-update', String(app.pid), target, work, '/usr/bin/true']).on('exit', resolve)
  })
  expect(status).toBe(0)
  expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  expect(version(target)).toBe('new')
})

test('settling removes only update folders and reports one that did not install', () => {
  const apps = fresh('settle')
  const bundle = path.join(apps, 'BetterGit.app')
  mkdirSync(bundle)
  mkdirSync(path.join(apps, '.BetterGit-update-aaaaaa/previous.app'), { recursive: true })
  expect(settleUpdates(bundle)).toBe(false)
  mkdirSync(path.join(apps, '.BetterGit-update-bbbbbb/failed.app'), { recursive: true })
  const outside = fresh('outside')
  symlinkSync(outside, path.join(apps, '.BetterGit-update-cccccc'))
  mkdirSync(path.join(apps, '.BetterGit-update-other'))
  expect(settleUpdates(bundle)).toBe(true)
  expect(readdirSync(apps).sort()).toEqual(['.BetterGit-update-cccccc', '.BetterGit-update-other', 'BetterGit.app'])
  expect(existsSync(outside)).toBe(true)
})

// A tiny ad-hoc signed BetterGit in a DMG, built the way a release lays it out.
function dmgFixture(version: string, tamper = false) {
  const dir = fresh('dmg')
  const app = path.join(dir, 'src/BetterGit.app')
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(path.join(dir, 'main.c'), 'int main(void) { return 0; }\n')
  execFileSync('/usr/bin/xcrun', ['cc', '-arch', 'arm64', '-o', path.join(app, 'Contents/MacOS/BetterGit'), path.join(dir, 'main.c')])
  writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.wrick17.bettergit</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>BetterGit</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
  execFileSync('/usr/bin/codesign', ['--force', '-s', '-', app], { stdio: 'ignore' })
  if (tamper) writeFileSync(path.join(app, 'Contents/Info.plist'), readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8').replace('APPL', 'APPX'))
  const dmg = path.join(dir, 'update.dmg')
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-srcfolder', path.join(dir, 'src'), '-volname', 'BetterGit', dmg])
  return { dmg, dir, into: () => fresh('work') }
}
const mounted = () => execFileSync('/sbin/mount').toString()

test.if(process.platform === 'darwin' && process.arch === 'arm64')('stages only a signed BetterGit of the expected version, and always detaches', async () => {
  const good = dmgFixture('0.1.9')
  const into = good.into()
  const staged = await stage(good.dmg, into, '0.1.9', null)
  expect(staged).toBe(path.join(into, 'BetterGit.app'))
  expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]).status).toBe(0)

  const refused: string[] = []
  const refuse = async (dmg: string, version: string, team: string | null, message: string) => {
    const dir = good.into()
    refused.push(dir)
    await expect(stage(dmg, dir, version, team)).rejects.toThrow(message)
  }
  await refuse(good.dmg, '0.2.0', null, 'is not BetterGit 0.2.0')
  // An ad-hoc download never replaces an app signed by a team.
  await refuse(good.dmg, '0.1.9', 'ABCDE12345', 'same developer')
  const tampered = dmgFixture('0.1.9', true)
  await refuse(tampered.dmg, '0.1.9', null, 'code signature')

  for (const dir of refused) expect(readdirSync(dir)).toEqual([])
  expect(mounted()).not.toContain(root)
  for (const fixture of [good, tampered]) expect(readdirSync(fixture.dir).filter((name) => name.startsWith('mount-'))).toEqual([])
}, 120_000)
