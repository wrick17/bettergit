import { useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive, ArchiveRestore, ArrowLeftRight, ArrowUpFromLine, Cherry, ChevronDown, ChevronRight, ChevronUp, Columns2, Columns3,
  CloudDownload, Code, Copy, Ellipsis, ExternalLink, Eye, EyeOff, FileDiff, FileText, FolderPlus, GitBranch, GitCommitHorizontal, GitCompare,
  GitFork, GitGraph, GitMerge, Hash, Link, List, ListOrdered, ListTree, LoaderCircle, LocateFixed, PackageMinus, PackageOpen, PanelLeft,
  MousePointerClick, Palette, PanelRight, Pencil, Plus, RefreshCw, Rows3, RotateCcw, Save, Search, SearchX, Settings, Shuffle, Sparkles, SquareTerminal, Tag, Trash2, Undo2, UnfoldVertical, Users, WrapText, X, type LucideIcon,
} from 'lucide-react'

// Every GUI icon is a Lucide icon. The names are stable keys, so call sites say what the action means, not how it looks.
const ICONS = {
  refresh: RefreshCw,
  // Replaces an action's glyph while that action runs.
  loader: LoaderCircle,
  push: ArrowUpFromLine,
  stash: Archive,
  undo: Undo2,
  rows: Rows3,
  columns: Columns2,
  markdown: FileText,
  paneList: Columns3,
  listFlat: List,
  listTree: ListTree,
  panelLeft: PanelLeft,
  panelRight: PanelRight,
  graph: GitGraph,
  copy: Copy,
  pullMerge: GitMerge,
  pullRebase: Shuffle,
  pullFrom: CloudDownload,
  reset: RotateCcw,
  stashList: ListOrdered,
  applyStash: ArchiveRestore,
  popStash: PackageOpen,
  popLatest: PackageMinus,
  diff: FileDiff,
  externalLink: ExternalLink,
  // Generic Open in … glyphs, shown until the chosen app's own icon loads.
  code: Code,
  terminal: SquareTerminal,
  locate: LocateFixed,
  tag: Tag,
  cherry: Cherry,
  edit: Pencil,
  compare: GitCompare,
  compareRef: ArrowLeftRight,
  mergeBase: GitFork,
  hash: Hash,
  link: Link,
  more: Ellipsis,
  eye: Eye,
  eyeOff: EyeOff,
  plus: Plus,
  chevron: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  branch: GitBranch,
  search: Search,
  settings: Settings,
  palette: Palette,
  trash: Trash2,
  unfold: UnfoldVertical,
  wrap: WrapText,
  close: X,
  save: Save,
  users: Users,
  // Empty-state marks.
  clean: Sparkles,
  commit: GitCommitHorizontal,
  pick: MousePointerClick,
  noResults: SearchX,
  addFolder: FolderPlus,
} satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name]
  return <Glyph className={className} aria-hidden="true" focusable="false" />
}

// The chip lives in the body, so a clipped toolbar or pane cannot cut it off.
function Tooltip({ anchor, label }: { anchor: HTMLElement; label: string }) {
  const chipRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Centred under the control and kept inside the window. It flips above the control when there is no room below.
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect()
    const chip = chipRef.current!.getBoundingClientRect()
    const left = Math.min(Math.max(box.left + box.width / 2 - chip.width / 2, 6), window.innerWidth - chip.width - 6)
    const below = box.bottom + 8
    setPosition({ left, top: below + chip.height > window.innerHeight ? box.top - chip.height - 8 : below })
  }, [anchor, label])

  return createPortal(
    <div ref={chipRef} className="tooltip" aria-hidden="true" style={{ left: position?.left, top: position?.top }}>
      {label}
    </div>,
    document.body,
  )
}

// A toggle's label and tooltip: the state it is in now, then what a click does. Toggles also set aria-pressed.
export function toggleLabel(state: string, action: string) {
  return `${state} — click to ${action}`
}

// The tooltip of a control: shown on hover or keyboard focus. It re-renders with the control, so a click that changes
// the label changes the tooltip at once.
export function useTooltip(tip: string) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  return {
    handlers: {
      onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => setAnchor(event.currentTarget),
      onPointerLeave: () => setAnchor(null),
      onFocus: (event: FocusEvent<HTMLButtonElement>) => { if (event.currentTarget.matches(':focus-visible')) setAnchor(event.currentTarget) },
      onBlur: () => setAnchor(null),
    },
    tooltip: anchor && <Tooltip anchor={anchor} label={tip} />,
  }
}

// A text button in a segmented toggle, such as a context level. Same label and tooltip rules as IconButton.
export function TextToggle({ text, label, active, onClick }: { text: string; label: string; active: boolean; onClick: () => void }) {
  const { handlers, tooltip } = useTooltip(label)
  return (
    <button type="button" className={active ? 'on' : ''} aria-label={label} aria-pressed={active} onClick={onClick} {...handlers}>
      {text}
      {tooltip}
    </button>
  )
}

// An icon-only button. The label is both the accessible name and the hover or keyboard-focus tooltip.
// While `busy`, the glyph becomes a spinner and aria-busy is set. The label should then say what runs.
// `blocked` gives the reason a control cannot run now. It stays focusable and hoverable, so the reason shows as a tooltip.
export function IconButton({ icon, image, label, onClick, active, disabled, busy, blocked, className, tabIndex }: {
  icon: IconName
  // An image URL (an app icon) shown instead of the glyph once it has loaded.
  image?: string | null
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  busy?: boolean
  blocked?: string
  className?: string
  tabIndex?: number
}) {
  const inert = !!busy || !!blocked
  const { handlers, tooltip } = useTooltip(blocked ? `${label}. ${blocked}` : label)
  return (
    <button
      type="button"
      className={`icon-button${active ? ' on' : ''}${busy ? ' busy' : ''}${blocked ? ' blocked' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      aria-busy={busy || undefined}
      aria-disabled={inert || undefined}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={inert ? undefined : onClick}
      {...handlers}
    >
      {image && !busy
        ? <img src={image} alt="" width={16} height={16} draggable={false} />
        : <Icon name={busy ? 'loader' : icon} className={busy ? 'action-spin' : undefined} />}
      {tooltip}
    </button>
  )
}
