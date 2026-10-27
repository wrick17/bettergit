import { splitPath } from './paths'

// One folder of a file tree, in the order the Changes tree draws it: folders first, then files, each alphabetical.
export interface Folder<T> {
  name: string
  path: string
  folders: Map<string, Folder<T>>
  files: T[]
  // Files beneath this folder, so a collapsed folder still shows how many there are.
  count: number
}

export function buildTree<T>(items: T[], pathOf: (item: T) => string): Folder<T> {
  const root: Folder<T> = { name: '', path: '', folders: new Map(), files: [], count: 0 }
  for (const item of items) {
    let folder = root
    root.count += 1
    for (const part of pathOf(item).split('/').slice(0, -1)) {
      let child = folder.folders.get(part)
      if (!child) {
        child = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [], count: 0 }
        folder.folders.set(part, child)
      }
      folder = child
      folder.count += 1
    }
    folder.files.push(item)
  }
  return sortTree(root, pathOf)
}

function sortTree<T>(folder: Folder<T>, pathOf: (item: T) => string): Folder<T> {
  folder.folders = new Map([...folder.folders].sort(([a], [b]) => a.localeCompare(b)))
  folder.folders.forEach((child) => sortTree(child, pathOf))
  folder.files.sort((a, b) => splitPath(pathOf(a)).name.localeCompare(splitPath(pathOf(b)).name))
  return folder
}

// Every file in the order the tree draws it: depth first, each folder's subfolders before its own files.
export function treeOrder<T>(folder: Folder<T>): T[] {
  return [...[...folder.folders.values()].flatMap(treeOrder), ...folder.files]
}
