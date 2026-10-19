import { DEFAULT_APPEARANCE, type Appearance } from '../../shared/editors'
import { applyThemes } from './themes'

// Empty is the system monospace font (SF Mono). The rest fall back through --font-code when not installed.
export const CODE_FONTS = [
  { value: 'JetBrains Mono', label: 'JetBrains Mono (default)' },
  { value: '', label: 'System (SF Mono)' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
]

export const UI_FONT_SIZES = { min: 11, max: 16 }
export const CODE_FONT_SIZES = { min: 10, max: 18 }

const clamp = (value: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

export function resolveAppearance(saved: Partial<Appearance> | undefined): Appearance {
  const source = saved ?? {}
  return {
    uiFontSize: clamp(source.uiFontSize, UI_FONT_SIZES, DEFAULT_APPEARANCE.uiFontSize),
    codeFontSize: clamp(source.codeFontSize, CODE_FONT_SIZES, DEFAULT_APPEARANCE.codeFontSize),
    codeFont: CODE_FONTS.some((font) => font.value === source.codeFont) ? source.codeFont! : DEFAULT_APPEARANCE.codeFont,
    density: source.density === 'compact' || source.density === 'comfortable' ? source.density : DEFAULT_APPEARANCE.density,
    lightTheme: typeof source.lightTheme === 'string' ? source.lightTheme : '',
    darkTheme: typeof source.darkTheme === 'string' ? source.darkTheme : '',
    iconTheme: typeof source.iconTheme === 'string' ? source.iconTheme : '',
  }
}

// Writes CSS variables, attributes and the theme sheet on :root only, so a change restyles the page without re-rendering any view.
export function applyAppearance(saved: Partial<Appearance> | undefined) {
  const appearance = resolveAppearance(saved)
  const root = document.documentElement
  // UI text sizes in styles.css are offsets from the default, so every size keeps its place in the hierarchy.
  root.style.setProperty('--ui-delta', `${appearance.uiFontSize - DEFAULT_APPEARANCE.uiFontSize}px`)
  root.style.setProperty('--code-size', `${appearance.codeFontSize}px`)
  root.style.setProperty('--code-font', appearance.codeFont ? `'${appearance.codeFont}'` : 'ui-monospace')
  root.dataset.density = appearance.density
  applyThemes(appearance)
}

// A canvas test: a font that is not installed falls back to serif and measures the same as serif.
const installed = new Map<string, boolean>()
export function isFontInstalled(family: string): boolean {
  // JetBrains Mono ships with the app (@fontsource), and the system font always exists.
  if (!family || family === 'JetBrains Mono') return true
  let found = installed.get(family)
  if (found === undefined) {
    const context = document.createElement('canvas').getContext('2d')!
    const sample = 'mmmmmmmmmmlliWW00'
    context.font = '32px serif'
    const serif = context.measureText(sample).width
    context.font = `32px '${family}', serif`
    found = context.measureText(sample).width !== serif
    installed.set(family, found)
  }
  return found
}
