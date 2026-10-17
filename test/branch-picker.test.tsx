import { expect, test } from 'bun:test'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as jsxDev from 'react/jsx-dev-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { runInNewContext } from 'node:vm'
import type { Branch } from '../src/main/git/ops'
import * as busy from '../src/renderer/src/repo-busy'

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
    react: { ...React, useId: () => 'picker', useEffect() {},
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
  return { render, find, Choices: module.exports.BranchChoices as typeof import('../src/renderer/src/BranchPicker').BranchChoices,
    click: (label: string) => { const button = find((p) => p.children === label && typeof p.onClick === 'function'); expect(button).toBeDefined(); button.onClick(); render() },
    key: (key: string) => { find((p) => p.role === 'dialog').onKeyDown({ key, preventDefault() {}, stopPropagation() {} }); render() },
    submit: () => { find((p) => p.role === 'dialog').onSubmit({ preventDefault() {} }); render() },
    stats: () => ({ closed, refreshed, changed, confirms }),
    discard: () => { discard = true },
  }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

test('branch rows expose groups, current/upstream labels and exact identities after case-insensitive keyboard search', async () => {
  const h = await harness()
  const picked: unknown[] = []
  let active = 0
  const view = (query = '') => h.Choices({ branches, query, active, onQuery() {}, onActive: (index) => { active = index }, onPick: (selection) => picked.push(selection), id: 'list', disabled: false })
  const all = renderToStaticMarkup(view())
  expect(all).toContain('role="group" aria-label="Local"')
  expect(all).toContain('role="group" aria-label="Remote"')
  expect(all).toContain('origin/main')
  expect(all).toContain('>Current</span>')
  const markup = renderToStaticMarkup(view('tOpIc'))
  expect(markup).toContain('origin/Topic/Long-Name')
  expect(markup).toContain('upstream/Topic/Long-Name')
  expect(markup).not.toContain('>main<')
  const key = (value: string, query = 'tOpIc') => h.find((p) => p.role === 'combobox', view(query)).onKeyDown({ key: value, preventDefault() {} })
  key('ArrowDown'); expect(active).toBe(1)
  key('Home'); expect(active).toBe(0)
  key('End'); expect(active).toBe(1)
  key('ArrowUp'); expect(active).toBe(0)
  key('End'); key('Enter')
  expect(picked).toEqual([{ fullRef: branches[2].fullRef, hash }])
  expect(renderToStaticMarkup(view('missing'))).toContain('No matching branches')
  key('Enter', 'missing'); expect(picked).toHaveLength(1)
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
  h.find((p) => typeof p.onPick === 'function').onPick({ fullRef: branches[2].fullRef, hash }); h.render()
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
  h.find((p) => typeof p.onPick === 'function').onPick({ fullRef: branches[1].fullRef, hash }); h.render()
  expect(h.find((p) => p.type === 'submit').disabled).toBe(false)
})
