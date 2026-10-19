// Word wrap off: sideways scroll sync and frame cost. node scripts/perf/hscroll.mjs <repo> <file> [layout] [tab]
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [repo, file, layout = 'split', tab = 'changes'] = process.argv.slice(2)
const b = await chromium.launch({ args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.addInitScript(([repo, layout, tab]) => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', layout); localStorage.setItem('bettergit.wordWrap', 'false'); localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab, sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) }, [repo, layout, tab])
await p.goto('http://localhost:5793/'); await p.waitForTimeout(3000)
if (tab === 'history') { await p.locator('li.commit >> nth=1').click(); await p.waitForTimeout(2000) }
const sel = `.diff-file[data-path="${file}"]`
await p.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'start' }), sel)
await p.waitForTimeout(300)
const box = await p.evaluate((sel) => { const r = document.querySelector(sel + ' code').getBoundingClientRect(); return [r.left + 50, r.top + 5] }, sel)
// Sideways wheel for 2 s, frames timed.
const cdp = await p.context().newCDPSession(p)
await cdp.send('Tracing.start', { categories: 'devtools.timeline,toplevel', transferMode: 'ReturnAsStream' })
const frames = await p.evaluate(async (sel) => {
  const section = document.querySelector(sel)
  const target = section.querySelector('code')
  const deltas = []
  let last = performance.now()
  const start = last
  await new Promise((resolve) => {
    let dir = 1
    const step = (now) => {
      deltas.push(now - last); last = now
      target.dispatchEvent(new WheelEvent('wheel', { deltaX: 13 * dir, bubbles: true }))
      const x = Number(section.style.getPropertyValue('--sx').replace('px', '') || 0)
      if (x > 400) dir = -1
      else if (x <= 0) dir = 1
      if (now - start < 2000) requestAnimationFrame(step); else resolve()
    }
    requestAnimationFrame(step)
  })
  deltas.shift(); deltas.sort((a, b) => a - b)
  const q = (x) => deltas[Math.floor(deltas.length * x)]
  return { frames: deltas.length, p50: q(0.5), p95: q(0.95), max: deltas[deltas.length - 1], bar: section.querySelector('.hscroll')?.scrollLeft, sx: section.style.getPropertyValue('--sx'), shifted: section.querySelectorAll('code > .sx').length }
}, sel)
console.log('static wheel', JSON.stringify(frames))
{
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r)); await cdp.send('Tracing.end'); const { stream } = await done
  let data = ''; for (;;) { const c = await cdp.send('IO.read', { handle: stream }); data += c.data; if (c.eof) break }
  const ev = JSON.parse(data).traceEvents ?? JSON.parse(data)
  const sums = new Map()
  for (const e of ev) if (e.ph === 'X' && e.dur) sums.set(e.name, [(sums.get(e.name)?.[0] ?? 0) + e.dur / 1000, Math.max(sums.get(e.name)?.[1] ?? 0, e.dur / 1000), (sums.get(e.name)?.[2] ?? 0) + 1])
  console.log([...sums].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12).map(([k, [t, m, n]]) => `${k}: total ${t.toFixed(0)} max ${m.toFixed(1)} n ${n}`).join('\n'))
}
// Click into the current side to mount the editor, then scroll its scroller and check the other side follows.
const at = await p.evaluate((sel) => { const row = document.querySelector(sel + ' .ed-line[data-new] code'); if (!row) return null; const r = row.getBoundingClientRect(); return [r.left + 30, r.top + 8] }, sel)
if (at) {
  await p.mouse.click(at[0], at[1]); await p.waitForTimeout(300)
  const synced = await p.evaluate(async (sel) => {
    const section = document.querySelector(sel)
    const scrollers = [...section.querySelectorAll('.cm-scroller')]
    const before = scrollers.map((s) => s.scrollLeft)
    scrollers[scrollers.length - 1].scrollLeft = 120
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { before, after: scrollers.map((s) => s.scrollLeft), sx: section.style.getPropertyValue('--sx'), bar: section.querySelector('.hscroll')?.scrollLeft }
  }, sel)
  console.log('editor sync', JSON.stringify(synced))
}
await p.screenshot({ path: `/tmp/bettergit-perf/shots/hscroll-${layout}.png` })
await b.close()
