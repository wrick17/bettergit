import { beforeAll, expect, test } from 'bun:test'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
import * as jsxDev from 'react/jsx-dev-runtime'
import { runInNewContext } from 'node:vm'
import * as treeOrder from '../src/renderer/src/tree-order'

let components: { TreeItem: (props: any) => React.ReactElement<any>; Sidebar: (props: any) => React.ReactNode }

// Compile in memory, like branch-picker.test.ts. Inspect real handlers without a browser or disk build.
beforeAll(async () => {
  const compiled = await Bun.build({ entrypoints: [new URL('../src/renderer/src/Sidebar.tsx', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['*'] })
  expect(compiled.success).toBe(true)
  const module = { exports: {} }
  const imports: Record<string, unknown> = {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useMemo: (make: () => unknown) => make() },
    'react/jsx-runtime': jsx,
    'react/jsx-dev-runtime': jsxDev,
    'react-dom': { createPortal: (node: unknown) => node },
    './Icons': { Icon: () => null, IconButton: () => null, toggleLabel: (state: string, action: string) => `${state} — click to ${action}` },
    './FileIcon': { FolderIcon: () => null },
    './session': { useScrollMemory: () => () => {} },
    './tree-order': treeOrder,
  }
  runInNewContext(await compiled.outputs[0].text() + '\nmodule.exports.TreeItem = TreeItem', {
    module, exports: module.exports, queueMicrotask, require: (id: string) => imports[id] ?? {},
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
    parent: '', siblings: [node.path], onReorder: () => calls.push('reorder'), dragRow: { current: null }, dropAt: null, onDropAt: () => {},
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


function memoryStore(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[treeOrder.TREE_ORDER_KEY, initial]])
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

const paths = (nodes: any[]) => nodes.map((node) => node.path)
const workspace = [
  { kind: 'repo', path: '/a', name: 'a' },
  { kind: 'folder', path: '/f', name: 'f', children: [{ kind: 'repo', path: '/f/x', name: 'x' }, { kind: 'repo', path: '/f/y', name: 'y' }] },
  { kind: 'repo', path: '/b', name: 'b' },
]

test('a saved order survives a reload, applies per parent, appends new children in scan order and skips missing paths', () => {
  const store = memoryStore()
  const root = treeOrder.moveSibling(['/a', '/f', '/b'], '/b', '/a', false)!
  const nested = treeOrder.moveSibling(['/f/x', '/f/y'], '/f/x', '/f/y', true)!
  treeOrder.saveTreeOrder({ '': [...root, '/gone'], '/f': nested }, store)
  const order = treeOrder.loadTreeOrder(store)
  const tree = treeOrder.orderTree([...workspace, { kind: 'repo', path: '/new', name: 'new' }] as any, order)
  expect(paths(tree)).toEqual(['/b', '/a', '/f', '/new'])
  expect(paths((tree[2] as any).children)).toEqual(['/f/y', '/f/x'])
  expect(paths(workspace)).toEqual(['/a', '/f', '/b'])
})

test('a corrupt cache reads as no order and keeps only well-formed entries', () => {
  for (const raw of ['not json', '[1,2]', 'null', '"x"']) expect(treeOrder.loadTreeOrder(memoryStore(raw))).toEqual({})
  expect(treeOrder.loadTreeOrder(memoryStore(JSON.stringify({ '': ['/a'], '/f': 'x', '/g': [1] })))).toEqual({ '': ['/a'] })
  expect(treeOrder.loadTreeOrder(undefined)).toEqual({})
})

test('rows never move across parents', () => {
  expect(treeOrder.moveSibling(['/a', '/f', '/b'], '/f/x', '/a', false)).toBeNull()
  expect(treeOrder.moveSibling(['/f/x', '/f/y'], '/a', '/f/x', true)).toBeNull()
  expect(treeOrder.moveSibling(['/a', '/b'], '/a', '/a', true)).toBeNull()
})

function sidebar(onDrop: (event: any) => unknown = () => {}) {
  return components.Sidebar({
    tree: workspace, config: { hidden: [], collapsed: [] }, selected: null, onDrop,
    fold: { pane: { current: null }, paneHandlers: {}, folded: false, held: false },
  }) as any
}

test('the sidebar renders and roves through rows in the saved order', () => {
  const previous = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = memoryStore(JSON.stringify({ '': ['/b', '/f', '/a'] }))
  try {
    const items = find(sidebar(), (p) => p.role === 'tree').children[1]
    expect(items.map((item: any) => item.props.node.path)).toEqual(['/b', '/f', '/a'])
    expect(items[0].props.tabStop).toBe('/b')
    expect(items[1].props.siblings).toEqual(['/b', '/f', '/a'])
  } finally {
    ;(globalThis as any).localStorage = previous
  }
})

const dragEvent = (types: string[], extra: any = {}) => ({
  dataTransfer: { types, setData() {}, dropEffect: '' }, preventDefault() { this.prevented = true }, stopPropagation() {},
  currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 20 }) }, clientY: 15, prevented: false, ...extra,
})

test('a reorder drag never reaches the folder drop, and a Finder drop still does', () => {
  const dropped: unknown[] = []
  const aside = sidebar((event: unknown) => dropped.push(event))
  const internal = dragEvent([treeOrder.REORDER_TYPE])
  aside.props.onDragOver(internal)
  aside.props.onDrop(internal)
  expect(internal.prevented).toBe(false)
  expect(dropped).toEqual([])
  const files = dragEvent(['Files'])
  aside.props.onDragOver(files)
  aside.props.onDrop(files)
  expect(files.prevented).toBe(true)
  expect(dropped).toEqual([files])
})

test('a row accepts a sibling drop by pointer half and refuses rows from another parent', () => {
  const moves: unknown[][] = []
  const base = {
    node: workspace[2], depth: 0, config: { hidden: [], collapsed: [] }, showHidden: false, selected: null, tabStop: '/a',
    parent: '', siblings: ['/a', '/f', '/b'], onReorder: (...args: unknown[]) => moves.push(args), dropAt: null, onDropAt: () => {},
  }
  const rowOf = (dragRow: any) => find(components.TreeItem({ ...base, dragRow: { current: dragRow } }), (p) => p.draggable)
  const foreign = dragEvent([treeOrder.REORDER_TYPE])
  rowOf({ path: '/f/x', parent: '/f' }).onDrop(foreign)
  expect(foreign.prevented).toBe(false)
  rowOf({ path: '/a', parent: '' }).onDrop(dragEvent([treeOrder.REORDER_TYPE]))
  rowOf({ path: '/a', parent: '' }).onDrop(dragEvent([treeOrder.REORDER_TYPE], { clientY: 5 }))
  expect(moves).toEqual([['', ['/a', '/f', '/b'], '/a', '/b', true], ['', ['/a', '/f', '/b'], '/a', '/b', false]])
})

test('Alt+Up/Down reorders past the shown neighbour and leaves arrow navigation alone', () => {
  const moves: unknown[][] = []
  const item = components.TreeItem({
    node: workspace[0], depth: 0, config: { hidden: ['/f'], collapsed: [] }, showHidden: false, selected: null, tabStop: '/a',
    parent: '', siblings: ['/a', '/f', '/b'], onReorder: (...args: unknown[]) => moves.push(args), dragRow: { current: null }, dropAt: null, onDropAt: () => {},
  })
  const current: any = { closest: () => current, isConnected: false }
  let stopped = 0
  const key = (key: string) => item.props.onKeyDown({ key, altKey: true, target: current, currentTarget: current, preventDefault() {}, stopPropagation: () => stopped++ })
  key('ArrowDown')
  key('ArrowUp')
  expect(moves).toEqual([['', ['/a', '/f', '/b'], '/a', '/b', true]])
  expect(stopped).toBe(2)
})
