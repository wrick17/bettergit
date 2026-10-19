import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KNOWN_APPS, type AppKind, type InstalledApp } from '../shared/editors'

// Searched in order. The first copy of an app wins.
const appDirs = () => [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
  '/Applications/Utilities',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications', 'JetBrains Toolbox'),
]

const BY_BUNDLE = new Map(KNOWN_APPS.flatMap((known) => known.bundles.map((bundle) => [bundle.toLowerCase(), known] as const)))

// One directory read per folder, so detection never walks app bundles. Missing folders are skipped.
export async function detectApps(dirs = appDirs()): Promise<InstalledApp[]> {
  const listings = await Promise.all(dirs.map((dir) => fs.readdir(dir).catch(() => [] as string[])))
  const found = new Map<string, InstalledApp>()
  dirs.forEach((dir, index) => {
    for (const name of listings[index]) {
      const known = BY_BUNDLE.get(name.toLowerCase())
      if (known && !found.has(known.id)) found.set(known.id, { id: known.id, name: known.name, path: path.join(dir, name), kind: known.kind })
    }
  })
  return [...found.values()]
}

let detected: Promise<InstalledApp[]> | null = null

// Cached for the process. A refresh rescans, so apps installed since show up.
export function installedApps(refresh = false): Promise<InstalledApp[]> {
  if (refresh || !detected) detected = detectApps()
  return detected
}

// Detected apps win over a custom entry with the same path.
export function mergeApps(found: readonly InstalledApp[], custom: readonly InstalledApp[], kind: AppKind): InstalledApp[] {
  const apps = [...found, ...custom].filter((entry) => entry.kind === kind)
  return apps.filter((entry, index) => apps.findIndex((other) => other.path === entry.path) === index)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const DEFAULTS: Record<AppKind, InstalledApp> = {
  editor: { id: 'vscode', name: 'VS Code', path: '/Applications/Visual Studio Code.app', kind: 'editor' },
  terminal: { id: 'terminal', name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app', kind: 'terminal' },
}

// The selected app, or the default when it is unset or no longer installed.
export async function resolveApp(kind: AppKind, id: string | undefined, custom: readonly InstalledApp[]): Promise<InstalledApp> {
  const apps = mergeApps(await installedApps(), custom, kind)
  const chosen = apps.find((entry) => entry.id === id)
  if (chosen && await (chosen.custom ? isAppBundle(chosen.path) : fs.stat(chosen.path).then(() => true, () => false))) return chosen
  return apps.find((entry) => entry.id === DEFAULTS[kind].id) ?? DEFAULTS[kind]
}

// A real .app bundle folder, not a symlink to one, so a retargeted link can never stand in for an approved app.
export async function isAppBundle(appPath: string): Promise<boolean> {
  if (!path.isAbsolute(appPath) || !appPath.endsWith('.app')) return false
  try {
    return await fs.realpath(appPath) === appPath && (await fs.stat(appPath)).isDirectory()
      && (await fs.stat(path.join(appPath, 'Contents', 'Info.plist'))).isFile()
  } catch {
    return false
  }
}

// A path from the open dialog, stored by its real path. Only an existing .app bundle is accepted.
export async function customApp(kind: AppKind, appPath: string): Promise<InstalledApp> {
  const real = typeof appPath === 'string' && path.isAbsolute(appPath) ? await fs.realpath(appPath).catch(() => '') : ''
  if (!real || !await isAppBundle(real)) throw new Error('Choose an application bundle (.app).')
  return { id: `custom:${kind}:${real}`, name: path.basename(real, '.app'), path: real, kind, custom: true }
}

// Shape check for custom apps read back from config.
export function isCustomApp(value: unknown): value is InstalledApp {
  const entry = value as Partial<InstalledApp> | null
  return typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && typeof entry.name === 'string'
    && typeof entry.path === 'string' && path.isAbsolute(entry.path) && entry.path.endsWith('.app')
    && (entry.kind === 'editor' || entry.kind === 'terminal') && entry.id === `custom:${entry.kind}:${entry.path}`
}
