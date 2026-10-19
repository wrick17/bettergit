import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BetterGitApi } from '../../preload'
import { Icon, useTooltip } from './Icons'
import { useEditorLaunch, type SelectedApp } from './editor-launch'
import { cachedAppIcon, cachedApps, fetchApps, loadAppIcon, subscribeApps } from './app-icons'

type AppKind = Parameters<BetterGitApi['listApps']>[0]
type InstalledApp = Awaited<ReturnType<BetterGitApi['listApps']>>[number]

const api = window.bettergit

// The setting each kind's list was last fetched for. A saved app that is gone rescans once, not on every render.
const listedFor = new Map<AppKind, string | undefined>()

// Ids match the main process defaults, so the button names the app that the launch really opens.
const FALLBACK = { editor: { id: 'vscode', name: 'VS Code', icon: 'code' }, terminal: { id: 'terminal', name: 'Terminal', icon: 'terminal' } } as const

// The chosen app, or the default (VS Code or Terminal) when the setting is unset or names a removed app.
function pick(kind: AppKind, list: InstalledApp[] | undefined, id: string | undefined) {
  return list?.find((app) => app.id === id) ?? list?.find((app) => app.id === FALLBACK[kind].id)
}

// The chosen app's name and icon. The name is the default's until the app list loads.
export function useSelectedApp(kind: AppKind, appId: string | undefined, onError: (error: unknown) => void): SelectedApp {
  // Settings' rescans and picked apps update the shared list, so the toolbar re-resolves the choice without a refetch.
  const snapshot = () => cachedApps(kind)
  const list = useSyncExternalStore(subscribeApps, snapshot, snapshot)
  const app = pick(kind, list, appId)
  const [icon, setIcon] = useState(() => (app ? cachedAppIcon(app.path) : undefined) ?? null)

  // A setting that names an app missing from the cached list (a custom app added since) refetches the list, once per setting.
  useEffect(() => {
    if (list && (!appId || list.some((entry) => entry.id === appId) || listedFor.get(kind) === appId)) return
    listedFor.set(kind, appId)
    fetchApps(kind).catch(onError)
  }, [kind, appId, list])

  useEffect(() => {
    if (!app) return setIcon(null)
    const cached = cachedAppIcon(app.path)
    if (cached !== undefined) return setIcon(cached)
    setIcon(null)
    let live = true
    loadAppIcon(app.path).then((url) => { if (live) setIcon(url) })
    return () => { live = false }
  }, [app?.path])

  return { name: app?.name ?? FALLBACK[kind].name, icon }
}

// Opens the repo in the editor or terminal chosen in Settings. The button keeps its size while the app icon loads.
export function OpenInAppButton({ kind, app, repoPath, onError }: {
  kind: AppKind
  app: SelectedApp
  repoPath: string | null
  onError: (error: unknown) => void
}) {
  const launch = useEditorLaunch(() => kind === 'editor' ? api.openInEditor(repoPath!) : api.openInTerminal(repoPath!), onError)
  const { name, icon } = app
  // cmux's chevron has more padding inside its dark app tile than VS Code's visible white tile.
  const iconSize = name === 'cmux' ? 24 : 16
  const label = launch.busy ? `Opening in ${name}…` : `Open in ${name}`
  const { handlers, tooltip } = useTooltip(label)

  return (
    <button
      type="button"
      className={`icon-button${launch.busy ? ' busy' : ''}`}
      aria-label={label}
      aria-busy={launch.busy || undefined}
      disabled={!repoPath}
      onClick={launch.open}
      {...handlers}
    >
      {launch.busy
        ? <Icon name="loader" className="action-spin" />
        : icon
          ? <img src={icon} alt="" width={iconSize} height={iconSize} draggable={false} />
          : <Icon name={FALLBACK[kind].icon} />}
      {tooltip}
    </button>
  )
}
