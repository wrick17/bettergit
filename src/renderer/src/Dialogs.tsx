import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AppConfig, ConfigPatch, Settings, ThemeMode } from '../../main/config'
import type { AppKind, Appearance, InstalledApp } from '../../shared/editors'
import type { InstalledExtension, ThemeChoice } from '../../shared/themes'
import { cachedAppIcon, cachedApps, fetchApps, loadAppIcon, storeApps } from './app-icons'
import { CODE_FONTS, CODE_FONT_SIZES, UI_FONT_SIZES, applyAppearance, isFontInstalled, resolveAppearance } from './appearance'
import { confirmOverBlur } from './confirm'
import { ExtensionSettings } from './ExtensionSettings'
import { Icon, type IconName } from './Icons'
import { forgetThemes, isThemeBroken, preloadThemes, useAppliedThemes, warmThemes } from './themes'

const api = window.bettergit

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'

// While a dialog is open the app root is inert, focus moves in, Tab wraps inside, and focus returns to the opener on close.
export function useDialogFocus(dialog: RefObject<HTMLElement | null>) {
  // Read on the first render, before autoFocus moves focus into the dialog.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const root = document.getElementById('root')!
    // Only Tab stops: roving tabIndex=-1 items (inactive tabs, radios) are skipped, so the first stop is the selected tab.
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((item) => item.tabIndex >= 0)
    root.toggleAttribute('inert', true)
    focusable()[0]?.focus()
    const wrap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', wrap)
    return () => {
      window.removeEventListener('keydown', wrap)
      root.toggleAttribute('inert', false)
      opener?.focus()
    }
  }, [dialog, opener])
}

function Modal({ title, subtitle, footer, onClose, children, className, hideHead }: {
  title: string
  subtitle?: string
  footer?: ReactNode
  onClose: () => void
  children: ReactNode
  className?: string
  // The title stays the dialog's accessible name; the body draws its own heading.
  hideHead?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portalled out of the app root, so the root can go inert while the dialog is open.
  return createPortal(
    <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className={`dialog${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {!hideHead && (
          <header className="dialog-head">
            <h2>{title}</h2>
            {subtitle && <p className="dialog-sub">{subtitle}</p>}
          </header>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function CloneDialog({ defaultParent, onClose, onCloned }: {
  defaultParent: string
  onClose: () => void
  onCloned: (destination: string) => void
}) {
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(defaultParent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Typed text survives a stray Escape or scrim click until the user confirms discarding it.
  const dirty = url !== '' || parent !== defaultParent
  const requestClose = async () => { if (!dirty || await confirmOverBlur('Discard this clone?')) onClose() }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim() || !parent) return
    setBusy(true)
    setError(null)
    try {
      const destination = await api.clone(url.trim(), parent)
      onCloned(String(destination))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  const choose = async () => {
    const picked = await api.pickFolder()
    if (picked) setParent(picked)
  }

  return (
    <Modal
      title="Clone repository"
      subtitle="Uses the Git and SSH credentials already on this Mac. BetterGit stores no tokens."
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="ghost" onClick={requestClose}>Cancel</button>
          <button type="submit" form="clone-form" className="primary" disabled={busy || !url.trim() || !parent}>
            {busy ? 'Cloning…' : 'Clone'}
          </button>
        </>
      )}
    >
      <form id="clone-form" onSubmit={submit} className="dialog-form">
        <label className="field">
          <span>Repository URL</span>
          <input autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" />
        </label>
        <label className="field">
          <span>Clone into</span>
          <div className="input-row">
            <input value={parent} onChange={(event) => setParent(event.target.value)} />
            <button type="button" onClick={choose}>Choose…</button>
          </div>
        </label>
        {error && <p className="dialog-error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

const TEXT_SIZES = [
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.15, label: 'Large' },
  { value: 1.3, label: 'Largest' },
]

// Reads "ts = typescript" lines. Blank or malformed lines are skipped.
function parseLanguages(text: string): Record<string, string> {
  const pairs = text.split('\n').map((line) => line.split('=').map((part) => part.trim().replace(/^\./, '').toLowerCase()))
  return Object.fromEntries(pairs.filter(([extension, language]) => extension && language).map(([extension, language]) => [extension, language]))
}

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

// A radio group with roving focus: one tab stop, and the arrow keys move and select.
function Segmented<T extends string | number>({ label, options, value, onChange }: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
        if (!step) return
        event.preventDefault()
        const index = (options.findIndex((option) => option.value === value) + step + options.length) % options.length
        onChange(options[index].value)
        const next = event.currentTarget.children[index] as HTMLElement
        next.focus()
      }}
    >
      {options.map((option) => (
        <button
          key={option.label}
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// Arrow keys move through a row or column of choices, wrapping at the ends. Returns the new index, or null for other keys.
function arrowStep(event: ReactKeyboardEvent, index: number, count: number): number | null {
  const step = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
  if (event.key === 'Home') return 0
  if (event.key === 'End') return count - 1
  return step ? (index + step + count) % count : null
}

const DENSITIES: { value: Appearance['density']; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
]

function AppIcon({ app, kind }: { app: InstalledApp | undefined; kind: AppKind }) {
  const [icon, setIcon] = useState(() => (app ? cachedAppIcon(app.path) ?? null : null))
  useEffect(() => {
    if (!app) return setIcon(null)
    const cached = cachedAppIcon(app.path)
    if (cached !== undefined) return setIcon(cached)
    let live = true
    loadAppIcon(app.path).then((url) => { if (live) setIcon(url) })
    return () => { live = false }
  }, [app?.path])
  return icon
    ? <img className="app-icon" src={icon} alt="" width={18} height={18} draggable={false} />
    : <span className="app-icon"><Icon name={kind === 'editor' ? 'code' : 'terminal'} /></span>
}

const APP_FALLBACK: Record<AppKind, string> = { editor: 'VS Code', terminal: 'Terminal' }

// A listbox button: native <select> cannot show app icons. Focus stays on the list while open; Escape closes only the list.
function AppPicker({ kind, label, value, onChange }: {
  kind: AppKind
  label: string
  value: string | undefined
  onChange: (id: string) => void
}) {
  const [apps, setApps] = useState<InstalledApp[] | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const id = `app-picker-${kind}`

  useEffect(() => {
    let live = true
    // A rescan also updates the toolbar's list, so an app installed since it loaded shows there too.
    fetchApps(kind).then((list) => { if (live) setApps(list) }, () => { if (live) setApps([]) })
    return () => { live = false }
  }, [kind])

  // Unset or removed choices show the default the toolbar falls back to.
  const current = apps && (apps.find((app) => app.id === value) ?? apps.find((app) => app.name === APP_FALLBACK[kind]) ?? apps[0])
  const count = (apps?.length ?? 0) + 1

  // Placed inside the dialog (it clips and is the containing block), below the trigger or above it when there is no room.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current!
    const dialog = trigger.closest('.dialog')!.getBoundingClientRect()
    const box = trigger.getBoundingClientRect()
    const below = dialog.bottom - box.bottom - 8
    const above = box.top - dialog.top - 8
    const height = Math.min(listRef.current!.scrollHeight, 320)
    const up = below < height && above > below
    const maxHeight = Math.min(320, up ? above : below)
    setPlace({ left: box.left - dialog.left, width: box.width, maxHeight, top: (up ? box.top - Math.min(height, maxHeight) - 4 : box.bottom + 4) - dialog.top })
    listRef.current!.focus()
  }, [open])

  useEffect(() => {
    if (open) listRef.current?.querySelector(`#${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, id])

  const show = () => {
    setActive(Math.max(0, apps?.findIndex((app) => app === current) ?? 0))
    setPlace(null)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const choose = async (index: number) => {
    close()
    const app = apps?.[index]
    if (app) return onChange(app.id)
    try {
      setError(null)
      const picked = await api.pickApp(kind)
      if (!picked) return
      const withPicked = (list?: InstalledApp[] | null) => [...(list ?? []).filter((entry) => entry.id !== picked.id), picked]
      setApps(withPicked)
      storeApps(kind, withPicked(cachedApps(kind)))
      onChange(picked.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  return (
    <div className="app-picker">
      <button
        ref={triggerRef}
        type="button"
        className="app-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label}: ${current?.name ?? 'None found'}`}
        disabled={!apps}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show() }
        }}
      >
        <AppIcon app={current ?? undefined} kind={kind} />
        <span className="app-name">{apps ? current?.name ?? 'None found' : 'Looking for apps…'}</span>
        {current?.custom && <span className="app-custom">Custom</span>}
        <Icon name="chevronDown" className="app-chevron" />
      </button>
      {error && <small className="dialog-error" role="alert">{error}</small>}
      {open && (
        <ul
          ref={listRef}
          id={id}
          className="popover app-picker-list"
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          style={place ? { left: place.left, top: place.top, minWidth: place.width, maxHeight: place.maxHeight } : { opacity: 0 }}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              // Escape closes the list, not the whole dialog.
              event.preventDefault()
              event.stopPropagation()
              return close()
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              return void choose(active)
            }
            const next = arrowStep(event, active, count)
            if (next === null || event.key === 'ArrowLeft' || event.key === 'ArrowRight') return
            event.preventDefault()
            setActive(next)
          }}
        >
          {apps?.map((app, index) => (
            <li
              key={app.id}
              id={`${id}-${index}`}
              role="option"
              aria-selected={app === current}
              className={`${index === active ? 'active' : ''}${app === current ? ' chosen' : ''}`}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void choose(index)}
            >
              <AppIcon app={app} kind={kind} />
              <span className="app-name">{app.name}</span>
              {app.custom && <span className="app-custom">Custom</span>}
            </li>
          ))}
          <li className="popover-sep" role="presentation" />
          <li
            id={`${id}-${count - 1}`}
            role="option"
            aria-selected={false}
            className={active === count - 1 ? 'active' : ''}
            onMouseEnter={() => setActive(count - 1)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void choose(count - 1)}
          >
            <span className="app-icon"><Icon name="plus" /></span>
            <span className="app-name">Add other…</span>
          </li>
        </ul>
      )}
    </div>
  )
}

type SectionId = 'general' | 'appearance' | 'apps' | 'syntax' | 'extensions'
const SECTIONS: { id: SectionId; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'apps', label: 'Editor & Terminal', icon: 'terminal' },
  { id: 'syntax', label: 'Syntax', icon: 'code' },
  { id: 'extensions', label: 'Extensions', icon: 'extensions' },
]
const SECTION_KEY = 'bettergit.settingsSection'

function Row({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <span className="setting-label">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help && <small>{help}</small>}
      </span>
      {children}
    </div>
  )
}

const sizes = ({ min, max }: { min: number; max: number }) => Array.from({ length: max - min + 1 }, (_, index) => min + index)

// A theme picker: the built-in look, then each extension's themes under its name. A saved theme that is not installed
// (or not listed yet) keeps its own entry, so the picker never shows a choice that is not the saved one. It shows the
// theme on screen (`value`); while a pick (`wanted`) still loads, it keeps that and spins in a slot that is always there,
// so nothing moves. Its themes load on focus or press, before the menu opens (themes.ts).
function ThemeSelect({ id, kind, value, wanted, builtIn, extensions, themes, onChange }: {
  id: string
  kind: 'color' | 'icons'
  value: string
  wanted: string
  builtIn: string
  extensions: InstalledExtension[] | null
  themes: (extension: InstalledExtension) => ThemeChoice[]
  onChange: (ref: string) => void
}) {
  const groups = (extensions ?? []).map((extension) => ({ extension, choices: themes(extension) })).filter((group) => group.choices.length)
  const listed = !value || groups.some((group) => group.choices.some((choice) => choice.ref === value))
  const preload = () => preloadThemes(kind, groups.flatMap((group) => group.choices.map((choice) => choice.ref)))
  const loading = wanted !== value
  const status = loading ? 'Loading theme…' : value && isThemeBroken(kind, value) ? 'This theme could not be loaded.' : ''
  return (
    <span className="theme-picker">
      <span className={`theme-status${loading ? '' : ' broken'}`} role={status ? 'img' : undefined} aria-label={status || undefined} title={status || undefined}>
        {status && <Icon name={loading ? 'loader' : 'warning'} className={loading ? 'action-spin' : undefined} />}
      </span>
      <select id={id} value={value} aria-busy={loading} onFocus={preload} onPointerDown={preload} onChange={(event) => onChange(event.target.value)}>
        <option value="">{builtIn}</option>
        {!listed && <option value={value}>{extensions ? 'Not installed' : 'Loading…'}</option>}
        {groups.map(({ extension, choices }) => (
          <optgroup key={extension.id} label={extension.name}>
            {choices.map((choice) => <option key={choice.ref} value={choice.ref}>{choice.label}</option>)}
          </optgroup>
        ))}
      </select>
    </span>
  )
}

export function SettingsDialog({ config, onUpdate, onClose }: {
  config: AppConfig
  onUpdate: (patch: ConfigPatch) => void
  onClose: () => void
}) {
  const { settings } = config
  // Only the changed fields: main merges them into its current settings, so a stale prop never undoes a newer write
  // (a custom app the picker just saved, or a quick theme change).
  const set = (patch: Partial<Settings>) => onUpdate({ settings: patch })
  const languagesText = Object.entries(settings.languages).map(([extension, language]) => `${extension} = ${language}`).join('\n')
  const languagesRef = useRef<HTMLTextAreaElement>(null)
  // The textarea unmounts when its section is hidden, so its last text is kept here for the save on close.
  const languagesDraft = useRef<string | null>(null)
  const commitLanguages = () => {
    const text = languagesRef.current?.value ?? languagesDraft.current
    if (text !== null) set({ languages: parseLanguages(text) })
  }
  // Closing is the one save point for syntax edits, so Escape and Done each write once.
  const close = () => { commitLanguages(); onClose() }

  const [section, setSection] = useState<SectionId>(() => {
    const saved = sessionStorage.getItem(SECTION_KEY)
    return SECTIONS.some((entry) => entry.id === saved) ? saved as SectionId : 'general'
  })
  const show = (next: SectionId) => {
    if (languagesRef.current) languagesDraft.current = languagesRef.current.value
    sessionStorage.setItem(SECTION_KEY, next)
    setSection(next)
  }
  const tabsRef = useRef<HTMLDivElement>(null)

  // Only this dialog writes appearance, so its own copy stays the truth while open: quick changes made before the config
  // round trip returns build on each other instead of on the stale prop.
  const appearanceRef = useRef(settings.appearance ?? {})
  const [appearance, setAppearanceState] = useState(() => resolveAppearance(appearanceRef.current))
  // Applied before the config round trip, so the change shows on the next frame.
  const writeAppearance = (next: Partial<Appearance>) => {
    appearanceRef.current = next
    applyAppearance(next)
    setAppearanceState(resolveAppearance(next))
    set({ appearance: next })
  }
  const setAppearance = (patch: Partial<Appearance>) => writeAppearance({ ...appearanceRef.current, ...patch })
  const resetAppearance = () => writeAppearance({})
  const title = SECTIONS.find((entry) => entry.id === section)!.label

  // Installed extensions, for the theme pickers and the Extensions section.
  const [extensions, setExtensions] = useState<InstalledExtension[] | null>(null)
  const listExtensions = () => api.listExtensions().then(setExtensions, () => setExtensions([]))
  useEffect(() => { void listExtensions() }, [])
  // The installed themes load one at a time while idle, so most picks apply at once. Caps in main bound each load.
  useEffect(() => extensions ? warmThemes(extensions.flatMap((extension) => [
    ...extension.themes.map(({ ref }) => ({ kind: 'color' as const, ref })),
    ...extension.iconThemes.map(({ ref }) => ({ kind: 'icons' as const, ref })),
  ])) : undefined, [extensions])
  const applied = useAppliedThemes()
  // An install or removal changes what the extension's refs point at. Removed themes fall back to the built-in look.
  const extensionChanged = (id: string, removed: boolean) => {
    forgetThemes(id)
    void listExtensions()
    const current = appearanceRef.current
    const gone = (ref: string | undefined) => removed && !!ref?.startsWith(`${id}/`)
    if (gone(current.lightTheme) || gone(current.darkTheme) || gone(current.iconTheme)) {
      setAppearance(Object.fromEntries((['lightTheme', 'darkTheme', 'iconTheme'] as const).filter((key) => gone(current[key])).map((key) => [key, ''])))
    } else applyAppearance(current)
  }

  return (
    <Modal
      title="Settings"
      hideHead
      className="settings-dialog"
      onClose={close}
      footer={<button className="primary" onClick={close}>Done</button>}
    >
      <nav className="settings-nav" aria-label="Settings sections">
        <h2>Settings</h2>
        <div
          ref={tabsRef}
          role="tablist"
          aria-orientation="vertical"
          onKeyDown={(event) => {
            const index = arrowStep(event, SECTIONS.findIndex((entry) => entry.id === section), SECTIONS.length)
            if (index === null) return
            event.preventDefault()
            show(SECTIONS[index].id)
            ;(tabsRef.current!.children[index] as HTMLElement).focus()
          }}
        >
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-tab-${entry.id}`}
              aria-selected={entry.id === section}
              aria-controls="settings-panel"
              tabIndex={entry.id === section ? 0 : -1}
              className={entry.id === section ? 'on' : ''}
              onClick={() => show(entry.id)}
            >
              <Icon name={entry.icon} />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="settings-pane" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section}`}>
        <h3 className="settings-title">{title}</h3>
        {section === 'general' && (
          <section className="settings-section">
            <h4>Background fetch</h4>
            <div className="settings-group">
              <div className="setting">
                <label>
                  <input type="checkbox" checked={settings.backgroundFetch} onChange={(event) => set({ backgroundFetch: event.target.checked })} />
                  <span>
                    Fetch while I am at the computer
                    <small>Fetches every repository. Never pulls or pushes.</small>
                  </span>
                </label>
              </div>
              <Row label="Interval" htmlFor="fetch-interval">
                <select id="fetch-interval" value={settings.fetchIntervalMinutes} disabled={!settings.backgroundFetch} onChange={(event) => set({ fetchIntervalMinutes: Number(event.target.value) })}>
                  {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>Every {minutes} minutes</option>)}
                </select>
              </Row>
            </div>
          </section>
        )}
        {section === 'appearance' && (
          <>
            <section className="settings-section">
              <h4>Theme</h4>
              <div className="settings-group">
                <Row label="Appearance">
                  <Segmented label="Appearance" options={THEMES} value={settings.theme} onChange={(theme) => set({ theme })} />
                </Row>
                <Row label="Light theme" htmlFor="light-theme" help="Colours and syntax in light appearance.">
                  <ThemeSelect id="light-theme" kind="color" value={applied.lightTheme} wanted={appearance.lightTheme} builtIn="BetterGit Light" extensions={extensions}
                    themes={(extension) => extension.themes.filter((theme) => !theme.dark)} onChange={(lightTheme) => setAppearance({ lightTheme })} />
                </Row>
                <Row label="Dark theme" htmlFor="dark-theme" help="Colours and syntax in dark appearance.">
                  <ThemeSelect id="dark-theme" kind="color" value={applied.darkTheme} wanted={appearance.darkTheme} builtIn="BetterGit Dark" extensions={extensions}
                    themes={(extension) => extension.themes.filter((theme) => theme.dark)} onChange={(darkTheme) => setAppearance({ darkTheme })} />
                </Row>
                <Row label="File icons" htmlFor="icon-theme" help="Image icon themes. Icon-font themes fall back to the built-in icons.">
                  <ThemeSelect id="icon-theme" kind="icons" value={applied.iconTheme} wanted={appearance.iconTheme} builtIn="BetterGit (vscode-icons)" extensions={extensions}
                    themes={(extension) => extension.iconThemes} onChange={(iconTheme) => setAppearance({ iconTheme })} />
                </Row>
                <Row label="Density" help="Row height in the sidebar and file lists.">
                  <Segmented label="Density" options={DENSITIES} value={appearance.density} onChange={(density) => setAppearance({ density })} />
                </Row>
              </div>
            </section>
            <section className="settings-section">
              <h4>Text</h4>
              <div className="settings-group">
                <Row label="Interface font size" htmlFor="ui-font-size">
                  <select id="ui-font-size" value={appearance.uiFontSize} onChange={(event) => setAppearance({ uiFontSize: Number(event.target.value) })}>
                    {sizes(UI_FONT_SIZES).map((size) => <option key={size} value={size}>{size} pt</option>)}
                  </select>
                </Row>
                <Row label="Code font" htmlFor="code-font" help="Used in diffs, the editor and commit hashes.">
                  <select id="code-font" value={appearance.codeFont} onChange={(event) => setAppearance({ codeFont: event.target.value })}>
                    {CODE_FONTS.map((font) => {
                      const missing = !isFontInstalled(font.value)
                      return <option key={font.value} value={font.value} disabled={missing && font.value !== appearance.codeFont}>{font.label}{missing ? ' (not installed)' : ''}</option>
                    })}
                  </select>
                </Row>
                <Row label="Code font size" htmlFor="code-font-size">
                  <select id="code-font-size" value={appearance.codeFontSize} onChange={(event) => setAppearance({ codeFontSize: Number(event.target.value) })}>
                    {sizes(CODE_FONT_SIZES).map((size) => <option key={size} value={size}>{size} pt</option>)}
                  </select>
                </Row>
                <Row label="Zoom" help="Scales the whole window, so rows and dividers stay aligned.">
                  <Segmented label="Zoom" options={TEXT_SIZES} value={settings.textZoom} onChange={(textZoom) => set({ textZoom })} />
                </Row>
              </div>
            </section>
            <div className="settings-actions">
              <button type="button" onClick={resetAppearance}>Reset to defaults</button>
            </div>
          </>
        )}
        {section === 'apps' && (
          <section className="settings-section">
            <h4>Open in</h4>
            <div className="settings-group">
              <Row label="Editor" help="Opens repositories and files from the toolbar and menus.">
                <AppPicker kind="editor" label="Editor" value={settings.editorApp} onChange={(editorApp) => set({ editorApp })} />
              </Row>
              <Row label="Terminal" help="Opens a terminal in the repository folder.">
                <AppPicker kind="terminal" label="Terminal" value={settings.terminalApp} onChange={(terminalApp) => set({ terminalApp })} />
              </Row>
            </div>
          </section>
        )}
        {section === 'extensions' && <ExtensionSettings extensions={extensions} onChanged={extensionChanged} />}
        {section === 'syntax' && (
          <section className="settings-section">
            <h4>Syntax highlighting</h4>
            <div className="settings-group">
              <div className="setting setting-stack">
                <span>
                  Extension to language
                  <small>One per line, like ts = typescript. Unlisted extensions use the built-in map. Ids come from Shiki.</small>
                </span>
                <textarea
                  ref={languagesRef}
                  key={languagesText}
                  defaultValue={languagesDraft.current ?? languagesText}
                  spellCheck={false}
                  aria-label="Extension to language mapping"
                />
              </div>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
