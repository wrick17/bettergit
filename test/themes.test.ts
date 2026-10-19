import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { entryPath, fetchOk, isInternalAddress, isOpenVsxUrl, loadColorTheme, loadIconTheme, parseJsonc, resolveInside } from '../src/main/extensions'
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
