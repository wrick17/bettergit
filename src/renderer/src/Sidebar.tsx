import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AppConfig } from '../../main/config'
import type { TreeNode } from '../../main/scan'
import { Icon, IconButton } from './Icons'
import { FolderIcon } from './FileIcon'
import { useScrollMemory } from './session'
import type { FoldHold } from './fold'

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
  dirty?: Record<string, number>
  // Folded into a strip that shows `stripLabel`. A held fold opens the full sidebar in flow beside the content.
  fold: FoldHold<HTMLElement>
  stripLabel?: string
}

interface ContextState {
  x: number
  y: number
  node: TreeNode
}

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

  // Popovers close on any outside click or Escape.
  useEffect(() => {
    if (!addOpen && !context) return
    const close = (event: globalThis.MouseEvent) => {
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

  const openContext = (event: MouseEvent, node: TreeNode) => {
    event.preventDefault()
    setContext({ x: event.clientX, y: event.clientY, node })
  }

  const visible = visibleRows(props.tree, props.config, showHidden)
  // The one row Tab reaches: the last focused row, else the selected one, else the first.
  const tabStop = [focusPath, props.selected].find((path) => path !== null && visible.includes(path)) ?? visible[0]

  return (
    <aside
      ref={props.fold.pane}
      {...props.fold.paneHandlers}
      className={`sidebar${dragging ? ' dragging' : ''}${props.fold.folded ? ' folded' : ''}${props.fold.held ? ' held' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { setDragging(false); props.onDrop(event) }}
    >
      {props.fold.folded && (
        <button ref={props.fold.strip} type="button" className="fold-strip" aria-label="Show repositories" onClick={props.fold.activate}>
          <Icon name="chevron" />
          <span className="fold-label">{props.stripLabel}</span>
        </button>
      )}
      <div className="sidebar-head">
        <span className="sidebar-title">Repositories</span>
        <div className="sidebar-tools">
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
            label="Show hidden repositories"
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
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')]
          const index = rows.indexOf(event.target as HTMLElement)
          const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
          if (index < 0 || !next) return
          event.preventDefault()
          next.focus()
        }}
      >
        {props.tree.length === 0 && <p className="tree-empty">Drop a projects folder here, or use + to add one.</p>}
        {props.tree.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} showHidden={showHidden} {...props} onContext={openContext} tabStop={tabStop} onFocusRow={setFocusPath} />
        ))}
      </div>

      {/* Portalled to the body: the sidebar's backdrop filter would otherwise clip and offset the fixed menu. */}
      {context && createPortal(
        <div ref={contextRef} className="popover context-menu" role="menu">
          {context.node.kind === 'repo' && (
            <button role="menuitem" onClick={() => { props.onReveal(context.node.path); setContext(null) }}>Reveal in Finder</button>
          )}
          <button role="menuitem" onClick={() => { props.onToggleHidden(context.node.path); setContext(null) }}>
            {props.config.hidden.includes(context.node.path) ? 'Show in Sidebar' : 'Hide in Sidebar'}
          </button>
          {props.config.sources.includes(context.node.path) && (
            <>
              <div className="popover-sep" role="separator" />
              <button role="menuitem" onClick={() => { props.onRemoveSource(context.node.path); setContext(null) }}>
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
  node: TreeNode
  depth: number
  showHidden: boolean
  onContext: (event: MouseEvent, node: TreeNode) => void
  tabStop: string | undefined
  onFocusRow: (path: string) => void
}

function TreeItem(props: ItemProps) {
  const { node, depth, config, selected, showHidden } = props
  const hidden = config.hidden.includes(node.path)
  if (hidden && !showHidden) return null

  if (node.kind === 'folder') {
    const collapsed = config.collapsed.includes(node.path)
    return (
      <div
        role="treeitem"
        aria-expanded={!collapsed}
        tabIndex={node.path === props.tabStop ? 0 : -1}
        onFocus={(event) => { if (event.target === event.currentTarget) props.onFocusRow(node.path) }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
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
          className={`tree-row folder${hidden ? ' is-hidden' : ''}`}
          onClick={() => props.onToggleCollapsed(node.path)}
          onContextMenu={(event) => props.onContext(event, node)}
        >
          <span className={`chevron${collapsed ? '' : ' open'}`}><Icon name="chevron" /></span>
          <span className="row-icon"><FolderIcon open={!collapsed} /></span>
          <span className="tree-label">{node.name}</span>
          {/* The hide click must not also toggle or select the row. */}
          <span className="row-tools" onClick={(event) => event.stopPropagation()}>
            <IconButton
              icon={hidden ? 'eye' : 'eyeOff'}
              label={hidden ? `Show ${node.name}` : `Hide ${node.name}`}
              tabIndex={-1}
              onClick={() => props.onToggleHidden(node.path)}
            />
          </span>
        </div>
        {!collapsed && (
          <div role="group" className="tree-children">
            {node.children.map((child) => (
              <TreeItem key={child.path} {...props} node={child} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const dirtyCount = props.dirty?.[node.path] ?? 0
  return (
    <div
      role="treeitem"
      aria-selected={selected === node.path}
      tabIndex={node.path === props.tabStop ? 0 : -1}
      onFocus={(event) => { if (event.target === event.currentTarget) props.onFocusRow(node.path) }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
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
        className={`tree-row repo${selected === node.path ? ' selected' : ''}${hidden ? ' is-hidden' : ''}`}
        onClick={() => props.onSelect(node.path)}
        onContextMenu={(event) => props.onContext(event, node)}
      >
        <span className="chevron-spacer" />
        <span className="row-icon"><FolderIcon repo /></span>
        <span className="tree-label">{node.name}</span>
        {node.branch && <span className="repo-branch" title={node.branch}>{node.branch}</span>}
        {dirtyCount > 0 && <span className="repo-dirty" title={`${dirtyCount} uncommitted files`}>{dirtyCount}</span>}
        <span className="row-tools" onClick={(event) => event.stopPropagation()}>
          <IconButton
            icon={hidden ? 'eye' : 'eyeOff'}
            label={hidden ? `Show ${node.name}` : `Hide ${node.name}`}
            tabIndex={-1}
            onClick={() => props.onToggleHidden(node.path)}
          />
        </span>
      </div>
    </div>
  )
}
