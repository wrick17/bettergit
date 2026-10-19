import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { promises as fs } from 'node:fs'
import { isIP, isIPv4 } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileIconId, isHexColor, PREVIEW_FILES, type ColorTheme, type ExtensionPreview, type ExtensionResult, type IconMaps, type IconTheme, type InstalledExtension, type ThemeChoice, type TokenRule } from '../shared/themes'

// VS Code extensions, used only for the colour and file icon themes they contribute. An extension is untrusted input:
// its code is never unpacked, so it can never run, and every file read back must stay inside the extension's folder.

const OPEN_VSX = 'https://open-vsx.org/api'
// The API host, and the storage host its file URLs redirect to (a 302 to openvsx.eclipsecontent.org, seen 2026-10-19).
const OPEN_VSX_HOSTS = new Set(['open-vsx.org', 'openvsx.eclipsecontent.org'])
const MAX_REDIRECTS = 3
const MAX_DOWNLOAD = 50 * 1024 * 1024
const MAX_UNPACKED = 100 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_FILE = 20 * 1024 * 1024
// Theme, include and manifest JSON. The largest real one seen is 1.5 MB (vscode-icons); the cap bounds parse memory.
const MAX_JSON = 4 * 1024 * 1024
const MAX_ICON = 512 * 1024
// Caps on one icon theme, checked from the map and file sizes before any image is read. Bytes count once per icon id,
// since each id carries its own copy of the data URL to the renderer. vscode-icons, the largest seen, has 1,668 images
// in 4.4 MB.
const MAX_ICON_COUNT = 5000
const MAX_ICON_BYTES = 16 * 1024 * 1024
const READERS = 8
// Theme JSON and images only.
const KEPT = /\.(?:json|jsonc|svg|png)$/i
const PART = /^[a-z0-9][a-z0-9-]*$/i

export const isExtensionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && value.split('.').length === 2 && value.split('.').every((part) => PART.test(part))

// JSON with comments and trailing commas, as VS Code reads theme and manifest files. Text between the characters that
// matter is copied as whole slices, so parsing costs about the size of the text.
export function parseJsonc(text: string): unknown {
  const parts: string[] = []
  // The start of text not yet copied.
  let from = text.charCodeAt(0) === 0xfeff ? 1 : 0
  // Where the comment starting at `at` ends, or -1 when none starts there. An unclosed block comment runs to the end.
  const commentEnd = (at: number) => {
    if (text[at] !== '/') return -1
    if (text[at + 1] === '/') {
      const end = text.indexOf('\n', at)
      return end < 0 ? text.length : end
    }
    if (text[at + 1] !== '*') return -1
    const end = text.indexOf('*/', at + 2)
    return end < 0 ? text.length : end + 2
  }
  const special = /["/,]/g
  special.lastIndex = from
  for (let match = special.exec(text); match; match = special.exec(text)) {
    const at = match.index
    if (text[at] === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
      special.lastIndex = end + 1
    } else if (text[at] === '/') {
      const end = commentEnd(at)
      if (end < 0) continue
      parts.push(text.slice(from, at), ' ')
      special.lastIndex = from = end
    } else {
      // A comma followed only by whitespace and comments before a closing bracket is dropped.
      let next = at + 1
      for (;;) {
        while (/\s/.test(text[next] ?? '')) next++
        const end = commentEnd(next)
        if (end < 0) break
        next = end
      }
      if (text[next] === '}' || text[next] === ']') {
        parts.push(text.slice(from, at))
        from = at + 1
      }
    }
  }
  parts.push(text.slice(from))
  return JSON.parse(parts.join(''))
}

// A zip entry's path inside the extension folder, or null for anything outside `extension/` or unsafe to write.
export function entryPath(name: string): string | null {
  if (!name.startsWith('extension/')) return null
  const parts = name.slice('extension/'.length).split('/')
  return parts.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part)) ? null : parts.join('/')
}

const isInside = (root: string, target: string) => target.startsWith(root + path.sep)

// `relative` resolved from `from` (`..` included), only when its real path, symlinks followed, is inside `root`'s real path.
export async function resolveInside(root: string, from: string, relative: string): Promise<string | null> {
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(path.resolve(from, relative))])
    return isInside(realRoot, realTarget) ? realTarget : null
  } catch {
    return null
  }
}

// A .vsix is a zip. This reads stored and deflated entries from its central directory; zip64 and encryption are refused.
export function unzip(data: Buffer, keep: (name: string) => boolean): Map<string, Buffer> {
  const damaged = () => new Error('The .vsix file is damaged or not a zip archive.')
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw damaged()
  let end = data.length - 22
  while (end > 0 && end >= data.length - 22 - 0xffff && data.readUInt32LE(end) !== 0x06054b50) end--
  if (data.readUInt32LE(end) !== 0x06054b50) throw damaged()
  const count = data.readUInt16LE(end + 10)
  if (count > MAX_ENTRIES) throw new Error('The .vsix file has too many entries.')
  const files = new Map<string, Buffer>()
  let at = data.readUInt32LE(end + 16)
  let total = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw damaged()
    const flags = data.readUInt16LE(at + 8)
    const method = data.readUInt16LE(at + 10)
    const compressed = data.readUInt32LE(at + 20)
    const size = data.readUInt32LE(at + 24)
    const nameLength = data.readUInt16LE(at + 28)
    const local = data.readUInt32LE(at + 42)
    const name = data.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32)
    if (!keep(name)) continue
    if (flags & 1) throw new Error('Encrypted .vsix files are not supported.')
    if (size > MAX_FILE || (total += size) > MAX_UNPACKED) throw new Error('The .vsix file unpacks too large.')
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw damaged()
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const raw = data.subarray(start, start + compressed)
    if (raw.length !== compressed || (method !== 0 && method !== 8)) throw damaged()
    // The declared size caps the inflated size, so a zip bomb fails instead of filling memory.
    let body: Buffer
    try {
      body = method === 0 ? raw : size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: size })
    } catch {
      throw damaged()
    }
    if (body.length !== size) throw damaged()
    files.set(name, body)
  }
  return files
}

async function readCapped(file: string, max: number): Promise<Buffer> {
  if ((await fs.stat(file)).size > max) throw new Error(`${path.basename(file)} is larger than ${max / 1024 / 1024} MB.`)
  return fs.readFile(file)
}

interface Manifest {
  name?: unknown
  publisher?: unknown
  displayName?: unknown
  description?: unknown
  version?: unknown
  contributes?: { themes?: unknown; iconThemes?: unknown }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

// Manifest strings like "%displayName%" come from package.nls.json.
function localizer(nls: Record<string, unknown>) {
  return (value: unknown) => {
    const raw = text(value)
    const key = /^%(.+)%$/.exec(raw)?.[1]
    const found = key && Object.hasOwn(nls, key) ? nls[key] : undefined
    return typeof found === 'string' ? found : typeof (found as { message?: unknown })?.message === 'string' ? (found as { message: string }).message : raw
  }
}

function choices(id: string, list: unknown, local: (value: unknown) => string, colour: boolean): ThemeChoice[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((entry): ThemeChoice[] => {
    const file = text(entry?.path)
    if (!file) return []
    const ref = `${id}/${path.posix.normalize(file)}`
    const label = local(entry.label) || text(entry.id) || path.posix.basename(file)
    return [colour ? { ref, label, dark: entry.uiTheme !== 'vs' && entry.uiTheme !== 'hc-light' } : { ref, label }]
  })
}

function describe(id: string, manifest: Manifest, nls: Record<string, unknown>): InstalledExtension {
  const local = localizer(nls)
  return {
    id,
    name: local(manifest.displayName) || text(manifest.name),
    publisher: text(manifest.publisher),
    version: text(manifest.version),
    description: local(manifest.description),
    themes: choices(id, manifest.contributes?.themes, local, true),
    iconThemes: choices(id, manifest.contributes?.iconThemes, local, false),
  }
}

async function readExtension(root: string, id: string): Promise<InstalledExtension> {
  const dir = path.join(root, id)
  const manifest = await readJson(path.join(dir, 'package.json')) as Manifest
  const nls = await readCapped(path.join(dir, 'package.nls.json'), MAX_JSON).then((data) => parseJsonc(data.toString('utf8')) as Record<string, unknown>, () => ({}))
  return describe(id, manifest, nls)
}

export async function listExtensions(root: string): Promise<InstalledExtension[]> {
  const names = await fs.readdir(root).catch(() => [] as string[])
  const found = await Promise.all(names.filter(isExtensionId).map((id) => readExtension(root, id).catch(() => null)))
  return found.filter((entry): entry is InstalledExtension => entry !== null).sort((a, b) => a.name.localeCompare(b.name))
}

// Unpacks into a temporary folder first, so a failed install never leaves half an extension or damages the one it replaces.
export async function installVsix(root: string, data: Buffer): Promise<InstalledExtension> {
  if (data.length > MAX_DOWNLOAD) throw new Error('The .vsix file is too large.')
  const files = unzip(data, (name) => KEPT.test(entryPath(name) ?? ''))
  const manifestData = files.get('extension/package.json')
  if (!manifestData) throw new Error('Not a VS Code extension: the .vsix has no extension/package.json.')
  const nlsData = files.get('extension/package.nls.json')
  if (manifestData.length > MAX_JSON || (nlsData?.length ?? 0) > MAX_JSON) throw new Error(`The extension manifest is larger than ${MAX_JSON / 1024 / 1024} MB.`)
  const manifest = parseJsonc(manifestData.toString('utf8')) as Manifest
  const id = `${text(manifest.publisher)}.${text(manifest.name)}`.toLowerCase()
  if (!isExtensionId(id)) throw new Error('The extension has no valid publisher and name.')
  const described = describe(id, manifest, nlsData ? parseJsonc(nlsData.toString('utf8')) as Record<string, unknown> : {})
  if (!described.themes.length && !described.iconThemes.length) throw new Error(`${described.name || id} has no colour or file icon themes.`)
  await fs.mkdir(root, { recursive: true })
  const temp = path.join(root, `.install-${randomUUID()}`)
  try {
    for (const [name, body] of files) {
      const target = path.join(temp, entryPath(name)!)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, body)
    }
    const destination = path.join(root, id)
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(temp, destination)
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true })
    throw error
  }
  return described
}

export async function removeExtension(root: string, id: unknown): Promise<void> {
  if (!isExtensionId(id)) throw new Error('Unknown extension.')
  await fs.rm(path.join(root, id), { recursive: true, force: true })
}

// Loopback, private, link-local, CGNAT and unspecified addresses, IPv4-mapped IPv6 included.
export function isInternalAddress(address: string): boolean {
  const v4 = address.toLowerCase().replace(/^::ffff:/, '')
  if (isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128)
  }
  return v4 === '::' || v4 === '::1' || /^f[cd]/.test(v4) || /^fe[89ab]/.test(v4)
}

// Whether a request may go to `url`: https on the default port to an Open VSX host by name, never an IP literal, and
// only while that name resolves to public addresses.
// shortcut: the resolver's answer is checked, not the socket's; pin the connection's lookup if a host on the list could
// ever be pointed at an internal address by someone else.
export async function isOpenVsxUrl(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.port || url.username || url.password || isIP(host) || !OPEN_VSX_HOSTS.has(host)) return false
  const addresses = await lookup(host, { all: true }).catch(() => [])
  return addresses.length > 0 && !addresses.some(({ address }) => isInternalAddress(address))
}

// Redirects are followed by hand, so every hop is checked before it is requested: a redirect to a host off the list
// fails without ever reaching it.
export async function fetchOk(url: string, allowed: (url: URL) => Promise<boolean> = isOpenVsxUrl): Promise<Response> {
  let next = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!await allowed(next)) throw new Error(`Refusing to fetch from ${next.host}: not an Open VSX address.`)
    const response = await fetch(next, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status > 399 || !location) {
      if (!response.ok) throw new Error(`Open VSX answered ${response.status}.`)
      return response
    }
    await response.body?.cancel()
    next = new URL(location, next)
  }
  throw new Error('Open VSX redirected too many times.')
}

// An empty query lists the most downloaded themes.
export async function searchOpenVsx(query: unknown): Promise<ExtensionResult[]> {
  const words = text(query).trim().slice(0, 100)
  const params = new URLSearchParams({ ...(words ? { query: words } : { sortBy: 'downloadCount', sortOrder: 'desc' }), category: 'Themes', size: '30' })
  const body = await (await fetchOk(`${OPEN_VSX}/-/search?${params}`)).json() as { extensions?: unknown }
  if (!Array.isArray(body.extensions)) return []
  return body.extensions.flatMap((entry): ExtensionResult[] => (PART.test(text(entry?.namespace)) && PART.test(text(entry?.name))
    ? [{
        namespace: entry.namespace,
        name: entry.name,
        displayName: text(entry.displayName) || entry.name,
        description: text(entry.description),
        version: text(entry.version),
        downloads: Number(entry.downloadCount) || 0,
      }]
    : []))
}

async function downloadFromOpenVsx(namespace: unknown, name: unknown): Promise<Buffer> {
  if (!PART.test(text(namespace)) || !PART.test(text(name))) throw new Error('Unknown extension.')
  const meta = await (await fetchOk(`${OPEN_VSX}/${namespace}/${name}`)).json() as { files?: { download?: unknown } }
  const download = text(meta.files?.download)
  if (!download.startsWith(`${OPEN_VSX}/`)) throw new Error('Open VSX has no download for this extension.')
  const response = await fetchOk(download)
  if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('The .vsix file is too large.')
  // Counted as it arrives, so a server that lies about the length still cannot send more than the cap. Redirect hops
  // carry no body (fetchOk discards them), so this one count covers the whole download.
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body!.getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length
    if (size > MAX_DOWNLOAD) {
      await reader.cancel()
      throw new Error('The .vsix file is too large.')
    }
    chunks.push(read.value)
  }
  return Buffer.concat(chunks)
}

export async function installFromOpenVsx(root: string, namespace: unknown, name: unknown): Promise<InstalledExtension> {
  return installVsix(root, await downloadFromOpenVsx(namespace, name))
}

export async function installVsixFile(root: string, file: string): Promise<InstalledExtension> {
  return installVsix(root, await readCapped(file, MAX_DOWNLOAD))
}

// The extension folder and contributed file a ref names, only when the extension lists it.
async function locate(root: string, ref: unknown, kind: 'themes' | 'iconThemes') {
  if (typeof ref !== 'string' || ref.length > 500) return null
  const id = ref.slice(0, ref.indexOf('/'))
  if (!isExtensionId(id)) return null
  const extension = await readExtension(root, id).catch(() => null)
  const choice = extension?.[kind].find((entry) => entry.ref === ref)
  const dir = path.join(root, id)
  const file = choice && await resolveInside(dir, dir, ref.slice(id.length + 1))
  return file ? { dir, file, choice: choice!, name: `${ref}@${extension!.version}` } : null
}

// Theme files, the files they include, and manifests: refused from their size alone when over MAX_JSON, never read.
const readJson = async (file: string) => parseJsonc((await readCapped(file, MAX_JSON)).toString('utf8')) as Record<string, any>

function tokenRules(value: unknown): TokenRule[] {
  // A string here names a .tmTheme file, which is not supported.
  if (!Array.isArray(value)) return []
  return value.flatMap((rule): TokenRule[] => {
    const scope = rule?.scope
    const foreground = rule?.settings?.foreground
    const scoped = typeof scope === 'string' || (Array.isArray(scope) && scope.every((entry) => typeof entry === 'string'))
    return [{ ...(scoped && { scope }), settings: isHexColor(foreground) ? { foreground } : {} }]
  })
}

// Includes load first; the including file's colours win and its token rules come after, as in VS Code.
async function readColorFile(dir: string, file: string, depth: number): Promise<Pick<ColorTheme, 'colors' | 'tokenColors'>> {
  const json = await readJson(file)
  let base: Pick<ColorTheme, 'colors' | 'tokenColors'> = { colors: {}, tokenColors: [] }
  if (typeof json.include === 'string') {
    const included = depth < 8 && await resolveInside(dir, path.dirname(file), json.include)
    if (!included) throw new Error(`Theme include not found or outside the extension: ${json.include}`)
    base = await readColorFile(dir, included, depth + 1)
  }
  const colors = typeof json.colors === 'object' && json.colors !== null ? json.colors as Record<string, unknown> : {}
  return {
    colors: { ...base.colors, ...Object.fromEntries(Object.entries(colors).filter((entry): entry is [string, string] => isHexColor(entry[1]))) },
    tokenColors: [...base.tokenColors, ...tokenRules(json.tokenColors)],
  }
}

export async function loadColorTheme(root: string, ref: unknown): Promise<ColorTheme | null> {
  const found = await locate(root, ref, 'themes')
  if (!found) return null
  return { name: found.name, label: found.choice.label, dark: found.choice.dark !== false, ...await readColorFile(found.dir, found.file, 0) }
}

function iconMaps(source: unknown): IconMaps {
  const json = (typeof source === 'object' && source !== null ? source : {}) as Record<string, unknown>
  const id = (value: unknown) => (typeof value === 'string' ? value : undefined)
  // Lower-cased, as VS Code matches file names and extensions without case.
  const map = (value: unknown) => Object.fromEntries(Object.entries(typeof value === 'object' && value !== null ? value : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, icon]) => [key.toLowerCase(), icon]))
  return {
    file: id(json.file), folder: id(json.folder), folderExpanded: id(json.folderExpanded),
    rootFolder: id(json.rootFolder), rootFolderExpanded: id(json.rootFolderExpanded),
    fileExtensions: map(json.fileExtensions), fileNames: map(json.fileNames), languageIds: map(json.languageIds),
  }
}

// Runs `task` on every item, at most `limit` at a time, and keeps the results in order.
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Only icons the maps use are read, each as a data URL, so the renderer never loads a file path. The whole load fails
// when the theme is over a cap, and the caps are checked before any image is read.
export async function loadIconTheme(root: string, ref: unknown): Promise<IconTheme | null> {
  const found = await locate(root, ref, 'iconThemes')
  if (!found) return null
  const json = await readJson(found.file)
  const base = iconMaps(json)
  const light = iconMaps(json.light)
  const definitions = (typeof json.iconDefinitions === 'object' && json.iconDefinitions !== null ? json.iconDefinitions : {}) as Record<string, any>
  const ids = new Set([base, light].flatMap(({ fileExtensions, fileNames, languageIds, ...single }) =>
    [...Object.values(single), ...Object.values(fileExtensions), ...Object.values(fileNames), ...Object.values(languageIds)]))
  let fontIcons = 0
  // Icon id and the image's path, before touching the disk.
  const wanted: [string, string][] = []
  for (const id of ids) {
    const definition = typeof id === 'string' && Object.hasOwn(definitions, id) ? definitions[id] : undefined
    const iconPath = text(definition?.iconPath)
    if (/\.(?:svg|png)$/i.test(iconPath)) wanted.push([id as string, path.resolve(path.dirname(found.file), iconPath)])
    else if (definition?.fontCharacter) fontIcons++
  }
  if (wanted.length > MAX_ICON_COUNT) throw new Error(`The icon theme uses more than ${MAX_ICON_COUNT} icons.`)
  // Each distinct path is resolved and sized once. Files outside the extension, missing or over MAX_ICON are skipped.
  const files = new Map(await pool([...new Set(wanted.map(([, file]) => file))], READERS, async (file) => {
    const real = await resolveInside(found.dir, found.dir, file)
    const stat = real && /\.(?:svg|png)$/i.test(real) ? await fs.stat(real).catch(() => null) : null
    return [file, real && stat?.isFile() && stat.size <= MAX_ICON ? { real, size: stat.size } : null] as const
  }))
  const total = wanted.reduce((sum, [, file]) => sum + (files.get(file)?.size ?? 0), 0)
  if (total > MAX_ICON_BYTES) throw new Error(`The icon theme's images add up to more than ${MAX_ICON_BYTES / 1024 / 1024} MB.`)
  // Each real file is read once; ids that share it share one data URL.
  const reals = [...new Set([...files.values()].flatMap((entry) => (entry ? [entry.real] : [])))]
  const urls = new Map(await pool(reals, READERS, async (real) => {
    const data = await readCapped(real, MAX_ICON).catch(() => null)
    return [real, data && `data:${real.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${data.toString('base64')}`] as const
  }))
  const icons = Object.fromEntries(wanted.flatMap(([id, file]) => {
    const url = urls.get(files.get(file)?.real ?? '')
    return url ? [[id, url]] : []
  }))
  return { name: found.name, ...base, light, icons, fontIcons }
}

// Only the icons the preview shows, so a large icon theme sends a few dozen images, not thousands.
function previewIcons(theme: IconTheme): IconTheme {
  const ids = new Set([
    ...PREVIEW_FILES.flatMap(([name, language]) => [fileIconId(theme, name, language, false), fileIconId(theme, name, language, true)]),
    ...[theme, theme.light].flatMap((map) => [map.folder, map.folderExpanded, map.rootFolder]),
  ])
  return { ...theme, icons: Object.fromEntries(Object.entries(theme.icons).filter(([id]) => ids.has(id))) }
}

// Most themes one preview loads, and the bytes they may add up to once loaded. Real packs stay far below (Catppuccin's
// four colour themes come to 187 KB); the caps stop a small package that repeats contributions from building gigabytes.
const MAX_PREVIEW_THEMES = 24
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

// Unpacks and checks a .vsix exactly as an install does, but into a temporary folder that is deleted once its themes are
// in memory, so a preview never installs or keeps anything. Themes load one at a time, each trimmed before the next, so
// at most one full theme is held while the total is counted against the budget.
export async function previewVsix(data: Buffer): Promise<ExtensionPreview> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bettergit-preview-'))
  try {
    const extension = await installVsix(root, data)
    const count = extension.themes.length + extension.iconThemes.length
    if (count > MAX_PREVIEW_THEMES) throw new Error(`${extension.name} has ${count} themes, more than the ${MAX_PREVIEW_THEMES} a preview can show.`)
    let bytes = 0
    const counted = async <T>(load: Promise<T | null>) => {
      const theme = await load.catch(() => null)
      bytes += JSON.stringify(theme).length
      if (bytes > MAX_PREVIEW_BYTES) throw new Error(`${extension.name}'s themes add up to more than ${MAX_PREVIEW_BYTES / 1024 / 1024} MB, too large to preview.`)
      return theme
    }
    const colorThemes: (ColorTheme | null)[] = []
    for (const theme of extension.themes) colorThemes.push(await counted(loadColorTheme(root, theme.ref)))
    const iconThemes: (IconTheme | null)[] = []
    for (const theme of extension.iconThemes) iconThemes.push(await counted(loadIconTheme(root, theme.ref).then((icons) => icons && previewIcons(icons))))
    return { extension, colorThemes, iconThemes }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

export async function previewFromOpenVsx(namespace: unknown, name: unknown): Promise<ExtensionPreview> {
  return previewVsix(await downloadFromOpenVsx(namespace, name))
}
