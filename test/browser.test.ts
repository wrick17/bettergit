import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Checks that need a real browser: where a click lands in wrapped editor-look rows, find highlights reaching rows that
// mount after the query, and keys typed before the editor mounts. They run in Chromium from the Playwright install the
// perf harness uses, and skip where it is missing.
const playwright = (() => {
  try {
    return createRequire(import.meta.url)(`${execSync('rtk proxy npm root -g').toString().trim()}/playwright`)
  } catch {
    return null
  }
})()

const root = `${import.meta.dir}/..`
let browser: any
let page: any

beforeAll(async () => {
  if (!playwright) return
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/browser-entry.ts`], target: 'browser' })
  if (!build.success) throw new Error(build.logs.join('\n'))
  const script = (await build.outputs.find((output) => output.path.endsWith('.js'))!.text()).replace(/<\/script/g, '<\\/script')
  const css = readFileSync(`${root}/src/renderer/src/diff-editor.css`, 'utf8') + readFileSync(`${root}/src/renderer/src/styles.css`, 'utf8')
  browser = await playwright.chromium.launch()
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  // A real origin, so the modules can read localStorage.
  await page.route('http://bettergit.test/', (route: any) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>window.bettergit = {}</script><script type="module">${script}</script></body></html>`,
  }))
  await page.goto('http://bettergit.test/')
  await page.waitForFunction(() => 'under' in window)
}, 30000)

afterAll(async () => { await browser?.close() })

test.skipIf(!playwright)('Changes context controls update previews and the same unsaved editor in both layouts', async () => {
  await page.setViewportSize({ width: 1200, height: 800 })
  const choose = async (value: number) => {
    await page.locator('.context-toggle button').filter({ hasText: new RegExp(`^${value === 100000 ? 'All' : value}$`) }).click()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  for (const layout of ['unified', 'split']) {
    await page.evaluate((layout: string) => {
      const w = window as any
      const { createElement, flushSync, createRoot, DiffView, setDiffLayout, setContextLines } = w.under
      setContextLines(3); setDiffLayout(layout)
      const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`)
      lines[94] = 'line 95 changed'
      w.contextText = lines.join('\n')
      w.contextSaved = null
      const file = { oldPath: 'context.txt', newPath: 'context.txt', status: 'modified', binary: false, hunks: [{
        header: '@@ -95 +95 @@', lines: [{ type: 'del', text: 'line 95', oldNo: 95, newNo: null }, { type: 'add', text: 'line 95 changed', oldNo: null, newNo: 95 }],
      }] }
      const edit = { repo: `/context-${layout}`, load: async () => w.contextText, save: async (_path: string, _loaded: string, text: string) => { w.contextSaved = text; return true }, onError: (error: unknown) => { throw error } }
      document.getElementById('root')!.innerHTML = '<div class="diff-pane" style="height:740px;overflow:auto"></div>'
      w.contextRoot = createRoot(document.querySelector('.diff-pane'))
      flushSync(() => w.contextRoot.render(createElement(DiffView, { files: [file], moves: [], edit, onExpand: () => undefined })))
    }, layout)
    await page.waitForSelector('.ed-preview')
    expect(await page.locator('.context-toggle button').count()).toBe(4)
    for (const [context, first] of [[3, 92], [10, 85], [25, 70], [100000, 1]]) {
      await choose(context)
      expect(await page.evaluate(() => Math.min(...[...document.querySelectorAll<HTMLElement>('.ed-line[data-new]')].map(row => Number(row.dataset.new))))).toBe(first)
    }
    await choose(3)
    await page.locator('.ed-preview').press('Enter')
    await page.waitForSelector('.cm-content')
    await page.evaluate(() => {
      const w = window as any
      w.contextEditor = w.under.mountedEditors.get(document.querySelector('.diff-editor'))
      const view = w.contextEditor.view, at = view.state.doc.line(95).to
      view.dispatch({ changes: { from: at, insert: ' unsaved' }, selection: { anchor: at + 8 } })
      w.contextSelection = view.state.selection.main.head
    })
    for (const [context, hidden] of [[10, 84], [25, 69], [100000, 0], [3, 91]]) {
      await choose(context)
      const result = await page.evaluate(() => {
        const w = window as any, editor = w.under.mountedEditors.get(document.querySelector('.diff-editor'))
        return { same: editor === w.contextEditor, text: editor.view.state.doc.line(95).text, selection: editor.view.state.selection.main.head === w.contextSelection,
          hidden: Number(editor.view.dom.querySelector('.cm-collapsedLines')?.textContent?.match(/\d+/)?.[0] ?? 0) }
      })
      expect(result).toEqual({ same: true, text: 'line 95 changed unsaved', selection: true, hidden })
    }
    await page.evaluate(() => (window as any).contextEditor.view.focus())
    await page.keyboard.press('Meta+s')
    await page.waitForFunction(() => (window as any).contextSaved !== null)
    expect(await page.evaluate(() => (window as any).contextSaved.split('\n')[94])).toBe('line 95 changed unsaved')
    await page.evaluate(() => (window as any).contextRoot.unmount())
  }
  await page.setViewportSize({ width: 800, height: 600 })
})

test.skipIf(!playwright)('saved working hunks keep stage and discard actions in previews and live editors across context changes', async () => {
  await page.setViewportSize({ width: 1200, height: 800 })
  for (const layout of ['unified', 'split']) {
    await page.evaluate((layout: string) => {
      const w = window as any
      const { createElement, flushSync, createRoot, DiffView, setDiffLayout, setContextLines } = w.under
      setContextLines(3); setDiffLayout(layout)
      const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`)
      lines[29] += ' changed'; lines[89] += ' changed'
      const file = { oldPath: 'hunks.txt', newPath: 'hunks.txt', status: 'modified', binary: false,
        hunks: [30, 90].map(line => ({ header: `@@ -${line} +${line} @@`, id: String(line).padStart(64, '0'), lines: [
          { type: 'del', text: `line ${line}`, oldNo: line, newNo: null }, { type: 'add', text: `line ${line} changed`, oldNo: null, newNo: line },
        ] })) }
      w.hunkWrites = []
      const edit = { repo: `/hunks-${layout}`, load: async () => lines.join('\n'), save: async () => true, onError: (error: unknown) => { throw error } }
      const stage = { staged: false, busy: null, onToggle() {}, onDiscard() {}, onHunk: (path: string, hunk: unknown, action: string) => w.hunkWrites.push({ path, hunk, action }) }
      document.getElementById('root')!.innerHTML = '<div class="diff-pane" style="height:740px;overflow:auto"></div>'
      w.hunkRoot = createRoot(document.querySelector('.diff-pane'))
      flushSync(() => w.hunkRoot.render(createElement(DiffView, { files: [file], moves: [], edit, stage, onExpand() {} })))
    }, layout)
    await page.waitForSelector('.ed-preview .hunk-actions')
    expect(await page.getByRole('button', { name: 'Stage hunk at line', exact: false }).count()).toBe(2)
    await page.locator('.ed-line[data-new="30"] code').click()
    await page.waitForSelector('.cm-content')
    // Merely entering the editor must not lose the hunk actions before any text was changed.
    expect(await page.getByRole('button', { name: 'Stage hunk at line', exact: false }).count()).toBe(2)
    await page.evaluate(() => {
      const w = window as any
      w.hunkEditor = w.under.mountedEditors.get(document.querySelector('.diff-editor'))
    })
    for (const context of [10, 25, 100000, 3]) {
      await page.locator('.context-toggle button').filter({ hasText: new RegExp(`^${context === 100000 ? 'All' : context}$`) }).click()
      // CodeMirror draws only the viewport; visit both hunks when a wider context puts one off screen.
      for (const [line, edge] of [[30, 'top'], [90, 'bottom']] as const) {
        await page.locator('.diff-pane').evaluate((pane: HTMLElement, edge: string) => { pane.scrollTop = edge === 'top' ? 0 : pane.scrollHeight }, edge)
        const button = page.getByRole('button', { name: `Discard hunk at line ${line} of hunks.txt`, exact: true })
        await button.waitFor()
        expect(await button.isVisible()).toBe(true)
      }
      expect(await page.evaluate(() => {
        const w = window as any
        return w.under.mountedEditors.get(document.querySelector('.diff-editor')) === w.hunkEditor
      })).toBe(true)
    }
    await page.locator('.diff-pane').evaluate((pane: HTMLElement) => { pane.scrollTop = 0 })
    await page.getByRole('button', { name: 'Stage hunk at line 30 of hunks.txt', exact: true }).click()
    await page.getByRole('button', { name: 'Discard hunk at line 90 of hunks.txt', exact: true }).click()
    expect(await page.evaluate(() => (window as any).hunkWrites.map(({ path, hunk, action }: any) => [path, hunk.header, hunk.id, action]))).toEqual([
      ['hunks.txt', '@@ -30 +30 @@', '30'.padStart(64, '0'), 'stage'], ['hunks.txt', '@@ -90 +90 @@', '90'.padStart(64, '0'), 'discard'],
    ])
    await page.evaluate(() => {
      const view = (window as any).hunkEditor.view
      view.dispatch({ changes: { from: view.state.doc.line(30).to, insert: ' unsaved' } })
    })
    await page.waitForFunction(() => !document.querySelector('.hunk-actions'))
    expect(await page.getByRole('button', { name: 'Stage hunk at line', exact: false }).count()).toBe(0)
    await page.evaluate(() => (window as any).hunkEditor.replace(Array.from({ length: 120 }, (_, i) => `line ${i + 1}${i === 29 || i === 89 ? ' changed' : ''}`).join('\n')))
    for (const [line, edge] of [[30, 'top'], [90, 'bottom']] as const) {
      await page.locator('.diff-pane').evaluate((pane: HTMLElement, edge: string) => { pane.scrollTop = edge === 'top' ? 0 : pane.scrollHeight }, edge)
      const button = page.getByRole('button', { name: `Stage hunk at line ${line} of hunks.txt`, exact: true })
      await button.waitFor()
      expect(await button.isVisible()).toBe(true)
    }
    await page.evaluate(() => (window as any).hunkRoot.unmount())
  }
  await page.setViewportSize({ width: 800, height: 600 })
})

test.skipIf(!playwright)('file headers match the Files pane fill and remain full width, square and sticky in Changes and History', async () => {
  for (const view of ['changes', 'history']) for (const theme of ['light', 'dark', 'custom-light', 'custom-dark']) {
    await page.evaluate(({ view, theme }: { view: string; theme: string }) => {
      const w = window as any
      const { createElement, createRoot, flushSync, DiffView } = w.under
      document.documentElement.dataset.theme = theme.endsWith('dark') ? 'dark' : 'light'
      document.documentElement.style.cssText = `--window: ${theme.endsWith('dark') ? '#303640' : '#d0d5de'}; ${theme.startsWith('custom') ? `--content: ${theme.endsWith('dark') ? '#263341' : '#ebeef4'}; --list: ${theme.endsWith('dark') ? '#313b4a' : '#cbd5e1'}` : ''}`
      const rail = '<div class="diff-rail"><div class="diff-pane"></div></div>'
      document.getElementById('root')!.innerHTML = `<div class="${view}" style="height:450px;width:780px;grid-template-columns:120px minmax(0,1fr)">${view === 'history' ? `<div class="history-list"></div><div class="commit-detail has-commit" style="grid-template-columns:120px minmax(0,1fr)"><div class="commit-info"></div>${rail}</div>` : `<div class="file-list"></div>${rail}`}</div>`
      const files = ['first.txt', 'second.txt'].map(path => ({ oldPath: path, newPath: path, status: 'modified', binary: false, hunks: [{ header: '@@ -1,40 +1,40 @@', lines: Array.from({ length: 40 }, (_, index) => ({ type: 'context', text: `line ${index + 1}`, oldNo: index + 1, newNo: index + 1 })) }] }))
      w.headerRoot = createRoot(document.querySelector('.diff-pane'))
      flushSync(() => w.headerRoot.render(createElement(DiffView, { files, moves: [] })))
    }, { view, theme })
    await page.locator('.diff-file > header').first().waitFor()
    const result = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.diff-pane')!, file = document.querySelector<HTMLElement>('.diff-file')!, header = file.querySelector('header')!
      const box = pane.getBoundingClientRect(), head = header.getBoundingClientRect(), style = getComputedStyle(header)
      return { left: head.left - box.left - pane.clientLeft, width: head.width - pane.clientWidth, radius: style.borderRadius, border: getComputedStyle(file).borderWidth,
        gap: parseFloat(getComputedStyle(file).marginTop), overflow: getComputedStyle(pane).overflowY, horizontal: pane.scrollWidth - pane.clientWidth,
        visibility: getComputedStyle(file).contentVisibility, headerFill: style.backgroundColor, filesFill: getComputedStyle(document.querySelector('.file-list, .commit-info')!).backgroundColor, image: style.backgroundImage }
    })
    expect([result.left, result.width, result.radius, result.border]).toEqual([0, 0, '0px', '0px'])
    expect([result.gap, result.overflow, result.horizontal, result.visibility, result.image]).toEqual([8, 'auto', 0, 'auto', 'none'])
    expect(result.headerFill).toBe(result.filesFill)
    await page.locator('.diff-pane').evaluate((pane: HTMLElement) => { pane.scrollTop = 100 })
    const sticky = await page.evaluate(() => document.querySelector('.diff-file > header')!.getBoundingClientRect().top - document.querySelector('.diff-pane')!.getBoundingClientRect().top)
    expect(Math.abs(sticky - 40)).toBeLessThan(1)
    await page.evaluate(() => (window as any).headerRoot.unmount())
  }
  await page.evaluate(() => { document.documentElement.style.cssText = ''; document.documentElement.dataset.theme = 'dark' })
})

test.skipIf(!playwright)('primary buttons keep readable theme colours on hover in light, dark and custom light themes', async () => {
  for (const theme of ['light', 'dark', 'custom-light']) {
    await page.evaluate((theme: string) => {
      document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
      document.documentElement.style.cssText = theme === 'custom-light' ? '--accent-fill: #ffd700; --on-accent: #111114' : ''
      document.getElementById('root')!.innerHTML = '<button class="primary">Done</button>'
    }, theme)
    await page.hover('.primary')
    await page.waitForTimeout(180)
    const colours = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.primary')!)
      // Account for the hover filter when comparing the actual painted colours.
      const brightness = Number(style.filter.match(/brightness\(([^)]+)\)/)?.[1] ?? 1)
      const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number)
      const light = (channels: number[]) => channels.slice(0, 3).map((value) => {
        const s = Math.min(255, value * brightness) / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const bg = rgb(style.backgroundColor)
      const alpha = bg[3] ?? 1
      const background = light(bg.map((value, index) => index < 3 ? value * alpha + 255 * (1 - alpha) : value))
      const foreground = light(rgb(style.color))
      return { background: style.backgroundColor, contrast: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) }
    })
    expect(colours.contrast).toBeGreaterThanOrEqual(4.5)
  }
  await page.evaluate(() => { document.documentElement.style.cssText = ''; document.documentElement.dataset.theme = 'dark' })
})

test.skipIf(!playwright)('repository hover and keyboard focus give branch width back to the name and keep badges', async () => {
  await page.mouse.move(799, 599)
  await page.evaluate(() => {
    document.getElementById('root')!.innerHTML = '<div role="treeitem" tabindex="0" style="width:260px"><div class="tree-row repo selected"><span class="row-icon has-row-action"><button class="icon-button">×</button></span><span class="tree-label" title="a-long-repository-name">a-long-repository-name</span><span class="repo-branch">feature/long-branch</span><span class="repo-dirty">2</span></div></div>'
  })
  const widths = () => page.evaluate(() => ({
    name: document.querySelector('.tree-label')!.getBoundingClientRect().width,
    badge: document.querySelector('.repo-dirty')!.getBoundingClientRect().width,
    branch: getComputedStyle(document.querySelector('.repo-branch')!).display,
    action: document.querySelector('.icon-button')!.getBoundingClientRect().width,
  }))
  const before = await widths()
  await page.hover('.tree-row.repo')
  const hovered = await widths()
  expect(hovered.name).toBeGreaterThan(before.name + 50)
  expect(hovered.branch).toBe('none')
  expect([hovered.badge, hovered.action]).toEqual([before.badge, before.action])
  await page.mouse.move(799, 599)
  await page.keyboard.press('Tab')
  expect(await widths()).toEqual(hovered)
})

test.skipIf(!playwright)('Themes combines selection and installation while Appearance changes preserve theme choices', async () => {
  await page.evaluate(() => {
    const w = window as any
    const { createElement, flushSync, createRoot, SettingsDialog, applyAppearance } = w.under
    const ref = (file: string) => `acme.theme/${file}.json`
    const extension = { id: 'acme.theme', name: 'Fixture', publisher: 'acme', version: '1', themes: [
      { ref: ref('light'), label: 'Fixture Light', dark: false }, { ref: ref('dark'), label: 'Fixture Dark', dark: true },
    ], iconThemes: [{ ref: ref('icons'), label: 'Fixture Icons' }] }
    let installed = [extension]
    w.detailRequests = []
    w.installRequests = []
    w.themeReads = []
    w.metadataRequests = []
    w.externalRequests = []
    w.detailMode = 'pending'
    const metadata = (namespace: string, name: string) => ({ namespace, name, displayName: 'Fixture', description: 'Fixture theme', version: '1', downloads: 1200, averageRating: 4.5, reviewCount: 2, icon: 'https://open-vsx.org/api/acme/theme/file/icon.png', url: 'https://open-vsx.org/extension/acme/theme' })
    const details = (namespace: string, name: string) => ({ ...metadata(namespace, name), readme: w.detailMode === 'empty' ? null : '# Fixture README\n\nReadable **theme** documentation.\n\n[Guide](./guide.md)\n\n![Theme screenshot](./shot.png)\n\n[unsafe](javascript:alert(1))\n\n<script>window.readmeExecuted = true</script>\n\n```js\nconst example = "safe"\n```', readmeBaseUrl: 'https://open-vsx.org/api/acme/theme/file/README.md' })
    Object.assign(w.bettergit, {
      listExtensions: async () => installed,
      searchExtensions: async () => [{ namespace: 'Acme', name: 'theme', displayName: 'Fixture', description: 'Fixture theme', version: '1', downloads: 1, averageRating: null, reviewCount: null, icon: null }],
      colorTheme: async (ref: string) => { w.themeReads.push(ref); return { name: ref, label: ref, dark: ref.includes('dark'), colors: {}, tokenColors: [] } },
      iconTheme: async (ref: string) => { w.themeReads.push(ref); return { name: ref, icons: {}, fontIcons: 0, fileExtensions: {}, fileNames: {}, languageIds: {}, light: {} } },
      extensionMetadata: async (namespace: string, name: string) => { w.metadataRequests.push([namespace, name]); return metadata(namespace, name) },
      extensionDetails: async (namespace: string, name: string) => {
        w.detailRequests.push([namespace, name])
        if (w.detailMode === 'error') throw new Error('README unavailable')
        if (w.detailMode === 'pending') return new Promise((resolve) => { w.finishDetails = () => resolve(details(namespace, name)) })
        return details(namespace, name)
      },
      extensionImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r9sAAAAASUVORK5CYII=',
      openExternal: async (url: string) => { w.externalRequests.push(url) },
      installExtension: async (...args: string[]) => { w.installRequests.push(args); installed = [extension]; return extension },
      installExtensionFile: async () => { w.installRequests.push('file'); return null },
      removeExtension: async () => { installed = [] },
    })
    w.settingsConfig = { sources: [], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null, settings: {
      theme: 'light', backgroundFetch: true, fetchIntervalMinutes: 10, idleThresholdSeconds: 120, textZoom: 1, languages: {}, editor: 'vscode',
      appearance: { uiFontSize: 15, density: 'compact', lightTheme: ref('light'), darkTheme: ref('dark'), iconTheme: ref('icons') },
    } }
    w.settingsWrites = []
    w.settingsRoot = createRoot(document.getElementById('root')!)
    const render = () => flushSync(() => w.settingsRoot.render(createElement(SettingsDialog, {
      config: w.settingsConfig,
      onUpdate: (patch: any) => {
        w.settingsWrites.push(patch)
        w.settingsConfig.settings = { ...w.settingsConfig.settings, ...patch.settings }
        render()
      },
      onClose: () => w.settingsRoot.unmount(),
    })))
    sessionStorage.setItem('bettergit.settingsSection', 'extensions')
    applyAppearance(w.settingsConfig.settings.appearance)
    render()
  })
  await page.waitForFunction(() => (document.querySelector('#icon-theme') as HTMLSelectElement)?.value === 'acme.theme/icons.json')
  expect(await page.getByRole('tab', { name: 'Themes', exact: true }).getAttribute('aria-selected')).toBe('true')
  expect(await page.getByRole('tab', { name: 'Extensions', exact: true }).count()).toBe(0)
  expect(await page.getByRole('radiogroup', { name: 'Appearance', exact: true }).count()).toBe(1)
  expect(await page.getByRole('button', { name: 'Remove Fixture' }).count()).toBe(1)
  expect(await page.inputValue('#light-theme')).toBe('acme.theme/light.json')
  expect(await page.inputValue('#dark-theme')).toBe('acme.theme/dark.json')
  expect(await page.evaluate(() => (window as any).detailRequests)).toEqual([])
  await page.waitForSelector('img.extension-logo')
  expect(await page.getByText(/1,200 downloads.*4.5\/5/).count()).toBe(1)
  expect(await page.getByText(/Open VSX.*Unrated/).count()).toBe(1)
  expect(await page.getByRole('img', { name: 'Fixture logo unavailable' }).count()).toBe(1)
  const detailsAction = page.getByRole('button', { name: 'Details for Fixture', exact: true }).first()
  expect(await detailsAction.getAttribute('class')).toContain('icon-button')
  expect(await detailsAction.textContent()).toBe('')
  await detailsAction.hover()
  await page.locator('.tooltip').filter({ hasText: 'Details for Fixture' }).waitFor()
  await page.mouse.move(799, 599)
  await detailsAction.press('Tab')
  expect(await page.getByRole('button', { name: 'Remove Fixture' }).evaluate((button: HTMLElement) => document.activeElement === button)).toBe(true)
  await page.locator('.tooltip').filter({ hasText: 'Remove Fixture' }).waitFor()
  const checkStats = async () => {
    const stats = await page.evaluate(() => {
      const root = document.documentElement, saved = root.style.cssText, mode = root.dataset.theme
      const check = () => [...document.querySelectorAll<HTMLElement>('.extension-stats')].map(element => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!
        canvas.width = canvas.height = 1
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1)
        const ancestors: Element[] = []
        for (let at: Element | null = element; at; at = at.parentElement) ancestors.unshift(at)
        for (const at of ancestors) { ctx.fillStyle = getComputedStyle(at).backgroundColor; ctx.fillRect(0, 0, 1, 1) }
        const light = (rgb: number[]) => rgb.slice(0, 3).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
        const background = light([...ctx.getImageData(0, 0, 1, 1).data])
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(element).color; ctx.fillRect(0, 0, 1, 1)
        const foreground = light([...ctx.getImageData(0, 0, 1, 1).data])
        return { groups: element.children.length, fits: element.scrollWidth <= element.clientWidth, size: parseFloat(getComputedStyle(element).fontSize), contrast: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05) }
      })
      const output = ['light', 'dark', 'custom-light'].flatMap(theme => {
        root.style.cssText = saved
        root.dataset.theme = theme === 'dark' ? 'dark' : 'light'
        if (theme === 'custom-light') { root.style.setProperty('--content', '#e8edf4'); root.style.setProperty('--text', '#172137'); root.style.setProperty('--text-2', '#35445a') }
        return check()
      })
      root.style.cssText = saved; root.dataset.theme = mode
      return output
    })
    for (const row of stats) { expect(row.groups).toBe(3); expect(row.fits).toBe(true); expect(row.size).toBeGreaterThanOrEqual(12.5); expect(row.contrast).toBeGreaterThanOrEqual(4.5) }
  }
  await checkStats()
  const reads = await page.evaluate(() => (window as any).themeReads.length)
  await page.getByRole('button', { name: 'Details for Fixture', exact: true }).nth(0).click()
  expect(await page.getByRole('status').textContent()).toBe('Loading extension details…')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).count()).toBe(1)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Details for Fixture')
  await page.evaluate(() => { (window as any).finishDetails(); (window as any).detailMode = 'normal' })
  await page.getByRole('button', { name: 'Details for Fixture', exact: true }).nth(1).click()
  await page.getByRole('heading', { name: 'Fixture README', exact: true }).waitFor()
  expect(await page.locator('.extension-details-meta .extension-stats > span').count()).toBe(3)
  expect(await page.locator('.extension-details-meta .extension-stats').evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await checkStats()
  expect(await page.locator('.extension-readme strong').textContent()).toBe('theme')
  expect(await page.locator('.extension-readme script, .extension-readme iframe').count()).toBe(0)
  expect(await page.evaluate(() => (window as any).readmeExecuted)).toBeUndefined()
  expect(await page.locator('.extension-readme a[href^="javascript:"]').count()).toBe(0)
  await page.getByRole('link', { name: 'Guide', exact: true }).click()
  expect(await page.evaluate(() => (window as any).externalRequests)).toEqual(['https://open-vsx.org/api/acme/theme/file/guide.md'])
  await page.keyboard.press('Escape')
  expect(await page.getByRole('dialog').count()).toBe(1)
  expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).getAttribute('inert')).toBeNull()
  expect(await page.evaluate(() => document.getElementById('root')!.hasAttribute('inert'))).toBe(true)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Details for Fixture')
  expect(await page.evaluate(() => (window as any).detailRequests)).toEqual([['acme', 'theme'], ['Acme', 'theme']])
  expect(await page.evaluate(() => (window as any).installRequests)).toEqual([])
  expect(await page.evaluate(() => (window as any).themeReads.length)).toBe(reads)
  await page.selectOption('#light-theme', '')
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
  expect(await page.locator('#light-theme, #dark-theme, #icon-theme').count()).toBe(0)
  expect(await page.getByRole('searchbox').count()).toBe(0)
  expect(await page.getByRole('radiogroup', { name: 'Density', exact: true }).count()).toBe(1)
  expect(await page.inputValue('#ui-font-size')).toBe('15')
  await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
  expect(await page.evaluate(() => (window as any).settingsWrites.at(-1).settings.appearance)).toEqual({ lightTheme: '', darkTheme: 'acme.theme/dark.json', iconTheme: 'acme.theme/icons.json' })
  expect(await page.inputValue('#ui-font-size')).toBe('13')
  await page.getByRole('tab', { name: 'Themes', exact: true }).click()
  await page.getByRole('button', { name: 'Remove Fixture' }).click()
  await page.waitForFunction(() => (document.querySelector('#icon-theme') as HTMLSelectElement)?.value === '')
  expect(await page.inputValue('#dark-theme')).toBe('')
  await page.getByRole('searchbox').fill('Fixture')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page.getByRole('button', { name: 'Details for Fixture', exact: true }).click()
  await page.getByRole('heading', { name: 'Fixture README', exact: true }).waitFor()
  expect(await page.evaluate(() => (window as any).detailRequests.at(-1))).toEqual(['Acme', 'theme'])
  expect(await page.evaluate(() => (window as any).installRequests)).toEqual([])
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.evaluate(() => { (window as any).detailMode = 'empty' })
  await page.getByRole('button', { name: 'Details for Fixture', exact: true }).click()
  await page.getByText('No README is available for this extension.', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.evaluate(() => { (window as any).detailMode = 'error' })
  await page.getByRole('button', { name: 'Details for Fixture', exact: true }).click()
  expect(await page.getByRole('alert').textContent()).toBe('README unavailable')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Install Fixture', exact: true }).click()
  await page.getByRole('button', { name: 'Install from .vsix…', exact: true }).click()
  expect(await page.getByRole('button', { name: 'Remove Fixture' }).count()).toBe(1)
  expect(await page.inputValue('#light-theme')).toBe('')
  await page.evaluate(() => (window as any).settingsRoot.unmount())
})

test.skipIf(!playwright)('Flow Icons README HTML renders through safe links and image data while dialog controls remain usable', async () => {
  const requests: string[] = []
  const onRequest = (request: any) => requests.push(request.url())
  page.on('request', onRequest)
  await page.emulateMedia({ colorScheme: 'light' })
  try {
    await page.evaluate(() => {
      const w = window as any
      const { createElement, flushSync, createRoot, SettingsDialog } = w.under
      // Header and picture from the shipped thang-nm.flow-icons 2.0.10 README.
      const readme = `<h1 align="center">
  <img src="https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/logo.png" width="160" alt="Flow Icons"/><br/>
  <a href="https://marketplace.visualstudio.com/items?itemName=thang-nm.flow-icons">Flow Icons</a>
</h1>

<p align="center">
  🌼 A brand new premium icon pack for VSCode
</p>

<p align="center">
  💎 <strong>IMPORTANT</strong> 💎<br>
  <a target="_blank" href="https://flow-icons.pages.dev">
    <img src="https://img.shields.io/badge/Get_full-Flow_Icons-blue?colorA=363a4f&colorB=c6a0f6&style=for-the-badge">
  </a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/preview_light.png">
    <img width="640" src="https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/preview.png">
  </picture>
</p>

Mixed <strong>safe **Markdown**</strong> prose. [Guide](./guide.md)

<details><summary>More</summary><p>Readable details</p></details>
<table><tr><th>Kind</th><td>Icons</td></tr></table>
<pre><code>&lt;safe&gt;</code></pre>
<a href="./guide.html">HTML guide</a><img src="./safe.png" alt="Relative image">
<script>window.readmeExecuted = true</script>
<img src="javascript:alert(1)" onerror="window.readmeExecuted = true" alt="Unsafe image">
<a href="javascript:alert(1)" onclick="window.readmeExecuted = true">Unsafe link</a>
<a href="https://user:password@example.org/">Credential link</a>
<p style="position:fixed" onmouseover="window.readmeExecuted = true">Safe text</p>
<iframe src="https://example.org/frame" srcdoc="<script>alert(1)</script>"></iframe>
<object data="https://example.org/object"></object><form action="https://example.org/"><input autofocus></form>
<svg onload="window.readmeExecuted = true"><script>alert(1)</script></svg>`
      w.htmlImages = []; w.htmlLinks = []; w.htmlArchives = []
      Object.assign(w.bettergit, {
        listExtensions: async () => [],
        searchExtensions: async () => [{ namespace: 'thang-nm', name: 'flow-icons', displayName: 'Flow Icons', description: '', version: '2.0.10', downloads: 0 }],
        extensionDetails: async () => ({ namespace: 'thang-nm', name: 'flow-icons', displayName: 'Flow Icons', description: '', version: '2.0.10', downloads: null, averageRating: null, reviewCount: null, icon: null, url: 'https://open-vsx.org/extension/thang-nm/flow-icons', readme: w.htmlReadme ?? readme, readmeBaseUrl: 'https://open-vsx.org/api/thang-nm/flow-icons/2.0.10/file/readme.md' }),
        extensionImage: async (url: string) => { w.htmlImages.push(url); return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r9sAAAAASUVORK5CYII=' },
        openExternal: async (url: string) => { w.htmlLinks.push(url) },
        installExtension: async (...args: unknown[]) => { w.htmlArchives.push(args) },
        installExtensionFile: async () => { w.htmlArchives.push('file') },
      })
      sessionStorage.setItem('bettergit.settingsSection', 'themes')
      w.htmlRoot = createRoot(document.getElementById('root')!)
      flushSync(() => w.htmlRoot.render(createElement(SettingsDialog, {
        config: { sources: [], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null, settings: { theme: 'light', backgroundFetch: true, fetchIntervalMinutes: 10, idleThresholdSeconds: 120, textZoom: 1, languages: {}, editor: 'vscode', appearance: {} } },
        onUpdate() {}, onClose: () => w.htmlRoot.unmount(),
      })))
    })
    const details = page.getByRole('button', { name: 'Details for Flow Icons', exact: true })
    await details.click()
    await page.locator('.extension-readme h1 img').waitFor({ timeout: 3000 })
    expect(await page.locator('.extension-readme h1 a').textContent()).toBe('Flow Icons')
    expect(await page.locator('.extension-readme h1').evaluate((heading: HTMLElement) => getComputedStyle(heading).textAlign)).toBe('center')
    expect(await page.locator('.extension-readme h1 img').getAttribute('width')).toBe('160')
    expect(await page.locator('.extension-readme picture img').getAttribute('width')).toBe('640')
    expect(await page.locator('.extension-readme strong strong').textContent()).toBe('Markdown')
    expect(await page.locator('.extension-readme th').textContent()).toBe('Kind')
    expect(await page.locator('.extension-readme pre code').textContent()).toBe('<safe>')
    expect(await page.locator('.extension-readme').textContent()).not.toContain('<h1')
    expect(await page.locator('.extension-readme [onerror], .extension-readme [onclick], .extension-readme [onmouseover], .extension-readme [style="position:fixed"]').count()).toBe(0)
    expect(await page.locator('.extension-readme script, .extension-readme iframe, .extension-readme object, .extension-readme form, .extension-readme svg, .extension-readme input').count()).toBe(0)
    expect(await page.locator('.extension-readme a[href^="javascript:"], .extension-readme a[href*="password"]').count()).toBe(0)
    expect(await page.locator('.extension-readme img:not([src^="data:image/"])').count()).toBe(0)
    const images = await page.evaluate(() => (window as any).htmlImages)
    expect(images).toContain('https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/logo.png')
    expect(images).toContain('https://raw.githubusercontent.com/thang-nm/Flow-Icons/main/preview_light.png')
    expect(images).toContain('https://img.shields.io/badge/Get_full-Flow_Icons-blue?colorA=363a4f&colorB=c6a0f6&style=for-the-badge')
    expect(images).toContain('https://open-vsx.org/api/thang-nm/flow-icons/2.0.10/file/safe.png')
    expect(images.every((url: string) => url.startsWith('https://'))).toBe(true)
    await page.getByRole('link', { name: 'HTML guide', exact: true }).click()
    expect(await page.evaluate(() => (window as any).htmlLinks)).toEqual(['https://open-vsx.org/api/thang-nm/flow-icons/2.0.10/file/guide.html'])
    await page.locator('.extension-readme summary').click()
    expect(await page.getByText('Readable details', { exact: true }).isVisible()).toBe(true)
    expect(await page.evaluate(() => (window as any).readmeExecuted)).toBeUndefined()
    expect(requests.filter((url) => /^https?:/.test(url))).toEqual([])
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    expect(await details.evaluate((button: HTMLElement) => document.activeElement === button)).toBe(true)
    await page.evaluate(() => { (window as any).htmlReadme = '<details open><summary>More</summary><p>Readable details</p></details>' })
    await details.click()
    await page.locator('.extension-readme summary').waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).focus()
    await page.keyboard.press('Tab')
    expect(await page.locator('.extension-readme summary').evaluate((summary: HTMLElement) => document.activeElement === summary)).toBe(true)
    await page.keyboard.press('Shift+Tab')
    expect(await page.getByRole('button', { name: 'Close', exact: true }).evaluate((button: HTMLElement) => document.activeElement === button)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).getAttribute('inert')).toBeNull()
    expect(await page.getByRole('dialog').count()).toBe(1)
    expect(await page.evaluate(() => (window as any).htmlArchives)).toEqual([])
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await page.getByRole('dialog').count()).toBe(0)
  } finally {
    page.off('request', onRequest)
    await page.evaluate(() => (window as any).htmlRoot?.unmount())
    await page.emulateMedia({ colorScheme: 'dark' })
  }
})

test.skipIf(!playwright)('README fenced JSON comments use theme tokens without changing text, inline code or unknown languages', async () => {
  // Settings excerpt from the shipped Flow Icons 2.0.10 jsonc fence.
  const code = '{\n  // Your license key\n  "flow-icons.licenseKey": "",\n\n  // Set default folder color\n  "flow-icons.folderColor": "gray",\n}'
  const palettes: string[] = []
  try {
    for (const language of ['jsonc', 'JSON', 'unknown-readme-language']) {
      await page.evaluate(({ code, language }: { code: string; language: string }) => {
        const w = window as any
        const { createElement, createRoot, flushSync, SettingsDialog } = w.under
        Object.assign(w.bettergit, {
          listExtensions: async () => [],
          searchExtensions: async () => [{ namespace: 'thang-nm', name: 'flow-icons', displayName: 'Flow Icons', description: '', version: '2.0.10', downloads: 0 }],
          extensionDetails: async () => ({ namespace: 'thang-nm', name: 'flow-icons', displayName: 'Flow Icons', description: '', version: '2.0.10', downloads: null, averageRating: null, reviewCount: null, icon: null, url: 'https://open-vsx.org/extension/thang-nm/flow-icons', readme: 'Inline `plain` code.\n\n```' + language + '\n' + code + '\n```', readmeBaseUrl: null }),
        })
        sessionStorage.setItem('bettergit.settingsSection', 'themes')
        w.syntaxRoot = createRoot(document.getElementById('root')!)
        flushSync(() => w.syntaxRoot.render(createElement(SettingsDialog, {
          config: { sources: [], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null, settings: { theme: 'dark', backgroundFetch: true, fetchIntervalMinutes: 10, idleThresholdSeconds: 120, textZoom: 1, languages: {}, editor: 'vscode', appearance: {} } },
          onUpdate() {}, onClose: () => w.syntaxRoot.unmount(),
        })))
      }, { code, language })
      await page.getByRole('button', { name: 'Details for Flow Icons', exact: true }).click()
      await page.locator('.extension-readme pre code').waitFor()
      if (language !== 'unknown-readme-language') await page.locator('.extension-readme pre .tok').first().waitFor({ timeout: 3000 })
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme }, theme)
        expect(await page.locator('.extension-readme pre code').textContent()).toBe(code)
        expect(await page.locator('.extension-readme p code').textContent()).toBe('plain')
        expect(await page.locator('.extension-readme p code .tok').count()).toBe(0)
        const colours = await page.locator('.extension-readme pre code').evaluate((element: HTMLElement) => {
          const tokens = [...element.querySelectorAll<HTMLElement>('.tok')]
          const comment = tokens.find(token => token.textContent?.includes('Your license key')), property = tokens.find(token => token.textContent?.includes('flow-icons.licenseKey'))
          return { comment: comment && getComputedStyle(comment).color, property: property && getComputedStyle(property).color, count: tokens.length }
        })
        if (language === 'unknown-readme-language') expect(colours.count).toBe(0)
        else { expect(colours.comment).not.toBe(colours.property); if (language === 'jsonc') palettes.push(colours.property) }
      }
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Done', exact: true }).click()
    }
    expect(palettes[0]).not.toBe(palettes[1])
  } finally {
    await page.evaluate(() => { (window as any).syntaxRoot?.unmount(); document.documentElement.dataset.theme = 'dark' })
  }
})

test.skipIf(!playwright)('deeply nested extension READMEs fall back to text and keep Close, Escape and Settings usable', async () => {
  const errors: string[] = []
  const onError = (error: Error) => errors.push(error.message)
  page.on('pageerror', onError)
  try {
    await page.evaluate(() => {
      const w = window as any
      const { createElement, flushSync, createRoot, SettingsDialog } = w.under
      w.archiveRequests = []
      Object.assign(w.bettergit, {
        listExtensions: async () => [],
        searchExtensions: async () => [{ namespace: 'acme', name: 'nested', displayName: 'Nested', description: '', version: '1', downloads: 0 }],
        extensionDetails: async () => ({ namespace: 'acme', name: 'nested', displayName: 'Nested', description: '', version: '1', downloads: null, averageRating: null, reviewCount: null, icon: null, url: 'https://open-vsx.org/extension/acme/nested', readme: w.nestedReadme, readmeBaseUrl: null }),
        installExtension: async (...args: unknown[]) => { w.archiveRequests.push(args) },
        installExtensionFile: async () => { w.archiveRequests.push('file') },
      })
      sessionStorage.setItem('bettergit.settingsSection', 'themes')
      w.nestedRoot = createRoot(document.getElementById('root')!)
      flushSync(() => w.nestedRoot.render(createElement(SettingsDialog, {
        config: { sources: [], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null, settings: { theme: 'dark', backgroundFetch: true, fetchIntervalMinutes: 10, idleThresholdSeconds: 120, textZoom: 1, languages: {}, editor: 'vscode', appearance: {} } },
        onUpdate() {}, onClose: () => w.nestedRoot.unmount(),
      })))
    })
    const details = page.getByRole('button', { name: 'Details for Nested', exact: true })
    for (const [format, depth, close] of [['markdown', 6000, 'button'], ['markdown', 256, 'escape'], ['html', 256, 'button']] as const) {
      await page.evaluate(({ format, depth }: { format: string; depth: number }) => {
        (window as any).nestedReadme = format === 'html' ? '<div>'.repeat(depth) + 'text' + '</div>'.repeat(depth) : '> '.repeat(depth) + 'text' + (depth === 256 ? ' <script>window.readmeExecuted = true</script>' : '')
      }, { format, depth })
      await details.click()
      await page.waitForFunction(() => document.querySelector('.extension-readme') || !document.querySelector('[role="dialog"]'))
      expect(errors).toEqual([])
      await page.getByText('README formatting is too complex to display. Showing plain text.', { exact: true }).waitFor({ timeout: 3000 })
      expect(await page.locator('.extension-readme pre code').textContent()).toBe(await page.evaluate(() => (window as any).nestedReadme))
      expect(await page.locator('.extension-readme script').count()).toBe(0)
      if (close === 'button') await page.getByRole('button', { name: 'Close', exact: true }).click()
      else await page.keyboard.press('Escape')
      expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).count()).toBe(1)
      expect(await page.getByRole('dialog').count()).toBe(1)
      expect(await page.getByRole('dialog', { name: 'Settings', exact: true }).getAttribute('inert')).toBeNull()
      expect(await details.evaluate((button: HTMLElement) => document.activeElement === button)).toBe(true)
    }
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    expect(await page.getByRole('radiogroup', { name: 'Density', exact: true }).count()).toBe(1)
    expect(await page.evaluate(() => (window as any).archiveRequests)).toEqual([])
    expect(errors).toEqual([])
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.locator('#root').getAttribute('inert')).toBeNull()
  } finally {
    page.off('pageerror', onError)
    await page.evaluate(() => (window as any).nestedRoot?.unmount())
  }
})

test.skipIf(!playwright)('a click maps to the current-side line and column, on wrapped lines and in split view', async () => {
  const result = await page.evaluate(() => {
    const { lineColumnAt } = (window as any).under
    const text = "const value = 'a long line that wraps around the narrow column several times over and over again'"
    document.getElementById('root')!.innerHTML = `
      <div class="ed-preview ed-unified" style="width: 320px; --digits-a: 1; --digits-b: 2">
        <div class="ed-line add side-b" data-new="12"><span class="ed-num">12</span><span class="ed-bar"></span><code><span class="sx"><span class="tok">const </span><span>${text.slice(6)}</span></span></code></div>
        <div class="ed-line del side-a" data-old="11"><span class="ed-num"></span><span class="ed-bar"></span><code><span class="sx">${text}</span></code></div>
      </div>
      <div class="ed-preview ed-split" style="width: 640px; --digits-a: 1; --digits-b: 1">
        <div class="ed-pair">
          <div class="ed-line old side-a" data-old="3"><span class="ed-num">3</span><span class="ed-bar"></span><code><span class="sx">${text}</span></code></div>
          <div class="ed-line add side-b" data-new="4"><span class="ed-num">4</span><span class="ed-bar"></span><code><span class="sx">${text}</span></code></div>
        </div>
      </div>`
    // The caret position at the middle of a character, the way a click there is resolved.
    const clickAt = (row: Element, index: number) => {
      const code = row.querySelector('code')!
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      let offset = 0
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (index < offset + node.data.length) {
          const range = document.createRange()
          range.setStart(node, index - offset)
          range.setEnd(node, index - offset + 1)
          const box = range.getBoundingClientRect()
          const caret = (document as any).caretPositionFromPoint(box.left + 1, box.top + box.height / 2)
          return { at: lineColumnAt(caret.offsetNode, caret.offset), wrapped: box.top - row.getBoundingClientRect().top >= 22 }
        }
        offset += node.data.length
      }
      return null
    }
    const [added, removed] = document.querySelectorAll('.ed-unified .ed-line')
    const [old, current] = document.querySelectorAll('.ed-split .ed-line')
    const gutter = added.querySelector('.ed-num')!.getBoundingClientRect()
    const inGutter = (document as any).caretPositionFromPoint(gutter.left + 2, gutter.top + 5)
    return {
      first: clickAt(added, 3),
      wrapped: clickAt(added, 70),
      removed: clickAt(removed, 10),
      oldSide: clickAt(old, 20),
      currentSide: clickAt(current, 50),
      gutter: lineColumnAt(inGutter.offsetNode, inGutter.offset),
    }
  })
  expect(result.first).toEqual({ at: { line: 12, column: 3 }, wrapped: false })
  // Past the first visual line of a wrapped row, the column still counts from the line's start.
  expect(result.wrapped).toEqual({ at: { line: 12, column: 70 }, wrapped: true })
  // Removed lines and the old side stay read-only.
  expect(result.removed?.at).toBeNull()
  expect(result.oldSide?.at).toBeNull()
  expect(result.currentSide?.at).toEqual({ line: 4, column: 50 })
  expect(result.gutter).toEqual({ line: 12, column: 0 })
})

test.skipIf(!playwright)('keys typed before the editor mounts are typed into it, at the caret', async () => {
  const text = await page.evaluate(() => {
    const { bufferedKey, typeKeys, EditorState, EditorSelection } = (window as any).under
    const events = ['X', 'Y', 'Backspace', 'Enter', 'é', 'Shift', 'ArrowLeft'].map((key) => ({ key, metaKey: false, ctrlKey: false }))
    events.push({ key: 's', metaKey: true, ctrlKey: false })
    const keys = events.map(bufferedKey).filter((key: unknown) => key !== null)
    let state = EditorState.create({ doc: 'hello', selection: EditorSelection.cursor(2) })
    typeKeys({ get state() { return state }, dispatch: (tr: any) => { state = tr.state } }, keys)
    return state.doc.toString()
  })
  expect(text).toBe('heX\néllo')
})

test.skipIf(!playwright)('find highlights matches in rows that mount after the query is set', async () => {
  const sizes = await page.evaluate(async () => {
    const { setFindQuery, watchFind } = (window as any).under
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    const size = () => (CSS as any).highlights.get('find-match')?.size ?? 0
    document.getElementById('root')!.innerHTML = '<div class="diff"><div class="row-chunk"><div class="line"><code><span class="sx">a Needle b</span></code></div></div></div>'
    const container = document.querySelector<HTMLElement>('.diff')!
    const stop = watchFind(container)
    setFindQuery('needle')
    const atStart = size()
    // A chunk scrolls near the screen and its rows mount.
    const chunk = document.createElement('div')
    chunk.className = 'row-chunk'
    chunk.innerHTML = '<div class="line"><code><span class="sx"><span class="tok">nee</span>dle and needle</span></code></div>'
    container.appendChild(chunk)
    await settle()
    const mounted = size()
    // The first chunk unmounts as it scrolls away.
    container.firstElementChild!.remove()
    await settle()
    const unmounted = size()
    setFindQuery('')
    const cleared = size()
    stop()
    return { atStart, mounted, unmounted, cleared }
  })
  // The match split across two coloured spans counts too.
  expect(sizes).toEqual({ atStart: 1, mounted: 3, unmounted: 2, cleared: 0 })
})

// A click on the read-only rows of a file still loading keeps the keys typed until its editor mounts. The capture must
// end when the load fails or the file unmounts, and must never take keys typed into another field.
test.skipIf(!playwright)('keys typed while a file loads are not taken from other fields, nor after the load fails or the file goes', async () => {
  const start = () => page.evaluate(async () => {
    const { createElement, flushSync, createRoot, EditableDiff } = (window as any).under
    document.body.insertAdjacentHTML('beforeend', '<input id="other">')
    const w = window as any
    w.root = createRoot(document.getElementById('root')!)
    const edit = { repo: 'r', load: () => new Promise((done, fail) => { w.failLoad = () => fail(new Error('gone')); w.finishLoad = () => done('hello') }), save: async () => true, onError: () => undefined }
    const hunks = [{ header: '@@ -1 +1 @@', lines: [{ type: 'context', text: 'hello', oldNo: 1, newNo: 1 }] }]
    const fallback = createElement('div', { 'data-source-row': '0:0:0', 'data-source-side': 'new' }, createElement('code', null, 'hello'))
    // A new path each time, since the draft one run types into outlives it.
    w.run = (w.run ?? 0) + 1
    flushSync(() => w.root.render(createElement(EditableDiff, { edit, path: `a${w.run}.ts`, hunks, layout: 'unified', language: null, fallback, fileIndex: 0, onExtent: () => undefined })))
    const row = document.querySelector('[data-source-row]')!.getBoundingClientRect()
    for (const type of ['mousedown', 'mouseup']) {
      document.querySelector('[data-source-row]')!.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: row.left + 2, clientY: row.top + 2 }))
    }
    while (!w.failLoad) await new Promise((resolve) => setTimeout(resolve, 10))
  })
  // Whether a key typed with nothing focused was taken, and what typing into another field gives it.
  const probe = async () => {
    const taken = await page.evaluate(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
      return !document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }))
    })
    await page.fill('#other', '')
    await page.focus('#other')
    await page.keyboard.type('hi')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    return { taken, typed: await page.inputValue('#other') }
  }
  const reset = () => page.evaluate(() => {
    ;(window as any).root?.unmount()
    ;(window as any).failLoad = null
    document.getElementById('other')?.remove()
  })

  await start()
  expect(await probe()).toEqual({ taken: true, typed: 'h' })
  await page.evaluate(async () => {
    ;(window as any).failLoad()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(await probe()).toEqual({ taken: false, typed: 'h' })
  await reset()

  await start()
  await page.evaluate(() => (window as any).root.unmount())
  expect(await probe()).toEqual({ taken: false, typed: 'h' })
  await reset()

  // The keys go into the editor the load mounts, unless the capture ended first: a blur (or the timeout) drops them.
  const finish = (blur: boolean) => page.evaluate(async (blur: boolean) => {
    const press = () => !document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }))
    const taken = press()
    if (blur) window.dispatchEvent(new Event('blur'))
    ;(window as any).finishLoad()
    for (let tries = 0; tries < 100 && !document.querySelector('.cm-content, .ed-preview'); tries++) await new Promise((resolve) => setTimeout(resolve, 20))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const content = document.querySelector('.cm-content')
    return { taken, editor: content && [...content.querySelectorAll(':scope > .cm-line')].map((line) => line.textContent).join('\n') }
  }, blur)
  await start()
  expect(await finish(false)).toEqual({ taken: true, editor: 'qhello' })
  await reset()
  await start()
  expect(await finish(true)).toEqual({ taken: true, editor: null })
  await reset()
})

test.skipIf(!playwright)('find recounts matches when a diff refreshes with the same number of files', async () => {
  const fileWith = (text: string) => [{ oldPath: 'a.ts', newPath: 'a.ts', status: 'modified', binary: false, hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', text, oldNo: null, newNo: 1 }] }] }]
  const render = (files: unknown) => page.evaluate((files: unknown) => {
    const { createElement, flushSync, createRoot, FindBar, FindDiff } = (window as any).under
    const w = window as any
    w.findRoot ??= createRoot(document.getElementById('root')!)
    flushSync(() => w.findRoot.render([createElement(FindDiff, { key: 'diff', files }), createElement(FindBar, { key: 'bar', open: true, focusKey: 0, onClose: () => undefined })]))
  }, files)
  await render(fileWith('one needle'))
  await page.fill('.find-bar input', 'needle')
  expect(await page.textContent('.find-count')).toBe('1 of 1')
  await render(fileWith('needle and needle'))
  expect(await page.textContent('.find-count')).toBe('1 of 2')
  await page.evaluate(() => (window as any).findRoot.unmount())
})

test.skipIf(!playwright)('clearing find stops a reveal still under way: no later scroll, no highlight', async () => {
  const result = await page.evaluate(async () => {
    const { revealMatch, clearHighlight } = (window as any).under
    const frames = (count: number) => new Promise<void>((resolve) => {
      const tick = () => (count-- ? requestAnimationFrame(tick) : resolve())
      tick()
    })
    // A match far down, in a chunk whose rows are not mounted yet, so the reveal keeps scrolling to it frame by frame.
    document.getElementById('root')!.innerHTML = `
      <div class="diff-pane" style="height: 200px; overflow: auto">
        <div class="diff"><div data-file-index="0"><div style="height: 5000px"></div><div data-lines="0:0:0:99" style="height: 400px"></div></div></div>
      </div>`
    const pane = document.querySelector<HTMLElement>('.diff-pane')!
    const container = document.querySelector<HTMLElement>('.diff')!
    const lines = Array.from({ length: 100 }, (_, index) => ({ type: 'context', text: index === 50 ? 'needle' : 'line', oldNo: index + 1, newNo: index + 1 }))
    const files = [{ oldPath: 'a.ts', newPath: 'a.ts', status: 'modified', binary: false, hunks: [{ header: '@@ -1,100 +1,100 @@', lines }] }]
    void revealMatch({ container: { current: container }, files, openFile: () => undefined }, { file: 0, hunk: 0, line: 50, start: 0, end: 6 })
    const scrolled = pane.scrollTop > 0
    clearHighlight()
    pane.scrollTop = 0
    // The row mounts after find was cleared.
    container.querySelector('[data-lines]')!.insertAdjacentHTML('beforeend', '<div data-source-row="0:0:50"><code>needle</code></div>')
    await frames(5)
    return { scrolled, after: pane.scrollTop, highlighted: (CSS as any).highlights.has('find-current') }
  })
  expect(result).toEqual({ scrolled: true, after: 0, highlighted: false })
})

test.skipIf(!playwright)('clearing find while a reveal waits for a removed row in the unified editor stops it there', async () => {
  // The editor on screen, and off screen, where the reveal would first scroll to it.
  const run = (spacer: number) => page.evaluate(async (spacer: number) => {
    const { revealMatch, clearHighlight, mountedEditors } = (window as any).under
    const frames = (count: number) => new Promise<void>((resolve) => {
      const tick = () => (count-- ? requestAnimationFrame(tick) : resolve())
      tick()
    })
    // An editor whose removed block has not drawn yet, so the reveal waits for the row frame by frame.
    document.getElementById('root')!.innerHTML = `
      <div class="diff-pane" style="height: 200px; overflow: auto">
        <div class="diff"><div data-file-index="0"><div style="height: ${spacer}px"></div><div class="diff-editor" style="height: 400px"></div></div></div>
      </div>`
    const pane = document.querySelector<HTMLElement>('.diff-pane')!
    const container = document.querySelector<HTMLElement>('.diff')!
    const calls: string[] = []
    mountedEditors.set(container.querySelector('.diff-editor'), {
      unfold: () => calls.push('unfold'),
      deletedLine: () => null,
      reveal: () => calls.push('reveal'),
      unmark: () => undefined,
    })
    const lines = [{ type: 'del', text: 'needle', oldNo: 1, newNo: null }, { type: 'context', text: 'line', oldNo: 2, newNo: 1 }]
    const files = [{ oldPath: 'a.ts', newPath: 'a.ts', status: 'modified', binary: false, hunks: [{ header: '@@ -1,2 +1 @@', lines }] }]
    void revealMatch({ container: { current: container }, files, openFile: () => undefined }, { file: 0, hunk: 0, line: 0, start: 0, end: 6 })
    await frames(3)
    clearHighlight()
    await frames(40)
    return { calls, scrollTop: pane.scrollTop, highlighted: (CSS as any).highlights.has('find-current') }
  }, spacer)
  // The fold opens before the wait; nothing is revealed, scrolled or marked after find is cleared.
  expect(await run(0)).toEqual({ calls: ['unfold'], scrollTop: 0, highlighted: false })
  expect(await run(5000)).toEqual({ calls: ['unfold'], scrollTop: 0, highlighted: false })
})
