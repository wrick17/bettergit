import { useSyncExternalStore } from 'react'
import type { ThemeMode } from '../../main/config'
import type { Appearance } from '../../shared/editors'
import { themeCss, type ColorTheme, type IconTheme, type InstalledExtension } from '../../shared/themes'
import { setSyntaxThemes } from './highlight'

const api = window.bettergit
const MODE_KEY = 'bettergit.themeMode'
// The applied colour themes, so the next launch paints them before the config and the theme files arrive.
const THEMES_KEY = 'bettergit.colorThemes'

// Loaded themes by ref; null when missing or broken. Settings loads every installed theme up front, so a pick applies on
// the next frame instead of after a round trip.
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

export function preloadThemes(extensions: InstalledExtension[]) {
  for (const extension of extensions) {
    for (const theme of extension.themes) if (!colorThemes.has(theme.ref)) void load('color', theme.ref)
    for (const theme of extension.iconThemes) if (!iconThemes.has(theme.ref)) void load('icons', theme.ref)
  }
}

// After an extension is reinstalled or removed, its themes load again on next use.
export function forgetThemes(id: string) {
  for (const cache of [colorThemes, iconThemes]) {
    for (const ref of cache.keys()) if (ref.startsWith(`${id}/`)) cache.delete(ref)
  }
}

// The icon theme FileIcon draws from, and whether the first one asked for has loaded: the app holds its first frame until
// then, so files never show the built-in icons and then swap.
let icons: IconTheme | null = null
let ready = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const useIconTheme = () => useSyncExternalStore(subscribe, () => icons)
export const useThemesReady = () => useSyncExternalStore(subscribe, () => ready)

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

let wanted: Appearance | null = null
let saved = ''

// Applies the chosen themes at once when they are loaded, or loads them first and then applies the latest choice.
export function applyThemes(appearance: Appearance) {
  wanted = appearance
  const { lightTheme, darkTheme, iconTheme } = appearance
  const missing = [
    ...[lightTheme, darkTheme].filter((ref) => ref && !colorThemes.has(ref)).map((ref) => load('color', ref)),
    ...(iconTheme && !iconThemes.has(iconTheme) ? [load('icons', iconTheme)] : []),
  ]
  if (missing.length) {
    void Promise.all(missing).then(() => { if (wanted === appearance) applyThemes(appearance) })
    return
  }
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
  const nextIcons = (iconTheme && iconThemes.get(iconTheme)) || null
  if (nextIcons !== icons || !ready) {
    icons = nextIcons
    ready = true
    listeners.forEach((listener) => listener())
  }
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
