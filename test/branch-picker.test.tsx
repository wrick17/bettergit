import { expect, test } from 'bun:test'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as jsxDev from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { runInNewContext } from 'node:vm'
import type { Branch } from '../src/main/git/ops'
import * as busy from '../src/renderer/src/repo-busy'
import * as refs from '../src/renderer/src/branch-tree'
import { readWorktrees } from '../src/main/git/ops'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const hash = 'a'.repeat(40)
const branches: Branch[] = [
  { name: 'main', fullRef: 'refs/heads/main', hash, upstream: 'origin/main', upstreamRef: 'refs/remotes/origin/main', current: true, remote: false, ahead: 2, behind: 3, gone: false },
  ...['origin', 'upstream'].map((remote) => ({ name: `${remote}/Topic/Long-Name`, fullRef: `refs/remotes/${remote}/Topic/Long-Name`, hash, upstream: null, upstreamRef: null, current: false, remote: true, ahead: 0, behind: 0, gone: false })),
]

// Same in-memory compilation technique as repo-lock.test.ts. No Electron window, browser or disk build output.
async function harness(api: Record<string, unknown> = {}, headHash: string | null = hash, list: Branch[] = branches) {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/BranchPicker.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const slots: any[] = []
  let cursor = 0, closed = 0, refreshed = 0, changed = 0, confirms = 0
  let discard = false
  let hidden: string[] = []
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
    './confirm': { confirmOverBlur: async () => { confirms++; return discard } },
    './Icons': { Icon: () => null },
    './branch-tree': refs,
    './OverflowBar': { ActionMenu: () => null },
    './prefs': { useHiddenBranches: () => hidden, hiddenBranches: () => hidden, setHiddenBranches: (_repo: string, refs: string[]) => { hidden = refs } },
    './repo-busy': { ...busy, useRepoBusy: () => busy.busyKey('/picker-test') },
  }
  runInNewContext(await compiled.outputs[0].text(), {
    Error, module, exports: module.exports, require: (id: string) => imports[id] ?? {},
    window: { bettergit: api },
    document: { getElementById: () => null },
  })
  const props = { repo: '/picker-test', branches: list, headHash, onRefresh: async () => { refreshed++ }, onChanged: () => { changed++ }, onClose: () => { closed++ } }
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
    hidden: () => hidden,
  }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

const tags = [{ name: 'v1.0.0', fullRef: 'refs/tags/v1.0.0', hash }, { name: 'release/2609', fullRef: 'refs/tags/release/2609', hash }]
const stashes = [{ ref: 'stash@{0}', message: 'WIP on main: topic' }]
const worktrees = [{ path: '/picker-test', branch: 'main', hash, locked: false, current: true }, { path: '/elsewhere', branch: null, hash, locked: false, current: false }]

test('sections fold refs by prefix, count them, and filter every section by whole name', () => {
  const sections = refs.buildSections({ branches: [...branches, { ...branches[0], name: 'feat/a', fullRef: 'refs/heads/feat/a', current: false },
    { ...branches[0], name: 'feat/b', fullRef: 'refs/heads/feat/b', current: false }], tags, stashes, worktrees: null })
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

test('local branches show unpushed and fetched-but-unpulled counts, both when diverged, and a gone upstream', async () => {
  const h = await harness()
  const local = (name: string, extra: Partial<Branch>): Branch => ({ ...branches[0], name, fullRef: `refs/heads/${name}`, current: false, ahead: 0, behind: 0, ...extra })
  const markup = renderToStaticMarkup(h.choices({
    branches: [branches[0], local('gone', { gone: true }), local('synced', {}), local('solo', { upstream: null, upstreamRef: null }), branches[1]],
    query: '', active: null, onQuery() {}, onActive() {}, onPick() {}, id: 'track', disabled: false,
  }))
  expect(markup).toContain('<span title="2 commits to push to origin/main">↑2</span><span title="3 commits to pull from origin/main">↓3</span>')
  expect(markup).toContain('<span title="Upstream origin/main is gone">gone</span>')
  // In sync, no upstream, and remote rows show no badge.
  expect(markup.match(/class="branch-track"/g)).toHaveLength(2)
  expect(markup).not.toContain('conflict')
})

test('only the checked-out branch shows the working tree\'s unresolved conflicts, beside its divergence', async () => {
  const h = await harness()
  const other: Branch = { ...branches[0], name: 'other', fullRef: 'refs/heads/other', current: false, ahead: 1, behind: 1 }
  const markup = renderToStaticMarkup(h.choices({
    branches: [branches[0], other], conflicts: 2,
    query: '', active: null, onQuery() {}, onActive() {}, onPick() {}, id: 'conflicts', disabled: false,
  }))
  expect(markup).toContain('<span class="conflicts" title="2 unresolved conflicted files in the working tree. Resolve them in Changes.">2 conflicts</span><span title="2 commits to push')
  // A diverged branch that is not checked out shows its counts and no conflict.
  expect(markup.match(/class="conflicts"/g)).toHaveLength(1)
})

test('a repo opened through a symlink finds its own worktree as current, by canonical path', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'picker-wt-')))
  try {
    const repo = path.join(dir, 'repo'), alias = path.join(dir, 'alias'), linked = path.join(dir, 'linked')
    const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    run('-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '--allow-empty', '-m', 'c')
    run('worktree', 'add', '-q', '-b', 'side', linked)
    symlinkSync(repo, alias)
    const listed = await readWorktrees(alias)
    expect(listed.map(({ path, current }) => ({ path, current }))).toEqual([{ path: repo, current: true }, { path: linked, current: false }])
    const rows = refs.flattenRows(refs.buildSections({ branches: [], worktrees: listed }), 'main', new Set())
    expect(rows.flatMap((row) => row.type === 'item' ? [{ current: row.entry.current, disabled: row.entry.disabled }] : [])).toEqual([{ current: true, disabled: true }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tree list keeps keyboard folding and picks branches, tags, stashes and worktrees by exact identity', async () => {
  const h = await harness()
  const picked: refs.RefItem[] = []
  let active = null as string | null
  const view = (query = '') => h.choices({ branches, tags, stashes, worktrees, query, active, onQuery() {},
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
  h.click('Cancel'); await flush(); expect(h.stats().closed).toBe(0)
  h.discard(); h.click('Cancel'); await flush(); expect(h.stats().closed).toBe(1)
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

test('Local marks every local branch, and a remote branch only when a local branch tracks its exact ref', async () => {
  const h = await harness()
  // Every branch shares one commit, and a local branch shares a remote's name without tracking it: neither counts.
  const list: Branch[] = [...branches, { ...branches[1], name: 'origin/main', fullRef: 'refs/remotes/origin/main' },
    { ...branches[0], name: 'Topic/Long-Name', fullRef: 'refs/heads/Topic/Long-Name', current: false, upstream: null, upstreamRef: null }]
  const view = (query: string) => renderToStaticMarkup(h.choices({ branches: list, query, active: null, onQuery() {}, onActive() {}, onPick() {}, id: 'local', disabled: false }))
  expect(view('main')).toContain('<span class="branch-local" title="Local branch, tracking origin/main">Local</span>')
  expect(view('main')).toContain('<span class="branch-local" title="Tracked by local branch main">Local</span>')
  expect(view('long-name').match(/class="branch-local"/g)).toHaveLength(1)
})

test('the branch menu never checks out on open, gives remote rows no push-only actions, and Escape closes it before the sheet', async () => {
  const calls: unknown[][] = []
  const other: Branch = { ...branches[0], name: 'other', fullRef: 'refs/heads/other', current: false, upstream: null, upstreamRef: null }
  const h = await harness({ switchBranch: async (...args: unknown[]) => { calls.push(['switch', ...args]) },
    deleteBranch: async (...args: unknown[]) => { calls.push(['delete', ...args]) },
    tags: async () => [], stashes: async () => [], worktrees: async () => [] }, hash, [...branches, other])
  const open = (branch: Branch) => { h.find((p) => typeof p.onMenu === 'function').onMenu(branch, { x: 1, y: 2 }); h.render() }
  const menu = () => h.find((p) => Array.isArray(p.items) && p.at)
  const item = (key: string) => menu().items.find((entry: { key: string }) => entry.key === key)
  open(branches[1])
  expect(menu().items.map((entry: { key: string }) => entry.key)).toEqual(['checkout', 'create-from', 'hide', 'hide-others', 'copy', 'search'])
  expect(calls).toEqual([])
  h.key('Escape')
  expect(menu()).toBeUndefined()
  expect(h.stats().closed).toBe(0)
  // Hiding is by full ref; hiding all but one keeps exactly that one shown.
  open(branches[1]); menu().onPick(item('hide-others')); h.render()
  expect(h.hidden()).toEqual(['refs/heads/main', 'refs/remotes/upstream/Topic/Long-Name', 'refs/heads/other'])
  // The checked-out branch cannot be deleted. Another one is deleted only after confirmation, by exact identity, and the picker stays open.
  open(branches[0])
  expect(item('delete').blocked).toContain('Checked out')
  expect(item('unset-upstream').disabled).toBe(false)
  open(other)
  expect(item('unset-upstream').disabled).toBe(true)
  menu().onPick(item('delete')); await flush()
  expect(calls).toEqual([])
  h.discard()
  open(other); menu().onPick(item('delete')); await flush(); h.render()
  expect(calls).toEqual([['delete', '/picker-test', { fullRef: 'refs/heads/other', hash }]])
  expect(h.stats()).toEqual({ closed: 0, refreshed: 1, changed: 1, confirms: 2 })
  h.key('Escape'); await flush()
  expect(h.stats().closed).toBe(1)
})
