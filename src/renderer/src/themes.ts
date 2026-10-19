import { useSyncExternalStore } from 'react'
import type { ThemeMode } from '../../main/config'
import type { Appearance } from '../../shared/editors'
import { themeCss, type ColorTheme, type IconTheme } from '../../shared/themes'
import { setSyntaxThemes } from './highlight'

const api = window.bettergit
const MODE_KEY = 'bettergit.themeMode'
// The applied colour themes, so the next launch paints them before the config and the theme files arrive.
const THEMES_KEY = 'bettergit.colorThemes'

// Loaded themes by ref; null when missing or broken. Only the chosen themes load at launch. Settings warms the installed
// ones while idle, and a picker loads its own on focus or press, so most picks apply on the next frame.
const colorThemes = new Map<string, ColorTheme | null>()
const iconThemes = new Map<string, IconTheme | null>()
const loading = new Map<string, Promise<void>>()

function load(kind: 'color' | 'icons', ref: string): Promise<void> {
  const key = `${kind}:${ref}`
  let pending = loading.get(key)
  if (!pending) {
    const request: Promise<ColorTheme | IconTheme | null> = kind === 'color' ? api.colorTheme(ref) : api.iconTheme(ref)
    pending = request.catch((error: unknown) => {
      console.warn(`Theme ${ref} did not load:`, error)
      return null
    }).then((theme) => {
      if (kind === 'color') colorThemes.set(ref, theme as ColorTheme | null)
      else iconThemes.set(ref, theme as IconTheme | null)
      loading.delete(key)
    })
    loading.set(key, pending)
  }
  return pending
}

const cacheOf = (kind: 'color' | 'icons'): Map<string, unknown> => (kind === 'color' ? colorThemes : iconThemes)

export function preloadThemes(kind: 'color' | 'icons', refs: string[]) {
  for (const ref of refs) if (!cacheOf(kind).has(ref)) void load(kind, ref)
}

// Loads themes one at a time while the page is idle. Returns a function that stops it.
export function warmThemes(themes: { kind: 'color' | 'icons'; ref: string }[]): () => void {
  let stopped = false
  const next = () => {
    const theme = themes.find(({ kind, ref }) => !cacheOf(kind).has(ref))
    if (!stopped && theme) requestIdleCallback(() => { if (!stopped) void load(theme.kind, theme.ref).then(next) })
  }
  next()
  return () => { stopped = true }
}

// A ref that was asked for and could not load: missing, refused by a cap, or broken.
export const isThemeBroken = (kind: 'color' | 'icons', ref: string) => cacheOf(kind).get(ref) === null

// After an extension is reinstalled or removed, its themes load again on next use.
export function forgetThemes(id: string) {
  for (const cache of [colorThemes, iconThemes]) {
    for (const ref of cache.keys()) if (ref.startsWith(`${id}/`)) cache.delete(ref)
  }
}

// The icon theme FileIcon draws from, and whether the first themes asked for have applied: the app holds its first frame
// until then, so files never show the built-in icons and then swap.
let icons: IconTheme | null = null
let ready = false
// The refs on screen now, per picker. A picker shows these, not a pick still loading, so it never claims a theme that is
// not painted yet.
export type AppliedThemes = Pick<Appearance, 'lightTheme' | 'darkTheme' | 'iconTheme'>
let applied: AppliedThemes = { lightTheme: '', darkTheme: '', iconTheme: '' }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const useIconTheme = () => useSyncExternalStore(subscribe, () => icons)
export const useThemesReady = () => useSyncExternalStore(subscribe, () => ready)
export const useAppliedThemes = () => useSyncExternalStore(subscribe, () => applied)

function paintColours(light: ColorTheme | null, dark: ColorTheme | null) {
  const css = themeCss(light, dark)
  let style = document.getElementById('extension-theme')
  if (!css) return style?.remove()
  if (!style) {
    style = Object.assign(document.createElement('style'), { id: 'extension-theme' })
    document.head.append(style)
  }
  if (style.textContent !== css) style.textContent = css
}

let saved = ''
// One turn per kind: only the latest request of a kind may paint, so a slow earlier load never covers a newer pick.
let colourTurn = 0
let iconTurn = 0
let coloursApplied = false
let iconsApplied = false

// Runs `then` at once when every ref is loaded, otherwise once they have loaded.
function whenLoaded(kind: 'color' | 'icons', refs: string[], then: () => void) {
  const missing = refs.filter((ref) => ref && !cacheOf(kind).has(ref))
  if (!missing.length) then()
  else void Promise.all(missing.map((ref) => load(kind, ref))).then(then)
}

function publish(patch: Partial<AppliedThemes>) {
  if (Object.entries(patch).some(([key, ref]) => applied[key as keyof AppliedThemes] !== ref)) applied = { ...applied, ...patch }
  ready = coloursApplied && iconsApplied
  listeners.forEach((listener) => listener())
}

// Colour themes and the icon theme apply on their own, each as soon as its themes are loaded: in the same task when
// they are cached.
export function applyThemes({ lightTheme, darkTheme, iconTheme }: Appearance) {
  const colour = ++colourTurn
  whenLoaded('color', [lightTheme, darkTheme], () => {
    if (colour !== colourTurn) return
    const light = (lightTheme && colorThemes.get(lightTheme)) || null
    const dark = (darkTheme && colorThemes.get(darkTheme)) || null
    paintColours(light, dark)
    setSyntaxThemes(light, dark)
    const key = `${light?.name ?? ''}|${dark?.name ?? ''}`
    if (key !== saved) {
      saved = key
      if (light || dark) localStorage.setItem(THEMES_KEY, JSON.stringify({ light, dark }))
      else localStorage.removeItem(THEMES_KEY)
    }
    coloursApplied = true
    publish({ lightTheme, darkTheme })
  })
  const icon = ++iconTurn
  whenLoaded('icons', [iconTheme], () => {
    if (icon !== iconTurn) return
    icons = (iconTheme && iconThemes.get(iconTheme)) || null
    iconsApplied = true
    publish({ iconTheme })
  })
}

export function applyMode(mode: ThemeMode) {
  localStorage.setItem(MODE_KEY, mode)
  document.documentElement.dataset.theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode
}

// Before the first render: the last launch's mode and colour themes, so the page never paints in the built-in look first.
export function restoreTheme() {
  const mode = localStorage.getItem(MODE_KEY)
  if (mode === 'system' || mode === 'light' || mode === 'dark') applyMode(mode)
  try {
    const { light = null, dark = null } = JSON.parse(localStorage.getItem(THEMES_KEY) ?? '{}') as { light?: ColorTheme | null; dark?: ColorTheme | null }
    paintColours(light, dark)
    setSyntaxThemes(light, dark)
    saved = `${light?.name ?? ''}|${dark?.name ?? ''}`
  } catch {
    localStorage.removeItem(THEMES_KEY)
  }
}
