// Author-filter popover screenshot, to check its backdrop blur: node scripts/perf/popover.mjs <out.png> [css-to-inject]
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [out, css = ''] = process.argv.slice(2)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
await p.addInitScript(() => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.session', JSON.stringify({ selected: '/tmp/bettergit-perf/bigrepo', tab: 'history', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) })
await p.goto('http://localhost:5793/'); await p.waitForTimeout(2500)
if (css) await p.addStyleTag({ content: css })
await p.locator('.author-trigger').click(); await p.waitForTimeout(600)
const box = await p.evaluate(() => { const r = document.querySelector('.author-popover').getBoundingClientRect(); const s = getComputedStyle(document.querySelector('.author-popover')); return { x: r.x, y: r.y, w: r.width, h: r.height, bf: s.backdropFilter } })
console.log(JSON.stringify(box))
await p.screenshot({ path: out, clip: { x: box.x - 40, y: box.y - 10, width: box.w + 60, height: Math.min(box.h + 20, 300) } })
// The band of the popover over the commit list, below its search field, with the popover's own text hidden.
await p.addStyleTag({ content: '.author-popover * { visibility: hidden !important }' })
await p.waitForTimeout(200)
const band = await p.screenshot({ path: out.replace('.png', '-band.png'), clip: { x: box.x + 10, y: box.y + 60, width: box.w - 20, height: box.h - 70 } })
// Sharpness: variance of the horizontal brightness differences. Blurred text scores near zero.
const score = await p.evaluate(async (data) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode()
  const canvas = new OffscreenCanvas(img.width, img.height); const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
  const { data: px } = ctx.getImageData(0, 0, img.width, img.height)
  let sum = 0, sq = 0, n = 0
  for (let y = 0; y < img.height; y++) for (let x = 1; x < img.width; x++) {
    const i = (y * img.width + x) * 4, j = i - 4
    const d = (px[i] + px[i + 1] + px[i + 2]) / 3 - (px[j] + px[j + 1] + px[j + 2]) / 3
    sum += d; sq += d * d; n++
  }
  return Math.round((sq / n - (sum / n) ** 2) * 10) / 10
}, band.toString('base64'))
console.log('sharpness', score)
await b.close()
