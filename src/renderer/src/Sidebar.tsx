import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AppConfig } from '../../main/config'
import type { FolderNode, RepoNode, TreeNode } from '../../main/scan'
import type { RepoCounts } from '../../main/git/dirty'
import { Icon, IconButton, toggleLabel } from './Icons'
import { FolderIcon } from './FileIcon'
import { useScrollMemory } from './session'
import type { FoldHold } from './fold'
import { dismissBatch, REFRESHING, useBatchStatus, type BatchStatus } from './batch-status'
import { blockedReason, useRepoBusy, workingLabel } from './repo-busy'
import { loadTreeOrder, moveSibling, orderTree, REORDER_TYPE, saveTreeOrder, type TreeOrder } from './tree-order'

interface SidebarProps {
  tree: TreeNode[]
  config: AppConfig
  selected: string | null
  onSelect: (path: string) => void
  onToggleCollapsed: (path: string) => void
  onToggleHidden: (path: string) => void
  onAddFolder: () => void
  onClone: () => void
  onSettings: () => void
  onRemoveSource: (path: string) => void
  onReveal: (path: string) => void
  onDrop: (event: DragEvent) => void
  // Rescans the sources, for a repo added or deleted while the watcher could not see it. The folder shows the progress.
  onRefresh: (folder: FolderNode) => void
  // Rescans every source and rereads the open repo, as the app menu's Refresh does.
  onRefreshAll: () => void
  // Fetch All or Pull All for the shown repos in a folder.
  onSyncFolder: (folder: FolderNode, kind: 'fetch' | 'pull') => void
  // Fetch, Pull or Refresh for one repo, from its row's menu. The open repo stays open.
  onRepoAction: (repo: RepoNode, action: 'fetch' | 'pull' | 'refresh') => void
  dirty?: Record<string, RepoCounts>
  // Folded into a strip that shows `stripLabel`. A held fold opens the full sidebar in flow beside the content.
  fold: FoldHold<HTMLElement>
  stripLabel?: string
}

interface ContextState {
  x: number
  y: number
  node: TreeNode
}

// The row being dragged to reorder, with the parent it may move within.
interface DragRow {
  path: string
  parent: string
}

const isReorder = (event: DragEvent) => event.dataTransfer.types.includes(REORDER_TYPE)

export function Sidebar(props: SidebarProps) {
  const [showHidden, setShowHidden] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [context, setContext] = useState<ContextState | null>(null)
  const addRef = useRef<HTMLDivElement>(null)
  const addTrigger = useRef<HTMLButtonElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const onTreeScroll = useScrollMemory(treeRef, 'sidebar', '', props.tree.length > 0)
  const [order, setOrder] = useState<TreeOrder>(() => loadTreeOrder())
  const tree = useMemo(() => orderTree(props.tree, order), [props.tree, order])
  const dragRow = useRef<DragRow | null>(null)
  const [dropAt, setDropAt] = useState<{ path: string; after: boolean } | null>(null)
  const batch = useBatchStatus()

  // Saves the whole sibling list, which also drops paths that no longer exist under that parent.
  const reorder = (parent: string, siblings: string[], from: string, to: string, after: boolean) => {
    const moved = moveSibling(siblings, from, to, after)
    if (!moved) return
    const next = { ...order, [parent]: moved }
    setOrder(next)
    saveTreeOrder(next)
  }

  // Popovers close on any outside click or Escape.
  useEffect(() => {
    if (!addOpen && !context) return
    const close = (event: MouseEvent) => {
      // A press inside the context menu is a click on one of its items, so it must reach them.
      if (contextRef.current?.contains(event.target as Node)) return
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false)
      setContext(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAddOpen(false); setContext(null) } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [addOpen, context])

  // Keeps the context menu inside the window, so a click near an edge does not clip it.
  useLayoutEffect(() => {
    const menu = contextRef.current
    if (!context || !menu) return
    menu.style.left = `${Math.max(0, Math.min(context.x, window.innerWidth - menu.offsetWidth))}px`
    menu.style.top = `${Math.max(0, Math.min(context.y, window.innerHeight - menu.offsetHeight))}px`
  }, [context])

  const openContext = (node: TreeNode, x: number, y: number) => setContext({ x, y, node })
  const pick = (action: () => void) => () => { setContext(null); action() }

  const visible = visibleRows(tree, props.config, showHidden)
  // The one row Tab reaches: the last focused row, else the selected one, else the first.
  const tabStop = [focusPath, props.selected].find((path) => path !== null && visible.includes(path)) ?? visible[0]

  return (
    <aside
      ref={props.fold.pane}
      {...props.fold.paneHandlers}
      className={`sidebar${dragging ? ' dragging' : ''}${props.fold.folded ? ' folded' : ''}${props.fold.held ? ' held' : ''}`}
      // A sidebar reorder is not a folder drop: no add-folder outline, and the rows handle its drop.
      onDragOver={(event) => { if (isReorder(event)) return; event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { setDragging(false); if (!isReorder(event)) props.onDrop(event) }}
    >
      {props.fold.folded && (
        <button ref={props.fold.strip} type="button" className="fold-strip" aria-label="Show repositories" aria-expanded={!props.fold.collapsed} onClick={props.fold.activate}>
          <Icon name="chevron" />
          <span className="fold-label">{props.stripLabel}</span>
        </button>
      )}
      <div className="sidebar-head">
        <span className="sidebar-title">Repositories</span>
        <div className="sidebar-tools">
          {/* One batch at a time: it spins for its own run and waits while a folder batch or Fetch All runs. */}
          <IconButton
            icon="rescan"
            label={batch?.running && batch.folder === null && batch.text === REFRESHING ? REFRESHING : 'Refresh repositories'}
            busy={batch?.running && batch.folder === null && batch.text === REFRESHING}
            blocked={batch?.running && !(batch.folder === null && batch.text === REFRESHING) ? 'Wait for the running Refresh, Fetch All or Pull All to finish.' : undefined}
            onClick={props.onRefreshAll}
          />
          <div className="add-anchor" ref={addRef}>
            <button
              ref={addTrigger}
              type="button"
              className={`icon-button${addOpen ? ' on' : ''}`}
              aria-label="Add repositories"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              title="Add repositories"
              onClick={() => setAddOpen((open) => !open)}
            >
              <Icon name="plus" />
            </button>
            {addOpen && (
              <div className="popover add-popover" role="menu">
                <button role="menuitem" onClick={() => { setAddOpen(false); props.onAddFolder() }}>Add folder…</button>
                <button role="menuitem" onClick={() => { setAddOpen(false); addTrigger.current?.focus(); props.onClone() }}>Clone from URL…</button>
              </div>
            )}
          </div>
          <IconButton
            icon="eye"
            label={showHidden ? toggleLabel('Hidden repositories: shown', 'hide them') : toggleLabel('Hidden repositories: hidden', 'show them')}
            active={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          />
          <IconButton icon="settings" label="Settings" onClick={props.onSettings} />
        </div>
      </div>

      <div
        ref={treeRef}
        className="tree"
        role="tree"
        onScroll={onTreeScroll}
        onKeyDown={(event) => {
          if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey) return
          const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
          const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')
          const index = item ? rows.indexOf(item) : -1
          const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (index < 0 || !next) return
          event.preventDefault()
          next.focus()
        }}
      >
        {props.tree.length === 0 && <p className="tree-empty">Drop a projects folder here, or use + to add one.</p>}
        {tree.map((node) => (
          <TreeItem
            key={node.path} {...props} batch={batch} node={node} depth={0} showHidden={showHidden} onContext={openContext} tabStop={tabStop} onFocusRow={setFocusPath}
            parent="" siblings={tree.map((sibling) => sibling.path)} onReorder={reorder} dragRow={dragRow} dropAt={dropAt} onDropAt={setDropAt}
          />
        ))}
      </div>

      <div className={`batch-status${batch?.failed ? ' failed' : ''}`} role="status" aria-live="polite">
        {batch && (
          <>
            <Icon name={batch.running ? 'loader' : batch.failed ? 'warning' : 'done'} className={batch.running ? 'action-spin' : undefined} />
            <span className="batch-status-text">{batch.text}</span>
            {!batch.running && <IconButton icon="close" label="Dismiss status" onClick={dismissBatch} />}
            {batch.problems.length > 0 && <ul>{batch.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          </>
        )}
      </div>

      {/* Portalled to the body: the sidebar's backdrop filter would otherwise clip and offset the fixed menu. */}
      {context && createPortal(
        <div ref={contextRef} className="popover context-menu" role="menu">
          {context.node.kind === 'folder' && (() => {
            const folder = context.node
            return (
              <>
                {/* One batch at a time: these wait while a Refresh, Fetch All or Pull All runs. */}
                <button role="menuitem" disabled={batch?.running} onClick={pick(() => props.onRefresh(folder))}><Icon name="rescan" />Refresh</button>
                <button role="menuitem" disabled={batch?.running} onClick={pick(() => props.onSyncFolder(folder, 'fetch'))}><Icon name="refresh" />Fetch All</button>
                <button role="menuitem" disabled={batch?.running} onClick={pick(() => props.onSyncFolder(folder, 'pull'))}><Icon name="pullMerge" />Pull All</button>
                <div className="popover-sep" role="separator" />
              </>
            )
          })()}
          {context.node.kind === 'repo' && (
            <>
              <RepoActions repo={context.node} pick={pick} onAction={props.onRepoAction} />
              <button role="menuitem" onClick={() => { props.onReveal(context.node.path); setContext(null) }}><Icon name="reveal" />Reveal in Finder</button>
            </>
          )}
          <button role="menuitem" onClick={() => { props.onToggleHidden(context.node.path); setContext(null) }}>
            <Icon name={props.config.hidden.includes(context.node.path) ? 'eye' : 'eyeOff'} />
            {props.config.hidden.includes(context.node.path) ? 'Show in Sidebar' : 'Hide in Sidebar'}
          </button>
          {props.config.sources.includes(context.node.path) && (
            <>
              <div className="popover-sep" role="separator" />
              <button role="menuitem" onClick={() => { props.onRemoveSource(context.node.path); setContext(null) }}>
                <Icon name="minus" />
                Remove from Sidebar
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </aside>
  )
}

// A repo's own Fetch, Pull and Refresh. Fetch and Pull wait while a write runs in that repo; Refresh only reads.
function RepoActions({ repo, pick, onAction }: {
  repo: RepoNode
  pick: (action: () => void) => () => void
  onAction: SidebarProps['onRepoAction']
}) {
  const busy = useRepoBusy(repo.path)
  return (
    <>
      <button role="menuitem" disabled={busy !== null} title={blockedReason(busy)} onClick={pick(() => onAction(repo, 'fetch'))}><Icon name="refresh" />Fetch</button>
      <button role="menuitem" disabled={busy !== null} title={blockedReason(busy)} onClick={pick(() => onAction(repo, 'pull'))}><Icon name="pullMerge" />Pull</button>
      <button role="menuitem" onClick={pick(() => onAction(repo, 'refresh'))}><Icon name="rescan" />Refresh</button>
      <div className="popover-sep" role="separator" />
    </>
  )
}

// A repo row's menu button, which spins while a write runs in that repo.
function RepoMore({ node, tabIndex, onContext }: { node: RepoNode; tabIndex: number; onContext: ItemProps['onContext'] }) {
  const busy = useRepoBusy(node.path)
  return (
    <span className="row-more" onClick={(event) => {
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      onContext(node, rect.left, rect.bottom)
    }}>
      <IconButton icon="more" label={busy ? `${node.name} actions. ${workingLabel(busy)}` : `${node.name} actions`} busy={busy !== null} tabIndex={tabIndex} onClick={() => {}} />
    </span>
  )
}

// Rows in the order Tab and the arrow keys reach them: a folder's children only while it is open.
function visibleRows(nodes: TreeNode[], config: AppConfig, showHidden: boolean): string[] {
  return nodes.flatMap((node) => {
    if (config.hidden.includes(node.path) && !showHidden) return []
    const children = node.kind === 'folder' && !config.collapsed.includes(node.path) ? visibleRows(node.children, config, showHidden) : []
    return [node.path, ...children]
  })
}

// Left on a row that is not open moves focus to the folder that holds it.
function focusParent(item: HTMLElement) {
  item.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus()
}

type ItemProps = SidebarProps & {
  batch: BatchStatus | null
  node: TreeNode
  depth: number
  showHidden: boolean
  onContext: (node: TreeNode, x: number, y: number) => void
  tabStop: string | undefined
  onFocusRow: (path: string) => void
  // Inside a hidden folder: shown greyed like a hidden row, though not hidden itself.
  inHidden?: boolean
  // Reordering: the parent path ('' at the top) and its children in displayed order, hidden ones included.
  parent: string
  siblings: string[]
  onReorder: (parent: string, siblings: string[], from: string, to: string, after: boolean) => void
  dragRow: RefObject<DragRow | null>
  dropAt: { path: string; after: boolean } | null
  onDropAt: (target: { path: string; after: boolean } | null) => void
}

// Alt+Up/Down moves the row past its previous or next shown sibling. Returns whether it handled the key.
function reorderKey(props: ItemProps, key: string, row: HTMLElement): boolean {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return false
  const shown = props.siblings.filter((path) => props.showHidden || !props.config.hidden.includes(path))
  const index = shown.indexOf(props.node.path)
  const target = shown[index + (key === 'ArrowDown' ? 1 : -1)]
  if (index >= 0 && target) {
    props.onReorder(props.parent, props.siblings, props.node.path, target, key === 'ArrowDown')
    // The keyed row may be moved in the DOM, which drops focus; give it back once React has committed.
    queueMicrotask(() => { if (row.isConnected) row.focus() })
  }
  return true
}

// Drag handlers for a row: it moves only among its own siblings, landing before or after by pointer half.
function dragHandlers(props: ItemProps) {
  const { node, parent } = props
  const accepts = (event: DragEvent) => {
    const drag = props.dragRow.current
    return isReorder(event) && !!drag && drag.parent === parent && drag.path !== node.path
  }
  const lowerHalf = (event: DragEvent) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY > rect.top + rect.height / 2
  }
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(REORDER_TYPE, node.path)
      event.dataTransfer.effectAllowed = 'move'
      props.dragRow.current = { path: node.path, parent }
    },
    onDragEnd: () => { props.dragRow.current = null; props.onDropAt(null) },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const after = lowerHalf(event)
      if (props.dropAt?.path !== node.path || props.dropAt.after !== after) props.onDropAt({ path: node.path, after })
    },
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.stopPropagation()
      props.onReorder(parent, props.siblings, props.dragRow.current!.path, node.path, lowerHalf(event))
      props.dragRow.current = null
      props.onDropAt(null)
    },
  }
}

function dropClass(props: ItemProps) {
  return props.dropAt?.path === props.node.path ? (props.dropAt.after ? ' drop-after' : ' drop-before') : ''
}

function TreeItem(props: ItemProps) {
  const { node, depth, config, selected, showHidden } = props
  const hidden = config.hidden.includes(node.path)
  if (hidden && !showHidden) return null
  const greyed = hidden || !!props.inHidden

  if (node.kind === 'folder') {
    const collapsed = config.collapsed.includes(node.path)
    const running = props.batch?.running && props.batch.folder === node.path ? props.batch.text : null
    return (
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        tabIndex={node.path === props.tabStop ? 0 : -1}
        onFocus={(event) => { if (event.target === event.currentTarget) props.onFocusRow(node.path) }}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest('[role="treeitem"]') !== event.currentTarget) return
          if (event.altKey) {
            if (reorderKey(props, event.key, event.currentTarget)) { event.preventDefault(); event.stopPropagation() }
            return
          }
          if (event.target !== event.currentTarget && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          const { key } = event
          if (key === 'Enter' || key === ' ' || (key === 'ArrowRight' && collapsed) || (key === 'ArrowLeft' && !collapsed)) {
            event.preventDefault()
            props.onToggleCollapsed(node.path)
          } else if (key === 'ArrowRight') {
            event.preventDefault()
            event.currentTarget.querySelector<HTMLElement>('[role="treeitem"]')?.focus()
          } else if (key === 'ArrowLeft') {
            event.preventDefault()
            focusParent(event.currentTarget)
          }
        }}
      >
        <div
          className={`tree-row folder${greyed ? ' is-hidden' : ''}${dropClass(props)}`}
          {...dragHandlers(props)}
          onClick={() => props.onToggleCollapsed(node.path)}
          onContextMenu={(event) => { event.preventDefault(); props.onContext(node, event.clientX, event.clientY) }}
        >
          <span className={`chevron${collapsed ? '' : ' open'}`}><Icon name="chevron" /></span>
          {/* The hide click must not also toggle or select the row. */}
          <span className="row-icon has-row-action" onClick={(event) => event.stopPropagation()}>
            <FolderIcon open={!collapsed} />
            <IconButton
              icon={hidden ? 'eye' : 'eyeOff'}
              label={hidden ? `Show ${node.name}` : `Hide ${node.name}`}
              tabIndex={node.path === props.tabStop ? 0 : -1}
              onClick={() => props.onToggleHidden(node.path)}
            />
          </span>
          <span className="tree-label">{node.name}</span>
          {/* The context menu, for a pointer or keyboard user who does not right-click. */}
          <span className="row-more" onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            props.onContext(node, rect.left, rect.bottom)
          }}>
            <IconButton icon="more" label={running ? `${node.name} actions. ${running}` : `${node.name} actions`} busy={!!running} tabIndex={node.path === props.tabStop ? 0 : -1} onClick={() => {}} />
          </span>
        </div>
        {!collapsed && (
          <div role="group" className="tree-children">
            {node.children.map((child) => (
              <TreeItem
                key={child.path} {...props} node={child} depth={depth + 1} inHidden={greyed}
                parent={node.path} siblings={node.children.map((sibling) => sibling.path)}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const { count: dirtyCount = 0, ahead = 0, behind = 0 } = props.dirty?.[node.path] ?? {}
  const sync = [ahead && `${ahead} commit${ahead === 1 ? '' : 's'} to push`, behind && `${behind} commit${behind === 1 ? '' : 's'} to pull`].filter(Boolean).join(', ')
  return (
    <div
      role="treeitem"
      aria-selected={selected === node.path}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      tabIndex={node.path === props.tabStop ? 0 : -1}
      onFocus={(event) => { if (event.target === event.currentTarget) props.onFocusRow(node.path) }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('[role="treeitem"]') !== event.currentTarget) return
        if (event.altKey) {
          if (reorderKey(props, event.key, event.currentTarget)) { event.preventDefault(); event.stopPropagation() }
          return
        }
        if (event.target !== event.currentTarget && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect(node.path)
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault()
          focusParent(event.currentTarget)
        }
      }}
    >
      <div
        className={`tree-row repo${selected === node.path ? ' selected' : ''}${greyed ? ' is-hidden' : ''}${dropClass(props)}`}
        {...dragHandlers(props)}
        onClick={() => props.onSelect(node.path)}
        onContextMenu={(event) => { event.preventDefault(); props.onContext(node, event.clientX, event.clientY) }}
      >
        <span className="chevron-spacer" />
        <span className="row-icon has-row-action" onClick={(event) => event.stopPropagation()}>
          <FolderIcon repo />
          <IconButton
            icon={hidden ? 'eye' : 'eyeOff'}
            label={hidden ? `Show ${node.name}` : `Hide ${node.name}`}
            tabIndex={node.path === props.tabStop ? 0 : -1}
            onClick={() => props.onToggleHidden(node.path)}
          />
        </span>
        <span className="tree-label" title={node.name}>{node.name}</span>
        {node.branch && <span className="repo-branch" title={node.branch}>{node.branch}</span>}
        {sync && (
          <span className="repo-sync" role="img" title={sync} aria-label={sync}>
            {ahead > 0 && <span><Icon name="arrowUp" />{ahead}</span>}
            {behind > 0 && <span><Icon name="arrowDown" />{behind}</span>}
          </span>
        )}
        {dirtyCount > 0 && <span className="repo-dirty" title={`${dirtyCount} uncommitted files`}>{dirtyCount}</span>}
        {/* The context menu, for a pointer or keyboard user who does not right-click. It does not open the repo. */}
        <RepoMore node={node} tabIndex={node.path === props.tabStop ? 0 : -1} onContext={props.onContext} />
      </div>
    </div>
  )
}
