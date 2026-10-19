// Median of repeated bench runs, before vs after: node scripts/perf/median.mjs base1,base2,base3 after1,after2,after3
import { readFileSync, existsSync } from 'node:fs'
const [before, after] = process.argv.slice(2).map((list) => list.split(','))
const load = (labels) => labels.filter((l) => existsSync(`/tmp/bettergit-perf/${l}/results.json`)).map((l) => JSON.parse(readFileSync(`/tmp/bettergit-perf/${l}/results.json`, 'utf8')))
const runsB = load(before), runsA = load(after)
const median = (values) => { const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : undefined }
const keyOf = (r) => `${r.scenario}|${r.name}`
const keys = [...new Set([...runsB, ...runsA].flat().map(keyOf))]
const pick = (runs, key, metric) => median(runs.map((rows) => rows.find((r) => keyOf(r) === key)?.[metric]))
const fmt = (x, pct) => (x === undefined ? 'n/a' : pct ? `${Math.round(x * 100)}%` : String(Math.round(x * 10) / 10))
const inter = keys.filter((k) => [...runsB, ...runsA].flat().some((r) => keyOf(r) === k && 'content' in r))
const scr = keys.filter((k) => [...runsB, ...runsA].flat().some((r) => keyOf(r) === k && 'p95' in r))
console.log(`Medians of ${runsB.length} runs before and ${runsA.length} runs after.\n`)
console.log('| Scenario | Interaction | Next paint (ms) | Content swapped (ms) | Longest task (ms) |\n|---|---|---|---|---|')
for (const k of inter) { const [s, n] = k.split('|'); console.log(`| ${s} | ${n} | ${['nextPaint', 'content', 'longestTask'].map((m) => `${fmt(pick(runsB, k, m))} → ${fmt(pick(runsA, k, m))}`).join(' | ')} |`) }
console.log('\n| Scenario | Scroll | p95 frame (ms) | Max frame (ms) | Frames > 8.3 ms | Longest task (ms) |\n|---|---|---|---|---|---|')
for (const k of scr) { const [s, n] = k.split('|'); console.log(`| ${s} | ${n} | ${fmt(pick(runsB, k, 'p95'))} → ${fmt(pick(runsA, k, 'p95'))} | ${fmt(pick(runsB, k, 'max'))} → ${fmt(pick(runsA, k, 'max'))} | ${fmt(pick(runsB, k, 'over120'), 1)} → ${fmt(pick(runsA, k, 'over120'), 1)} | ${fmt(pick(runsB, k, 'longestTask'))} → ${fmt(pick(runsA, k, 'longestTask'))} |`) }
