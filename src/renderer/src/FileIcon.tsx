import { fileIconId, type IconMaps, type IconTheme } from '../../shared/themes'
import { FILE_ICONS, type FileIconName } from './file-icons'
import { languageFor } from './highlight'
import { useIconTheme } from './themes'

// A Map, not an object, so names like `constructor` are not mistaken for extensions.
const EXTENSIONS = new Map<string, FileIconName>()
function register(extensions: string[], icon: FileIconName) {
  for (const extension of extensions) EXTENSIONS.set(extension, icon)
}
register(['ts', 'mts', 'cts'], 'file-type-typescript-official')
register(['tsx'], 'file-type-reactts')
register(['js', 'mjs', 'cjs'], 'file-type-js-official')
register(['jsx'], 'file-type-reactjs')
register(['json', 'jsonc'], 'file-type-json-official')
register(['md', 'markdown'], 'file-type-markdown')
register(['css'], 'file-type-css')
register(['scss'], 'file-type-scss')
register(['html', 'htm'], 'file-type-html')
register(['swift'], 'file-type-swift')
register(['rs'], 'file-type-rust')
register(['py'], 'file-type-python')
register(['go'], 'file-type-go')
register(['sh', 'bash', 'zsh'], 'file-type-shell')
register(['yml', 'yaml'], 'file-type-yaml-official')
register(['toml'], 'file-type-toml')
register(['xml'], 'file-type-xml')
register(['sql'], 'file-type-sql')
register(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'], 'file-type-image')
register(['txt'], 'file-type-text')

// No lock-file icon exists in the set, so every lock file uses the plain-text icon.
function iconFor(name: string): FileIconName {
  if (name === 'package.json') return 'file-type-npm'
  if (name.startsWith('tsconfig')) return 'file-type-tsconfig-official'
  if (name.startsWith('.git')) return 'file-type-git'
  if (name.endsWith('.lock') || name.includes('-lock.')) return 'file-type-text'
  const dot = name.lastIndexOf('.')
  return (dot < 0 ? undefined : EXTENSIONS.get(name.slice(dot + 1).toLowerCase())) ?? 'default-file'
}

// VS Code language ids where they differ from Shiki's, for icon themes that pick icons by language.
const VSCODE_LANGUAGES: Record<string, string> = { tsx: 'typescriptreact', jsx: 'javascriptreact', shell: 'shellscript' }

const hasIcon = (theme: IconTheme, id: string | undefined): id is string => !!id && Object.hasOwn(theme.icons, id)

// An icon from the chosen icon theme; callers check it has one. When the theme's light icon differs, both are drawn and the
// stylesheet shows the one for the current appearance, so switching light and dark needs no re-render.
function ThemeIcon({ theme, pick, className, size }: { theme: IconTheme; pick: (light: boolean) => string | undefined; className: string; size: number }) {
  const url = (id: string | undefined) => (hasIcon(theme, id) ? theme.icons[id] : undefined)
  const dark = url(pick(false))!
  const light = url(pick(true)) ?? dark
  const image = (src: string, mode = '') => <img src={src} alt="" aria-hidden="true" className={`${className}${mode}`} width={size} height={size} draggable={false} />
  return light === dark ? image(dark) : <>{image(dark, ' icon-dark')}{image(light, ' icon-light')}</>
}

export function FileIcon({ name }: { name: string }) {
  const theme = useIconTheme()
  if (theme) {
    const language = languageFor(name, {})
    const languageId = language && (VSCODE_LANGUAGES[language] ?? language)
    const pick = (light: boolean) => fileIconId(theme, name, languageId, light)
    if (hasIcon(theme, pick(false))) return <ThemeIcon theme={theme} pick={pick} className="file-icon" size={15} />
  }
  const svg = FILE_ICONS[iconFor(name)]
  return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt="" aria-hidden="true" className="file-icon" width={15} height={15} />
}

// Folder rows and repo rows share the file tree's vscode-icons set; a repo uses the git folder. An icon theme's root
// folder icons stand for repos.
export function FolderIcon({ open = false, repo = false }: { open?: boolean; repo?: boolean }) {
  const theme = useIconTheme()
  if (theme) {
    const pick = (light: boolean) => {
      const maps: IconMaps[] = light ? [theme.light, theme] : [theme]
      const keys = (repo ? (open ? ['rootFolderExpanded', 'rootFolder'] : ['rootFolder']) : []).concat(open ? ['folderExpanded', 'folder'] : ['folder']) as (keyof IconMaps)[]
      return keys.flatMap((key) => maps.map((map) => map[key] as string | undefined)).find((id) => hasIcon(theme, id))
    }
    if (pick(false)) return <ThemeIcon theme={theme} pick={pick} className="folder-icon" size={14} />
  }
  const name: FileIconName = repo
    ? (open ? 'folder-type-git-opened' : 'folder-type-git')
    : (open ? 'default-folder-opened' : 'default-folder')
  const svg = FILE_ICONS[name]
  return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt="" aria-hidden="true" className="folder-icon" width={14} height={14} />
}
