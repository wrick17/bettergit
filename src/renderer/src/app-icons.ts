import type { AppKind, InstalledApp } from '../../shared/editors'

// App icons as data URLs, loaded once per app path and kept for the session. A miss is not kept: the button shows the
// generic glyph, and its next mount or app change asks again, so one failed Quick Look call never hides an icon for good.
const icons = new Map<string, string>()
const requests = new Map<string, Promise<string | null>>()

export const cachedAppIcon = (path: string) => icons.get(path)

export function loadAppIcon(path: string): Promise<string | null> {
  let request = requests.get(path)
  if (!request) {
    request = window.bettergit.appIcon(path).catch(() => null).then((url) => {
      if (url) icons.set(path, url)
      else requests.delete(path)
      return url
    })
    requests.set(path, request)
  }
  return request
}

// The installed apps per kind, shared by the toolbar and Settings, so a rescan or a picked app reaches every subscriber.
// Module-level, so a repo switch (which remounts the toolbar) shows the app icon at once, with no generic-icon flash.
const appLists = new Map<AppKind, InstalledApp[]>()
const listeners = new Set<() => void>()

export const cachedApps = (kind: AppKind) => appLists.get(kind)

export function subscribeApps(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function storeApps(kind: AppKind, list: InstalledApp[]) {
  appLists.set(kind, list)
  for (const listener of listeners) listener()
}

export function fetchApps(kind: AppKind): Promise<InstalledApp[]> {
  return window.bettergit.listApps(kind).then((list) => { storeApps(kind, list); return list })
}
