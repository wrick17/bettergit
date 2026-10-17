import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent } from 'react'

// Window widths below which a pane folds into a strip. The order is strict: the sidebar folds first, then the list,
// then the commit details. The stops are suggested values (1600, 1280, 1040), so every stage sits above the 900px
// minimum window width. They are not measured at runtime yet.
export const FOLD_BELOW = { sidebar: 1600, list: 1280, details: 1040 } as const
export type Pane = keyof typeof FOLD_BELOW
// One rail geometry for every folded pane: a 36px visible card, then an 8px gutter on its right (CSS `margin-right: var(--gutter)`).
// The sidebar also keeps the window's 8px inset on its left, so its track adds one more gutter. Keep GUTTER equal to `--gutter`.
export const GUTTER = 8
export const STRIP_WIDTH = 36 + GUTTER
export const SIDEBAR_STRIP_WIDTH = STRIP_WIDTH + GUTTER

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

// True while the window is narrower than the pane's fold line. Re-renders only when that changes.
export function useFolded(pane: Pane): boolean {
  return useSyncExternalStore(subscribe, () => window.innerWidth < FOLD_BELOW[pane])
}

// Leaving the pane waits a beat, so a pointer that crosses a divider or a gap does not flicker the pane.
const LEAVE_DELAY = 120

// A folded pane opens in flow while it is held: the pointer is over it, or keyboard focus or typing is inside it.
// The strip never holds the pane, so a click on the strip cannot keep it open after the pointer leaves.
// `focusTarget` is the element that receives focus when the strip opens the pane from the keyboard.
export type FoldHold<T extends HTMLElement> = ReturnType<typeof useFoldHold<T>>

export function useFoldHold<T extends HTMLElement>(folded: boolean, focusTarget: string) {
  const pane = useRef<T>(null)
  const strip = useRef<HTMLButtonElement>(null)
  const [pointer, setPointer] = useState(false)
  const [keyboard, setKeyboard] = useState(false)
  const leave = useRef(0)
  const held = pointer || keyboard
  const collapsed = folded && !held

  useEffect(() => () => window.clearTimeout(leave.current), [])

  // Focus never falls to the body. A pane that folds under focus hands focus to its strip, and a strip that opens the pane hands it to the target.
  useLayoutEffect(() => {
    const active = document.activeElement
    const onStrip = !!strip.current && active === strip.current
    if (collapsed) {
      if (!onStrip && pane.current?.contains(active)) strip.current?.focus()
    } else if (onStrip) {
      // With no target (an empty or fully hidden repo list has no tree row), the pane's first enabled control takes focus.
      const target = pane.current?.querySelector<HTMLElement>(focusTarget) ?? pane.current?.querySelector<HTMLElement>('button:not(.fold-strip):not(:disabled)')
      // Nothing to hand focus to, so the keyboard hold is released rather than left open with nothing focused.
      if (target) target.focus()
      else setKeyboard(false)
    }
  }, [collapsed, focusTarget])

  const enter = () => {
    window.clearTimeout(leave.current)
    setPointer(true)
  }
  const exit = () => {
    leave.current = window.setTimeout(() => setPointer(false), LEAVE_DELAY)
  }

  return {
    folded,
    held,
    collapsed,
    pane,
    strip,
    // The strip's click. Keyboard activation holds the pane, then moves focus into it.
    activate: () => setKeyboard(true),
    paneHandlers: {
      onPointerEnter: enter,
      onPointerLeave: exit,
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (event.target === strip.current) return
        const target = event.target as HTMLElement
        // Keyboard focus and typing hold the pane. A mouse click on a control does not.
        setKeyboard(target.matches(':focus-visible') || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!pane.current?.contains(event.relatedTarget as Node | null)) setKeyboard(false)
      },
    },
    // A divider beside a folded pane keeps the pane held while the pointer crosses it, so a divider drag is not cut off.
    splitterHandlers: { onPointerEnter: enter, onPointerLeave: exit },
  }
}
