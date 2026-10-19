// Find a far, unmounted row in the 12,000-line commit and report where the current match lands.
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const b = await chromium.launch({ args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.addInitScript(() => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', 'unified'); localStorage.setItem('bettergit.session', JSON.stringify({ selected: '/tmp/bettergit-perf/bigrepo', tab: 'history', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) })
await p.goto('http://localhost:5793/'); await p.waitForTimeout(2500)
await p.locator('li.commit >> nth=1').click(); await p.waitForTimeout(2500)
await p.evaluate(() => document.querySelector('.commit-detail .diff-pane')?.scrollTo(0, 0))
await p.evaluate(() => { const pane = document.querySelector('.commit-detail .diff-pane'); window.__sc = []; pane.addEventListener('scroll', () => window.__sc.push([Math.round(performance.now()), pane.scrollTop, [...document.querySelectorAll('.commit-detail code')].some((c) => c.textContent.includes('value29_399'))])) })
await p.keyboard.press('Meta+f')
const t0 = Date.now()
await p.keyboard.type('value29_399'); await p.keyboard.press('Enter')
for (let i = 0; i < 20; i++) {
  await p.waitForTimeout(150)
  const s = await p.evaluate(() => {
    const h = CSS.highlights.get('find-current'); const r = h && [...h][0]?.getBoundingClientRect()
    const code = [...document.querySelectorAll('.commit-detail code')].find((c) => c.textContent.includes('value29_399'))
    const row = code?.closest('[data-source-row]')
    const pane = document.querySelector('.commit-detail .diff-pane').getBoundingClientRect()
    return { row: row && [row.dataset.sourceRow, Math.round(row.getBoundingClientRect().top - pane.top)], chunks: [...document.querySelectorAll('.commit-detail .row-chunk')].filter((c) => c.firstChild).length, has: !!h, size: h?.size, top: r && Math.round(r.top), count: document.querySelector('.find-count')?.textContent, all: CSS.highlights.get('find-match')?.size, scroll: document.querySelector('.commit-detail .diff-pane')?.scrollTop }
  })
  if (i % 4 === 0 || (s.top > 0 && s.top < 1000)) console.log(Date.now() - t0, JSON.stringify(s))
  if (s.top > 0 && s.top < 1000) break
}
console.log(JSON.stringify(await p.evaluate(() => window.__sc.slice(0, 30))))
console.log(JSON.stringify(await p.evaluate(() => { const pane = document.querySelector('.commit-detail .diff-pane'); const box = pane.getBoundingClientRect()
  return [...pane.querySelectorAll('.row-chunk, .diff-file')].filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > box.top - 300 && r.top < box.bottom + 300 }).map((c) => [c.className, c.dataset.lines ?? c.dataset.path, !!c.firstChild, Math.round(c.getBoundingClientRect().top - box.top), c.offsetHeight]) })))
await b.close()
