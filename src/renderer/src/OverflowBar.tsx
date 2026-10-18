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
  // Destructive actions render red, in the bar and in the overflow menu.
  danger?: boolean
  // Neighbours in the same group sit together. A divider separates two groups.
  group: string
}

// Fixed width of the "more" button and its gap.
const MORE = 30

// How many items fit in `available` pixels. Each width already includes its item's divider. When some do not fit, room is kept for the "more" button.
function countFit(widths: number[], available: number): number {
  const width = (count: number) => widths.slice(0, count).reduce((sum, value) => sum + value, 0)
  if (width(widths.length) <= available) return widths.length
  let count = widths.length - 1
  while (count > 0 && width(count) + MORE > available) count--
  return count
}

export function OverflowBar({ items, align = 'end' }: { items: BarItem[]; align?: 'start' | 'end' }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [widths, setWidths] = useState<number[]>([])
  const [fit, setFit] = useState(items.length)
  const [menuOpen, setMenuOpen] = useState(false)
  // Items get new callbacks on every render, so measurement keys on what is shown instead.
  const signature = items.map((item) => `${item.key}|${item.icon}|${item.label}|${item.group}`).join('\n')

  // Measure once per change to the items.
  useLayoutEffect(() => {
    setWidths([...(probeRef.current?.children ?? [])].map((node) => (node as HTMLElement).offsetWidth))
  }, [signature])

  // Recount whenever the bar is resized.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const update = () => setFit(widths.length === items.length ? countFit(widths, box.clientWidth) : items.length)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(box)
    return () => observer.disconnect()
  }, [widths, signature])

  // The menu closes on an outside click or Escape, like the other popovers. Focus leaving it closes it too (see the wrapper's onBlur).
  useLayoutEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        moreRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const hidden = items.slice(fit)

  // One item with the divider before it. The measuring copy and the visible row share this markup, so their widths match.
  const renderItem = (item: BarItem, index: number, onClick: () => void) => (
    <span key={item.key} className="overflow-item">
      {index > 0 && items[index - 1].group !== item.group && <span className="toolbar-divider" aria-hidden="true" />}
      <IconButton icon={item.icon} label={item.label} disabled={item.disabled} busy={item.busy} blocked={item.blocked} className={item.danger ? 'danger' : undefined} onClick={onClick} />
    </span>
  )

  return (
    <div className={`overflow-bar${align === 'end' ? ' end' : ''}`} ref={boxRef}>
      <div className="overflow-probe" ref={probeRef} aria-hidden="true">
        {items.map((item, index) => renderItem(item, index, () => undefined))}
      </div>
      <div className="overflow-row">
        {items.slice(0, fit).map((item, index) => renderItem(item, index, item.onClick))}
        {hidden.length > 0 && (
          <div className="overflow-more" ref={menuRef}>
            <button
              ref={moreRef}
              type="button"
              className={`icon-button${menuOpen ? ' on' : ''}`}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="More actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <Icon name="more" />
            </button>
            {menuOpen && (
              <ActionMenu
                className="overflow-menu"
                items={hidden}
                onPick={(item) => { setMenuOpen(false); moreRef.current?.focus(); item.onClick() }}
                onDismiss={() => setMenuOpen(false)}
              />
            )}
          </div>
        )}
      </div>
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
export function ActionMenu({ items, onPick, onDismiss, className, at }: {
  items: BarItem[]
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
          </button>
        </Fragment>
      ))}
    </div>
  )
}
