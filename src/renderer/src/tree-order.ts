import type { TreeNode } from '../../main/scan'

// Sibling paths per parent path, as the user arranged them. The top level is keyed by ''.
export type TreeOrder = Record<string, string[]>

export const TREE_ORDER_KEY = 'bettergit.treeOrder'
// Marks a drag as a sidebar reorder, so the Finder folder drop ignores it.
export const REORDER_TYPE = 'application/x-bettergit-reorder'

type Store = Pick<Storage, 'getItem' | 'setItem'> | undefined

// A corrupt or foreign value reads as no order, entry by entry.
export function loadTreeOrder(store: Store = globalThis.localStorage): TreeOrder {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(TREE_ORDER_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((path) => typeof path === 'string'),
    ))
  } catch {
    return {}
  }
}

export function saveTreeOrder(order: TreeOrder, store: Store = globalThis.localStorage) {
  try { store?.setItem(TREE_ORDER_KEY, JSON.stringify(order)) } catch { /* storage full or unavailable: order lasts this session */ }
}

// Known paths take their saved place; new ones follow in scan order. Missing saved paths are skipped.
export function orderTree(nodes: TreeNode[], order: TreeOrder, parent = ''): TreeNode[] {
  const rank = new Map((order[parent] ?? []).map((path, index) => [path, index]))
  const sorted = [...nodes].sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity))
  return sorted.map((node) => node.kind === 'folder' ? { ...node, children: orderTree(node.children, order, node.path) } : node)
}

// Moves `from` next to `to` within one sibling list. Null when either is not in it, so nothing crosses parents.
export function moveSibling(siblings: string[], from: string, to: string, after: boolean): string[] | null {
  if (from === to || !siblings.includes(from) || !siblings.includes(to)) return null
  const rest = siblings.filter((path) => path !== from)
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, from)
  return rest
}
