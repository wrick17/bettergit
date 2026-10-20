// Drives the production renderer build in headless Chromium and records interaction latency, long tasks and scroll frame cost.
// Usage: node scripts/perf/bench.mjs <label> [scenario-filter]   (needs server.ts on :5792 and `vite preview` on :5793)
import { writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright')

const label = process.argv[2] ?? 'run'
const only = process.argv[3]
const OUT = '/tmp/bettergit-perf'
const SPUR = `${OUT}/spur-snapshot`
const BIG = `${OUT}/bigrepo`
const SELF = process.cwd()
mkdirSync(`${OUT}/${label}`, { recursive: true })

// Uncapped frames: a frame's interval is then the time it took to make, so frames over 8.3 ms would miss a 120 Hz vsync.
const browser = await chromium.launch({ args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })

async function open({ repo, tab, context = 3, prefs = {} }) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.addInitScript(([repo, tab, context, prefs]) => {
    if (sessionStorage.getItem('init')) return
    sessionStorage.setItem('init', '1')
    localStorage.clear()
    localStorage.setItem('bettergit.session', JSON.stringify({ selected: repo, tab, sidebarOpen: true, listOpen: true, detailOpen: true, places: {}, views: {} }))
    localStorage.setItem('bettergit.contextLines', String(context))
    localStorage.setItem('bettergit.diffLayout', 'unified')
    for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value)
    // Long tasks and event timings for the whole page life.
    window.__entries = []
    for (const type of ['longtask', 'event', 'long-animation-frame']) {
      try { new PerformanceObserver((list) => window.__entries.push(...list.getEntries().map((e) => ({ type, name: e.name, start: e.startTime, duration: e.duration })))).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) }) } catch {}
    }
  }, [repo, tab, context, prefs])
  await page.goto('http://localhost:5793/')
  await settle(page, 20000)
  await page.waitForTimeout(800)
  return page
}

// Settled: no API call in flight and no "Loading…" hint, for three frames in a row.
async function settle(page, timeout = 10000) {
  return page.evaluate((timeout) => new Promise((resolve) => {
    const t0 = performance.now()
    let calm = 0
    const tick = () => {
      const loading = [...document.querySelectorAll('.hint')].some((e) => e.textContent?.includes('Loading'))
      calm = (window.__perf?.inflight ?? 1) === 0 && !loading && document.querySelector('.diff, .commits') ? calm + 1 : 0
      if (calm >= 3 || performance.now() - t0 > timeout) resolve(performance.now())
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), timeout)
}

const rows = []
async function measure(page, scenario, name, act, check) {
  const t0 = await page.evaluate(() => performance.now())
  await act()
  const tDone = await page.evaluate((check) => new Promise((resolve) => {
    const t0 = performance.now()
    let calm = 0
    const ok = check ? new Function(`return (${check})`) : () => true
    const tick = () => {
      const loading = [...document.querySelectorAll('.hint')].some((e) => e.textContent?.includes('Loading'))
      calm = (window.__perf?.inflight ?? 1) === 0 && !loading && ok() ? calm + 1 : 0
      // Two calm frames after the swap, then the time of the first calm frame.
      if (calm >= 2 || performance.now() - t0 > 15000) resolve(performance.now() - 16)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), check)
  await page.waitForTimeout(1500)
  const entries = await page.evaluate(() => window.__entries)
  const inWindow = entries.filter((e) => e.start >= t0 - 5 && e.start <= tDone + 1500)
  const events = inWindow.filter((e) => e.type === 'event' && ['pointerdown', 'pointerup', 'click', 'keydown'].includes(e.name))
  const tasks = inWindow.filter((e) => e.type === 'longtask')
  const row = {
    scenario, name,
    nextPaint: Math.round(Math.max(0, ...events.map((e) => e.duration))),
    content: Math.round(tDone - t0),
    longestTask: Math.round(Math.max(0, ...tasks.map((e) => e.duration))),
    blocking: Math.round(tasks.reduce((sum, e) => sum + Math.max(0, e.duration - 50), 0)),
  }
  rows.push(row)
  console.log(JSON.stringify(row))
}

async function scroll(page, scenario, selector, name = 'scroll diff', trace = true) {
  const session = await page.context().newCDPSession(page)
  if (trace) await session.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame,toplevel', transferMode: 'ReturnAsStream' })
  const result = await page.evaluate((selector) => new Promise((resolve) => {
    const pane = [...document.querySelectorAll(selector)].find((e) => e.scrollHeight > e.clientHeight)
    if (!pane) return resolve(null)
    pane.scrollTop = 0
    const start = performance.now()
    const tasks0 = window.__entries.length
    const deltas = []
    let last = performance.now()
    const step = (now) => {
      deltas.push(now - last)
      last = now
      pane.scrollTop += 40
      if (performance.now() - start < 3000 && pane.scrollTop + pane.clientHeight < pane.scrollHeight - 2) requestAnimationFrame(step)
      else {
        const longTasks = window.__entries.slice(tasks0).filter((e) => e.type === 'longtask')
        deltas.shift()
        deltas.sort((a, b) => a - b)
        const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))]
        resolve({ frames: deltas.length, height: pane.scrollHeight, p50: q(0.5), p95: q(0.95), max: deltas[deltas.length - 1], over120: deltas.filter((d) => d > 8.34).length / deltas.length, over60: deltas.filter((d) => d > 16.7).length / deltas.length, longestTask: Math.max(0, ...longTasks.map((e) => e.duration)) })
      }
    }
    requestAnimationFrame(step)
  }), selector)
  if (trace) {
    const done = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve))
    await session.send('Tracing.end')
    const { stream } = await done
    let data = ''
    for (;;) { const chunk = await session.send('IO.read', { handle: stream }); data += chunk.data; if (chunk.eof) break }
    writeFileSync(`${OUT}/${label}/trace-${scenario.replace(/\W+/g, '-')}.json`, data)
  }
  const row = { scenario, name, ...Object.fromEntries(Object.entries(result ?? {}).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v])) }
  rows.push(row)
  console.log(JSON.stringify(row))
}

const click = (page, selector) => () => page.locator(selector).first().click()
const MD = '.diff-toolbar button[aria-label*="arkdown"]'
const WS = '.diff-toolbar button[aria-label*="hitespace"]'
const SPLIT = '.diff-toolbar button[aria-label*="plit"]'
const UNIFIED = '.diff-toolbar button[aria-label*="nified"]'
const mdOn = "document.querySelector('.md-hunk') !== null"
const mdOff = "document.querySelector('.md-hunk') === null"
const split = "document.querySelector('.diff .split-row, .diff .cm-mergeView, .diff .ed-split') !== null"
const unified = "document.querySelector('.diff .split-row, .diff .cm-mergeView, .diff .ed-split') === null"

async function toggles(page, scenario, { markdown = true } = {}) {
  if (markdown) {
    await measure(page, scenario, 'markdown on', click(page, MD), mdOn)
    await measure(page, scenario, 'markdown off', click(page, MD), mdOff)
    await measure(page, scenario, 'markdown on again', click(page, MD), mdOn)
    await measure(page, scenario, 'markdown off again', click(page, MD), mdOff)
  }
  await measure(page, scenario, 'whitespace hide', click(page, WS))
  await measure(page, scenario, 'whitespace show', click(page, WS))
  await measure(page, scenario, 'whitespace hide again', click(page, WS))
  await measure(page, scenario, 'whitespace show again', click(page, WS))
  await measure(page, scenario, 'split', click(page, SPLIT), split)
  await measure(page, scenario, 'unified', click(page, UNIFIED), unified)
}

const scenarios = {
  async 'spur changes ctx3'() {
    const page = await open({ repo: SPUR, tab: 'changes', context: 3 })
    await toggles(page, 'spur changes ctx3')
    await scroll(page, 'spur changes ctx3', '.diff-pane')
    await page.keyboard.press('Meta+f')
    await measure(page, 'spur changes ctx3', 'find type "the"', async () => { await page.keyboard.type('the') },
      "globalThis.CSS?.highlights?.has('find-current')")
    await page.keyboard.press('Escape')
    await page.evaluate(() => document.querySelector('.diff-pane').scrollTo(0, 0))
    await page.waitForTimeout(300)
    await measure(page, 'spur changes ctx3', 'click to edit', click(page, '.diff-file .ed-line.add code, .diff-file .cm-line'), "document.querySelector('.cm-focused .cm-cursor') !== null")
    await page.close()
  },
  async 'spur changes all'() {
    const page = await open({ repo: SPUR, tab: 'changes', context: 100000 })
    await toggles(page, 'spur changes all')
    await scroll(page, 'spur changes all', '.diff-pane')
    await measure(page, 'spur changes all', 'markdown on (for scroll)', click(page, MD), mdOn)
    await scroll(page, 'spur changes all md', '.diff-pane', 'scroll formatted', false)
    await measure(page, 'spur changes all', 'select file', click(page, '.file-list .file >> nth=2'))
    await page.close()
  },
  async 'big changes'() {
    const page = await open({ repo: BIG, tab: 'changes', context: 3 })
    await toggles(page, 'big changes', { markdown: false })
    await scroll(page, 'big changes', '.diff-pane')
    await measure(page, 'big changes', 'select file', click(page, '.file-list .file >> nth=12'))
    await page.close()
  },
  async 'big history'() {
    const page = await open({ repo: BIG, tab: 'history', context: 3 })
    await measure(page, 'big history', 'select big commit', click(page, 'li.commit >> nth=1'))
    await measure(page, 'big history', 'select newest commit', click(page, 'li.commit >> nth=0'))
    await measure(page, 'big history', 'select big commit again', click(page, 'li.commit >> nth=1'))
    await toggles(page, 'big history', { markdown: false })
    await measure(page, 'big history', 'context 10', click(page, '.context-toggle button >> nth=1'))
    await measure(page, 'big history', 'context 3', click(page, '.context-toggle button >> nth=0'))
    await scroll(page, 'big history', '.commit-detail .diff-pane')
    await page.evaluate(() => document.querySelector('.commit-detail .diff-pane')?.scrollTo(0, 0))
    await page.keyboard.press('Meta+f')
    await measure(page, 'big history', 'find far row (unmounted)', async () => { await page.keyboard.type('value29_399'); await page.keyboard.press('Enter') },
      "globalThis.CSS?.highlights?.has('find-current') && (() => { const r = [...CSS.highlights.get('find-current')][0].getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight })()")
    await page.keyboard.press('Escape')
    await measure(page, 'big history', 'load more x5', async () => { for (let i = 0; i < 5; i++) { await page.locator('.history-list .more').click(); await page.waitForTimeout(300) } })
    await scroll(page, 'big history list', '.history-scroll', 'scroll commit list', false)
    await measure(page, 'big history', 'switch repo', click(page, `[role="treeitem"]:has-text("spur-snapshot")`))
    await page.close()
  },
  async 'bettergit md commit'() {
    const page = await open({ repo: SELF, tab: 'history', context: 3 })
    await measure(page, 'bettergit md commit', 'select 3569d6b', click(page, 'li.commit[data-hash^="3569d6b"]'))
    await toggles(page, 'bettergit md commit')
    await page.close()
  },
}

for (const [name, run] of Object.entries(scenarios)) {
  if (only && !name.includes(only)) continue
  try { await run() } catch (error) { console.error(name, 'failed:', error.message); rows.push({ scenario: name, name: 'FAILED', error: error.message.split('\n')[0] }) }
}
writeFileSync(`${OUT}/${label}/results.json`, JSON.stringify(rows, null, 1))
await browser.close()
