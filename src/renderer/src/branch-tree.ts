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
  // The whole ref name, shown and searched as is.
  path: string
  lower: string
  detail?: string
  current?: boolean
  disabled?: boolean
  item: RefItem
}

export interface Section {
  id: string
  label: string
  // Null while the section is still loading.
  entries: Entry[] | null
  open: boolean
  // Remotes count remotes, not branches, as Sublime Merge does.
  count?: number
}

export type Row =
  | { type: 'section'; key: string; label: string; count: number | null; expanded: boolean; level: 1 }
  | { type: 'item'; key: string; label: string; entry: Entry; level: number }

const entry = (key: string, path: string, item: RefItem, extra: Partial<Entry> = {}): Entry =>
  ({ key, path, lower: path.toLowerCase(), item, ...extra })

export function buildSections({ branches, head, tags, stashes, worktrees, hidden }: {
  branches: Branch[]
  // Undefined hides the Starting point section; null is an unborn HEAD.
  head?: BranchSelection | null
  // Undefined hides a section; null shows it loading.
  tags?: Tag[] | null
  stashes?: Stash[] | null
  worktrees?: Worktree[] | null
  // Full refs hidden from the list. They move to a folded Hidden section, where they can still be picked or shown again.
  hidden?: ReadonlySet<string>
}): Section[] {
  const section = (id: string, label: string, entries: Entry[] | null, open = false, count?: number): Section =>
    ({ id, label, entries, open, count })
  const branchEntry = (branch: Branch) => entry(`i:${branch.fullRef}`, branch.name, { kind: 'branch', branch },
    branch.remote ? {} : { detail: branch.upstream ?? undefined, current: branch.current })
  const concealed = hidden?.size ? branches.filter((branch) => hidden.has(branch.fullRef)) : []
  const shown = concealed.length ? branches.filter((branch) => !hidden!.has(branch.fullRef)) : branches
  const local = shown.filter((branch) => !branch.remote)
  const remote = shown.filter((branch) => branch.remote)
  const sections = [
    ...(head === undefined ? [] : [section('head', 'Starting point', [entry('i:HEAD', 'Current HEAD', { kind: 'head', selection: head },
      { detail: head ? head.hash.slice(0, 7) : 'Create a commit first', disabled: !head })], true)]),
    section('local', 'Branches', local.map(branchEntry), true),
    section('remote', 'Remotes', remote.map(branchEntry), false, new Set(remote.map((branch) => branch.name.split('/')[0])).size),
    ...(concealed.length ? [section('hidden', 'Hidden', concealed.map(branchEntry))] : []),
  ]
  if (tags !== undefined) sections.push(section('tag', 'Tags', tags && tags.map((tag) => entry(`i:${tag.fullRef}`, tag.name, { kind: 'tag', tag }))))
  if (stashes !== undefined) sections.push(section('stash', 'Stashes', stashes && stashes.map((stash) =>
    entry(`i:stash:${stash.ref}`, stash.message, { kind: 'stash', stash }, { detail: stash.ref }))))
  if (worktrees !== undefined) sections.push(section('worktree', 'Worktrees', worktrees && worktrees.map((worktree) =>
    entry(`i:wt:${worktree.path}`, worktree.branch ?? `detached at ${worktree.hash.slice(0, 7)}`, { kind: 'worktree', worktree },
      { detail: worktree.path, lower: `${worktree.branch ?? ''}\n${worktree.path}`.toLowerCase(), current: worktree.current, disabled: worktree.current }))))
  return sections
}

// A flat list, as Sublime Merge's Checkout palette: every ref by its whole name, so a nested name like feat/x is never folded
// away. Filtering keeps only matches, in open sections. `toggled` holds the section keys flipped from their defaults.
export function flattenRows(sections: Section[], query: string, toggled: ReadonlySet<string>): Row[] {
  const needle = query.trim().toLowerCase()
  const rows: Row[] = []
  for (const section of sections) {
    const key = `s:${section.id}`
    const matches = needle && section.entries ? section.entries.filter((item) => item.lower.includes(needle)) : section.entries
    if (needle && matches?.length === 0) continue
    const expanded = (needle ? true : section.open) !== toggled.has(key)
    rows.push({ type: 'section', key, label: section.label, count: matches ? (needle ? matches.length : section.count ?? matches.length) : null, expanded, level: 1 })
    if (expanded && matches) for (const item of matches) rows.push({ type: 'item', key: item.key, label: item.path, entry: item, level: 2 })
  }
  return rows
}

// The parent row of an item, for ArrowLeft.
export function parentIndex(rows: Row[], index: number): number {
  const level = rows[index]?.level ?? 1
  for (let i = index - 1; i >= 0; i--) if (rows[i].level < level) return i
  return -1
}
