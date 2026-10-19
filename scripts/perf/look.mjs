// Screenshots of a Changes view: node scripts/perf/look.mjs <repo> <out.png> [layout]
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [repo, out, layout = 'unified'] = process.argv.slice(2)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
await p.addInitScript(([repo, layout]) => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', layout); localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) }, [repo, layout])
await p.goto('http://localhost:5793/'); await p.waitForTimeout(3000)
await p.screenshot({ path: out })
console.log(await p.evaluate(() => ({ editors: document.querySelectorAll('.cm-editor').length, files: document.querySelectorAll('.diff-file').length })))
await b.close()
