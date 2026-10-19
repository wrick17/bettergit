import { expect, test } from 'bun:test'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as jsxDev from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { runInNewContext } from 'node:vm'
import type { Branch } from '../src/main/git/ops'
import * as busy from '../src/renderer/src/repo-busy'
import * as refs from '../src/renderer/src/branch-tree'

const hash = 'a'.repeat(40)
const branches: Branch[] = [
  { name: 'main', fullRef: 'refs/heads/main', hash, upstream: 'origin/main', upstreamRef: 'refs/remotes/origin/main', current: true, remote: false },
  ...['origin', 'upstream'].map((remote) => ({ name: `${remote}/Topic/Long-Name`, fullRef: `refs/remotes/${remote}/Topic/Long-Name`, hash, upstream: null, upstreamRef: null, current: false, remote: true })),
]

// Same in-memory compilation technique as repo-lock.test.ts. No Electron window, browser or disk build output.
async function harness(api: Record<string, unknown> = {}, headHash: string | null = hash) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/BranchPicker.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const slots: any[] = []
  let cursor = 0, closed = 0, refreshed = 0, changed = 0, confirms = 0
  let discard = false
  const module = { exports: {} as any }
  const imports: Record<string, unknown> = {
    react: { ...React, useId: () => 'picker', useEffect() {}, useLayoutEffect() {}, useMemo: (make: () => unknown) => make(),
      useState: (initial: any) => {
        const index = cursor++
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
        return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
      },
      useRef: (initial: any) => slots[cursor++] ??= { current: initial },
    },
    'react/jsx-runtime': jsx,
    'react/jsx-dev-runtime': jsxDev,
    'react-dom': { createPortal: (node: unknown) => node },
    './Dialogs': { useDialogFocus() {} },
    './Icons': { Icon: () => null },
    './branch-tree': refs,
    './repo-busy': { ...busy, useRepoBusy: () => busy.busyKey('/picker-test') },
  }
  runInNewContext(await compiled.outputs[0].text(), {
    Error, module, exports: module.exports, require: (id: string) => imports[id] ?? {},
    window: { bettergit: api, confirm: () => { confirms++; return discard } },
    document: { getElementById: () => null },
  })
  const props = { repo: '/picker-test', branches, headHash, onRefresh: async () => { refreshed++ }, onChanged: () => { changed++ }, onClose: () => { closed++ } }
  let tree: React.ReactNode
  const render = () => { cursor = 0; tree = module.exports.BranchPicker(props); return tree }
  const find = (match: (props: any) => boolean, node: React.ReactNode = tree): any => {
    for (const child of Array.isArray(node) ? node : [node]) {
      if (!React.isValidElement<any>(child)) continue
      if (match(child.props)) return child.props
      const found = find(match, child.props.children ?? null)
      if (found) return found
    }
  }
  render()
  const Choices = module.exports.BranchChoices as typeof import('../src/renderer/src/BranchPicker').BranchChoices
  // Its own hook slots, so fold state persists between calls like a mounted list.
  const choices = (props: Parameters<typeof Choices>[0]) => { cursor = 1000; return Choices(props) }
  return { render, find, choices,
    click: (label: string) => { const button = find((p) => p.children === label && typeof p.onClick === 'function'); expect(button).toBeDefined(); button.onClick(); render() },
    key: (key: string) => { find((p) => p.role === 'dialog').onKeyDown({ key, preventDefault() {}, stopPropagation() {} }); render() },
    submit: () => { find((p) => p.role === 'dialog').onSubmit({ preventDefault() {} }); render() },
    stats: () => ({ closed, refreshed, changed, confirms }),
    discard: () => { discard = true },
  }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

const tags = [{ name: 'v1.0.0', fullRef: 'refs/tags/v1.0.0', hash }, { name: 'release/2609', fullRef: 'refs/tags/release/2609', hash }]
const stashes = [{ ref: 'stash@{0}', message: 'WIP on main: topic' }]
const worktrees = [{ path: '/picker-test', branch: 'main', hash, locked: false }, { path: '/elsewhere', branch: null, hash, locked: false }]

test('sections fold refs by prefix, count them, and filter every section by whole name', () => {
  const sections = refs.buildSections({ branches: [...branches, { ...branches[0], name: 'feat/a', fullRef: 'refs/heads/feat/a', current: false },
    { ...branches[0], name: 'feat/b', fullRef: 'refs/heads/feat/b', current: false }], tags, stashes, worktrees: null, repo: '/picker-test' })
  const labels = (rows: refs.Row[]) => rows.map((row) => `${row.level}:${row.label}${row.type === 'section' ? `(${row.count ?? '…'})` : ''}${row.type !== 'item' && !row.expanded ? '+' : ''}`)
  // Branches open, others folded; folders sit where their first branch does and start folded unless they hold HEAD.
  expect(labels(refs.flattenRows(sections, '', new Set()))).toEqual(['1:Branches(3)', '2:main', '2:feat+', '1:Remotes(2)+', '1:Tags(2)+', '1:Stashes(1)+', '1:Worktrees(…)+'])
  const opened = refs.flattenRows(sections, '', new Set(['f:local:feat/', 's:remote', 'f:remote:origin/', 's:tag']))
  expect(labels(opened)).toEqual(['1:Branches(3)', '2:main', '2:feat', '3:a', '3:b', '1:Remotes(2)', '2:origin', '3:Topic+', '2:upstream+',
    '1:Tags(2)', '2:v1.0.0', '2:release+', '1:Stashes(1)+', '1:Worktrees(…)+'])
  expect(refs.parentIndex(opened, 4)).toBe(2)
  // Filtering opens matching sections, lists whole names, and hides sections without a match.
  expect(labels(refs.flattenRows(sections, 'TOPIC', new Set()))).toEqual(['1:Remotes(2)', '2:origin/Topic/Long-Name', '2:upstream/Topic/Long-Name', '1:Stashes(1)', '2:WIP on main: topic', '1:Worktrees(…)'])
  expect(labels(refs.flattenRows(sections, 'topic', new Set(['s:remote'])))[0]).toBe('1:Remotes(2)+')
})

test('the tree list keeps keyboard folding and picks branches, tags, stashes and worktrees by exact identity', async () => {
  const h = await harness()
  const picked: refs.RefItem[] = []
  let active = null as string | null
  const view = (query = '') => h.choices({ branches, tags, stashes, worktrees, repo: '/picker-test', query, active, onQuery() {},
    onActive: (key) => { active = key }, onPick: (item) => picked.push(item), id: 'list', disabled: false })
  const all = renderToStaticMarkup(view())
  expect(all).toContain('role="tree"')
  expect(all).toContain('aria-level="1" aria-selected="false" aria-expanded="true"')
  expect(all).toContain('>Current</span>')
  expect(all).toContain('origin/main')
  expect(all).not.toContain('Long-Name')
  const key = (value: string, query = '') => h.find((p) => p.role === 'combobox', view(query)).onKeyDown({ key: value, preventDefault() {} })
  // The first item starts active; Home reaches the Branches header, End the folded Worktrees header, which ArrowRight opens.
  key('Home'); expect(active).toBe('s:local')
  key('End'); expect(active).toBe('s:worktree')
  key('ArrowRight'); key('End'); expect(active).toBe('i:wt:/elsewhere')
  key('Enter'); key('ArrowUp'); key('Enter')
  expect(picked).toEqual([{ kind: 'worktree', worktree: worktrees[1] }])
  key('ArrowLeft'); expect(active).toBe('s:worktree')
  key('ArrowLeft'); expect(renderToStaticMarkup(view())).not.toContain('/elsewhere')
  active = null as string | null
  key('ArrowDown', 'tOpIc'); expect(active).toBe('i:refs/remotes/upstream/Topic/Long-Name')
  key('Enter', 'tOpIc')
  key('Home', 'v1'); key('ArrowDown', 'v1'); key('Enter', 'v1')
  active = null as string | null; key('Enter', 'wip')
  expect(picked.slice(1)).toEqual([{ kind: 'branch', branch: branches[2] }, { kind: 'tag', tag: tags[0] }, { kind: 'stash', stash: stashes[0] }])
  expect(renderToStaticMarkup(view('missing'))).toContain('No matching refs')
  key('Enter', 'missing'); expect(picked).toHaveLength(4)
})

test('creation retains its name through base selection, refuses dismissal while running, and keeps errors/drafts after failure', async () => {
  let reject!: (error: Error) => void
  const calls: unknown[][] = []
  const pending = new Promise<void>((_done, fail) => { reject = fail })
  const h = await harness({ createBranch: (...args: unknown[]) => { calls.push(args); return pending } })
  let tabStopped = false, tabPrevented = false
  const tab = () => h.find((p) => p.role === 'dialog').onKeyDown({ key: 'Tab', stopPropagation: () => { tabStopped = true }, preventDefault: () => { tabPrevented = true } })
  tab(); expect(tabStopped).toBe(false); expect(tabPrevented).toBe(false)
  h.click('Create Branch…')
  h.find((p) => p.name === 'branch-name').onChange({ target: { value: 'draft/topic' } }); h.render()
  h.find((p) => p.className === 'branch-base').onClick(); h.render()
  h.key('Escape')
  expect(h.find((p) => p.name === 'branch-name').value).toBe('draft/topic')
  h.find((p) => p.className === 'branch-base').onClick(); h.render()
  h.find((p) => typeof p.onPick === 'function').onPick({ kind: 'branch', branch: branches[2] }); h.render()
  h.submit(); h.submit(); h.key('Escape')
  tab(); expect(tabPrevented).toBe(true)
  expect(calls).toEqual([['/picker-test', 'draft/topic', { fullRef: branches[2].fullRef, hash }]])
  expect(h.stats().closed).toBe(0)
  expect(h.find((p) => p.type === 'submit').disabled).toBe(true)
  reject(new Error('Selected branch changed'))
  await flush(); h.render()
  expect(h.stats()).toEqual({ closed: 0, refreshed: 1, changed: 0, confirms: 0 })
  expect(h.find((p) => p.role === 'alert').children).toBe('Selected branch changed')
  expect(h.find((p) => p.name === 'branch-name').value).toBe('draft/topic')
  h.click('Cancel'); expect(h.stats().closed).toBe(0)
  h.discard(); h.click('Cancel'); expect(h.stats().closed).toBe(1)
})

test('search-only cancel makes no Git call, and successful creation closes after one write and reload', async () => {
  const calls: unknown[][] = []
  const h = await harness({ createBranch: async (...args: unknown[]) => { calls.push(args) } })
  h.find((p) => typeof p.onPick === 'function').onQuery('topic'); h.render()
  h.click('Cancel')
  expect(h.stats()).toEqual({ closed: 1, refreshed: 0, changed: 0, confirms: 0 })
  expect(calls).toEqual([])
  h.click('Create Branch…')
  h.find((p) => p.name === 'branch-name').onChange({ target: { value: 'new-topic' } }); h.render()
  h.submit(); await flush(); h.render()
  expect(calls).toEqual([['/picker-test', 'new-topic', { fullRef: 'HEAD', hash }]])
  expect(h.stats().closed).toBe(2)
  expect(h.stats().changed).toBe(1)
})

test('unborn Current HEAD disables creation while a picked fetched base remains usable', async () => {
  const h = await harness({}, null)
  h.click('Create Branch…')
  h.find((p) => p.name === 'branch-name').onChange({ target: { value: 'first-topic' } }); h.render()
  expect(h.find((p) => p.type === 'submit').disabled).toBe(true)
  h.find((p) => p.className === 'branch-base').onClick(); h.render()
  h.find((p) => typeof p.onPick === 'function').onPick({ kind: 'branch', branch: branches[1] }); h.render()
  expect(h.find((p) => p.type === 'submit').disabled).toBe(false)
})
