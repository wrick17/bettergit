import type { Branch, BranchSelection, Stash, Tag, Worktree } from '../../main/git/ops'

// What a picked row stands for. The picker decides the action: switch, detached checkout, stash apply or opening a worktree.
export type RefItem =
  | { kind: 'head'; selection: BranchSelection | null }
  | { kind: 'branch'; branch: Branch }
  | { kind: 'tag'; tag: Tag }
  | { kind: 'stash'; stash: Stash }
  | { kind: 'worktree'; worktree: Worktree }

export interface Entry {
  key: string
  // Slash-separated name. Browsing folds it into folders; filtering shows and searches it whole.
  path: string
  lower: string
  detail?: string
  current?: boolean
  disabled?: boolean
  item: RefItem
}

interface Folder { key: string; name: string; children: (Folder | Entry)[]; sub: Map<string, Folder>; count: number; current: boolean }

export interface Section {
  id: string
  label: string
  // Null while the section is still loading.
  entries: Entry[] | null
  folders: boolean
  open: boolean
  // Remotes count remotes, not branches, as Sublime Merge does.
  count?: number
  root: Folder | null
}

export type Row =
  | { type: 'section'; key: string; label: string; count: number | null; expanded: boolean; level: 1 }
  | { type: 'folder'; key: string; label: string; count: number; expanded: boolean; level: number }
  | { type: 'item'; key: string; label: string; entry: Entry; level: number }

const entry = (key: string, path: string, item: RefItem, extra: Partial<Entry> = {}): Entry =>
  ({ key, path, lower: path.toLowerCase(), item, ...extra })

// Folders appear where their first entry does, so Git's alphabetical branches read like Sublime's sidebar.
function fold(id: string, entries: Entry[]): Folder {
  const root: Folder = { key: `f:${id}:`, name: '', children: [], sub: new Map(), count: 0, current: false }
  for (const item of entries) {
    const parts = item.path.split('/')
    let folder = root
    folder.count++
    if (item.current) folder.current = true
    for (const part of parts.slice(0, -1)) {
      let next = folder.sub.get(part)
      if (!next) {
        folder.sub.set(part, next = { key: `${folder.key}${part}/`, name: part, children: [], sub: new Map(), count: 0, current: false })
        folder.children.push(next)
      }
      folder = next
      folder.count++
      if (item.current) folder.current = true
    }
    folder.children.push(item)
  }
  return root
}

export function buildSections({ branches, head, tags, stashes, worktrees, repo }: {
  branches: Branch[]
  // Undefined hides the Starting point section; null is an unborn HEAD.
  head?: BranchSelection | null
  // Undefined hides a section; null shows it loading.
  tags?: Tag[] | null
  stashes?: Stash[] | null
  worktrees?: Worktree[] | null
  repo?: string
}): Section[] {
  const section = (id: string, label: string, entries: Entry[] | null, folders: boolean, open = false, count?: number): Section =>
    ({ id, label, entries, folders, open, count, root: entries && folders ? fold(id, entries) : null })
  const local = branches.filter((branch) => !branch.remote)
  const remote = branches.filter((branch) => branch.remote)
  const sections = [
    ...(head === undefined ? [] : [section('head', 'Starting point', [entry('i:HEAD', 'Current HEAD', { kind: 'head', selection: head },
      { detail: head ? head.hash.slice(0, 7) : 'Create a commit first', disabled: !head })], false, true)]),
    section('local', 'Branches', local.map((branch) =>
      entry(`i:${branch.fullRef}`, branch.name, { kind: 'branch', branch }, { detail: branch.upstream ?? undefined, current: branch.current })), true, true),
    section('remote', 'Remotes', remote.map((branch) => entry(`i:${branch.fullRef}`, branch.name, { kind: 'branch', branch })), true, false,
      new Set(remote.map((branch) => branch.name.split('/')[0])).size),
  ]
  if (tags !== undefined) sections.push(section('tag', 'Tags', tags && tags.map((tag) => entry(`i:${tag.fullRef}`, tag.name, { kind: 'tag', tag })), true))
  if (stashes !== undefined) sections.push(section('stash', 'Stashes', stashes && stashes.map((stash) =>
    entry(`i:stash:${stash.ref}`, stash.message, { kind: 'stash', stash }, { detail: stash.ref })), false))
  if (worktrees !== undefined) sections.push(section('worktree', 'Worktrees', worktrees && worktrees.map((worktree) =>
    entry(`i:wt:${worktree.path}`, worktree.branch ?? `detached at ${worktree.hash.slice(0, 7)}`, { kind: 'worktree', worktree },
      { detail: worktree.path, lower: `${worktree.branch ?? ''}\n${worktree.path}`.toLowerCase(), current: worktree.path === repo, disabled: worktree.path === repo })), false))
  return sections
}

// Browsing shows folders, collapsed unless they hold the current branch. Filtering lists every match by its whole name
// in open sections. `toggled` holds the keys flipped from those defaults.
export function flattenRows(sections: Section[], query: string, toggled: ReadonlySet<string>): Row[] {
  const needle = query.trim().toLowerCase()
  const open = (key: string, byDefault: boolean) => byDefault !== toggled.has(key)
  const rows: Row[] = []
  const walk = (folder: Folder, level: number) => {
    for (const child of folder.children) {
      if (!('children' in child)) {
        rows.push({ type: 'item', key: child.key, label: child.path.slice(child.path.lastIndexOf('/') + 1), entry: child, level })
        continue
      }
      const expanded = open(child.key, child.current)
      rows.push({ type: 'folder', key: child.key, label: child.name, count: child.count, expanded, level })
      if (expanded) walk(child, level + 1)
    }
  }
  for (const section of sections) {
    const key = `s:${section.id}`
    const matches = needle && section.entries ? section.entries.filter((item) => item.lower.includes(needle)) : section.entries
    if (needle && matches?.length === 0) continue
    const expanded = open(key, needle ? true : section.open)
    rows.push({ type: 'section', key, label: section.label, count: matches ? (needle ? matches.length : section.count ?? matches.length) : null, expanded, level: 1 })
    if (!expanded || !matches) continue
    if (needle || !section.root) for (const item of matches) rows.push({ type: 'item', key: item.key, label: item.path, entry: item, level: 2 })
    else walk(section.root, 2)
  }
  return rows
}

// The parent row of an item or folder, for ArrowLeft.
export function parentIndex(rows: Row[], index: number): number {
  const level = rows[index]?.level ?? 1
  for (let i = index - 1; i >= 0; i--) if (rows[i].level < level) return i
  return -1
}
