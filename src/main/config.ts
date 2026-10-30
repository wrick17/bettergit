import { randomUUID } from 'node:crypto'
import { promises as fs, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_EDITOR, isEditorId, type Appearance, type EditorId, type InstalledApp } from '../shared/editors'
import { isCustomApp } from './apps'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemeMode
  backgroundFetch: boolean
  fetchIntervalMinutes: number
  batchConcurrency: number
  idleThresholdSeconds: number
  // Scales the whole window. 1 is the default size.
  textZoom: number
  // Extension (without the dot) to Shiki language id. Overrides the built-in map.
  languages: Record<string, string>
  // The app that Open in … launches. Unknown values fall back to the default.
  editor: EditorId
  // InstalledApp ids. An app that is unset or no longer installed falls back to VS Code or Terminal.
  editorApp?: string
  terminalApp?: string
  // Added only through the app picker. A config update may drop entries but never add one.
  customApps?: InstalledApp[]
  // Only the fields the user changed. The renderer fills the rest from DEFAULT_APPEARANCE.
  appearance?: Partial<Appearance>
}

// What config:update accepts. Settings fields are merged into the current settings, so a patch carries only its changes.
export type ConfigPatch = Omit<Partial<AppConfig>, 'settings'> & { settings?: Partial<Settings> }

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
    batchConcurrency: 4,
    idleThresholdSeconds: 120,
    textZoom: 1,
    languages: {},
    editor: DEFAULT_EDITOR,
    editorApp: DEFAULT_EDITOR,
    terminalApp: 'terminal',
    customApps: [],
    appearance: {},
  },
  lastCloneDirectory: null,
}

function normalizeSettings(input: unknown): Settings {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Partial<Settings>
  const languages = typeof source.languages === 'object' && source.languages !== null
    ? Object.fromEntries(Object.entries(source.languages).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  const editor = isEditorId(source.editor) ? source.editor : DEFAULT_EDITOR
  return {
    ...DEFAULT_CONFIG.settings,
    ...source,
    backgroundFetch: typeof source.backgroundFetch === 'boolean' ? source.backgroundFetch : DEFAULT_CONFIG.settings.backgroundFetch,
    // A zero or non-numeric interval would make the fetch timer spin, so only a positive number is kept.
    fetchIntervalMinutes: Number.isFinite(source.fetchIntervalMinutes) && source.fetchIntervalMinutes! > 0 ? source.fetchIntervalMinutes! : DEFAULT_CONFIG.settings.fetchIntervalMinutes,
    batchConcurrency: Number.isSafeInteger(source.batchConcurrency) && source.batchConcurrency! > 0 ? source.batchConcurrency! : DEFAULT_CONFIG.settings.batchConcurrency,
    textZoom: typeof source.textZoom === 'number' ? Math.min(1.6, Math.max(0.8, source.textZoom)) : DEFAULT_CONFIG.settings.textZoom,
    languages,
    editor,
    // Config files from before app selection carry only the editor, whose id is also its app id.
    editorApp: typeof source.editorApp === 'string' ? source.editorApp : editor,
    terminalApp: typeof source.terminalApp === 'string' ? source.terminalApp : DEFAULT_CONFIG.settings.terminalApp,
    customApps: Array.isArray(source.customApps)
      ? source.customApps.filter(isCustomApp).map(({ id, name, path, kind }) => ({ id, name, path, kind, custom: true }))
      : [],
    appearance: normalizeAppearance(source.appearance),
  }
}

const themeRef = (value: unknown) => (typeof value === 'string' && value.length <= 500 && !/[\0\n]/.test(value) ? value : undefined)

// Each field is kept only when valid, so a bad value falls back to its default alone.
function normalizeAppearance(input: unknown): Partial<Appearance> {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const size = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined
  const appearance: Partial<Appearance> = {
    uiFontSize: size(source.uiFontSize, 10, 20),
    codeFontSize: size(source.codeFontSize, 9, 24),
    // A CSS font-family list. Characters that could end the declaration are refused.
    codeFont: typeof source.codeFont === 'string' && source.codeFont.length <= 200 && !/[;{}<>\\]/.test(source.codeFont) ? source.codeFont : undefined,
    density: source.density === 'compact' || source.density === 'comfortable' ? source.density : undefined,
    // Theme refs. Loading one checks it against the installed extensions, so this only bounds the string.
    lightTheme: themeRef(source.lightTheme),
    darkTheme: themeRef(source.darkTheme),
    iconTheme: themeRef(source.iconTheme),
  }
  return Object.fromEntries(Object.entries(appearance).filter((entry) => entry[1] !== undefined))
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
