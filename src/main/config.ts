import { randomUUID } from 'node:crypto'
import { promises as fs, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeMode
  backgroundFetch: boolean
  fetchIntervalMinutes: number
  idleThresholdSeconds: number
  // Scales the whole window. 1 is the default size.
  textZoom: number
  // Extension (without the dot) to Shiki language id. Overrides the built-in map.
  languages: Record<string, string>
}

export interface RepoGroup {
  id: string
  name: string
  repos: string[]
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface AppConfig {
  // Folders and single repos added to the sidebar, in the order the user added them.
  sources: string[]
  hidden: string[]
  collapsed: string[]
  groups: RepoGroup[]
  settings: Settings
  lastCloneDirectory: string | null
  // Missing in config files written before window state was saved.
  window?: WindowState
}

export const DEFAULT_CONFIG: AppConfig = {
  sources: [],
  hidden: [],
  collapsed: [],
  groups: [],
  settings: {
    theme: 'system',
    backgroundFetch: true,
    fetchIntervalMinutes: 10,
    idleThresholdSeconds: 120,
    textZoom: 1,
    languages: {},
  },
  lastCloneDirectory: null,
}

function normalizeSettings(input: unknown): Settings {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<Settings>
  const languages = typeof source.languages === 'object' && source.languages !== null
    ? Object.fromEntries(Object.entries(source.languages).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return {
    ...DEFAULT_CONFIG.settings,
    ...source,
    textZoom: typeof source.textZoom === 'number' ? Math.min(1.6, Math.max(0.8, source.textZoom)) : DEFAULT_CONFIG.settings.textZoom,
    languages,
  }
}

// The minimums match the window's minWidth and minHeight, so a stale size is never below them.
function normalizeWindow(input: unknown): WindowState | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const { x, y, width, height, maximized } = input as Partial<WindowState>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  if (![x, y, width, height].every(Number.isFinite) || width < 480 || height < 320) return undefined
  return { x, y, width, height, maximized: maximized === true }
}

// Missing or partial fields fall back to defaults so older config files keep working.
export function normalizeConfig(input: unknown): AppConfig {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<AppConfig>
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  return {
    sources: strings(source.sources),
    hidden: strings(source.hidden),
    collapsed: strings(source.collapsed),
    groups: Array.isArray(source.groups)
      ? source.groups.filter((group): group is RepoGroup => typeof group?.id === 'string' && typeof group?.name === 'string')
        .map((group) => ({ id: group.id, name: group.name, repos: strings(group.repos) }))
      : [],
    settings: normalizeSettings(source.settings),
    lastCloneDirectory: typeof source.lastCloneDirectory === 'string' ? source.lastCloneDirectory : null,
    window: normalizeWindow(source.window),
  }
}

// A file that cannot be parsed is moved aside, never overwritten: it may hold the user's only copy.
export async function loadConfig(file: string): Promise<AppConfig> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalizeConfig(DEFAULT_CONFIG)
    throw error
  }
  try {
    return normalizeConfig(JSON.parse(text))
  } catch {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`)
    return normalizeConfig(DEFAULT_CONFIG)
  }
}

// Every async save joins this chain, so two saves never run at the same time.
let saving: Promise<void> = Promise.resolve()

// Unique temp names keep overlapping writers from renaming each other's file away.
const tempFile = (file: string) => `${file}.${process.pid}.${randomUUID()}.tmp`

export function saveConfig(file: string, config: AppConfig): Promise<void> {
  // The JSON is taken now, so each queued save writes the state it was asked to save.
  const text = JSON.stringify(config, null, 2)
  const write = saving.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = tempFile(file)
    await fs.writeFile(temp, text)
    await fs.rename(temp, file)
  })
  // A failed save must not block the saves queued after it; the caller still gets the error.
  saving = write.catch(() => {})
  return write
}

// For the quit flush, which cannot wait for the async chain.
export function saveConfigSync(file: string, config: AppConfig): void {
  const temp = tempFile(file)
  writeFileSync(temp, JSON.stringify(config, null, 2))
  renameSync(temp, file)
}
