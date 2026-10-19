// Colour and file icon themes from VS Code extensions, as the main process hands them to the renderer.
// Extensions are untrusted: main keeps only hex colours, scope strings and image data URLs, so nothing here can carry markup or code.

export interface TokenRule {
  scope?: string | string[]
  settings: { foreground?: string }
}

export interface ColorTheme {
  // The ref plus the extension version, so a reinstalled theme is never mistaken for the copy it replaced.
  name: string
  label: string
  dark: boolean
  colors: Record<string, string>
  tokenColors: TokenRule[]
}

export interface IconMaps {
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  languageIds: Record<string, string>
}

export interface IconTheme extends IconMaps {
  name: string
  light: IconMaps
  // Icon id to a data URL. Ids with no usable image are missing, so lookups fall through to the built-in icons.
  icons: Record<string, string>
  // Icons drawn from an icon font, which BetterGit does not load.
  fontIcons: number
}

// A theme an extension contributes. `ref` is `<extension id>/<path in the extension>`.
export interface ThemeChoice {
  ref: string
  label: string
  dark?: boolean
}

export interface InstalledExtension {
  id: string
  name: string
  publisher: string
  version: string
  description: string
  themes: ThemeChoice[]
  iconThemes: ThemeChoice[]
}

export interface ExtensionResult {
  namespace: string
  name: string
  displayName: string
  description: string
  version: string
  downloads: number
}

// An Open VSX extension's themes, loaded before install. Each list lines up with the extension's choices; null where one
// failed to load.
export interface ExtensionPreview {
  extension: InstalledExtension
  colorThemes: (ColorTheme | null)[]
  iconThemes: (IconTheme | null)[]
}

// The files an icon theme preview shows, with their VS Code language ids.
export const PREVIEW_FILES: [string, string | null][] = [
  ['package.json', 'json'], ['README.md', 'markdown'], ['index.ts', 'typescript'], ['App.tsx', 'typescriptreact'],
  ['main.js', 'javascript'], ['styles.css', 'css'], ['index.html', 'html'], ['config.yml', 'yaml'], ['main.py', 'python'],
  ['main.go', 'go'], ['lib.rs', 'rust'], ['build.sh', 'shellscript'], ['Dockerfile', 'dockerfile'], ['.gitignore', 'ignore'],
  ['logo.svg', null], ['notes.txt', 'plaintext'],
]

// The foreground VS Code would most likely give `scope`: the rule whose selector matches the most of it, the later rule
// on a tie. shortcut: parent selectors ("a b") and exclusions are skipped; it only colours the preview's sample code.
export function tokenColor(rules: TokenRule[], scope: string): string | undefined {
  let best: string | undefined
  let bestLength = 0
  for (const rule of rules) {
    if (!rule.settings.foreground || !rule.scope) continue
    const selectors = (Array.isArray(rule.scope) ? rule.scope : [rule.scope]).flatMap((entry) => entry.split(',')).map((entry) => entry.trim())
    for (const selector of selectors) {
      if (selector && !selector.includes(' ') && (scope === selector || scope.startsWith(`${selector}.`)) && selector.length >= bestLength) {
        best = rule.settings.foreground
        bestLength = selector.length
      }
    }
  }
  return best
}

export const isHexColor =(value: unknown): value is string =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)

// App variable to the workbench colours that can fill it, best first. A variable the theme cannot fill keeps the built-in
// value, so translucent overlays (lines, hovers, chips) still work on any background.
const VARIABLES: [string, string[]][] = [
  ['--window', ['titleBar.activeBackground', 'sideBar.background', 'editor.background']],
  ['--glass-fill', ['sideBar.background', 'editor.background']],
  ['--content', ['editor.background']],
  ['--list', ['sideBar.background', 'editor.background']],
  ['--glass-strong', ['editorWidget.background', 'menu.background', 'dropdown.background', 'sideBar.background', 'editor.background']],
  ['--sunken', ['input.background']],
  ['--text', ['foreground', 'editor.foreground']],
  ['--text-2', ['editor.foreground', 'foreground']],
  ['--text-3', ['descriptionForeground']],
  ['--hover', ['list.hoverBackground']],
  ['--idle-selection', ['list.inactiveSelectionBackground']],
  ['--accent', ['textLink.foreground', 'focusBorder', 'button.background']],
  // The focus colour, not the button colour: it fills selected rows, and some themes' buttons are green or grey.
  ['--accent-fill', ['focusBorder', 'button.background']],
  ['--add', ['gitDecoration.addedResourceForeground', 'terminal.ansiGreen']],
  ['--del', ['gitDecoration.deletedResourceForeground', 'terminal.ansiRed']],
  ['--mod', ['gitDecoration.modifiedResourceForeground', 'terminal.ansiYellow']],
  ['--ren', ['gitDecoration.renamedResourceForeground', 'terminal.ansiCyan']],
  ['--add-bg', ['diffEditor.insertedLineBackground', 'diffEditor.insertedTextBackground']],
  ['--del-bg', ['diffEditor.removedLineBackground', 'diffEditor.removedTextBackground']],
  ['--find-match', ['editor.findMatchHighlightBackground']],
]

export function themeVariables(colors: Record<string, string>, dark: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [variable, keys] of VARIABLES) {
    const key = keys.find((name) => Object.hasOwn(colors, name) && isHexColor(colors[name]))
    if (key) out[variable] = colors[key]
  }
  if (out['--accent-fill']) {
    out['--accent-soft'] = `color-mix(in srgb, var(--accent-fill) ${dark ? 30 : 14}%, transparent)`
    out['--on-accent'] = luminance(out['--accent-fill']) < 0.179 ? '#ffffff' : '#111114'
  }
  return out
}

// WCAG relative luminance of a hex colour, alpha ignored. Below 0.179, white text contrasts more than black.
function luminance(hex: string): number {
  const digits = hex.length <= 5 ? [...hex.slice(1, 4)].map((digit) => digit + digit) : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
  const [r, g, b] = digits.map((pair) => {
    const channel = parseInt(pair, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// One rule per appearance. The doubled :root outranks the built-in theme blocks wherever this sheet lands in the page.
export function themeCss(light: ColorTheme | null, dark: ColorTheme | null): string {
  const block = (mode: 'light' | 'dark', theme: ColorTheme | null) => {
    const variables = Object.entries(theme ? themeVariables(theme.colors, mode === 'dark') : {})
    return variables.length ? `:root:root[data-theme='${mode}'] { ${variables.map(([name, value]) => `${name}: ${value};`).join(' ')} }` : ''
  }
  return [block('light', light), block('dark', dark)].filter(Boolean).join('\n')
}

const own = (map: Record<string, string>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined)

// The icon id VS Code would show for a file: its name, then its extensions longest first ("d.ts" before "ts"), then its
// language, then the theme's default. Within each step the light override wins in light mode.
export function fileIconId(theme: IconTheme, fileName: string, languageId: string | null, light: boolean): string | undefined {
  const name = fileName.toLowerCase()
  const maps = light ? [theme.light, theme] : [theme]
  const pick = (lookup: (map: IconMaps) => string | undefined) => maps.map(lookup).find(Boolean)
  const extensions = name.split('.').slice(1).map((_, index, parts) => parts.slice(index).join('.'))
  return pick((map) => own(map.fileNames, name))
    ?? extensions.map((extension) => pick((map) => own(map.fileExtensions, extension))).find(Boolean)
    ?? (languageId ? pick((map) => own(map.languageIds, languageId)) : undefined)
    ?? pick((map) => map.file)
}
