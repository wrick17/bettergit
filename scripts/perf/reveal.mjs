// Scroll-to-file probe: picks files in the Changes list and reports where each file's header lands under the toolbar.
// node scripts/perf/reveal.mjs <repo> [layout] [wrap]
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')
const [repo, layout = 'unified', wrap = 'true'] = process.argv.slice(2)
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
p.on('console', (m) => { if (m.text().startsWith('DBG')) console.log(m.text()) })
await p.addInitScript(([repo, layout, wrap]) => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i','1'); localStorage.clear(); localStorage.setItem('bettergit.diffLayout', layout); localStorage.setItem('bettergit.wordWrap', wrap); localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab: 'changes', sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} })) }, [repo, layout, wrap])
await p.goto('http://localhost:5793/'); await p.waitForTimeout(2500)
const where = (path) => p.evaluate((path) => {
  const pane = document.querySelector('.diff-pane')
  const section = [...pane.querySelectorAll('.diff-file')].find((s) => s.dataset.path === path)
  const toolbar = pane.querySelector('.diff-toolbar').getBoundingClientRect()
  return section ? [Math.round(section.getBoundingClientRect().top - toolbar.bottom), pane.scrollTop, pane.scrollHeight - pane.clientHeight, document.querySelectorAll('.diff-file').length, section.offsetHeight].join('/') : null
}, path)
const files = await p.evaluate(() => [...document.querySelectorAll('.file-list .file')].map((f) => f.closest('li, [role=treeitem]')?.querySelector('.file')?.textContent))
const count = await p.locator('.file-list .file').count()
for (const index of [count - 1, 1, count - 1]) {
  await p.locator('.file-list .file').nth(index).click()
  const path = await p.evaluate(async (repo) => { await new Promise((r) => setTimeout(r, 50)); return JSON.parse(localStorage.getItem('bettergit.session')).places[repo]?.file }, repo)
  const trail = []
  for (let t = 0; t < 12; t++) { await p.waitForTimeout(250); trail.push(await where(path)) }
  console.log('  trail', trail.join(' '))
  const _unused = await p.evaluate((repo) => JSON.parse(localStorage.getItem('bettergit.session')).places[repo]?.file, repo)
  console.log('picked', index, path, 'header top - toolbar bottom:', await where(path))
}
await b.close()
