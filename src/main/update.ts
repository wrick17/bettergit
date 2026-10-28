import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { accessSync, constants, createWriteStream, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

// Updates come only from this repo's latest stable GitHub release. The DMG must match the size and SHA-256 digest that
// GitHub reports for it. The app inside must match this app's ID and the release version, and pass codesign. A signed app
// takes only an update from the same team. Nothing here takes a URL or a path from the renderer.
const REPO = 'wrick17/bettergit'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const APP_ID = 'com.wrick17.bettergit'
const APP_NAME = 'BetterGit.app'
const MAX_DMG = 1024 * 1024 * 1024
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/
// The folder next to the installed app that holds the staged update, and later the replaced app.
export const WORK_PREFIX = '.BetterGit-update-'
const WORK_DIR = /^\.BetterGit-update-[A-Za-z0-9]{6}$/

const run = promisify(execFile)
const tool = (file: string, args: string[]) => run(file, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })

export interface Release {
  version: string
  name: string
  url: string
  size: number
  sha256: string
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  // `blocked` says why this copy cannot replace itself; the user then downloads the release by hand.
  | { kind: 'available'; version: string; blocked?: string }
  | { kind: 'downloading'; version: string; received: number; total: number }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string }

// Whether `next` is a higher stable x.y.z than `current`. A prerelease or malformed version on either side is never newer.
export function isNewer(next: string, current: string): boolean {
  const a = STABLE.exec(next)
  const b = STABLE.exec(current)
  if (!a || !b) return false
  for (let index = 1; index <= 3; index++) {
    if (Number(a[index]) !== Number(b[index])) return Number(a[index]) > Number(b[index])
  }
  return false
}

// The update in GitHub's latest-release reply, or null when it is not newer. A newer release without exactly one valid
// arm64 DMG throws, so the user hears about it and can download by hand.
export function pickRelease(reply: unknown, current: string): Release | null {
  const release = reply as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
  if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false) return null
  const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : ''
  if (!isNewer(version, current)) return null
  const name = `BetterGit-${version}-arm64.dmg`
  const matches = (Array.isArray(release.assets) ? release.assets : []).filter((asset) => asset?.name === name)
  const asset = matches.length === 1 ? matches[0] as { size?: unknown; digest?: unknown; state?: unknown } : null
  const sha256 = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined
  const size = asset?.size
  if (!asset || asset.state !== 'uploaded' || !sha256 || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_DMG) {
    throw new Error(`BetterGit ${version} has no verifiable download for this Mac.`)
  }
  return { version, name, url: `https://github.com/${REPO}/releases/download/v${version}/${name}`, size, sha256 }
}

export async function latestRelease(fetch: typeof globalThis.fetch, current: string): Promise<Release | null> {
  const response = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to the update check.`)
  return pickRelease(await response.json(), current)
}

// The installed app running `exe` (its Contents/MacOS/<name>), at its real path, and why it cannot replace itself there, or
// null. An update always lands at exactly this path, under the user's own name for the app, wherever they installed it.
export function installTarget(exe: string, packaged: boolean): { bundle: string; blocked: string | null } {
  const found = path.resolve(exe, '../../..')
  let bundle = found
  try {
    bundle = realpathSync.native(found)
  } catch {}
  return { bundle, blocked: blocker() }

  function blocker(): string | null {
    if (!packaged) return 'Development builds do not install updates.'
    if (!bundle.endsWith('.app') || path.relative(found, exe) !== path.join('Contents/MacOS', path.basename(exe))) {
      return 'BetterGit is not running from an installed app.'
    }
    if (bundle.includes('/AppTranslocation/')) {
      return 'macOS is running BetterGit from a temporary copy. Move it to a folder such as Applications, open it there, and update again.'
    }
    try {
      if (!lstatSync(bundle).isDirectory()) return 'BetterGit is not running from an installed app.'
      // Moving a folder needs write access to it and to the folder holding it. A disk image or read-only folder has neither.
      accessSync(bundle, constants.W_OK)
      accessSync(path.dirname(bundle), constants.W_OK)
    } catch {
      return 'BetterGit cannot replace itself in the folder it is installed in, such as a disk image or a read-only folder.'
    }
    return null
  }
}

// The signing team of an app, or null when it is ad-hoc signed or unsigned.
export async function teamOf(app: string): Promise<string | null> {
  const { stderr } = await tool('/usr/bin/codesign', ['-dv', '--verbose=2', app]).catch((failure) => ({ stderr: String(failure?.stderr ?? '') }))
  const team = /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1]
  return team && team !== 'not set' && !/^Signature=adhoc$/m.test(stderr) ? team : null
}

// Streams the DMG to `file`, hashing as it writes. Rejects a wrong status, length, size or digest.
export async function download(fetch: typeof globalThis.fetch, release: Release, file: string, onProgress: (received: number) => void): Promise<void> {
  // Opened first and only as a new file, so an existing path is refused before anything downloads.
  const out = createWriteStream(file, { fd: openSync(file, 'wx', 0o600) })
  const closed = new Promise<void>((resolve, reject) => out.on('close', resolve).on('error', reject))
  closed.catch(() => {})
  const hash = createHash('sha256')
  let received = 0
  try {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!response.ok || !response.body) throw new Error(`The download failed with status ${response.status}.`)
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) !== release.size) throw new Error('The download is not the size GitHub reported.')
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (received > release.size) throw new Error('The download is larger than GitHub reported.')
      hash.update(chunk)
      // Rejects if the write fails, such as a full disk, instead of waiting for a drain that never comes.
      if (!out.write(chunk)) await once(out, 'drain')
      onProgress(received)
    }
  } finally {
    out.end()
    await closed
  }
  if (received !== release.size) throw new Error('The download ended early.')
  if (hash.digest('hex') !== release.sha256) throw new Error('The download does not match the checksum GitHub published.')
}

const plist = async (app: string, key: string) =>
  (await tool('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')])).stdout.trim()

// Checks the app in the DMG and copies it to `<into>/BetterGit.app`. The DMG mounts read-only and is always detached.
// `team` is the running app's signing team: a signed app accepts only the same team.
export async function stage(dmg: string, into: string, version: string, team: string | null): Promise<string> {
  const mount = mkdtempSync(path.join(path.dirname(dmg), 'mount-'))
  await tool('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
  try {
    const app = path.join(mount, APP_NAME)
    if (!lstatSync(app).isDirectory()) throw new Error('The download has no BetterGit app.')
    if (await plist(app, 'CFBundleIdentifier') !== APP_ID) throw new Error('The download is not BetterGit.')
    if (await plist(app, 'CFBundleShortVersionString') !== version) throw new Error(`The download is not BetterGit ${version}.`)
    const executable = await plist(app, 'CFBundleExecutable')
    if (!executable || executable.includes('/')) throw new Error('The download has no app executable.')
    const archs = (await tool('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS', executable)])).stdout.trim().split(/\s+/)
    if (!archs.includes(process.arch)) throw new Error('The download does not run on this Mac.')
    await tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).catch(() => { throw new Error('The downloaded app failed its code signature check.') })
    if (team && await teamOf(app) !== team) throw new Error('The download is not signed by the same developer as this app.')
    const staged = path.join(into, APP_NAME)
    await tool('/usr/bin/ditto', [app, staged])
    return staged
  } finally {
    await tool('/usr/bin/hdiutil', ['detach', mount]).catch(() => tool('/usr/bin/hdiutil', ['detach', '-force', mount])).catch(() => {})
    rmSync(mount, { recursive: true, force: true })
  }
}

// A new folder for the staged app, next to the installed one, so the swap is a rename on one volume.
export const workFolder = (bundle: string) => mkdtempSync(path.join(path.dirname(bundle), WORK_PREFIX))

// Removes update folders from earlier runs next to `bundle`. True when one still held an app that was not installed, or
// one put back after the new version failed to open: that update did not install.
export function settleUpdates(bundle: string): boolean {
  const parent = path.dirname(bundle)
  let failed = false
  for (const name of readdirSync(parent)) {
    const dir = path.join(parent, name)
    if (!WORK_DIR.test(name) || !lstatSync(dir).isDirectory()) continue
    failed ||= existsSync(path.join(dir, APP_NAME)) || existsSync(path.join(dir, 'failed.app'))
    rmSync(dir, { recursive: true, force: true })
  }
  return failed
}

// Runs after the app quits. Waits up to 60 s for its PID to exit, then moves the old app aside, moves the staged one in
// and opens it. If the move or the launch fails, the old app goes back and opens. Paths arrive as arguments only.
// $1 pid, $2 installed app, $3 work folder, $4 opener.
export const SWAP_SCRIPT = `
pid=$1 target=$2 work=$3 opener=$4
staged="$work/BetterGit.app" backup="$work/previous.app" failed="$work/failed.app"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  [ "$n" -gt 600 ] && exit 1
  sleep 0.1
done
if [ ! -d "$staged" ] || [ -L "$staged" ] || [ ! -d "$target" ] || [ -L "$target" ] || [ -e "$backup" ]; then
  "$opener" "$target"
  exit 1
fi
/bin/mv "$target" "$backup" || { "$opener" "$target"; exit 1; }
if [ ! -e "$target" ] && /bin/mv "$staged" "$target" && "$opener" "$target"; then exit 0; fi
[ -d "$target" ] && [ ! -e "$failed" ] && /bin/mv "$target" "$failed"
[ ! -e "$target" ] && /bin/mv "$backup" "$target"
"$opener" "$target"
exit 1
`

// Starts the swap in its own process group, so it outlives the app.
export function startSwap(pid: number, target: string, work: string, opener = '/usr/bin/open') {
  spawn('/bin/sh', ['-c', SWAP_SCRIPT, 'bettergit-update', String(pid), target, work, opener], { detached: true, stdio: 'ignore' }).unref()
}
