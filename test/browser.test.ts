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
