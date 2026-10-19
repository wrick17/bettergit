// Click-to-edit probe: node scripts/perf/click.mjs <repo> [layout] [wrap]
// Checks that the static rows line up with the editor that replaces them, and times click → caret and typing.
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [repo, layout = 'unified', wrap = 'true'] = process.argv.slice(2)
const b = await chromium.launch({ args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.text().slice(0, 300)) })
await p.addInitScript(([repo, layout, wrap]) => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', layout); localStorage.setItem('bettergit.wordWrap', wrap); localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) }, [repo, layout, wrap])
await p.goto('http://localhost:5793/'); await p.waitForTimeout(3000)
console.log(await p.evaluate(() => ({ previews: document.querySelectorAll('.ed-preview').length, editors: document.querySelectorAll('.cm-editor').length, files: document.querySelectorAll('.diff-file').length })))
await p.screenshot({ path: `/tmp/bettergit-perf/shots/preview-${layout}-${wrap}.png` })
// Pick an editable changed row on screen, and a point a few characters into its text.
const target = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.ed-preview .ed-line.add[data-new]')].filter((r) => { const b = r.getBoundingClientRect(); return b.top > 250 && b.bottom < 900 })
  const row = rows[0]
  if (!row) return null
  const code = row.querySelector('code')
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode()
  const range = document.createRange(); range.setStart(node, Math.min(5, node.data.length)); range.setEnd(node, Math.min(6, node.data.length))
  const r = range.getBoundingClientRect()
  // Tops of every numbered row on screen, by side and line.
  const tops = {}
  for (const el of document.querySelectorAll('.ed-preview .ed-line[data-new], .ed-preview .ed-line[data-old]')) {
    const box = el.getBoundingClientRect(); if (box.bottom < 0 || box.top > innerHeight) continue
    tops[(el.dataset.new ? 'n' : 'o') + (el.dataset.new ?? el.dataset.old) + (el.classList.contains('side-a') ? 'a' : '')] = [Math.round(box.top * 10) / 10, Math.round(code.getBoundingClientRect().left)]
  }
  return { line: Number(row.dataset.new), x: r.left + 1, y: r.top + r.height / 2, charLeft: r.left, tops, file: row.closest('.diff-file').dataset.path }
})
console.log('target', target && { line: target.line, file: target.file })
if (target) {
  await p.evaluate(() => {
    window.__t = {}
    addEventListener('pointerdown', () => { window.__t.down = performance.now() }, true)
    addEventListener('pointerup', () => {
      window.__t.up = performance.now()
      window.__t.frames = 0
      // Frames rendered after the release until a caret is drawn in a focused editor (checked at each frame start).
      const tick = () => {
        window.__t.frames++
        const content = document.activeElement?.closest?.('.cm-content')
        const cursor = document.querySelector('.cm-focused .cm-cursor')
        if (content && cursor && cursor.getBoundingClientRect().height > 0) { window.__t.caret = performance.now(); return }
        if (performance.now() - window.__t.up < 2000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      // Main-thread time of the release itself (the editor mount runs inside it).
      queueMicrotask(() => { window.__t.handler = performance.now() - window.__t.up })
      setTimeout(() => { window.__t.task = performance.now() - window.__t.up }, 0)
    }, true)
  })
  await p.mouse.move(target.x, target.y)
  await p.mouse.down(); await p.mouse.up()
  // Keys typed at once after the click.
  await p.keyboard.type('XY')
  await p.waitForTimeout(500)
  const after = await p.evaluate((target) => {
    const editor = document.querySelector('.cm-focused')
    const lines = {}
    for (const host of document.querySelectorAll('.diff-editor')) {
      const eds = host.querySelectorAll('.cm-editor')
      eds.forEach((ed, i) => {
        const side = eds.length > 1 && i === 0 ? 'a' : ''
        const gut = [...ed.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].filter((g) => g.offsetHeight > 0 && Number(g.textContent) > 0)
        for (const g of gut) {
          const box = g.getBoundingClientRect(); if (box.bottom < 0 || box.top > innerHeight) continue
          lines[(side === 'a' ? 'o' : 'n') + g.textContent + side] = Math.round(box.top * 10) / 10
        }
      })
    }
    const cursor = document.querySelector('.cm-focused .cm-cursor')?.getBoundingClientRect()
    const lineEl = [...document.querySelectorAll('.cm-focused .cm-line')].find((l) => l.textContent.includes('XY'))
    return { lines, cursorLeft: cursor?.left, t: window.__t, typed: lineEl?.textContent.slice(0, 40) ?? null, focused: !!editor }
  }, target)
  let diffs = []
  for (const [k, [top]] of Object.entries(target.tops)) if (after.lines[k] !== undefined && Math.abs(after.lines[k] - top) > 0.5) diffs.push([k, top, after.lines[k]])
  console.log('compared rows', Object.keys(target.tops).filter((k) => after.lines[k] !== undefined).length, 'mismatched', JSON.stringify(diffs.slice(0, 10)))
  console.log('click→caret ms', after.t.caret && Math.round(after.t.caret - after.t.up), 'frames', after.t.frames, 'release task ms', after.t.task && Math.round(after.t.task), 'typed line', JSON.stringify(after.typed), 'focused', after.focused)
  await p.screenshot({ path: `/tmp/bettergit-perf/shots/editor-${layout}-${wrap}.png` })
}
await b.close()
