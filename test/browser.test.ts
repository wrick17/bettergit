import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { git } from '../src/main/git/exec'
import { readStatus } from '../src/main/git/status'
import { workingDiff } from '../src/main/git/diff'
import { discardPaths, deleteUntracked } from '../src/main/git/ops'
import { applyHunk, type HunkAction, type HunkRequest } from '../src/main/git/hunks'
import { cleanup } from './helpers'
import { loadConflict, resetConflict, takeConflictSide } from '../src/main/git/conflict'

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

test.skipIf(!playwright)('two-click file controls cancel safely and never arm ordinary or blocked actions', async () => {
  await page.evaluate(() => {
    const w = window as any
    const { createElement, createRoot, flushSync, IconButton } = w.under
    w.confirmCalls = 0
    w.confirmRoot = createRoot(document.getElementById('root'))
    w.renderConfirm = (props = {}) => flushSync(() => w.confirmRoot.render(createElement(IconButton, {
      icon: 'trash', label: 'Delete test.txt', confirm: 'Delete', onClick: () => w.confirmCalls++, ...props,
    })))
    w.renderConfirm()
  })
  const button = page.locator('#root > button')
  const calls = () => page.evaluate(() => (window as any).confirmCalls)
  try {
    await button.click()
    expect(await calls()).toBe(0)
    expect(await button.innerText()).toBe('Delete!')
    expect(await page.locator('.confirm-tooltip').innerText()).toBe('Click again to confirm')
    expect(await page.locator('.confirm-tooltip').evaluate((tip: HTMLElement) => getComputedStyle(tip).animationName)).toBe('none')
    await page.keyboard.press('Escape')
    expect(await button.getAttribute('class')).not.toContain('confirm-armed')
    await button.click()
    await page.mouse.move(700, 500)
    expect(await button.getAttribute('class')).not.toContain('confirm-armed')
    await button.focus()
    await page.keyboard.press('Enter')
    await button.dispatchEvent('keydown', { key: 'Enter', repeat: true })
    expect(await calls()).toBe(0)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    expect(await button.getAttribute('class')).not.toContain('confirm-armed')
    await button.click()
    await button.evaluate((node: HTMLButtonElement) => node.blur())
    expect(await button.getAttribute('class')).not.toContain('confirm-armed')
    await button.click()
    await page.evaluate(() => (window as any).renderConfirm({ label: 'Delete other.txt' }))
    await button.click()
    expect(await calls()).toBe(0)
    await button.click()
    expect(await calls()).toBe(1)
    await page.evaluate(() => (window as any).renderConfirm({ busy: true }))
    await button.dispatchEvent('click')
    expect(await calls()).toBe(1)
    await page.evaluate(() => (window as any).renderConfirm({ blocked: 'Another action is running.' }))
    await button.dispatchEvent('click')
    expect(await calls()).toBe(1)
    await page.evaluate(() => (window as any).renderConfirm({ confirm: undefined, label: 'Stage test.txt' }))
    await button.click()
    expect(await calls()).toBe(2)
  } finally {
    await page.evaluate(() => (window as any).confirmRoot.unmount())
  }
})

test.skipIf(!playwright)('file and hunk destruction reaches Git only on the second click in a disposable repo', async () => {
  page.setDefaultTimeout(10000)
  const previousView = await page.evaluate(() => localStorage.getItem('bettergit.changesView'))
  const repo = mkdtempSync(path.join(tmpdir(), 'bettergit-two-click-'))
  const tracked = path.join(repo, 'tracked.txt')
  const untracked = path.join(repo, 'scratch.txt')
  const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const changed = base.replace('line 2\n', 'line 2 changed\n').replace('line 3\n', 'line  3\n').replace('line 28\n', 'line 28 changed\n')
  const writes: string[] = []
  const dialogs: string[] = []
  const errors: string[] = []
  const dialog = async (entry: any) => { dialogs.push(entry.message()); await entry.dismiss() }
  page.on('dialog', dialog)
  try {
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'user.email', 'test@example.test'])
    await git(repo, ['config', 'core.hooksPath', path.join(repo, '.git/hooks')])
    writeFileSync(tracked, base)
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'Test baseline'])
    writeFileSync(tracked, changed)
    writeFileSync(untracked, 'disposable scratch\n')
    await page.exposeFunction('fileTestStatus', () => readStatus(repo))
    await page.exposeFunction('fileTestWorking', async (staged: boolean, context: number, file?: string, hideWhitespace?: boolean) => ({ files: await workingDiff(repo, staged, context, file, hideWhitespace), moves: [] }))
    await page.exposeFunction('fileTestRead', (file: string) => readFileSync(path.join(repo, file), 'utf8'))
    await page.exposeFunction('fileTestWrite', async (action: string, file: string, request?: HunkRequest) => {
      expect(['tracked.txt', 'scratch.txt']).toContain(file)
      writes.push(action)
      if (request) await applyHunk(repo, action as HunkAction, request)
      else if (action === 'delete') await deleteUntracked(repo, file)
      else if (action === 'discard') await discardPaths(repo, [file])
    })
    await page.exposeFunction('fileTestError', (error: string) => { errors.push(error) })
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.evaluate(async (repo: string) => {
      const w = window as any
      const { createElement, createRoot, flushSync, ChangesView, setContextLines } = w.under
      setContextLines(3)
      Object.assign(w.bettergit, {
        commitIdentity: async () => ({ name: 'Test', email: 'test@example.test', error: null }),
        working: (_repo: string, staged: boolean, context: number, file?: string, hideWhitespace?: boolean) => w.fileTestWorking(staged, context, file, hideWhitespace),
        readFile: (_repo: string, file: string) => w.fileTestRead(file),
        discard: (_repo: string, files: string[]) => w.fileTestWrite('discard', files[0]),
        deleteUntracked: (_repo: string, file: string) => w.fileTestWrite('delete', file),
        applyHunk: (_repo: string, action: string, request: any) => w.fileTestWrite(action, request.path, request),
      })
      document.getElementById('root')!.style.cssText = 'display:flex;height:850px;width:1400px'
      w.fileTestRoot = createRoot(document.getElementById('root'))
      let revision = 0
      w.fileTestRender = async () => {
        const status = await w.fileTestStatus()
        flushSync(() => w.fileTestRoot.render(createElement(ChangesView, {
          repo, status, revision: revision++, listOpen: true, detailOpen: true,
          onChanged: w.fileTestRender, onError: (error: unknown) => w.fileTestError(String(error)),
        })))
      }
      await w.fileTestRender()
    }, repo)
    // Start with the screenshot's hidden-whitespace setting at the real ChangesView/Git seam.
    for (const layout of ['unified', 'split']) {
      await page.evaluate((layout: string) => {
        const { setDiffLayout, setIgnoreWhitespace } = (window as any).under
        setDiffLayout(layout); setIgnoreWhitespace(true)
      }, layout)
      const reveal = page.getByRole('button', { name: 'Show whitespace to change this hunk', exact: true }).first()
      await reveal.waitFor()
      expect(await page.getByRole('button', { name: 'Stage hunk at line 1 of tracked.txt', exact: true }).isDisabled()).toBe(true)
      const before = writes.length
      await reveal.click()
      expect(writes.length).toBe(before)
      await page.getByRole('button', { name: 'Stage hunk at line 1 of tracked.txt', exact: true }).click()
      await page.getByRole('button', { name: 'Unstage hunk at line 1 of tracked.txt', exact: true }).waitFor()
      expect(await git(repo, ['show', ':tracked.txt'])).toBe(base.replace('line 2\n', 'line 2 changed\n').replace('line 3\n', 'line  3\n'))
      expect(readFileSync(tracked, 'utf8')).toBe(changed)
      await page.evaluate(() => (window as any).under.setIgnoreWhitespace(true))
      const staged = page.locator('[data-section="staged"]')
      await staged.getByRole('button', { name: 'Show whitespace to change this hunk', exact: true }).waitFor()
      expect(await staged.getByRole('button', { name: 'Unstage hunk at line 1 of tracked.txt', exact: true }).isDisabled()).toBe(true)
      await staged.getByRole('button', { name: 'Show whitespace to change this hunk', exact: true }).click()
      await page.getByRole('button', { name: 'Unstage hunk at line 1 of tracked.txt', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
      expect(await git(repo, ['show', ':tracked.txt'])).toBe(base)
      expect(readFileSync(tracked, 'utf8')).toBe(changed)
    }
    expect(writes).toEqual(['stage', 'unstage', 'stage', 'unstage'])
    writes.length = 0
    await page.evaluate(() => (window as any).under.setDiffLayout('unified'))
    const fileButton = (name: string) => page.locator('.diff-file-actions').getByRole('button', { name, exact: true })
    const deleteButton = fileButton('Delete untracked file scratch.txt')
    await deleteButton.click()
    expect(existsSync(untracked)).toBe(true)
    expect(writes).toEqual([])
    await fileButton('Delete untracked file scratch.txt. Click again to confirm').click()
    await page.waitForFunction(() => !document.querySelector('.diff-file[data-path="scratch.txt"]'))
    expect(existsSync(untracked)).toBe(false)
    expect(writes).toEqual(['delete'])

    const hunk = page.getByRole('button', { name: 'Discard hunk at line 1 of tracked.txt', exact: true }).first()
    await hunk.click()
    expect(readFileSync(tracked, 'utf8')).toBe(changed)
    await page.getByRole('button', { name: 'Discard hunk at line 1 of tracked.txt. Click again to confirm', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.confirm-armed'))
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
    expect(readFileSync(tracked, 'utf8')).toBe(base.replace('line 28\n', 'line 28 changed\n'))

    await fileButton('Discard changes to tracked.txt').click()
    expect(readFileSync(tracked, 'utf8')).not.toBe(base)
    await fileButton('Discard changes to tracked.txt. Click again to confirm').click()
    await page.waitForFunction(() => !document.querySelector('.diff-file[data-path="tracked.txt"]'))
    expect(readFileSync(tracked, 'utf8')).toBe(base)

    // List and tree rows share the same file handler, and must also arm before it runs.
    for (const mode of ['list', 'tree']) {
      writeFileSync(tracked, changed)
      await page.evaluate(() => (window as any).fileTestRender())
      await page.getByRole('button', { name: mode === 'list' ? /^List view/ : /^Tree view/ }).click()
      const row = page.locator('.file-list').getByRole('button', { name: 'Discard changes to tracked.txt', exact: true })
      await row.locator('..').hover()
      await row.click()
      expect(readFileSync(tracked, 'utf8')).toBe(changed)
      await page.locator('.file-list').getByRole('button', { name: 'Discard changes to tracked.txt. Click again to confirm', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('.diff-file[data-path="tracked.txt"]'))
      expect(readFileSync(tracked, 'utf8')).toBe(base)
    }
    writeFileSync(tracked, changed)
    await page.evaluate(() => (window as any).fileTestRender())
    await page.locator('.ed-line[data-new="2"] code').click()
    await page.waitForSelector('.cm-content')
    await page.keyboard.type(' unsaved')
    const draft = page.getByRole('button', { name: 'Discard edits to tracked.txt', exact: true })
    await draft.click()
    expect(await page.locator('.cm-content').innerText()).toContain('unsaved')
    await page.getByRole('button', { name: 'Discard edits to tracked.txt. Click again to confirm', exact: true }).click()
    expect(await page.locator('.cm-content').innerText()).not.toContain('unsaved')
    expect(readFileSync(tracked, 'utf8')).toBe(changed)
    await page.locator('.cm-content').click()
    await page.keyboard.type(' unsaved')
    await fileButton('Stage tracked.txt. Discards unsaved edits').click()
    expect(await page.locator('.cm-content').innerText()).toContain('unsaved')
    await page.keyboard.press('Escape')
    await fileButton('Discard changes to tracked.txt').click()
    expect(await page.locator('.cm-content').innerText()).toContain('unsaved')
    await fileButton('Discard changes to tracked.txt. Click again to confirm').click()
    await page.waitForFunction(() => !document.querySelector('.diff-file[data-path="tracked.txt"]'))
    expect(readFileSync(tracked, 'utf8')).toBe(base)
    expect(writes).toEqual(['delete', 'discard', 'discard', 'discard', 'discard', 'discard'])

    // A real merge conflict exercises whole-file reset and both side replacements.
    await git(repo, ['checkout', '-qb', 'incoming'])
    writeFileSync(tracked, 'theirs\n')
    await git(repo, ['commit', '-qam', 'Incoming test edit'])
    await git(repo, ['checkout', '-q', '-'])
    writeFileSync(tracked, 'ours\n')
    await git(repo, ['commit', '-qam', 'Current test edit'])
    await expect(git(repo, ['merge', 'incoming'])).rejects.toThrow()
    const conflictWrites: string[] = []
    await page.exposeFunction('fileTestConflict', () => loadConflict(repo, 'tracked.txt'))
    await page.exposeFunction('fileTestReset', async (request: Parameters<typeof resetConflict>[2]) => {
      conflictWrites.push('reset')
      return resetConflict(repo, 'tracked.txt', request)
    })
    await page.exposeFunction('fileTestTake', async (request: Parameters<typeof takeConflictSide>[2]) => {
      conflictWrites.push(request.side)
      return takeConflictSide(repo, 'tracked.txt', request)
    })
    await page.evaluate(() => {
      const w = window as any
      Object.assign(w.bettergit, {
        conflictLoad: () => w.fileTestConflict(),
        conflictReset: (_repo: string, _file: string, request: unknown) => w.fileTestReset(request),
        conflictTake: (_repo: string, _file: string, request: unknown) => w.fileTestTake(request),
      })
      return w.fileTestRender()
    })
    for (const [label, expected] of [
      ['Resolve using ours, the current side, for tracked.txt', 'ours\n'],
      ['Reset resolution', null],
      ['Resolve using theirs, the incoming side, for tracked.txt', 'theirs\n'],
    ] as const) {
      const before = readFileSync(tracked, 'utf8')
      await page.getByRole('button', { name: label, exact: true }).click()
      expect(readFileSync(tracked, 'utf8')).toBe(before)
      await page.getByRole('button', { name: `${label}. Click again to confirm`, exact: true }).click()
      await page.waitForFunction(async (expected: string | null) => {
        const text = await (window as any).fileTestRead('tracked.txt')
        return expected === null ? text.includes('<<<<<<<') : text === expected
      }, expected)
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'))
      await page.waitForFunction((markers: boolean) => !!document.querySelector('.conflict-count')?.textContent?.includes('of') === markers, expected === null)
      if (expected) expect(readFileSync(tracked, 'utf8')).toBe(expected)
      else expect(readFileSync(tracked, 'utf8')).toContain('<<<<<<<')
    }
    expect(conflictWrites).toEqual(['ours', 'reset', 'theirs'])
    expect((await readStatus(repo)).changes[0].conflicted).toBe(true)
    expect(dialogs).toEqual([])
    expect(errors).toEqual([])
  } finally {
    page.off('dialog', dialog)
    await page.evaluate(() => { (window as any).fileTestRoot?.unmount(); document.getElementById('root')!.style.cssText = '' })
    await page.setViewportSize({ width: 800, height: 600 })
    cleanup(repo)
    await page.evaluate((value: string | null) => {
      if (value === null) localStorage.removeItem('bettergit.changesView')
      else localStorage.setItem('bettergit.changesView', value)
    }, previousView)
    page.setDefaultTimeout(30000)
  }
}, 60000)

for (const layout of ['unified', 'split'] as const) test.skipIf(!playwright)(`staging and unstaging a file keeps neighbouring diff rows and the visible scroll anchor (${layout})`, async () => {
  await page.setViewportSize({ width: 1400, height: 800 })
  const rootStyle = await page.locator('#root').getAttribute('style') ?? ''
  await page.evaluate((layout: 'unified' | 'split') => {
    const w = window as any
    const { createElement, createRoot, flushSync, ChangesView, setContextLines, setDiffLayout } = w.under
    setContextLines(3); setDiffLayout(layout)
    const paths = ['a.txt', 'b.txt', 'c.txt']
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}${i === 29 || i === 169 ? ' changed' : ''}`)
    const files = paths.map(path => ({ oldPath: path, newPath: path, status: 'modified', binary: false,
      hunks: [30, 170].map(line => ({ header: `@@ -${line - 3},7 +${line - 3},7 @@`, id: `${path}:${line}`,
        lines: Array.from({ length: 7 }, (_, i) => line - 3 + i).flatMap<object>(n => n === line
          ? [{ type: 'del', text: `line ${n}`, oldNo: n, newNo: null }, { type: 'add', text: `line ${n} changed`, oldNo: null, newNo: n }]
          : [{ type: 'context', text: `line ${n}`, oldNo: n, newNo: n }]) })) }))
    let staged = false, revision = 0
    w.stageErrors = []
    Object.assign(w.bettergit, {
      commitIdentity: async () => ({ name: 'Browser Author', email: 'author@example.test', error: null }),
      readFile: async () => lines.join('\n'),
      working: async (_repo: string, cached: boolean) => ({ files: structuredClone(files.filter(f => cached ? staged && f.newPath === 'a.txt' : !staged || f.newPath !== 'a.txt')), moves: [] }),
      stage: async () => { staged = true }, unstage: async () => { staged = false },
    })
    document.getElementById('root')!.style.cssText = 'display:flex;flex-direction:column;height:760px;width:1400px'
    w.stageRoot = createRoot(document.getElementById('root'))
    const render = () => flushSync(() => w.stageRoot.render(createElement(ChangesView, {
      repo: '/stage-browser', status: { changes: paths.map(path => ({ path, kind: 'modified', staged: staged && path === 'a.txt', unstaged: !staged || path !== 'a.txt', conflicted: false })) },
      revision: revision++, listOpen: true, detailOpen: true, onChanged: render, onError: (error: unknown) => w.stageErrors.push(String(error)),
    })))
    render()
  }, layout)
  try {
    await page.waitForFunction(() => document.querySelectorAll('[data-section="unstaged"] .ed-preview').length === 3, undefined, { timeout: 3000 }).catch(async (error: Error) => {
      throw new Error(`${error.message}\n${await page.evaluate(() => JSON.stringify({ errors: (window as any).stageErrors, text: document.getElementById('root')?.innerText.slice(0, 1500), previews: document.querySelectorAll('.ed-preview').length }))}`)
    })
    await page.locator('.diff-pane').evaluate((pane: HTMLElement) => {
      const file = pane.querySelector<HTMLElement>('[data-section="unstaged"] [data-path="b.txt"]')!
      pane.scrollTop = file.offsetTop + 80
    })
    // Settle the observer work before sampling frames through the stage and reverse transition.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await page.locator('.diff-pane').evaluate((pane: HTMLElement) => pane.scrollTop)).toBeGreaterThan(0)
    expect(await page.locator('.diff-pane').evaluate((pane: HTMLElement) => pane.querySelector('[data-path="a.txt"]')!.getBoundingClientRect().bottom <= pane.getBoundingClientRect().top)).toBe(true)
    for (const action of ['Stage', 'Unstage']) {
      await page.evaluate(() => {
        const w = window as any
        const pane = document.querySelector('.diff-pane')!
        const file = pane.querySelector('[data-section="unstaged"] [data-path="b.txt"]')!
        w.stageNeighbour = file.querySelector('.ed-preview')
        w.stageSamples = []
        w.stageSampling = true
        const sample = () => {
          if (!w.stageSampling) return
          const current = pane.querySelector('[data-section="unstaged"] [data-path="b.txt"]')
          w.stageSamples.push({ same: current?.querySelector('.ed-preview') === w.stageNeighbour,
            top: current?.getBoundingClientRect().top, blank: !current?.querySelector('code')?.textContent })
          requestAnimationFrame(sample)
        }
        sample()
      })
      const button = page.locator('.file-list').getByRole('button', { name: `${action} a.txt`, exact: true }).first()
      await button.locator('xpath=ancestor::li').hover({ timeout: 1500 })
      await button.click({ timeout: 1500 })
      await page.waitForFunction((staged: boolean) => !!document.querySelector('[data-section="staged"] [data-path="a.txt"]') === staged, action === 'Stage', { timeout: 1500 }).catch(async (error: Error) => {
        throw new Error(`${action}: ${error.message}\n${await page.evaluate(() => JSON.stringify({ errors: (window as any).stageErrors, text: document.getElementById('root')?.innerText.slice(0, 1500) }))}`)
      })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const samples = await page.evaluate(() => { const w = window as any; w.stageSampling = false; return w.stageSamples })
      expect(samples.every((sample: any) => sample.same), `${action} replaced an unchanged neighbour's preview`).toBe(true)
      expect(samples.every((sample: any) => !sample.blank), `${action} exposed an empty neighbour`).toBe(true)
      expect(await page.locator('[data-section="unstaged"] [data-path="a.txt"]').count()).toBe(action === 'Stage' ? 0 : 1)
      expect(await page.locator('[data-section="staged"] [data-path="a.txt"]').count()).toBe(action === 'Stage' ? 1 : 0)
      expect(Math.max(...samples.map((sample: any) => sample.top)) - Math.min(...samples.map((sample: any) => sample.top)), `${action} moved the visible neighbour between frames`).toBeLessThanOrEqual(2)
    }
    expect(await page.evaluate(() => (window as any).stageErrors)).toEqual([])
  } finally {
    await page.evaluate(() => { const w = window as any; w.stageSampling = false; w.stageRoot.unmount() })
    await page.locator('#root').evaluate((root: HTMLElement, style: string) => { root.style.cssText = style }, rootStyle)
    await page.setViewportSize({ width: 800, height: 600 })
  }
})

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

test.skipIf(!playwright)('unified deleted imports align and keep syntax and inline highlights in preview and editor', async () => {
  await page.evaluate(() => {
    const w = window as any
    const { createElement, createRoot, flushSync, DiffView, setDiffLayout, setContextLines } = w.under
    setDiffLayout('unified'); setContextLines(3)
    const before = ["import React from 'react';", "import { Router, Redirect, useLocation } from 'host/router';", "import { Query } from 'query';"]
    const after = before.map(line => line.replace('Redirect, ', ''))
    const file = { oldPath: 'imports.ts', newPath: 'imports.ts', status: 'modified', binary: false, hunks: [{ header: '@@ -1,3 +1,3 @@', lines: [
      { type: 'context', text: before[0], oldNo: 1, newNo: 1 },
      { type: 'del', text: before[1], oldNo: 2, newNo: null },
      { type: 'add', text: after[1], oldNo: null, newNo: 2 },
      { type: 'context', text: before[2], oldNo: 3, newNo: 3 },
    ] }] }
    w.syntaxFile = file
    w.syntaxRoot = createRoot(document.getElementById('root'))
    flushSync(() => w.syntaxRoot.render(createElement(DiffView, { files: [file], moves: [], edit: {
      repo: '/syntax-imports', load: async () => after.join('\n'), save: async () => true, onError: (error: unknown) => { throw error },
    } })))
  })
  try {
    await page.waitForSelector('.ed-preview .tok')
    for (const live of [false, true]) {
      if (live) {
        await page.locator('.ed-line[data-new="2"] code').click()
        await page.waitForSelector('.cm-line .tok')
        await page.waitForSelector('.cm-deletedLine .tok')
      }
      const result = await page.evaluate((live: boolean) => {
        const deleted = document.querySelector(live ? '.cm-deletedLine' : '.ed-line.del code')!
        const added = document.querySelector(live ? '.cm-changedLine' : '.ed-line.add code')!
        const context = document.querySelector(live ? '.cm-line' : '.ed-line code')!
        const start = (line: Element) => {
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
          const text = walker.nextNode()!
          const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1)
          return range.getBoundingClientRect().left
        }
        const colour = (line: Element) => getComputedStyle(line.querySelector('.tok') ?? line).color
        return { offset: start(deleted) - start(added), contextOffset: start(context) - start(added),
          deletedColour: colour(deleted), addedColour: colour(added), contextColour: colour(context),
          marked: deleted.querySelector(live ? '.cm-deletedText' : '.ed-changed')?.textContent,
          full: deleted.classList.contains('cm-fullChange') }
      }, live)
      expect(Math.abs(result.offset)).toBeLessThan(1)
      expect(Math.abs(result.contextOffset)).toBeLessThan(1)
      expect(result.deletedColour).toBe(result.addedColour)
      expect(result.contextColour).toBe(result.addedColour)
      expect(result.marked).toContain('Redirect')
      expect(result.full).toBe(false)
    }
    await page.evaluate(async () => {
      const w = window as any
      const start = w.syntaxFile.hunks[0].lines[1].text.indexOf('Redirect')
      w.under.setFindQuery('Redirect')
      await w.under.revealMatch({ container: { current: document.querySelector('.diff') }, files: [w.syntaxFile], openFile() {} },
        { file: 0, hunk: 0, line: 1, start, end: start + 'Redirect'.length })
      w.syntaxToken = document.querySelector('.cm-deletedLine .tok')
      w.under.setSyntaxThemes(null, { name: 'find-recolour', label: 'Find recolour', dark: true, colors: {}, tokenColors: [] })
    })
    await page.waitForFunction(() => document.querySelector('.cm-deletedLine .tok') !== (window as any).syntaxToken)
    expect(await page.evaluate(() => [...((CSS as any).highlights.get('find-current') ?? [])].map((range: Range) => range.toString()))).toEqual(['Redirect'])
  } finally {
    await page.evaluate(() => {
      const w = window as any
      w.under.clearHighlight(); w.under.setFindQuery(''); w.under.setSyntaxThemes(null, null); w.syntaxRoot.unmount()
    })
  }
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
    expect(await page.evaluate(() => (window as any).hunkWrites.length)).toBe(1)
    await page.getByRole('button', { name: 'Discard hunk at line 90 of hunks.txt. Click again to confirm', exact: true }).click()
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

test.skipIf(!playwright)('scrolling a diff marks the file at its top in the flat and tree file list and keeps its row on screen', async () => {
  await page.evaluate(() => {
    const w = window as any
    const { createElement, createRoot, flushSync, ActiveDiff, StrictMode } = w.under
    localStorage.setItem('bettergit.commitFilesView', 'list')
    document.getElementById('root')!.innerHTML = '<div id="active"></div>'
    const files = Array.from({ length: 30 }, (_, index) => `${index < 15 ? 'a' : 'b'}/file-${String(index).padStart(2, '0')}.txt`).map(path => ({
      oldPath: path, newPath: path, status: 'modified', binary: false,
      hunks: [{ header: '@@ -1,20 +1,20 @@', lines: Array.from({ length: 20 }, (_, index) => ({ type: 'context', text: `line ${index + 1}`, oldNo: index + 1, newNo: index + 1 })) }],
    }))
    w.activeRoot = createRoot(document.getElementById('active'))
    // StrictMode, as the app renders: its extra effect cleanup must not leave the probe stuck.
    flushSync(() => w.activeRoot.render(createElement(StrictMode, null, createElement(ActiveDiff, { files }))))
  })
  const marked = (path: string) => page.waitForFunction((path: string) => {
    const rows = document.querySelectorAll<HTMLElement>('.commit-stat-row.in-view')
    if (rows.length !== 1 || rows[0].title !== path) return false
    // On screen within its scroller, whichever box that is in this layout.
    let box = rows[0].parentElement
    while (box && !(box.scrollHeight > box.clientHeight)) box = box.parentElement
    const row = rows[0].getBoundingClientRect(), list = box!.getBoundingClientRect()
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1
  }, path, { timeout: 3000 })
  // Files off screen lay out at estimated heights, so the scroll is repeated until rows above have settled.
  const scrollTo = (path: string) => page.evaluate(async (path: string) => {
    const pane = document.querySelector<HTMLElement>('.diff-pane')!
    for (let pass = 0; pass < 3; pass++) {
      const file = Array.from(pane.querySelectorAll<HTMLElement>('[data-path]')).find((element) => element.dataset.path === path)!
      pane.scrollTop += file.getBoundingClientRect().top - pane.getBoundingClientRect().top
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
  }, path)
  await marked('a/file-00.txt')
  await scrollTo('b/file-27.txt')
  await marked('b/file-27.txt')
  await page.click('[aria-label^="Tree view"]')
  await marked('b/file-27.txt')
  await scrollTo('a/file-03.txt')
  await marked('a/file-03.txt')
  await page.click('[aria-label^="List view"]')
  await marked('a/file-03.txt')
  // Marking never selects: no row takes the selection's look or state.
  expect(await page.evaluate(() => document.querySelectorAll('.selected, [aria-selected="true"]').length)).toBe(0)
  await page.evaluate(() => (window as any).activeRoot.unmount())
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

// The native window has only a plain opaque backing and no material, so the page paints its own opaque --window behind the panes.
test.skipIf(!playwright)('built-in and extension themes paint an opaque window behind the translucent panes', async () => {
  for (const theme of ['light', 'dark', 'extension-dark']) {
    const panes = await page.evaluate(async (theme: string) => {
      const w = window as any
      w.bettergit.colorTheme = async (ref: string) => ({ name: ref, label: ref, dark: true, tokenColors: [],
        colors: { 'titleBar.activeBackground': '#010409', 'sideBar.background': '#010409', 'editor.background': '#0d1117' } })
      document.documentElement.dataset.theme = theme.endsWith('dark') ? 'dark' : 'light'
      w.under.applyAppearance({ darkTheme: theme === 'extension-dark' ? 'acme.github/dark.json' : '', lightTheme: '', iconTheme: '' })
      document.getElementById('root')!.innerHTML = '<div class="changes" style="height:450px;width:780px;grid-template-columns:120px minmax(0,1fr)"><div class="file-list"></div><div class="diff-rail"><div class="diff-pane"></div></div></div>'
      await new Promise(resolve => setTimeout(resolve, 50))
      return { body: getComputedStyle(document.body).backgroundColor, list: getComputedStyle(document.querySelector('.file-list')!).backgroundColor }
    }, theme)
    // omitBackground drops the browser's own white canvas, so the screenshot keeps only what the page paints.
    const shot = (await page.screenshot({ omitBackground: true })).toString('base64')
    const paint = await page.evaluate(async (shot: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot}`)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      let translucent = 0
      for (let index = 3; index < data.length; index += 4) if (data[index] < 255) translucent++
      return { translucent, corner: [...data.slice(0, 4)] }
    }, shot)
    expect({ theme, translucent: paint.translucent }).toEqual({ theme, translucent: 0 })
    if (theme === 'extension-dark') {
      expect(paint.corner).toEqual([1, 4, 9, 255])
      expect(panes.list).toBe('rgb(1, 4, 9)')
    } else expect(Number(panes.list.match(/[\d.]+/g)![3])).toBeLessThan(1)
  }
  await page.evaluate(() => {
    (window as any).under.applyAppearance({ darkTheme: '', lightTheme: '', iconTheme: '' })
    document.documentElement.dataset.theme = 'dark'
  })
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

// Folder Refresh, Fetch All and Pull All run while the menu that started them is gone. Each IPC call here waits for the
// test to settle it, so the sidebar must show the run, its progress and its result, and refuse a second batch meanwhile.
// Failures go to the notification hub, one entry per failure, each kept until marked read and able to open its repo.
test.skipIf(!playwright)('folder batches show progress and a result, and failures wait in the notification hub with their repo', async () => {
  await page.setViewportSize({ width: 1700, height: 800 })
  await page.evaluate(() => {
    const w = window as any
    const { createElement, createRoot, App, markAllRead } = w.under
    markAllRead()
    const repos = ['a', 'b', 'c'].map((name) => ({ kind: 'repo', path: `/p/${name}`, name, branch: 'main' }))
    const tree = [{ kind: 'folder', path: '/p', name: 'projects', children: repos }, { kind: 'folder', path: '/e', name: 'empty', children: [] }]
    const config = { sources: ['/p', '/e'], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null,
      settings: { theme: 'dark', backgroundFetch: true, fetchIntervalMinutes: 10, batchConcurrency: 4, appearance: {}, languages: {}, editorApp: 'none', terminalApp: 'none', customApps: [] } }
    w.sync = { tree, config, writes: [], calls: [] as string[], pending: [] as any[], listeners: {} as Record<string, (payload: unknown) => void>, holdTree: false, confirm: false, confirms: 0 }
    const hold = (call: string) => new Promise((resolve, reject) => { w.sync.calls.push(call); w.sync.pending.push({ call, resolve, reject }) })
    Object.assign(w.bettergit, {
      getConfig: async () => w.sync.config,
      updateConfig: async (patch: any) => {
        w.sync.writes.push(patch)
        w.sync.config = { ...w.sync.config, ...patch, settings: { ...w.sync.config.settings, ...patch.settings } }
        return w.sync.config
      },
      getTree: () => (w.sync.holdTree ? hold('getTree') : Promise.resolve(tree)),
      repoLocks: async () => ({ seq: 0, holders: {} }),
      onEvent: (name: string, listener: (payload: unknown) => void) => { w.sync.listeners[name] = listener; return () => undefined },
      fetch: (path: string) => hold(`fetch ${path}`),
      pull: (path: string, mode: string) => hold(`pull ${path} ${mode}`),
      refreshRepo: async (path: string) => { w.sync.calls.push(`count ${path}`) },
      clone: async () => '/p/new',
      pickFolder: async () => { throw new Error("Error invoking remote method 'folder:pick': Error: no access") },
      listExtensions: async () => { throw new Error('disk unreadable') },
      searchExtensions: async () => [{ namespace: 'acme', name: 'theme', displayName: 'Fixture', description: 'Fixture theme', version: '1', downloads: 1, averageRating: null, reviewCount: null, icon: null }],
      installExtension: async () => { throw new Error("Error invoking remote method 'extensions:install': Error: network down") },
    })
    // An opened repo's pane asks for more than this test answers; those reads stay pending.
    Object.setPrototypeOf(w.bettergit, new Proxy({}, { get: () => () => new Promise(() => undefined) }))
    window.confirm = () => { w.sync.confirms++; return w.sync.confirm }
    document.getElementById('root')!.style.cssText = 'height:780px;width:1700px'
    w.syncRoot = createRoot(document.getElementById('root'))
    w.syncRoot.render(createElement(App))
  })
  const statusText = () => page.evaluate(() => document.querySelector('.sidebar [role="status"]')?.textContent ?? '')
  // Waits for the sidebar status to include `text`, and reports what it showed instead on a timeout.
  const shows = (text: string) => page.waitForFunction((text: string) => (document.querySelector('.sidebar [role="status"]')?.textContent ?? '').includes(text), text, { timeout: 2000 })
    .catch(async () => { throw new Error(`status never showed "${text}"; it shows "${await statusText()}"`) })
  const actions = page.getByRole('button', { name: /^projects actions/ })
  const settle = (index: number, error?: string) => page.evaluate(([index, error]: [number, string | undefined]) => {
    const pending = (window as any).sync.pending[index]
    // A held getTree answers with the tree; a Git write answers with nothing.
    if (error) pending.reject(new Error(error)); else pending.resolve(pending.call === 'getTree' ? (window as any).sync.tree : undefined)
  }, [index, error])
  const calls = () => page.evaluate(() => (window as any).sync.calls)
  const reset = () => page.evaluate(() => { const w = window as any; w.sync.calls = []; w.sync.pending = [] })
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const menu = async (item: string) => {
    await page.locator('.tree-row.folder', { hasText: item === 'Fetch All in empty' ? 'empty' : 'projects' }).locator('.row-more').click({ force: true })
    return page.getByRole('menuitem', { name: item === 'Fetch All in empty' ? 'Fetch All' : item, exact: true })
  }
  // The hub's entries, opening it if needed; the bell's name; the brief announcement.
  const hub = async () => {
    await frames()
    if (!(await page.locator('.notify-panel').count())) {
      if (!(await page.locator('.notify-trigger').count())) return []
      await page.locator('.notify-trigger').click()
    }
    return page.evaluate(() => [...document.querySelectorAll('.notify-panel li')].map((li) => [
      li.querySelector('strong')!.textContent, li.querySelector('p')!.textContent, li.querySelector('.notify-repo')?.textContent ?? '', li.querySelector('.notify-count')?.textContent ?? '',
    ].join(' | ')))
  }
  const bell = async () => { await frames(); return page.evaluate(() => document.querySelector('.notify-trigger')?.getAttribute('aria-label') ?? null) }
  const closeHub = async () => { if (await page.locator('.notify-panel').count()) await page.keyboard.press('Escape') }
  const selected = () => page.evaluate(() => document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent ?? null)
  try {
    await page.waitForSelector('.tree-row.folder', { timeout: 3000 })

    // Refresh shows the rescan until getTree answers, then the result. A failed rescan says so and ends the spinner.
    await page.evaluate(() => { (window as any).sync.holdTree = true })
    await (await menu('Refresh')).click()
    await shows('Refreshing repositories…')
    expect(await actions.getAttribute('aria-busy')).toBe('true')
    await settle(0)
    await shows('Refreshed repositories')
    expect(await actions.getAttribute('aria-busy')).toBeNull()
    expect(await bell()).toBeNull()
    await (await menu('Refresh')).click()
    await settle(1, 'scan failed')
    await shows('Refresh failed: scan failed')
    expect(await actions.getAttribute('aria-busy')).toBeNull()
    // The failure is announced without taking focus, and waits in the hub.
    await page.waitForFunction(() => document.querySelector('.notify-toast-region')?.textContent?.includes('Refresh failed scan failed'), undefined, { timeout: 2000 })
    expect(await page.evaluate(() => !!document.activeElement?.closest('.notify-layer'))).toBe(false)
    expect(await bell()).toBe('Notifications: 1 unread')
    // The Repositories header's Refresh rescans every source with the same status, and spins while it runs.
    const refreshAll = page.getByRole('button', { name: /^Refresh(ing)? repositories/ })
    await refreshAll.click()
    await shows('Refreshing repositories…')
    expect(await refreshAll.getAttribute('aria-busy')).toBe('true')
    expect(await (await menu('Refresh')).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await settle(2)
    await shows('Refreshed repositories')
    // Then it recounts every repo's changes and commits to push and pull, without fetching.
    expect((await calls()).filter((call: string) => !call.startsWith('getTree'))).toEqual(['count /p/a', 'count /p/b', 'count /p/c'])
    expect([await refreshAll.getAttribute('aria-busy'), await refreshAll.getAttribute('aria-disabled')]).toEqual([null, null])
    await page.evaluate(() => { (window as any).sync.holdTree = false })
    await reset()

    // Fetch All starts independent repos together after its menu has closed.
    await (await menu('Fetch All')).click()
    expect(await page.locator('.context-menu').count()).toBe(0)
    await shows('Fetch All in projects: 0 of 3, fetching c')
    expect(await actions.getAttribute('aria-busy')).toBe('true')
    // A second batch is refused while one runs: the folder actions are disabled and the app menu's Fetch All starts nothing.
    for (const item of ['Refresh', 'Fetch All', 'Pull All']) expect(await (await menu(item)).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    expect([await refreshAll.getAttribute('aria-busy'), await refreshAll.getAttribute('aria-disabled')]).toEqual([null, 'true'])
    await page.evaluate(() => { (window as any).sync.holdTree = true })
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('fetch-all'))
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(await calls()).toEqual(['fetch /p/a', 'fetch /p/b', 'fetch /p/c'])
    await page.evaluate(() => { (window as any).sync.holdTree = false })
    await settle(2)
    expect(await actions.getAttribute('aria-busy')).toBe('true')
    await settle(1, 'no remote')
    expect(await actions.getAttribute('aria-busy')).toBe('true')
    await settle(0)
    await shows('Fetch All in projects done: 2 succeeded, 1 failed')
    await shows('b: no remote')
    expect(await actions.getAttribute('aria-busy')).toBeNull()
    expect(await hub()).toEqual([
      'Fetch All in projects: b failed | no remote | b | ',
      'Starting Fetch All failed | Wait for the running Refresh, Fetch All or Pull All to finish. |  | ',
      'Refresh failed | scan failed |  | ',
    ])
    await closeHub()

    // A cancelled Pull All starts nothing and claims nothing.
    await reset()
    await (await menu('Pull All')).click()
    await page.waitForFunction(() => (window as any).sync.confirms === 1, undefined, { timeout: 2000 })
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(await calls()).toEqual([])
    expect(await statusText()).not.toContain('Pull All')
    expect(await actions.getAttribute('aria-busy')).toBeNull()

    // A confirmed Pull All fast-forwards each repo; one busy elsewhere is skipped and named, but is not a failure.
    await page.evaluate(() => { const w = window as any; w.sync.confirm = true; w.sync.listeners['repo:locks']({ seq: 1, holders: { '/p/c': 'push' } }) })
    await (await menu('Pull All')).click()
    await shows('Pull All in projects: 0 of 3, pulling c')
    expect(await calls()).toEqual(['pull /p/a ff-only', 'pull /p/b ff-only'])
    await settle(0)
    await settle(1)
    await shows('Pull All in projects done: 2 succeeded, 1 skipped')
    await shows('c: skipped, another action was running')
    expect(await calls()).toEqual(['pull /p/a ff-only', 'pull /p/b ff-only'])
    expect(await bell()).toBe('Notifications: 3 unread')
    await page.evaluate(() => (window as any).sync.listeners['repo:locks']({ seq: 2, holders: {} }))

    // A folder with no repos finishes at once and says so.
    await (await menu('Fetch All in empty')).click()
    await shows('Fetch All in empty: no repositories')

    // The app menu's Fetch All uses the same status, so it does not finish silently.
    await reset()
    await page.evaluate(() => { (window as any).sync.holdTree = true })
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('fetch-all'))
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('fetch-all'))
    expect(await calls()).toEqual(['getTree'])
    await settle(0)
    await page.evaluate(() => { (window as any).sync.holdTree = false })
    await shows('Fetch All: 0 of 3, fetching c')
    for (const index of [1, 2, 3]) await page.waitForFunction((index: number) => (window as any).sync.pending.length > index, index).then(() => settle(index))
    await shows('Fetch All done: 3 succeeded')

    // Marked read, an entry leaves the hub and the store; nothing clears on its own.
    await page.evaluate(() => (window as any).under.markAllRead())
    expect(await bell()).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('bettergit.notifications'))).toBe('[]')

    // A menu command names its action and why it could not run. The same failure again counts instead of stacking.
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('pull'))
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('pull'))
    expect(await hub()).toEqual(['Pulling failed | Select a repository first. |  | ×2'])
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('bettergit.notifications')))).toHaveLength(1)
    await page.getByRole('button', { name: 'Mark "Pulling failed" as read' }).click()
    expect(await bell()).toBeNull()

    // A dialog failure shows in the dialog. A background failure while the dialog is open waits in the hub, which stays
    // usable above the inert app; the same failure again raises its count.
    await page.evaluate(() => (window as any).sync.listeners['menu:action']('clone'))
    await page.getByRole('button', { name: 'Choose…' }).click()
    await page.waitForFunction(() => document.querySelector('.dialog-error')?.textContent === 'Choosing a folder failed: no access', undefined, { timeout: 2000 })
    expect(await hub()).toEqual(['Choosing a clone folder failed | no access |  | '])
    await closeHub()
    expect(await page.locator('[role="dialog"]').count()).toBe(1)
    const report = { fetched: [], skipped: [{ repo: '*', reason: 'user idle' }], failed: [{ repo: '/p/a', reason: "Error invoking remote method 'x': Error: offline" }] }
    await page.evaluate((report: unknown) => { const w = window as any; w.sync.listeners['fetch:report'](report); w.sync.listeners['fetch:report'](report) }, report)
    expect(await page.evaluate(() => !!document.querySelector('.notify-trigger')?.closest('[inert]'))).toBe(false)
    expect(await hub()).toEqual(['Background fetch: a failed | offline | a | ×2', 'Choosing a clone folder failed | no access |  | '])
    await page.getByRole('button', { name: 'Mark "Background fetch: a failed" as read' }).click()
    expect(await bell()).toBe('Notifications: 1 unread')
    await closeHub()
    expect(await page.locator('[role="dialog"]').count()).toBe(1)

    // Keyboard input must not wait for an animation frame to move focus out of the dialog.
    await page.evaluate(() => {
      const w = window as any
      w.savedNotificationRaf = window.requestAnimationFrame
      window.requestAnimationFrame = () => 0
    })
    await page.locator('.notify-trigger').click()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('.notify-layer'))).toBe(true)
    await page.keyboard.press('Escape')
    expect(await page.locator('[role="dialog"]').count()).toBe(1)
    expect(await page.locator('.notify-panel').count()).toBe(0)
    await page.evaluate(() => { window.requestAnimationFrame = (window as any).savedNotificationRaf })

    // A clone that succeeds but whose sidebar rescan fails says both.
    await page.evaluate(() => { (window as any).sync.holdTree = true })
    await reset()
    await page.getByLabel('Repository URL').fill('https://example.com/new.git')
    await page.getByRole('button', { name: 'Clone', exact: true }).click()
    await page.waitForFunction(() => (window as any).sync.pending.length === 1, undefined, { timeout: 2000 })
    await settle(0, 'scan failed')
    await page.waitForSelector('.notify-trigger', { timeout: 2000 })
    expect(await page.locator('[role="dialog"]').count()).toBe(0)
    // The clone dialog's own failure is still waiting after the dialog closed.
    expect(await hub()).toEqual(['Cloned into /p/new, but showing it in the sidebar failed | scan failed |  | ', 'Choosing a clone folder failed | no access |  | '])
    await page.getByRole('button', { name: 'Mark "Choosing a clone folder failed" as read' }).click()
    expect(await bell()).toBe('Notifications: 1 unread')
    await closeHub()
    await page.evaluate(() => { const w = window as any; w.sync.holdTree = false; w.under.markAllRead() })

    // Settings failures show in the dialog and also wait in the hub after it closes.
    await page.evaluate(() => { sessionStorage.setItem('bettergit.settingsSection', 'themes'); (window as any).sync.listeners['menu:action']('open-settings') })
    await page.waitForFunction(() => document.querySelector('.dialog-error')?.textContent === 'Could not list installed extensions: disk unreadable', undefined, { timeout: 2000 })
    await page.getByRole('button', { name: 'Install Fixture' }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.dialog-error')].some((element) => element.textContent === 'network down'), undefined, { timeout: 2000 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), undefined, { timeout: 2000 })
    expect(await hub()).toEqual(['Installing acme.theme failed | network down |  | ', 'Listing installed extensions failed | disk unreadable |  | '])
    await page.getByRole('button', { name: 'Mark "Installing acme.theme failed" as read' }).click()
    expect(await hub()).toEqual(['Listing installed extensions failed | disk unreadable |  | '])
    await closeHub()
    await page.evaluate(() => (window as any).under.markAllRead())

    // Editing the setting updates App's config; the next folder and app-menu batches must use it.
    await page.evaluate(() => { sessionStorage.setItem('bettergit.settingsSection', 'general'); (window as any).sync.listeners['menu:action']('open-settings') })
    const concurrency = page.getByLabel('Repositories at once', { exact: true })
    expect(await concurrency.inputValue()).toBe('4')
    await concurrency.selectOption('2')
    await page.waitForFunction(() => (window as any).sync.config.settings.batchConcurrency === 2)
    expect(await page.evaluate(() => (window as any).sync.writes.at(-1))).toEqual({ settings: { batchConcurrency: 2 } })
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    // The fixture deliberately reports an extensions error whenever Settings opens.
    await page.evaluate(() => (window as any).under.markAllRead())
    for (const kind of ['Pull All', 'app-menu']) {
      await reset()
      if (kind === 'app-menu') await page.evaluate(() => (window as any).sync.listeners['menu:action']('fetch-all'))
      else await (await menu(kind)).click()
      await page.waitForFunction(() => (window as any).sync.pending.length === 2)
      expect(await calls()).toEqual(kind === 'app-menu' ? ['fetch /p/a', 'fetch /p/b'] : ['pull /p/a ff-only', 'pull /p/b ff-only'])
      await settle(0)
      await page.waitForFunction(() => (window as any).sync.pending.length === 3)
      await settle(1)
      await settle(2)
      await shows('done: 3 succeeded')
    }

    // A failure that lands after the user moved to another repo still goes to its own repo, as does each repo's entry.
    await page.locator('.tree-row.repo', { hasText: 'b' }).click()
    expect(await selected()).toBe('bmain')
    await reset()
    await (await menu('Fetch All')).click()
    await page.waitForFunction(() => (window as any).sync.pending.length === 2)
    expect(await calls()).toEqual(['fetch /p/a', 'fetch /p/b'])
    await page.locator('.tree-row.repo', { hasText: 'c' }).click()
    await settle(0, 'denied a')
    await page.waitForFunction(() => (window as any).sync.pending.length > 1).then(() => settle(1))
    await page.waitForFunction(() => (window as any).sync.pending.length > 2).then(() => settle(2, 'denied c'))
    await shows('done: 1 succeeded, 2 failed')
    expect(await selected()).toBe('cmain')
    expect(await hub()).toEqual(['Fetch All in projects: c failed | denied c | c | ', 'Fetch All in projects: a failed | denied a | a | '])
    await page.getByRole('button', { name: 'Go to repository a' }).click()
    expect(await selected()).toBe('amain')
    await page.getByRole('button', { name: 'Go to repository c' }).click()
    expect(await selected()).toBe('cmain')
    // Going to a repo does not mark its entry read.
    expect(await bell()).toBe('Notifications: 2 unread')

    // A repo that has left the sidebar is named instead of opened.
    await page.evaluate(() => (window as any).under.notify({ action: 'Pushing in gone', reason: 'rejected', repo: '/p/gone' }))
    await page.getByRole('button', { name: 'Go to repository gone' }).click()
    await page.waitForFunction(() => document.querySelector('.notify-panel em')?.textContent === 'gone is no longer in the sidebar.', undefined, { timeout: 2000 })
    expect(await selected()).toBe('cmain')
    // Mark all as read clears every entry, the bell and the stored list in one go.
    expect(await bell()).toBe('Notifications: 3 unread')
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('bettergit.notifications')))).toHaveLength(3)
    await page.getByRole('button', { name: 'Mark all as read' }).click()
    expect(await bell()).toBeNull()
    expect(await page.locator('.notify-panel').count()).toBe(0)
    expect(await page.evaluate(() => localStorage.getItem('bettergit.notifications'))).toBe('[]')

    // A damaged store loads as checked entries: bad fields fall back, and entries without an action are dropped.
    expect(await page.evaluate(() => (window as any).under.parseNotifications('[{"id":"x","action":"A","reason":5,"repo":"rel","time":1,"count":-1},{"id":"y"},3,null]')))
      .toEqual([{ id: 'x', action: 'A', reason: '', time: 1, count: 1 }])
    expect(await page.evaluate(() => (window as any).under.parseNotifications('{not json'))).toEqual([])
  } finally {
    await page.evaluate(() => { const w = window as any; w.syncRoot.unmount(); Object.setPrototypeOf(w.bettergit, Object.prototype); w.under.markAllRead() })
    await page.setViewportSize({ width: 800, height: 600 })
  }
}, 30000)

// A repo row has its own actions menu, like a folder's: Fetch, Pull and Refresh act on that row's repo without opening it.
// The open repo's header hides a zero push or pull count. A raw Git failure reads as a summary with a next step, and the
// raw text stays under Details.
test.skipIf(!playwright)('repo rows fetch, pull and refresh their own repo, the header hides zero counts, and Git failures read plainly', async () => {
  await page.setViewportSize({ width: 1700, height: 800 })
  const raw = 'ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.'
  await page.evaluate(() => {
    const w = window as any
    const { createElement, createRoot, App, markAllRead } = w.under
    markAllRead()
    const repos = ['a', 'b'].map((name) => ({ kind: 'repo', path: `/p/${name}`, name, branch: 'main' }))
    const tree = [{ kind: 'folder', path: '/p', name: 'projects', children: repos }]
    w.rows = { calls: [] as string[], pending: [] as any[], listeners: {} as Record<string, (payload: unknown) => void>,
      status: { head: 'main', headHash: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, detached: false, changes: [] } }
    const hold = (call: string) => new Promise((resolve, reject) => { w.rows.calls.push(call); w.rows.pending.push({ call, resolve, reject }) })
    Object.assign(w.bettergit, {
      getConfig: async () => ({ sources: ['/p'], hidden: [], collapsed: [], groups: [], lastCloneDirectory: null,
        settings: { theme: 'dark', appearance: {}, languages: {}, editorApp: 'none', terminalApp: 'none', customApps: [] } }),
      getTree: async () => { w.rows.calls.push('getTree'); return tree },
      repoLocks: async () => ({ seq: 0, holders: {} }),
      onEvent: (name: string, listener: (payload: unknown) => void) => { w.rows.listeners[name] = listener; return () => undefined },
      status: async () => ({ ...w.rows.status }),
      branches: async () => [],
      fetch: (path: string) => hold(`fetch ${path}`),
      pull: (path: string, mode: string) => hold(`pull ${path} ${mode}`),
      refreshRepo: async (path: string) => {
        w.rows.calls.push(`refresh ${path}`)
        if (w.rows.countFail?.[path]) throw new Error(`Error invoking remote method 'repo:refresh': Error: ${w.rows.countFail[path]}`)
      },
    })
    Object.setPrototypeOf(w.bettergit, new Proxy({}, { get: () => () => new Promise(() => undefined) }))
    document.getElementById('root')!.style.cssText = 'height:780px;width:1700px'
    w.rowsRoot = createRoot(document.getElementById('root'))
    w.rowsRoot.render(createElement(App))
  })
  const calls = () => page.evaluate(() => (window as any).rows.calls.filter((call: string) => call !== 'getTree'))
  const settle = (error?: string) => page.evaluate((error: string | undefined) => {
    const pending = (window as any).rows.pending.shift()
    if (error) pending.reject(new Error(error)); else pending.resolve()
  }, error)
  const selected = () => page.evaluate(() => document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent ?? null)
  const sync = () => page.evaluate(() => [...document.querySelectorAll('.toolbar .sync [role="img"]')].map((item) => item.getAttribute('aria-label')))
  const menu = async (name: string) => {
    await page.locator('.tree-row.repo').filter({ has: page.locator('.tree-label', { hasText: new RegExp(`^${name}$`) }) }).hover()
    await page.getByRole('button', { name: new RegExp(`^${name} actions`) }).click({ force: true })
    // Every item leads with its icon, in the menu's shared 16px slot.
    return page.evaluate(() => [...document.querySelectorAll('.context-menu [role="menuitem"]')].map((item) => {
      const icon = item.firstElementChild?.tagName === 'svg' && getComputedStyle(item.firstElementChild).width === '16px' ? '' : ' (no icon)'
      return `${item.textContent}${icon}${(item as HTMLButtonElement).disabled ? ' (disabled)' : ''}`
    }))
  }
  const item = (name: string) => page.getByRole('menuitem', { name, exact: true })
  try {
    await page.waitForSelector('.tree-row.repo', { timeout: 3000 })
    await page.locator('.tree-row.repo', { hasText: 'b' }).click()
    await page.waitForSelector('.toolbar .repo-name', { timeout: 3000 })

    // In step with its upstream, the header shows no arrows. A count of commits to pull shows alone.
    await page.waitForFunction(() => document.querySelector('.branch-pill')?.textContent?.includes('main'), undefined, { timeout: 2000 })
    expect(await sync()).toEqual([])
    await page.evaluate(() => { const w = window as any; w.rows.status.behind = 3; w.rows.listeners['repos:changed']({ repos: ['/p/b'], tree: false }) })
    await page.waitForFunction(() => document.querySelector('.toolbar .sync'), undefined, { timeout: 2000 })
    expect(await sync()).toEqual(['3 commits to pull from origin/main'])

    // The other repo's menu keeps its items and adds Fetch, Pull and Refresh. Opening it leaves the open repo open.
    expect(await menu('a')).toEqual(['Fetch', 'Pull', 'Refresh', 'Reveal in Finder', 'Hide in Sidebar'])
    expect(await selected()).toBe('bmain')

    // Fetch runs in that repo; while it runs, its row shows the spinner and its own Fetch and Pull wait.
    await item('Fetch').click()
    expect(await calls()).toEqual(['fetch /p/a'])
    expect(await page.getByRole('button', { name: /^a actions/ }).getAttribute('aria-busy')).toBe('true')
    expect(await menu('a')).toEqual(['Fetch (disabled)', 'Pull (disabled)', 'Refresh', 'Reveal in Finder', 'Hide in Sidebar'])
    await page.keyboard.press('Escape')
    expect(await selected()).toBe('bmain')

    // A raw Git failure is summarised with a next step; the raw text stays under Details.
    await settle(`Error invoking remote method 'repo:fetch': GitError: ${raw}`)
    await page.waitForFunction(() => document.querySelector('.notify-toast'), undefined, { timeout: 2000 })
    const toast = await page.evaluate(() => document.querySelector('.notify-toast')!.textContent)
    expect(toast).toContain('Fetching in a failed')
    expect(toast).toContain('The remote repository was not found, or this account cannot access it.')
    expect(toast).not.toContain('ERROR')
    await page.locator('.notify-trigger').click()
    const entry = () => page.evaluate(() => {
      const li = document.querySelector('.notify-panel li')!
      return { summary: li.querySelector('p')!.textContent, hint: li.querySelector('.notify-hint')?.textContent ?? '', details: li.querySelector('details pre')?.textContent ?? '',
        detailsOpen: li.querySelector('details')?.open ?? null, buttons: [...li.querySelectorAll('.notify-actions button')].map((button) => button.textContent) }
    })
    expect(await entry()).toEqual({
      summary: 'The remote repository was not found, or this account cannot access it.',
      hint: 'Check the remote URL and that your Git account has access. Git hosts also report a private repository you cannot see as not found.',
      details: raw, detailsOpen: false, buttons: ['Retry fetch', 'Go to repository', 'Mark as read'],
    })
    // Retry fetches the same repo again; a success marks the entry read.
    await page.getByRole('button', { name: 'Retry fetch in a' }).click()
    expect(await calls()).toEqual(['fetch /p/a', 'fetch /p/a'])
    await settle()
    await page.waitForFunction(() => !document.querySelector('.notify-trigger'), undefined, { timeout: 2000 })

    // Pull merges that repo's upstream, as the toolbar's Pull does. Refresh rereads it without a Git write.
    expect(await menu('a')).toEqual(['Fetch', 'Pull', 'Refresh', 'Reveal in Finder', 'Hide in Sidebar'])
    await item('Pull').click()
    await settle()
    await menu('a')
    await item('Refresh').click()
    await page.waitForFunction(() => (window as any).rows.calls.includes('refresh /p/a'), undefined, { timeout: 2000 })
    expect(await calls()).toEqual(['fetch /p/a', 'fetch /p/a', 'pull /p/a merge', 'refresh /p/a'])
    expect(await selected()).toBe('bmain')

    // The header's Refresh rescans the sidebar, recounts every repo and rereads the open repo, which stays open. A repo
    // Git cannot read is named in the status and the hub, and the rest are still counted.
    const notifications = async () => {
      if (!(await page.locator('.notify-panel').count())) await page.locator('.notify-trigger').click()
      return page.evaluate(() => [...document.querySelectorAll('.notify-panel li')].map((li) =>
        [li.querySelector('strong')!.textContent, li.querySelector('p')!.textContent, ...[...li.querySelectorAll('.notify-actions button')].map((button) => button.textContent)].join(' | ')))
    }
    const notFound = 'fatal: not a git repository (or any of the parent directories): .git'
    await page.evaluate((reason: string) => {
      const w = window as any
      Object.assign(w.rows, { calls: [], countFail: { '/p/a': reason } })
      Object.assign(w.rows.status, { behind: 0, ahead: 1 })
    }, notFound)
    await page.getByRole('button', { name: 'Refresh repositories' }).click()
    await page.waitForFunction(() => document.querySelector('.sidebar [role="status"]')?.textContent?.startsWith('Refreshed repositories, 1 failed'), undefined, { timeout: 2000 })
    await page.waitForFunction(() => document.querySelector('.toolbar .sync [aria-label="1 commit to push to origin/main"]'), undefined, { timeout: 2000 })
    expect(await page.evaluate(() => (window as any).rows.calls)).toEqual(['getTree', 'refresh /p/a', 'refresh /p/b'])
    expect(await page.evaluate(() => document.querySelector('.sidebar [role="status"] li')?.textContent)).toBe(`a: ${notFound}`)
    expect(await selected()).toBe('bmain')
    expect(await notifications()).toEqual([`Refresh: a failed | ${notFound} | Go to repository | Mark as read`])
    await page.evaluate(() => { const w = window as any; w.under.markAllRead(); w.rows.countFail = {} })

    // Retry fetch is offered for fetch failures only, even when a repo's name has "fetch" in it, and marks only its own
    // entry read.
    await page.evaluate(() => {
      const { notify } = (window as any).under
      notify({ action: 'Pulling in fetch-client', reason: 'merge stopped', repo: '/p/fetch-client' })
      notify({ action: 'Fetching in a', reason: 'offline', repo: '/p/a' })
    })
    expect(await notifications()).toEqual([
      'Fetching in a failed | offline | Retry fetch | Go to repository | Mark as read',
      'Pulling in fetch-client failed | merge stopped | Go to repository | Mark as read',
    ])
    await page.evaluate(() => { (window as any).rows.calls = [] })
    await page.getByRole('button', { name: 'Retry fetch in a' }).click()
    await settle()
    await page.waitForFunction(() => document.querySelectorAll('.notify-panel li').length === 1, undefined, { timeout: 2000 })
    expect(await calls()).toEqual(['fetch /p/a'])
    expect(await notifications()).toEqual(['Pulling in fetch-client failed | merge stopped | Go to repository | Mark as read'])
    await page.evaluate(() => (window as any).under.markAllRead())

    // A background fetch failure for a repo reads the same way, and SSH, sign-in and network failures each say which.
    const report = { fetched: [], skipped: [], failed: [{ repo: '/p/a', reason: raw }, { repo: '/p/b', reason: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' }] }
    await page.evaluate((report: unknown) => (window as any).rows.listeners['fetch:report'](report), report)
    expect(await notifications()).toEqual([
      'Background fetch: b failed | The remote refused this SSH key. | Retry fetch | Go to repository | Mark as read',
      'Background fetch: a failed | The remote repository was not found, or this account cannot access it. | Retry fetch | Go to repository | Mark as read',
    ])
    // A delayed success clears only older failures from the same default fetch, never a newer failure or a tag fetch.
    await page.evaluate(() => {
      const w = window as any
      w.under.markAllRead()
      const now = Date.now
      try {
        Date.now = () => 100
        w.under.notify({ action: 'Background fetch: a', reason: 'old offline', repo: '/p/a' })
        w.under.notify({ action: 'Fetch All: a', reason: 'old offline', repo: '/p/a' })
        w.under.notify({ action: 'Fetching in a', reason: 'would clobber existing tag', repo: '/p/a' })
        w.under.notify({ action: 'Background fetch: b', reason: 'still offline', repo: '/p/b' })
        Date.now = () => 300
        w.under.notify({ action: 'Background fetch: a', reason: 'new offline', repo: '/p/a' })
      } finally { Date.now = now }
      w.rows.listeners['fetch:report']({ fetched: ['/p/a'], startedAt: 200, skipped: [], failed: [] })
    })
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bettergit.notifications')!).map((entry: any) => entry.reason))).toEqual([
      'new offline', 'still offline', 'would clobber existing tag',
    ])
  } finally {
    await page.evaluate(() => { const w = window as any; w.rowsRoot.unmount(); Object.setPrototypeOf(w.bettergit, Object.prototype); w.under.markAllRead() })
    await page.setViewportSize({ width: 800, height: 600 })
  }
}, 30000)

// The update toast never downloads or restarts by itself, and a restart never closes over unsaved edits.
test.skipIf(!playwright)('an update downloads only on click, and the restart is refused while edits are unsaved', async () => {
  const render = (state: unknown) => page.evaluate(async (state: unknown) => {
    const { createElement, flushSync, createRoot, UpdateStatus } = (window as any).under
    const w = window as any
    w.updateCalls = []
    Object.assign(w.bettergit, {
      onEvent: () => () => undefined,
      updateState: async () => state,
      downloadUpdate: async () => { w.updateCalls.push('download') },
      installUpdate: async () => { w.updateCalls.push('install'); return null },
      openUpdatePage: async () => { w.updateCalls.push('page') },
    })
    w.updateRoot?.unmount()
    document.getElementById('update-host')?.remove()
    document.body.insertAdjacentHTML('beforeend', '<div id="update-host"></div>')
    w.updateRoot = createRoot(document.getElementById('update-host')!)
    flushSync(() => w.updateRoot.render(createElement(UpdateStatus)))
    for (let tries = 0; tries < 50 && !document.querySelector('.update-toast'); tries++) await new Promise((resolve) => setTimeout(resolve, 10))
  }, state)
  const toast = () => page.evaluate(() => ({
    text: document.querySelector('.update-toast > span')?.textContent ?? null,
    calls: (window as any).updateCalls,
  }))

  await render({ kind: 'available', version: '0.1.9' })
  expect(await toast()).toEqual({ text: 'BetterGit 0.1.9 is available.', calls: [] })
  await page.click('.update-toast button:text("Update")')
  expect((await toast()).calls).toEqual(['download'])

  await render({ kind: 'available', version: '0.1.9', blocked: 'BetterGit cannot replace itself in the folder it is installed in.' })
  await page.click('.update-toast button:text("Download")')
  expect((await toast()).calls).toEqual(['page'])

  // An unsaved edit in a working file.
  await page.evaluate(async () => {
    const { createElement, flushSync, createRoot, EditableDiff } = (window as any).under
    const w = window as any
    w.draftRoot = createRoot(document.getElementById('root')!)
    const edit = { repo: 'update-repo', load: async () => 'hello', save: async () => true, onError: () => undefined }
    const hunks = [{ header: '@@ -1 +1 @@', lines: [{ type: 'context', text: 'hello', oldNo: 1, newNo: 1 }] }]
    const fallback = createElement('div', { 'data-source-row': '0:0:0', 'data-source-side': 'new' }, createElement('code', null, 'hello'))
    flushSync(() => w.draftRoot.render(createElement(EditableDiff, { edit, path: 'update.ts', hunks, layout: 'unified', language: null, fallback, fileIndex: 0, onExtent: () => undefined })))
    const row = document.querySelector('[data-source-row]')!.getBoundingClientRect()
    for (const type of ['mousedown', 'mouseup']) {
      document.querySelector('[data-source-row]')!.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: row.left + 2, clientY: row.top + 2 }))
    }
    for (let tries = 0; tries < 100 && !document.querySelector('.cm-content'); tries++) await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await page.focus('.cm-content')
  await page.keyboard.type('x')

  await render({ kind: 'ready', version: '0.1.9' })
  await page.click('.update-toast button:text("Restart to Update")')
  expect(await toast()).toEqual({
    text: 'BetterGit 0.1.9 is ready to install.Save or discard your unsaved edits and conflict choices, then restart.',
    calls: [],
  })
  // Without an accepted restart, closing the window is not held up.
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true)
  await page.evaluate(() => {
    const w = window as any
    w.updateRoot.unmount()
    w.draftRoot.unmount()
    document.getElementById('update-host')?.remove()
  })

  // In the notification corner, an update and a new failure share one live region and stack without overlapping.
  await page.evaluate(() => {
    const { createElement, flushSync, createRoot, NotificationHub, UpdateStatus, markAllRead } = (window as any).under
    const w = window as any
    w.bettergit.updateState = async () => ({ kind: 'available', version: '0.1.9' })
    markAllRead()
    document.body.insertAdjacentHTML('beforeend', '<div id="hub-host"></div>')
    w.hubRoot = createRoot(document.getElementById('hub-host')!)
    flushSync(() => w.hubRoot.render(createElement(NotificationHub, { onGo: () => true, onRetryFetch: async () => true }, createElement(UpdateStatus))))
  })
  await page.waitForSelector('.notify-toast-region .update-toast')
  await page.evaluate(() => (window as any).under.notify({ action: 'Fetching in a', reason: 'offline', repo: '/p/a' }))
  await page.waitForSelector('.notify-toast-region .notify-toast:not(.update-toast)')
  const corner = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.notify-toast')].map((toast) => toast.getBoundingClientRect())
    return {
      regions: document.querySelectorAll('.notify-toast-region').length,
      toasts: [...document.querySelectorAll('.notify-toast-region > .notify-toast')].map((toast) => toast.textContent),
      onScreen: boxes.every((box) => box.width > 0 && box.height > 0 && box.bottom <= innerHeight && box.right <= innerWidth),
      apart: boxes.length === 2 && (boxes[0].bottom <= boxes[1].top || boxes[1].bottom <= boxes[0].top),
    }
  })
  expect(corner).toEqual({ regions: 1, toasts: ['BetterGit 0.1.9 is available.Update', 'Fetching in a failed offlineView'], onScreen: true, apart: true })
  await page.evaluate(() => {
    const w = window as any
    w.under.markAllRead()
    w.hubRoot.unmount()
    document.getElementById('hub-host')?.remove()
  })
})
