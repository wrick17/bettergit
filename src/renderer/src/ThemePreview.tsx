import type { CSSProperties } from 'react'
import { fileIconId, PREVIEW_FILES, themeVariables, tokenColor, type ColorTheme, type IconMaps, type IconTheme } from '../../shared/themes'
import './theme-preview.css'

// Opaque stand-ins for the built-in glass values, for app variables a theme leaves unset. The card sits on whatever the
// app shows, so it cannot inherit the app's own values.
const BUILT_IN: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    '--window': '#eceef3', '--list': '#f6f7fa', '--content': '#ffffff', '--text': '#111114', '--text-2': '#3f3f47', '--text-3': '#65656e',
    '--hover': 'rgba(20, 26, 44, 0.05)', '--accent-fill': '#0067d0', '--on-accent': '#ffffff', '--add': '#17803a', '--del': '#c12c26',
    '--mod': '#9a5a00', '--add-bg': 'rgba(52, 199, 89, 0.14)', '--del-bg': 'rgba(255, 59, 48, 0.1)',
  },
  dark: {
    '--window': '#16171c', '--list': '#111216', '--content': '#0b0c0f', '--text': '#f5f5f8', '--text-2': '#d6d6de', '--text-3': '#a2a2ac',
    '--hover': 'rgba(255, 255, 255, 0.055)', '--accent-fill': '#0a6ad0', '--on-accent': '#ffffff', '--add': '#4cd964', '--del': '#ff6961',
    '--mod': '#ffb340', '--add-bg': 'rgba(48, 209, 88, 0.15)', '--del-bg': 'rgba(255, 69, 58, 0.14)',
  },
}

// Sample code as [text, TextMate scope] pieces, coloured by the theme's token rules.
const CODE: [string, string?][][] = [
  [['// Pull, then show what changed', 'comment.line.double-slash']],
  [['import', 'keyword.control.import'], [' { fetch } '], ['from', 'keyword.control.from'], [' '], ["'./git'", 'string.quoted.single']],
  [['export', 'keyword.control.export'], [' '], ['async', 'storage.modifier.async'], [' '], ['function', 'storage.type.function'], [' '], ['pull', 'entity.name.function'], ['('], ['depth', 'variable.parameter'], [' = '], ['1', 'constant.numeric'], [') {']],
  [['  '], ['return', 'keyword.control.flow'], [' '], ['fetch', 'entity.name.function'], ['('], ['true', 'constant.language.boolean'], [', depth)']],
  [['}']],
]

// A small BetterGit window painted with a colour theme: what its colours become here, through the same mapping as applying it.
export function ColorPreview({ theme }: { theme: ColorTheme }) {
  const style = { ...BUILT_IN[theme.dark ? 'dark' : 'light'], ...themeVariables(theme.colors, theme.dark) } as CSSProperties
  const code = theme.colors['editor.foreground'] ?? theme.colors.foreground
  return (
    <figure className="theme-preview">
      <figcaption>{theme.label}<small>{theme.dark ? 'Dark' : 'Light'}</small></figcaption>
      <div className="tp-window" style={style} aria-hidden="true">
        <div className="tp-side">
          <small>Branches</small>
          <span className="tp-row tp-selected">main</span>
          <span className="tp-row tp-hover">feature/themes</span>
          <span className="tp-row">release</span>
        </div>
        <div className="tp-main">
          <span className="tp-row"><b className="tp-mod">M</b>src/styles.css</span>
          <span className="tp-row"><b className="tp-add">A</b>src/ThemePreview.tsx</span>
          <span className="tp-row"><b className="tp-del">D</b>src/old.ts</span>
          <code className="tp-diff tp-diff-del">- const theme = 'light'</code>
          <code className="tp-diff tp-diff-add">+ const theme = pickTheme()</code>
          <pre className="tp-code" style={{ color: code }}>
            {CODE.map((line, index) => (
              <span key={index}>
                {line.map(([piece, scope], at) => <span key={at} style={scope ? { color: tokenColor(theme.tokenColors, scope) } : undefined}>{piece}</span>)}
                {'\n'}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </figure>
  )
}

// An icon id for the light or dark appearance.
type Choose = (light: boolean) => string | undefined

const hasIcon = (theme: IconTheme, id: string | undefined): id is string => !!id && Object.hasOwn(theme.icons, id)

// One icon from the theme, drawn for both appearances like FileIcon, so the stylesheet shows the right one. Empty when the
// theme has no image for it, where BetterGit would use its built-in icon.
function Icon({ theme, choose }: { theme: IconTheme; choose: Choose }) {
  const dark = choose(false)
  if (!hasIcon(theme, dark)) return <span className="tp-icon" />
  const light = choose(true)
  const image = (id: string, mode = '') => <img src={theme.icons[id]} alt="" className={`tp-icon${mode}`} width={16} height={16} draggable={false} />
  return !hasIcon(theme, light) || theme.icons[light] === theme.icons[dark] ? image(dark) : <>{image(dark, ' icon-dark')}{image(light, ' icon-light')}</>
}

const FOLDERS: [string, (keyof IconMaps)[]][] = [['src', ['folder']], ['src (open)', ['folderExpanded', 'folder']], ['repository', ['rootFolder', 'folder']]]

export function IconPreview({ theme, label }: { theme: IconTheme; label: string }) {
  const folder = (keys: (keyof IconMaps)[]): Choose => (light) =>
    keys.flatMap((key) => (light ? [theme.light, theme] : [theme]).map((map) => map[key] as string | undefined)).find((id) => hasIcon(theme, id))
  const items: [string, Choose][] = [
    ...FOLDERS.map(([name, keys]): [string, Choose] => [name, folder(keys)]),
    ...PREVIEW_FILES.map(([name, language]): [string, Choose] => [name, (light) => fileIconId(theme, name, language, light)]),
  ]
  const missing = items.filter(([, choose]) => !hasIcon(theme, choose(false))).length
  const notes = [
    missing > 0 && `${missing} of ${items.length} would use BetterGit's built-in icons.`,
    theme.fontIcons > 0 && `${theme.fontIcons} icons come from an icon font, which BetterGit does not load.`,
  ].filter(Boolean)
  return (
    <figure className="theme-preview">
      <figcaption>{label}<small>File icons</small></figcaption>
      <ul className="tp-icons">
        {items.map(([name, choose]) => <li key={name}><Icon theme={theme} choose={choose} />{name}</li>)}
      </ul>
      {notes.length > 0 && <small className="settings-note">{notes.join(' ')}</small>}
    </figure>
  )
}
