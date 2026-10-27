import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
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
  // A dimmer line under the label that says what the action does.
  detail?: string
  // Options for a toolbar button, shown in a dropdown beside it. The button itself still runs onClick.
  menu?: BarItem[]
}

const HOVER_DELAY = 150

// The sync actions used most often stay one click away. The menu lists them too, so it names every action.
const QUICK = new Set(['fetch', 'pullMerge', 'push'])

// The title-bar actions: the most frequent sync actions as icon buttons, then an "Actions" icon button whose menu lists
// every action with its label and shortcut. The trigger has a fixed width, so busy or blocked states never shift the bar.
export function ActionsMenu({ items }: { items: BarItem[] }) {
  const menu = useHoverMenu()

  return (
    <>
      {items.filter((item) => QUICK.has(item.key)).map((item) => item.menu
        ? <SplitButton key={item.key} item={item} menu={item.menu} />
        : <IconButton key={item.key} icon={item.icon} label={item.label} disabled={item.disabled} busy={item.busy} blocked={item.blocked}
          className={item.danger ? 'danger' : undefined} onClick={item.onClick} />)}
      <div ref={menu.rootRef} className="overflow-more" {...menu.hover}>
        <button {...menu.trigger} className={`icon-button${menu.open ? ' on' : ''}`} aria-label="Actions">
          <Icon name="more" />
        </button>
        {menu.open && (
          <ActionMenu
            className="overflow-menu"
            label="Repository actions"
            items={items}
            autoFocus={menu.open === 'focus'}
            onPick={(item) => { menu.close(menu.open === 'focus'); item.onClick() }}
            onDismiss={() => menu.setOpen(null)}
          />
        )}
      </div>
    </>
  )
}

// A menu that hovering its trigger opens after a short delay without taking focus, so typing elsewhere carries on, and
// that closes once the pointer has left for the same delay. The trigger opens it by click, Enter, Space or ArrowDown with
// focus on the first option. Escape or a press outside dismisses it either way.
function useHoverMenu(disabled?: boolean) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // 'hover' leaves focus where it was; 'focus' moves it into the menu.
  const [open, setOpen] = useState<'hover' | 'focus' | null>(null)
  const later = (next: () => void) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(next, HOVER_DELAY) }
  const close = (refocus: boolean) => {
    window.clearTimeout(timer.current)
    setOpen(null)
    if (refocus) triggerRef.current?.focus()
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])
  // A hover-opened menu never holds focus, so presses and Escape are watched on the document.
  useEffect(() => {
    if (!open) return
    const press = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(!!rootRef.current?.contains(document.activeElement))
    }
    document.addEventListener('pointerdown', press)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', press)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return {
    rootRef,
    open,
    setOpen,
    close,
    hover: {
      onMouseEnter: () => { if (disabled) return; if (open) window.clearTimeout(timer.current); else later(() => setOpen('hover')) },
      onMouseLeave: () => later(() => setOpen((current) => current === 'hover' ? null : current)),
    },
    trigger: {
      ref: triggerRef,
      type: 'button' as const,
      'aria-haspopup': 'menu' as const,
      'aria-expanded': !!open,
      disabled,
      // While focused open, a press here must not blur the menu first: it would close, then the click reopen it.
      onMouseDown: (event: ReactMouseEvent) => { if (open === 'focus') event.preventDefault() },
      onClick: () => { window.clearTimeout(timer.current); if (open === 'focus') close(true); else setOpen('focus') },
      onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === 'ArrowDown') { event.preventDefault(); window.clearTimeout(timer.current); setOpen('focus') } },
    },
  }
}

// A quick action with a dropdown of its options, opened from the chevron (useHoverMenu) or by hovering the pair.
function SplitButton({ item, menu }: { item: BarItem; menu: BarItem[] }) {
  const options = useHoverMenu(item.disabled)

  return (
    <div ref={options.rootRef} className="split-action" {...options.hover}>
      <IconButton icon={item.icon} label={item.label} disabled={item.disabled} busy={item.busy} blocked={item.blocked}
        className={item.danger ? 'danger' : undefined} onClick={item.onClick} />
      <button {...options.trigger} className={`split-chevron${options.open ? ' on' : ''}`} aria-label={`${item.label} options`}>
        <Icon name="chevronDown" className="chevron-down" />
      </button>
      {options.open && (
        <ActionMenu
          className="overflow-menu split-menu"
          label={`${item.label} options`}
          items={menu}
          autoFocus={options.open === 'focus'}
          onPick={(option) => { options.close(options.open === 'focus'); option.onClick() }}
          onDismiss={() => options.setOpen(null)}
        />
      )}
    </div>
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
export function ActionMenu({ items, onPick, onDismiss, className, at, label, autoFocus = true }: {
  items: BarItem[]
  label?: string
  // False for a menu opened by hover, which must not pull focus from where the user is typing.
  autoFocus?: boolean
  onPick: (item: BarItem) => void
  onDismiss?: () => void
  className?: string
  at?: { x: number; y: number }
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  // Focus goes to the first enabled item when the menu opens. Blocked items are skipped by focus and arrow keys.
  useEffect(() => {
    if (autoFocus) rootRef.current?.querySelector<HTMLElement>(ENABLED_ITEM)?.focus()
  }, [autoFocus])

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
          {/* type=button: a menu opened inside a form, like the branch picker, must not submit it. */}
          <button
            type="button"
            role="menuitem"
            className={[item.danger ? 'danger' : '', item.blocked ? 'blocked' : ''].filter(Boolean).join(' ') || undefined}
            disabled={item.disabled}
            aria-disabled={inertItem(item) || undefined}
            aria-busy={item.busy || undefined}
            title={item.blocked}
            onClick={() => { if (!inertItem(item)) onPick(item) }}
          >
            <Icon name={item.busy ? 'loader' : item.icon} className={item.busy ? 'action-spin' : undefined} />
            {item.detail
              ? <span className="menu-text"><span className="menu-label">{item.label}</span><span className="menu-detail">{item.detail}</span></span>
              : item.label}
            {item.shortcut && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
