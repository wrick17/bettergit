// Upward scroll jump probe: scrolls a diff pane up in fixed steps and checks a visible row moves by exactly the step.
// node scripts/perf/jump.mjs <repo> <tab> <layout> [wrap]
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [repo, tab = 'history', layout = 'split', wrap = 'true', hash] = process.argv.slice(2)
const b = await chromium.launch({ args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.addInitScript(([repo, tab, layout, wrap]) => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', layout); localStorage.setItem('bettergit.wordWrap', wrap); localStorage.setItem('bettergit.contextLines', '100000'); localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab, sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) }, [repo, tab, layout, wrap])
await p.goto('http://localhost:5793/'); await p.waitForTimeout(3000)
if (tab === 'history') { await p.locator(hash ? `li.commit[data-hash^="${hash}"]` : 'li.commit >> nth=1').click(); await p.waitForTimeout(2500) }
const result = await p.evaluate(async () => {
  const pane = [...document.querySelectorAll('.diff-pane')].find((e) => e.scrollHeight > e.clientHeight)
  // Jump to the bottom and let it settle, so rows above are placeholders measured or estimated.
  pane.scrollTop = pane.scrollHeight
  await new Promise((r) => setTimeout(r, 800))
  // Measured just after a frame's rendering (layout, resize observers, paint), which is what the user saw.
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  const jumps = []
  window.__anchorLog = []
  window.__sizes = new Map([...pane.querySelectorAll('.diff-file, .row-chunk')].map((e) => [e, e.offsetHeight]))
  let steps = 0
  let pending = false
  for (let i = 0; i < 400 && pane.scrollTop > 0; i++) {
    const box = pane.getBoundingClientRect()
    const ref = [...pane.querySelectorAll('[data-source-row]')].find((e) => { const r = e.getBoundingClientRect(); return r.top > box.top + 200 && r.top < box.bottom - 200 })
    const before = ref?.getBoundingClientRect().top
    const top0 = pane.scrollTop
    pane.scrollTop -= 60
    const moved = top0 - pane.scrollTop
    await frame(); await frame()
    if (ref?.isConnected && before !== undefined) {
      const shift = ref.getBoundingClientRect().top - before - moved
      // A shift undone on the very next step is a commit landing between this probe's read and the next frame's
      // anchoring; it never reached the screen, so the pair is dropped.
      if (Math.abs(shift) > 1 && jumps.length && Math.abs(jumps[jumps.length - 1] + shift) <= 1 && pending) { jumps.pop(); pending = false; continue }
      pending = Math.abs(shift) > 1
      if (Math.abs(shift) > 1) { jumps.push(Math.round(shift)); window.__dumps = (window.__dumps ?? []).concat([[window.__anchorLog.slice(-3), ref.closest('.diff-file')?.dataset.path, before, ref.getBoundingClientRect().top, moved, [...pane.querySelectorAll('.row-chunk, .diff-file')].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > box.top - 3000 && r.top < box.bottom }).map((c) => [c.dataset.lines ?? c.dataset.range ?? c.dataset.path, c.childElementCount, Math.round(c.getBoundingClientRect().top - box.top), c.offsetHeight])]]) }
    }
    steps++
  }
  return { dump: window.__dumps?.slice(-2), steps, jumps: jumps.length, worst: Math.max(0, ...jumps.map(Math.abs)), sample: jumps.slice(0, 10) }
})
console.log(JSON.stringify(result))
await b.close()
