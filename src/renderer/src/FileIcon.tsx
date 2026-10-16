import { FILE_ICONS, type FileIconName } from './file-icons'

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

export function FileIcon({ name }: { name: string }) {
  const svg = FILE_ICONS[iconFor(name)]
  return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt="" aria-hidden="true" className="file-icon" width={15} height={15} />
}

// Folder rows and repo rows share the file tree's vscode-icons set; a repo uses the git folder.
export function FolderIcon({ open = false, repo = false }: { open?: boolean; repo?: boolean }) {
  const name: FileIconName = repo
    ? (open ? 'folder-type-git-opened' : 'folder-type-git')
    : (open ? 'default-folder-opened' : 'default-folder')
  const svg = FILE_ICONS[name]
  return <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt="" aria-hidden="true" className="folder-icon" width={14} height={14} />
}
