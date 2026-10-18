import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// Checks that need a real browser: where a click lands in wrapped editor-look rows, find highlights reaching rows that
// mount after the query, and keys typed before the editor mounts. They run in Chromium from the Playwright install the
// perf harness uses, and skip where it is missing.
const playwright = (() => {
  try {
    return createRequire(import.meta.url)(`${execSync('npm root -g').toString().trim()}/playwright`)
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
    body: `<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`,
  }))
  await page.goto('http://bettergit.test/')
  await page.waitForFunction(() => 'under' in window)
}, 30000)

afterAll(async () => { await browser?.close() })

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
