import { app, net, shell, type WebContents } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { closeRepoLocks, reopenRepoLocks } from './repo-lock'
import { download, installTarget, latestRelease, RELEASES_PAGE, settleUpdates, stage, startSwap, teamOf, workFolder, type Release, type UpdateState } from './update'

const DAY = 24 * 60 * 60 * 1000
const fetch = net.fetch as typeof globalThis.fetch

// Checks at launch and once a day in the packaged app, and when the user picks Check for Updates. It downloads only when
// the user clicks Update and restarts only when they click Restart, never while a Git write runs or edits are unsaved.
export function createUpdater(send: (state: UpdateState) => void) {
  // The update replaces the running app where it is installed, and the restart opens that same path.
  const { bundle, blocked } = installTarget(app.getPath('exe'), app.isPackaged)
  let state: UpdateState = { kind: 'idle' }
  let release: Release | null = null
  let work: string | null = null
  let quitting = false
  let checking = false
  const set = (next: UpdateState) => send(state = next)
  const busy = () => checking || state.kind === 'downloading' || quitting
  const dropWork = () => {
    if (work) rmSync(work, { recursive: true, force: true })
    work = null
  }

  // A silent check shows only an update. A user's check also shows that the app is current, or why the check failed.
  async function check(user: boolean) {
    if (busy() || state.kind === 'ready') return void (user && send(state))
    checking = true
    if (user) set({ kind: 'checking' })
    try {
      release = await latestRelease(fetch, app.getVersion())
      if (release) set({ kind: 'available', version: release.version, ...(blocked ? { blocked } : {}) })
      else if (user) set({ kind: 'current', version: app.getVersion() })
    } catch (failure) {
      if (user) set({ kind: 'failed', message: failure instanceof Error ? failure.message : String(failure) })
    } finally {
      checking = false
    }
  }

  async function update() {
    if (busy() || !release || blocked || state.kind !== 'available') return
    const target = release
    const temp = mkdtempSync(path.join(app.getPath('temp'), 'bettergit-update-'))
    try {
      set({ kind: 'downloading', version: target.version, received: 0, total: target.size })
      let shown = 0
      const dmg = path.join(temp, target.name)
      await download(fetch, target, dmg, (received) => {
        if (received - shown < target.size / 100 && received < target.size) return
        shown = received
        set({ kind: 'downloading', version: target.version, received, total: target.size })
      })
      dropWork()
      work = workFolder(bundle)
      await stage(dmg, work, target.version, await teamOf(bundle))
      set({ kind: 'ready', version: target.version })
    } catch (failure) {
      dropWork()
      set({ kind: 'failed', message: `Could not download BetterGit ${target.version}. ${failure instanceof Error ? failure.message : String(failure)}` })
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  // Quits so the swap can run. Refused while a Git write or fetch runs; from here no new one can start. The renderer's
  // unload guard may still cancel the quit for unsaved edits, which keeps the staged update and opens the repos again.
  function install(): string | null {
    if (state.kind !== 'ready' || !work || quitting) return 'No update is ready to install.'
    if (!closeRepoLocks()) return 'Wait for the running Git actions to finish, then restart.'
    quitting = true
    app.quit()
    return null
  }

  function cancelled() {
    if (!quitting) return
    quitting = false
    reopenRepoLocks()
  }

  return {
    state: () => state,
    check,
    update,
    install,
    openPage: () => shell.openExternal(RELEASES_PAGE),
    // A window that cancels its unload, for unsaved edits, cancels the restart.
    watch: (contents: WebContents) => contents.on('will-prevent-unload', cancelled),
    // Settles any earlier update and starts the checks. Call once.
    start() {
      app.on('will-quit', () => {
        if (!quitting || !work) return
        try {
          startSwap(process.pid, bundle, work)
        } catch (failure) {
          console.error('Could not start the update:', failure)
        }
      })
      if (!app.isPackaged) return
      let failed = false
      try {
        failed = !blocked && settleUpdates(bundle)
      } catch (failure) {
        console.error('Could not clean up an earlier update:', failure)
      }
      if (failed) set({ kind: 'failed', message: 'The last update did not install, so BetterGit kept the version you had. Download it from the releases page.' })
      setTimeout(() => void check(false), 5000)
      setInterval(() => void check(false), DAY)
    },
  }
}
