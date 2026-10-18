// Editors that files and repos can open in. Each entry is a macOS app found by bundle ID, so no CLI has to be on PATH.
export const EDITORS = {
  vscode: { label: 'VS Code', bundleId: 'com.microsoft.VSCode' },
} as const

export type EditorId = keyof typeof EDITORS

export const DEFAULT_EDITOR: EditorId = 'vscode'

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EDITORS, value)
}
