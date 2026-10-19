import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, IconButton, type IconName } from './Icons'
import './overflow-bar.css'
import './action-progress.css'

export interface BarItem {
  key: string
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  // The action is running: its glyph becomes a spinner and aria-busy is set. The label names the running action.
  busy?: boolean
  // Why the action cannot run right now, such as another action in the same repo. It shows as a tooltip, and the click does nothing.
  blocked?: string
  // Destructive actions render red, as buttons and as menu rows.
  danger?: boolean
  // Neighbours in the same group sit together. A divider separates two groups.
  group: string
  // The app menu's key equivalent, in macOS glyphs such as ⇧⌘F. Menus show it after the label.
  shortcut?: string
}

// The sync actions used most often stay one click away. The menu lists them too, so it names every action.
const QUICK = new Set(['fetch', 'pullMerge', 'push'])

// The title-bar actions: the most frequent sync actions as icon buttons, then a labelled "Actions" button whose menu lists
// every action with its label and shortcut. The trigger has a fixed width, so busy or blocked states never shift the bar.
export function ActionsMenu({ items }: { items: BarItem[] }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const close = () => { setOpen(false); triggerRef.current?.focus() }

  return (
    <>
      {items.filter((item) => QUICK.has(item.key)).map((item) => (
        <IconButton key={item.key} icon={item.icon} label={item.label} disabled={item.disabled} busy={item.busy} blocked={item.blocked}
          className={item.danger ? 'danger' : undefined} onClick={item.onClick} />
      ))}
      <div className="overflow-more" onKeyDown={(event) => { if (open && event.key === 'Escape') { event.preventDefault(); close() } }}>
        <button
          ref={triggerRef}
          type="button"
          className={`actions-trigger${open ? ' on' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          // While open, a press on the trigger must not move focus first: the menu would close on blur, then the click reopen it.
          onMouseDown={(event) => { if (open) event.preventDefault() }}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}
        >
          Actions
          <Icon name="chevronDown" className="chevron-down" />
        </button>
        {open && (
          <ActionMenu
            className="overflow-menu"
            label="Repository actions"
            items={items}
            onPick={(item) => { close(); item.onClick() }}
            onDismiss={() => setOpen(false)}
          />
        )}
      </div>
    </>
  )
}

const ENABLED_ITEM = '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'

// A running or blocked action keeps its place and tooltip, but does nothing when picked.
function inertItem(item: BarItem): boolean {
  return !!item.busy || !!item.blocked
}

// A popover of actions, with a divider between groups. Arrow keys, Home, and End move between enabled items.
// With `at`, the menu opens at that point and is kept inside the window. Focus leaving the menu, by Tab or a click
// elsewhere, dismisses it and keeps focus where it went.
export function ActionMenu({ items, onPick, onDismiss, className, at, label }: {
  items: BarItem[]
  label?: string
  onPick: (item: BarItem) => void
  onDismiss?: () => void
  className?: string
  at?: { x: number; y: number }
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  // Focus goes to the first enabled item when the menu opens. Blocked items are skipped by focus and arrow keys.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(ENABLED_ITEM)?.focus()
  }, [])

  useLayoutEffect(() => {
    const menu = rootRef.current
    if (!at || !menu) return
    menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - menu.offsetWidth))}px`
    menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - menu.offsetHeight))}px`
  }, [at])

  return (
    <div
      ref={rootRef}
      className={`popover${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDismiss?.() }}
      onKeyDown={(event) => {
        const menuItems = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(ENABLED_ITEM)]
        const index = menuItems.indexOf(document.activeElement as HTMLButtonElement)
        let next: number | undefined
        if (event.key === 'ArrowDown') next = (index + 1) % menuItems.length
        else if (event.key === 'ArrowUp') next = (index - 1 + menuItems.length) % menuItems.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = menuItems.length - 1
        if (next === undefined) return
        event.preventDefault()
        menuItems[next]?.focus()
      }}
    >
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && items[index - 1].group !== item.group && <div className="popover-sep" role="separator" />}
          <button
            role="menuitem"
            className={[item.danger ? 'danger' : '', item.blocked ? 'blocked' : ''].filter(Boolean).join(' ') || undefined}
            disabled={item.disabled}
            aria-disabled={inertItem(item) || undefined}
            aria-busy={item.busy || undefined}
            title={item.blocked}
            onClick={() => { if (!inertItem(item)) onPick(item) }}
          >
            <Icon name={item.busy ? 'loader' : item.icon} className={item.busy ? 'action-spin' : undefined} />
            {item.label}
            {item.shortcut && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
