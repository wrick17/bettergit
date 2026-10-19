// Editors that files and repos can open in. Each entry is a macOS app found by bundle ID, so no CLI has to be on PATH.
export const EDITORS = {
  vscode: { label: 'VS Code', bundleId: 'com.microsoft.VSCode' },
} as const

export type EditorId = keyof typeof EDITORS

export const DEFAULT_EDITOR: EditorId = 'vscode'

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EDITORS, value)
}

export type AppKind = 'editor' | 'terminal'

export interface InstalledApp {
  id: string
  name: string
  path: string
  kind: AppKind
  custom?: boolean
}

export type Density = 'compact' | 'comfortable'

export interface Appearance {
  uiFontSize: number
  codeFontSize: number
  // Empty means the system monospace font.
  codeFont: string
  // A preset name from the renderer's accent list. Empty means the theme's own accent.
  accent: string
  density: Density
}

// The app's look before appearance settings existed: bundled JetBrains Mono at 13px for code.
export const DEFAULT_APPEARANCE: Appearance = { uiFontSize: 13, codeFontSize: 13, codeFont: 'JetBrains Mono', accent: '', density: 'comfortable' }

export function isAppKind(value: unknown): value is AppKind {
  return value === 'editor' || value === 'terminal'
}

// Known macOS apps by bundle file name. Ids of EDITORS entries match, so a saved EditorId is already an app id.
export const KNOWN_APPS: ReadonlyArray<{ id: string; name: string; kind: AppKind; bundles: readonly string[] }> = [
  { id: 'vscode', name: 'VS Code', kind: 'editor', bundles: ['Visual Studio Code.app'] },
  { id: 'vscode-insiders', name: 'VS Code Insiders', kind: 'editor', bundles: ['Visual Studio Code - Insiders.app'] },
  { id: 'vscodium', name: 'VSCodium', kind: 'editor', bundles: ['VSCodium.app'] },
  { id: 'cursor', name: 'Cursor', kind: 'editor', bundles: ['Cursor.app'] },
  { id: 'windsurf', name: 'Windsurf', kind: 'editor', bundles: ['Windsurf.app'] },
  { id: 'zed', name: 'Zed', kind: 'editor', bundles: ['Zed.app', 'Zed Preview.app'] },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', bundles: ['Sublime Text.app'] },
  { id: 'nova', name: 'Nova', kind: 'editor', bundles: ['Nova.app'] },
  { id: 'bbedit', name: 'BBEdit', kind: 'editor', bundles: ['BBEdit.app'] },
  { id: 'textmate', name: 'TextMate', kind: 'editor', bundles: ['TextMate.app'] },
  { id: 'coteditor', name: 'CotEditor', kind: 'editor', bundles: ['CotEditor.app'] },
  { id: 'xcode', name: 'Xcode', kind: 'editor', bundles: ['Xcode.app', 'Xcode-beta.app'] },
  { id: 'macvim', name: 'MacVim', kind: 'editor', bundles: ['MacVim.app'] },
  { id: 'neovide', name: 'Neovide', kind: 'editor', bundles: ['Neovide.app'] },
  { id: 'fleet', name: 'Fleet', kind: 'editor', bundles: ['Fleet.app'] },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', bundles: ['WebStorm.app'] },
  { id: 'intellij', name: 'IntelliJ IDEA', kind: 'editor', bundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app'] },
  { id: 'intellij-ce', name: 'IntelliJ IDEA CE', kind: 'editor', bundles: ['IntelliJ IDEA CE.app', 'IntelliJ IDEA Community Edition.app'] },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', bundles: ['PyCharm.app', 'PyCharm Professional Edition.app', 'PyCharm CE.app', 'PyCharm Community Edition.app'] },
  { id: 'goland', name: 'GoLand', kind: 'editor', bundles: ['GoLand.app'] },
  { id: 'rubymine', name: 'RubyMine', kind: 'editor', bundles: ['RubyMine.app'] },
  { id: 'phpstorm', name: 'PhpStorm', kind: 'editor', bundles: ['PhpStorm.app'] },
  { id: 'clion', name: 'CLion', kind: 'editor', bundles: ['CLion.app'] },
  { id: 'rustrover', name: 'RustRover', kind: 'editor', bundles: ['RustRover.app'] },
  { id: 'android-studio', name: 'Android Studio', kind: 'editor', bundles: ['Android Studio.app'] },
  { id: 'kiro', name: 'Kiro', kind: 'editor', bundles: ['Kiro.app'] },
  { id: 'void', name: 'Void', kind: 'editor', bundles: ['Void.app'] },
  { id: 'trae', name: 'Trae', kind: 'editor', bundles: ['Trae.app'] },
  { id: 'terminal', name: 'Terminal', kind: 'terminal', bundles: ['Terminal.app'] },
  { id: 'iterm', name: 'iTerm', kind: 'terminal', bundles: ['iTerm.app'] },
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', bundles: ['Ghostty.app'] },
  { id: 'warp', name: 'Warp', kind: 'terminal', bundles: ['Warp.app'] },
  { id: 'wezterm', name: 'WezTerm', kind: 'terminal', bundles: ['WezTerm.app'] },
  { id: 'alacritty', name: 'Alacritty', kind: 'terminal', bundles: ['Alacritty.app'] },
  { id: 'kitty', name: 'kitty', kind: 'terminal', bundles: ['kitty.app'] },
  { id: 'hyper', name: 'Hyper', kind: 'terminal', bundles: ['Hyper.app'] },
  { id: 'tabby', name: 'Tabby', kind: 'terminal', bundles: ['Tabby.app'] },
  { id: 'rio', name: 'Rio', kind: 'terminal', bundles: ['Rio.app'] },
  { id: 'cmux', name: 'cmux', kind: 'terminal', bundles: ['cmux.app'] },
]
