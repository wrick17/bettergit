import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, promises as fsPromises, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_APPEARANCE } from '../src/shared/editors'
import { entryPath, fetchOk, isInternalAddress, isOpenVsxUrl, loadColorTheme, loadIconTheme, parseJsonc, resolveInside } from '../src/main/extensions'
import * as shared from '../src/shared/themes'
import { fileIconId, themeCss, themeVariables, type IconTheme } from '../src/shared/themes'

const root = mkdtempSync(path.join(tmpdir(), 'bettergit-themes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// An installed extension as installVsix leaves it: <root>/<publisher.name>/ with the files under extension/.
function extension(id: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, id, file)), { recursive: true })
    writeFileSync(path.join(root, id, file), text)
  }
}

async function registryWithFetch(fetch: (url: URL) => Promise<Response>, lookup = async (_host: string) => [{ address: '151.101.1.242', family: 4 }]) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/main/extensions.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const module = { exports: {} as typeof import('../src/main/extensions') }
  runInNewContext(await compiled.outputs[0].text(), {
    module, exports: module.exports, URL, URLSearchParams, AbortSignal, Buffer, fetch,
    require: (id: string) => id === '../shared/themes' ? shared : id === 'node:dns/promises'
      ? { lookup } : require(id),
  })
  return module.exports
}

test('registry lists and metadata stay lazy; Details reads the selected README and never an extension archive', async () => {
  const api = 'https://open-vsx.org/api/PKief/material-icon-theme'
  const readmeUrl = `${api}/5.39.0/file/readme.md`
  const storedReadme = 'https://openvsx.eclipsecontent.org/PKief/material-icon-theme/5.39.0/readme.md'
  const icon = `${api}/5.39.0/file/logo.png`
  const entry = { namespace: 'PKief', name: 'material-icon-theme', displayName: 'Material Icon Theme', description: 'Icons', version: '5.39.0',
    downloadCount: 6532520, averageRating: 4.846153846153846, reviewCount: 13,
    files: { icon, readme: readmeUrl, download: `${api}/5.39.0/file/theme.vsix` } }
  const requests: string[] = []
  let missing = false
  const registry = await registryWithFetch(async (url) => {
    requests.push(url.href)
    if (url.pathname === '/api/-/search') return Response.json({ extensions: [entry] })
    if (url.href === api) return Response.json(missing ? { files: { icon: 'file:///tmp/icon.svg' } } : entry)
    if (url.href === readmeUrl) return new Response(null, { status: 302, headers: { location: storedReadme } })
    if (url.href === storedReadme) {
      const response = new Response('# Material Icon Theme\n![Preview](./images/preview.png)', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      Object.defineProperty(response, 'url', { value: storedReadme })
      return response
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const [result] = await registry.searchOpenVsx('Material Icon Theme')
  expect(result).toMatchObject({ namespace: 'PKief', name: 'material-icon-theme', icon, downloads: 6532520, averageRating: entry.averageRating, reviewCount: 13 })
  expect(requests.length).toBe(1)
  expect(new URL(requests[0]).pathname).toBe('/api/-/search')
  requests.length = 0
  const metadata = await registry.extensionMetadata('PKief', 'material-icon-theme')
  expect(metadata).toMatchObject({ ...result, url: 'https://open-vsx.org/extension/PKief/material-icon-theme' })
  expect(requests).toEqual([api])
  requests.length = 0
  const details = await registry.extensionDetails('PKief', 'material-icon-theme')
  expect(details.readme).toBe('# Material Icon Theme\n![Preview](./images/preview.png)')
  expect(details.readmeBaseUrl).toBe(storedReadme)
  expect(requests).toEqual([api, readmeUrl, storedReadme])
  expect(requests.some((url) => url.endsWith('.vsix') || url === icon)).toBe(false)
  requests.length = 0
  missing = true
  expect(await registry.extensionDetails('PKief', 'material-icon-theme')).toMatchObject({ readme: null, readmeBaseUrl: null, icon: null, downloads: null, averageRating: null, reviewCount: null })
  expect(requests).toEqual([api])
  requests.length = 0
  for (const [namespace, name] of [['acme', 'Display Name'], ['https://evil.example', 'theme'], ['acme', '../theme'], ['acme.theme', 'extra'], [undefined, 'theme'], ['acme', null]]) {
    await expect(registry.extensionDetails(namespace, name)).rejects.toThrow('Unknown extension.')
  }
  expect(requests).toEqual([])
})

test('registry images are bounded data URLs inferred from bytes, with no arbitrary hosts, HTML or archive requests', async () => {
  const icon = 'https://open-vsx.org/api/PKief/material-icon-theme/5.39.0/file/logo.png'
  const storedIcon = 'https://openvsx.eclipsecontent.org/PKief/material-icon-theme/5.39.0/logo.png'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZZkAAAAASUVORK5CYII=', 'base64')
  const requests: string[] = []
  const registry = await registryWithFetch(async (url) => {
    requests.push(url.href)
    if (url.href === icon) return new Response(null, { status: 302, headers: { location: storedIcon } })
    if (url.href === storedIcon) return new Response(png, { headers: { 'content-type': 'application/octet-stream' } })
    if (url.pathname === '/large.png') return new Response(png, { headers: { 'content-length': String(512 * 1024 + 1) } })
    return new Response('<html><script>throw 1</script></html>', { headers: { 'content-type': 'image/png' } })
  })
  expect(await registry.extensionImage(icon)).toBe(`data:image/png;base64,${png.toString('base64')}`)
  expect(requests).toEqual([icon, storedIcon])
  expect(await registry.extensionImage('https://open-vsx.org/large.png')).toBeNull()
  expect(await registry.extensionImage('https://open-vsx.org/fake.png')).toBeNull()
  requests.length = 0
  for (const url of ['https://evil.example/logo.png', 'http://open-vsx.org/logo.png', 'https://user@open-vsx.org/logo.png', 'file:///tmp/logo.png', 'javascript:alert(1)', `${icon}.vsix`]) {
    expect(await registry.extensionImage(url)).toBeNull()
  }
  expect(requests).toEqual([])
})

test('Flow Icons README assets and Shields badges use an image-only public-address policy on every redirect', async () => {
  const raw = 'https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/'
  const badge = 'https://img.shields.io/badge/Get_full-Flow_Icons-blue'
  const registryIcon = 'https://open-vsx.org/flow-logo.png'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZZkAAAAASUVORK5CYII=', 'base64')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Flow Icons</text></svg>'
  const requests: string[] = []
  const lookups: string[] = []
  let privateAddress = false
  const registry = await registryWithFetch(async (url) => {
    requests.push(url.href)
    if (url.href === registryIcon) return new Response(null, { status: 302, headers: { location: `${raw}logo.png` } })
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/badge.svg' } })
    return new Response(url.hostname === 'img.shields.io' ? svg : png)
  }, async (host) => {
    lookups.push(host)
    return [{ address: privateAddress ? '127.0.0.1' : '151.101.1.242', family: 4 }]
  })
  expect(await registry.extensionImage(registryIcon)).toStartWith('data:image/png;base64,')
  expect(requests).toEqual([registryIcon, `${raw}logo.png`])
  expect(lookups).toEqual(['open-vsx.org', 'raw.githubusercontent.com'])
  for (const file of ['preview.png', 'preview_light.png', 'you/sequoia_moonlight.png']) {
    expect(await registry.extensionImage(`${raw}${file}`)).toStartWith('data:image/png;base64,')
  }
  expect(await registry.extensionImage(badge)).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  expect(await registry.isOpenVsxUrl(new URL(`${raw}logo.png`))).toBe(false)
  expect(await registry.isOpenVsxUrl(new URL(badge))).toBe(false)
  requests.length = 0
  expect(await registry.extensionImage('https://img.shields.io/redirect')).toBeNull()
  expect(requests).toEqual(['https://img.shields.io/redirect'])
  requests.length = 0
  expect(await registry.extensionImage(`${raw}README.md`)).toBeNull()
  expect(await registry.extensionImage('https://raw.githubusercontent.com/other/repo/main/logo.png')).toBeNull()
  privateAddress = true
  expect(await registry.extensionImage(`${raw}logo.png`)).toBeNull()
  expect(requests).toEqual([])
})

test('workbench colours fill app variables best key first, and anything but a hex colour is dropped', () => {
  const variables = themeVariables({
    'editor.background': '#282a36',
    'sideBar.background': '#21222c',
    foreground: '#f8f8f2',
    'button.background': 'red; background: url(https://evil)',
    focusBorder: '#6272a4',
  }, true)
  expect(variables).toMatchObject({ '--content': '#282a36', '--list': '#21222c', '--window': '#21222c', '--text': '#f8f8f2', '--accent-fill': '#6272a4', '--on-accent': '#ffffff' })
  expect(variables['--accent-soft']).toContain('var(--accent-fill) 30%')
  expect(variables['--sunken']).toBeUndefined()
  // A pale accent gets dark text.
  expect(themeVariables({ focusBorder: '#ffd' }, false)['--on-accent']).toBe('#111114')
  const css = themeCss(null, { name: 'x', label: 'X', dark: true, colors: { 'editor.background': '#000' }, tokenColors: [] })
  expect(css).toBe(":root:root[data-theme='dark'] { --window: #000; --glass-fill: #000; --content: #000; --list: #000; --glass-strong: #000; }")
})

test('custom light themes keep the app diff fills while their other colours and dark diff fills still apply', () => {
  const colors = {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f2328',
    'diffEditor.insertedLineBackground': '#aceebb4d',
    'diffEditor.insertedTextBackground': '#6fdd8b80',
    'diffEditor.removedLineBackground': '#ffcecb4d',
    'diffEditor.removedTextBackground': '#ff818266',
  }
  const light = themeVariables(colors, false)
  expect(light).toMatchObject({ '--content': '#ffffff', '--text': '#1f2328' })
  expect(light['--add-bg']).toBeUndefined()
  expect(light['--del-bg']).toBeUndefined()
  const theme = { name: 'github-light', label: 'GitHub Light Default', dark: false, colors, tokenColors: [] }
  const css = themeCss(theme, null)
  expect(css).not.toContain('--add-bg:')
  expect(css).not.toContain('--del-bg:')
  expect(css).toContain('--text: #1f2328;')
  expect(themeVariables(colors, true)).toMatchObject({ '--add-bg': '#aceebb4d', '--del-bg': '#ffcecb4d' })
  expect(themeCss(null, { ...theme, dark: true })).toContain('--add-bg: #aceebb4d; --del-bg: #ffcecb4d;')
})

test('JSONC keeps comment-like text in strings and drops comments and trailing commas', () => {
  expect(parseJsonc('﻿{ /* a */ "url": "https://x//y", // note\n "list": [1, 2, /* c */ ], "s": "a,]", }')).toEqual({ url: 'https://x//y', list: [1, 2], s: 'a,]' })
})

test('a colour theme follows its include chain: included colours load first, the including file wins, token rules append', async () => {
  extension('acme.night', {
    'package.json': JSON.stringify({ name: 'night', publisher: 'acme', version: '1.0.0', contributes: { themes: [{ label: 'Night', uiTheme: 'vs-dark', path: './themes/night.json' }] } }),
    'themes/base.jsonc': '{ "colors": { "editor.background": "#111111", "editor.foreground": "#eeeeee", }, "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#777777" } }] }',
    'themes/night.json': '{\n  // Inherits the base\n  "include": "./base.jsonc",\n  "colors": { "editor.background": "#000000", "bad": "javascript:alert(1)" },\n  "tokenColors": [{ "scope": ["string"], "settings": { "foreground": "#00ff00", "fontStyle": "bold" } }],\n}',
  })
  const theme = await loadColorTheme(root, 'acme.night/themes/night.json')
  expect(theme).toEqual({
    name: 'acme.night/themes/night.json@1.0.0', label: 'Night', dark: true,
    colors: { 'editor.background': '#000000', 'editor.foreground': '#eeeeee' },
    tokenColors: [{ scope: 'comment', settings: { foreground: '#777777' } }, { scope: ['string'], settings: { foreground: '#00ff00' } }],
  })
  // Refs the extension does not contribute load nothing.
  expect(await loadColorTheme(root, 'acme.night/themes/base.jsonc')).toBeNull()
  expect(await loadColorTheme(root, '../acme.night/themes/night.json')).toBeNull()
})

test('files outside the extension are refused: zip entries, includes, icon paths and symlinks', async () => {
  for (const name of ['extension/../evil.json', 'extension/a/../../evil.json', '../extension/x.json', '/etc/passwd', 'extension/a\\..\\b.json', 'extension/']) {
    expect(entryPath(name)).toBeNull()
  }
  expect(entryPath('extension/themes/a.json')).toBe('themes/a.json')

  writeFileSync(path.join(root, 'outside.json'), '{ "colors": { "editor.background": "#ff0000" } }')
  extension('acme.escape', {
    'package.json': JSON.stringify({ name: 'escape', publisher: 'acme', version: '1.0.0', contributes: {
      themes: [{ label: 'Escape', uiTheme: 'vs', path: './theme.json' }, { label: 'Linked', uiTheme: 'vs', path: './linked.json' }],
      iconThemes: [{ id: 'icons', label: 'Icons', path: './icons.json' }],
    } }),
    'theme.json': '{ "include": "../outside.json" }',
    'icons.json': JSON.stringify({ iconDefinitions: { a: { iconPath: '../outside.svg' }, b: { iconPath: './b.svg' }, f: { fontCharacter: '\\E001' } }, fileExtensions: { md: 'a', ts: 'b' }, file: 'f' }),
    'b.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  })
  writeFileSync(path.join(root, 'outside.svg'), '<svg/>')
  symlinkSync(path.join(root, 'outside.json'), path.join(root, 'acme.escape', 'linked.json'))
  const dir = path.join(root, 'acme.escape')

  expect(await resolveInside(dir, dir, '../outside.json')).toBeNull()
  expect(await resolveInside(dir, dir, '/etc/hosts')).toBeNull()
  expect(await resolveInside(dir, dir, 'linked.json')).toBeNull()
  expect(await resolveInside(dir, dir, 'theme.json')).toBe(path.join(realpathSync(dir), 'theme.json'))
  await expect(loadColorTheme(root, 'acme.escape/theme.json')).rejects.toThrow('outside the extension')
  expect(await loadColorTheme(root, 'acme.escape/linked.json')).toBeNull()
  const icons = await loadIconTheme(root, 'acme.escape/icons.json')
  expect(Object.keys(icons!.icons)).toEqual(['b'])
  expect(icons!.icons.b).toStartWith('data:image/svg+xml;base64,')
  expect(icons!.fontIcons).toBe(1)
})

test('file icons resolve by name, then longest extension, then language, then the default, with light overrides', () => {
  const maps = { fileExtensions: {}, fileNames: {}, languageIds: {} }
  const theme: IconTheme = {
    name: 't', icons: {}, fontIcons: 0, file: 'file',
    fileNames: { 'package.json': 'npm' }, fileExtensions: { 'd.ts': 'typings', ts: 'ts', json: 'json' }, languageIds: { python: 'py' },
    light: { ...maps, fileExtensions: { ts: 'ts-light' } },
  }
  expect(fileIconId(theme, 'Package.JSON', 'json', false)).toBe('npm')
  expect(fileIconId(theme, 'index.d.ts', 'typescript', false)).toBe('typings')
  expect(fileIconId(theme, 'main.ts', 'typescript', true)).toBe('ts-light')
  expect(fileIconId(theme, 'main.ts', 'typescript', false)).toBe('ts')
  expect(fileIconId(theme, 'tool.py', 'python', false)).toBe('py')
  expect(fileIconId(theme, 'README', null, false)).toBe('file')
})

test('a redirect is checked before it is followed, so a hop off the allowed hosts is never requested', async () => {
  const hits: string[] = []
  const target = Bun.serve({ port: 0, fetch: (request) => { hits.push(request.url); return new Response('PK') } })
  const start = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}/private-target` } }) })
  try {
    const first = `http://127.0.0.1:${start.port}/`
    await expect(fetchOk(`${first}file.vsix`, async (url) => url.href.startsWith(first))).rejects.toThrow('Refusing to fetch')
    expect(hits).toEqual([])
  } finally {
    start.stop(true)
    target.stop(true)
  }
  // The real policy refuses these before any lookup or request.
  for (const url of ['http://open-vsx.org/api', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/x', 'https://localhost/x',
    'https://open-vsx.org.evil.example/x', 'https://evil.example/x', 'https://open-vsx.org:8443/x', 'https://user@open-vsx.org/x']) {
    expect(await isOpenVsxUrl(new URL(url))).toBe(false)
  }
  expect(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']
    .filter((address) => !isInternalAddress(address))).toEqual([])
  expect(['104.18.12.1', '172.32.0.1', '2606:4700::1'].filter(isInternalAddress)).toEqual([])
})

test('Open VSX retries a transient DNS or connection failure once and validates the address again', async () => {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/main/extensions.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  for (const failure of ['dns', 'connection']) {
    let validations = 0
    let requests = 0
    const module = { exports: {} as typeof import('../src/main/extensions') }
    runInNewContext(await compiled.outputs[0].text(), {
      module, exports: module.exports, URL, URLSearchParams, AbortSignal, Buffer,
      require: (id: string) => id === '../shared/themes' ? shared : id === 'node:dns/promises' ? {
        lookup: async () => {
          if (++validations === 1 && failure === 'dns') throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
          return [{ address: '151.101.1.242', family: 4 }]
        },
      } : require(id),
      fetch: async (input: URL) => {
        expect(input.searchParams.get('query')).toBe('Material icon theme')
        if (++requests === 1 && failure === 'connection') {
          throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })
        }
        return Response.json({ extensions: [{ namespace: 'PKief', name: 'material-icon-theme' }] })
      },
    })
    const found = await module.exports.searchOpenVsx('Material icon theme')
    expect(found[0].name).toBe('material-icon-theme')
    expect(validations).toBe(2)
    expect(requests).toBe(failure === 'dns' ? 1 : 2)
  }
})

test('Open VSX stops after one retry and never retries policy, TLS or HTTP failures', async () => {
  const original = globalThis.fetch
  try {
    for (const failure of ['policy', 'tls', 'http', 'connection', 'changed-address']) {
      let validations = 0
      let requests = 0
      globalThis.fetch = (async () => {
        requests++
        if (failure === 'http') return new Response(null, { status: 404 })
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(failure), {
          code: failure === 'tls' ? 'CERT_HAS_EXPIRED' : 'ECONNRESET',
        }) })
      }) as unknown as typeof fetch
      await expect(fetchOk('https://open-vsx.org/api/-/search', async () => {
        validations++
        return failure !== 'policy' && !(failure === 'changed-address' && validations > 1)
      })).rejects.toThrow(failure === 'policy' || failure === 'changed-address' ? 'Refusing to fetch' : failure === 'http' ? '404' : 'fetch failed')
      expect(validations).toBe(failure === 'connection' || failure === 'changed-address' ? 2 : 1)
      expect(requests).toBe(failure === 'policy' ? 0 : failure === 'connection' ? 2 : 1)
    }
  } finally {
    globalThis.fetch = original
  }
})

test('Open VSX DNS validation and retry backoff share the request deadline', async () => {
  const originalTimeout = AbortSignal.timeout
  const originalFetch = globalThis.fetch
  let requests = 0
  AbortSignal.timeout = ((milliseconds: number) => {
    expect(milliseconds).toBe(30_000)
    return originalTimeout(20)
  }) as typeof AbortSignal.timeout
  globalThis.fetch = (async () => {
    requests++
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })
  }) as unknown as typeof fetch
  try {
    await expect(fetchOk('https://open-vsx.org/api', () => new Promise(() => {}))).rejects.toThrow()
    expect(requests).toBe(0)
    await expect(fetchOk('https://open-vsx.org/api', async () => true)).rejects.toThrow()
    expect(requests).toBe(1)
  } finally {
    AbortSignal.timeout = originalTimeout
    globalThis.fetch = originalFetch
  }
})

test('icon caps are checked from the map and file sizes before any image is read, each file is read once, a few at a time', async () => {
  const icons = (count: number, file: (index: number) => string) => JSON.stringify({
    iconDefinitions: Object.fromEntries(Array.from({ length: count }, (_, index) => [`icon${index}`, { iconPath: file(index) }])),
    fileExtensions: Object.fromEntries(Array.from({ length: count }, (_, index) => [`ext${index}`, `icon${index}`])),
  })
  const svg = (bytes: number) => `<svg xmlns="http://www.w3.org/2000/svg"/>${' '.repeat(bytes)}`
  extension('acme.flood', {
    'package.json': JSON.stringify({ name: 'flood', publisher: 'acme', version: '1.0.0', contributes: { themes: [{ label: 'Huge', uiTheme: 'vs-dark', path: './huge.json' }], iconThemes: [
      { id: 'big', label: 'Big', path: './big.json' }, { id: 'many', label: 'Many', path: './many.json' }, { id: 'fine', label: 'Fine', path: './fine.json' },
    ] } }),
    // Sol's probe: 256 ids on one 500 KB file, 125 MB of data URLs from one file.
    'big.json': icons(256, () => './one.svg'),
    'one.svg': svg(500_000),
    'many.json': icons(5001, () => './small.svg'),
    'huge.json': `{ "colors": {} }${' '.repeat(4 * 1024 * 1024)}`,
    'small.svg': svg(10),
    'fine.json': icons(80, (index) => `./fine/${index % 40}.svg`),
    ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`fine/${index}.svg`, svg(index)])),
  })
  const original = fsPromises.readFile
  const reads: string[] = []
  let active = 0
  let most = 0
  fsPromises.readFile = (async (...args: Parameters<typeof original>) => {
    if (!/\.svg$|huge\.json$/.test(String(args[0]))) return original(...args)
    reads.push(String(args[0]))
    most = Math.max(most, ++active)
    try {
      return await original(...args)
    } finally {
      active--
    }
  }) as typeof original
  try {
    await expect(loadIconTheme(root, 'acme.flood/big.json')).rejects.toThrow('add up to more than 16 MB')
    await expect(loadIconTheme(root, 'acme.flood/many.json')).rejects.toThrow('more than 5000 icons')
    await expect(loadColorTheme(root, 'acme.flood/huge.json')).rejects.toThrow('huge.json is larger than 4 MB')
    expect(reads).toEqual([])
    const fine = await loadIconTheme(root, 'acme.flood/fine.json')
    expect(reads.length).toBe(40)
    expect(most).toBeLessThanOrEqual(8)
    expect(Object.keys(fine!.icons).length).toBe(80)
    expect(fine!.icons.icon3).toBe(fine!.icons.icon43)
  } finally {
    fsPromises.readFile = original
  }
})

test('the last theme pick applies once it loads, an earlier slower load never covers it, and nothing shows applied early', async () => {
  // themes.ts compiled in memory, as branch-picker.test.tsx does, with icon theme loads that finish when the test says.
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/themes.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const finish = new Map<string, () => void>()
  const iconTheme = (ref: string) => new Promise((resolve) => finish.set(ref, () => resolve({ name: ref, icons: {}, fontIcons: 0, fileExtensions: {}, fileNames: {}, languageIds: {}, light: {} })))
  const imports: Record<string, unknown> = { react: { useSyncExternalStore: (_: unknown, get: () => unknown) => get() }, '../../shared/themes': shared, './highlight': { setSyntaxThemes() {} } }
  const module = { exports: {} as any }
  runInNewContext(await compiled.outputs[0].text(), {
    module, exports: module.exports, console, require: (id: string) => imports[id] ?? {},
    window: { bettergit: { iconTheme, colorTheme: async () => null } },
    document: { getElementById: () => null },
    localStorage: { setItem() {}, removeItem() {} },
  })
  const themes = module.exports
  const pick = (ref: string) => themes.applyThemes({ ...DEFAULT_APPEARANCE, iconTheme: ref })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  // What the picker shows and what FileIcon draws.
  const shown = () => [themes.useAppliedThemes().iconTheme, themes.useIconTheme()?.name ?? '']

  pick('a.x/slow.json')
  pick('b.x/fast.json')
  expect(shown()).toEqual(['', ''])
  finish.get('b.x/fast.json')!()
  await settle()
  expect(shown()).toEqual(['b.x/fast.json', 'b.x/fast.json'])
  finish.get('a.x/slow.json')!()
  await settle()
  expect(shown()).toEqual(['b.x/fast.json', 'b.x/fast.json'])

  // A then B where A lands first: A never shows, and B applies when it lands.
  pick('c.x/first.json')
  pick('d.x/second.json')
  finish.get('c.x/first.json')!()
  await settle()
  expect(shown()).toEqual(['b.x/fast.json', 'b.x/fast.json'])
  finish.get('d.x/second.json')!()
  await settle()
  expect(shown()).toEqual(['d.x/second.json', 'd.x/second.json'])

  // A loaded theme applies in the same task.
  pick('c.x/first.json')
  expect(shown()).toEqual(['c.x/first.json', 'c.x/first.json'])
})
