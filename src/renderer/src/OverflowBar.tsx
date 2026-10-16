import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, IconButton, type IconName } from './Icons'
import './overflow-bar.css'

export interface BarItem {
  key: string
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  // Destructive actions render red, in the bar and in the overflow menu.
  danger?: boolean
  // Neighbours in the same group sit together. A divider separates two groups.
  group: string
}

// Fixed widths: a divider with its margins, and the "more" button.
const DIVIDER = 13
const MORE = 30

// How many items fit in `available` pixels. When some do not fit, room is kept for the "more" button.
function countFit(items: BarItem[], widths: number[], available: number): number {
  const width = (count: number) => {
    let sum = 0
    for (let index = 0; index < count; index++) {
      if (index > 0 && items[index].group !== items[index - 1].group) sum += DIVIDER
      sum += widths[index]
    }
    return sum
  }
  if (width(items.length) <= available) return items.length
  let count = items.length - 1
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
    const update = () => setFit(widths.length === items.length ? countFit(items, widths, box.clientWidth) : items.length)
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

  // Focus moves into the menu when it opens.
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [menuOpen])

  const hidden = items.slice(fit)

  return (
    <div className={`overflow-bar${align === 'end' ? ' end' : ''}`} ref={boxRef}>
      {items.slice(0, fit).map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 && item.group !== items[index - 1].group && <span className="toolbar-divider" aria-hidden="true" />}
          <IconButton icon={item.icon} label={item.label} disabled={item.disabled} className={item.danger ? 'danger' : undefined} onClick={item.onClick} />
        </Fragment>
      ))}
      {hidden.length > 0 && (
        <div className="overflow-more" ref={menuRef} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false) }}>
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
            <div
              className="popover overflow-menu"
              role="menu"
              onKeyDown={(event) => {
                const menuItems = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
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
              {hidden.map((item, index) => (
                <Fragment key={item.key}>
                  {index > 0 && hidden[index - 1].group !== item.group && <div className="popover-sep" role="separator" />}
                  <button role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled} onClick={() => { setMenuOpen(false); moreRef.current?.focus(); item.onClick() }}>
                    <Icon name={item.icon} />
                    {item.label}
                  </button>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="overflow-probe" ref={probeRef} aria-hidden="true">
        {items.map((item) => (
          <IconButton key={item.key} icon={item.icon} label={item.label} onClick={() => undefined} />
        ))}
      </div>
    </div>
  )
}
