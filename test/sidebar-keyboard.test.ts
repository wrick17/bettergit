import { beforeAll, expect, test } from 'bun:test'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as jsxDev from 'react/jsx-dev-runtime'
import { runInNewContext } from 'node:vm'

let components: { TreeItem: (props: any) => React.ReactElement<any>; Sidebar: (props: any) => React.ReactNode }

// Compile in memory, like branch-picker.test.ts. Inspect real handlers without a browser or disk build.
beforeAll(async () => {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/Sidebar.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const module = { exports: {} }
  const imports: Record<string, unknown> = {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, () => {}] },
    'react/jsx-runtime': jsx,
    'react/jsx-dev-runtime': jsxDev,
    'react-dom': { createPortal: (node: unknown) => node },
    './Icons': { Icon: () => null, IconButton: () => null },
    './FileIcon': { FolderIcon: () => null },
    './session': { useScrollMemory: () => () => {} },
  }
  runInNewContext(await compiled.outputs[0].text() + '\nmodule.exports.TreeItem = TreeItem', {
    module, exports: module.exports, require: (id: string) => imports[id] ?? {},
  })
  components = module.exports as typeof components
})

function find(node: React.ReactNode, match: (props: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, match); if (found) return found }
  } else if (React.isValidElement<any>(node)) {
    const props = node.props as { children?: React.ReactNode }
    return match(props) ? props : find(props.children, match)
  }
}

const repo = { kind: 'repo', path: '/projects/repo', name: 'repo', branch: 'main' }
const folder = { kind: 'folder', path: '/projects', name: 'projects', children: [repo] }

function row(node: typeof repo | typeof folder, collapsed = false) {
  const calls: string[] = []
  const props = {
    node, depth: 0, config: { hidden: [], collapsed: collapsed ? [node.path] : [] }, showHidden: false,
    selected: repo.path, tabStop: node.path,
    onToggleCollapsed: () => calls.push('toggle'), onSelect: () => calls.push('select'),
    onToggleHidden: () => calls.push('hide'), onFocusRow: () => calls.push('focus'),
  }
  const tree = components.TreeItem(props)
  const current: any = {
    parentElement: { closest: () => ({ focus: () => calls.push('parent') }) },
    querySelector: () => ({ focus: () => calls.push('child') }),
    closest: () => current, focus: () => calls.push('row'),
  }
  const eye = { closest: () => current }
  return { tree, calls, current, eye, props,
    key: (key: string, target: any = eye) => {
      let prevented = false
      tree.props.onKeyDown({ key, target, currentTarget: current, preventDefault: () => { prevented = true } })
      return prevented
    },
  }
}

test('folder eye focus retains the same Left/Right collapse, expand, parent and child navigation as row focus', () => {
  for (const eye of [false, true]) for (const collapsed of [false, true]) {
    const left = row(folder, collapsed)
    expect(left.key('ArrowLeft', eye ? left.eye : left.current)).toBe(true)
    expect(left.calls).toEqual([collapsed ? 'parent' : 'toggle'])
    const right = row(folder, collapsed)
    expect(right.key('ArrowRight', eye ? right.eye : right.current)).toBe(true)
    expect(right.calls).toEqual([collapsed ? 'toggle' : 'child'])
  }
})

test('repo eye Left reaches its parent, Right stays put, and nested-row keys do not toggle ancestor folders', () => {
  const child = row(repo)
  expect(child.key('ArrowLeft')).toBe(true)
  expect(child.calls).toEqual(['parent'])
  child.calls.length = 0
  expect(child.key('ArrowRight')).toBe(false)
  expect(child.calls).toEqual([])
  const parent = row(folder)
  expect(parent.key('ArrowLeft', child.eye)).toBe(false)
  expect(parent.key('ArrowRight', child.eye)).toBe(false)
  expect(parent.calls).toEqual([])
})

test('eye Enter/Space stay with the hide action, its click stops propagation, and roving row semantics remain intact', () => {
  for (const node of [folder, repo]) {
    const item = row(node)
    expect(item.key('Enter')).toBe(false)
    expect(item.key(' ')).toBe(false)
    expect(item.calls).toEqual([])
    const button = find(item.tree, (p) => p.icon === 'eyeOff')
    expect(button.tabIndex).toBe(0)
    expect(item.tree.props.tabIndex).toBe(0)
    const inactive = components.TreeItem({ ...item.props, tabStop: '/other' })
    expect(inactive.props.tabIndex).toBe(-1)
    expect(find(inactive, (p) => p.icon === 'eyeOff').tabIndex).toBe(-1)
    let stopped = false
    find(item.tree, (p) => p.className === 'row-icon has-row-action').onClick({ stopPropagation: () => { stopped = true } })
    button.onClick()
    expect(stopped).toBe(true)
    expect(item.calls).toEqual(['hide'])
    item.calls.length = 0
    expect(item.key('Enter', item.current)).toBe(true)
    expect(item.calls).toEqual([node.kind === 'folder' ? 'toggle' : 'select'])
  }
})

test('Up/Down from eye focus still moves between rows through the tree handler', () => {
  const item = row(repo)
  const next = { focus: () => item.calls.push('next') }
  const tree = components.Sidebar({
    tree: [repo], config: { hidden: [], collapsed: [] }, selected: repo.path,
    fold: { pane: { current: null }, paneHandlers: {}, folded: false, held: false },
  })
  const handler = find(tree, (p) => p.role === 'tree').onKeyDown
  let prevented = 0
  const rows = [item.current, next]
  handler({ key: 'ArrowDown', target: item.eye, currentTarget: { querySelectorAll: () => rows }, preventDefault: () => prevented++ })
  handler({ key: 'ArrowUp', target: { closest: () => next }, currentTarget: { querySelectorAll: () => rows }, preventDefault: () => prevented++ })
  expect(item.calls).toEqual(['next', 'row'])
  expect(prevented).toBe(2)
})
