import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ExtensionPreview, ExtensionResult, InstalledExtension } from '../../shared/themes'
import { ColorPreview, IconPreview } from './ThemePreview'

const api = window.bettergit

const count = (number: number, noun: string) => `${number} ${noun}${number === 1 ? '' : 's'}`

function summary(extension: InstalledExtension) {
  const parts = [extension.themes.length && count(extension.themes.length, 'colour theme'), extension.iconThemes.length && count(extension.iconThemes.length, 'icon theme')]
  return [extension.publisher, extension.version && `v${extension.version}`, ...parts].filter(Boolean).join(' · ')
}

const resultDetail = (result: ExtensionResult) => `${result.namespace} · v${result.version} · ${result.downloads.toLocaleString()} downloads`

const message = (failure: unknown) => (failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))

function Item({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="setting">
      <span className="setting-label">
        <span>{title}</span>
        <small className="extension-detail">{detail}</small>
      </span>
      {children}
    </div>
  )
}

// Installs VS Code extensions from Open VSX or a .vsix file, for their colour and file icon themes. An empty search lists
// the most downloaded themes, and any result can be previewed before it is installed.
export function ExtensionSettings({ extensions, onChanged }: {
  extensions: InstalledExtension[] | null
  onChanged: (id: string, removed: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [popular, setPopular] = useState<ExtensionResult[] | null>(null)
  const [results, setResults] = useState<ExtensionResult[] | null>(null)
  // The running action, such as `install:dracula-theme.theme-dracula`. One at a time.
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The result whose details are open, and its preview once loaded. Previews live only here, in memory.
  const [open, setOpen] = useState<ExtensionResult | null>(null)
  const [preview, setPreview] = useState<ExtensionPreview | string | null>(null)
  const opened = useRef<ExtensionResult | null>(null)

  useEffect(() => {
    let live = true
    api.searchExtensions('').then((found) => { if (live) setPopular(found) }, (failure: unknown) => {
      if (!live) return
      setPopular([])
      setError(message(failure))
    })
    return () => { live = false }
  }, [])

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(null)
    }
  }
  const search = (event: FormEvent) => {
    event.preventDefault()
    if (query.trim()) void run('search', async () => setResults(await api.searchExtensions(query)))
  }
  const install = (result: ExtensionResult) => run(`install:${result.namespace}.${result.name}`, async () => {
    onChanged((await api.installExtension(result.namespace, result.name)).id, false)
  })
  const installFile = () => run('file', async () => {
    const installed = await api.installExtensionFile()
    if (installed) onChanged(installed.id, false)
  })
  const remove = (extension: InstalledExtension) => run(`remove:${extension.id}`, async () => {
    await api.removeExtension(extension.id)
    onChanged(extension.id, true)
  })
  const show = (result: ExtensionResult | null) => {
    opened.current = result
    setOpen(result)
    setPreview(null)
    setError(null)
    // Only the details still open take the answer, so going back or opening another never shows a stale preview.
    if (result) api.previewExtension(result.namespace, result.name).then((found) => found, message).then((found) => { if (opened.current === result) setPreview(found) })
  }

  const installButton = (result: ExtensionResult) => {
    const key = `${result.namespace}.${result.name}`
    const installed = extensions?.find((extension) => extension.id === key.toLowerCase())
    const current = installed?.version === result.version
    const label = current ? 'Installed' : installed ? 'Update' : 'Install'
    return (
      <button type="button" disabled={!!busy || current} aria-label={`${label} ${result.displayName}`} onClick={() => void install(result)}>
        {busy === `install:${key}` ? 'Installing…' : label}
      </button>
    )
  }

  if (open) {
    const loaded = typeof preview === 'object' ? preview : null
    const themes = loaded ? loaded.extension.themes.map((choice, index) => ({ choice, theme: loaded.colorThemes[index] })) : []
    const icons = loaded ? loaded.extension.iconThemes.map((choice, index) => ({ choice, theme: loaded.iconThemes[index] })) : []
    const failed = [...themes, ...icons].filter(({ theme }) => !theme).map(({ choice }) => choice.label)
    return (
      <section className="settings-section extension-details">
        <button type="button" onClick={() => show(null)}>‹ Back</button>
        <header>
          <div>
            <h4>{open.displayName}</h4>
            <p>{[resultDetail(open), open.description].filter(Boolean).join('\n')}</p>
          </div>
          {installButton(open)}
        </header>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {!preview && <small className="settings-note" role="status">Loading a preview from Open VSX…</small>}
        {typeof preview === 'string' && <p className="dialog-error" role="alert">No preview: {preview}</p>}
        {themes.map(({ choice, theme }) => theme && <ColorPreview key={choice.ref} theme={theme} />)}
        {icons.map(({ choice, theme }) => theme && <IconPreview key={choice.ref} theme={theme} label={choice.label} />)}
        {failed.length > 0 && <small className="settings-note">Could not load: {failed.join(', ')}.</small>}
        {loaded && <small className="settings-note">Previewing installs nothing. After installing, pick these themes under Appearance.</small>}
      </section>
    )
  }

  const shown = results ?? popular
  return (
    <>
      <section className="settings-section">
        <h4>Installed</h4>
        <div className="settings-group">
          {!extensions?.length && (
            <div className="setting"><small>{extensions ? 'No extensions yet. Install a theme from Open VSX or a .vsix file.' : 'Loading…'}</small></div>
          )}
          {extensions?.map((extension) => (
            <Item key={extension.id} title={extension.name} detail={summary(extension)}>
              <button type="button" disabled={!!busy} aria-label={`Remove ${extension.name}`} onClick={() => void remove(extension)}>
                {busy === `remove:${extension.id}` ? 'Removing…' : 'Remove'}
              </button>
            </Item>
          ))}
        </div>
        <div className="settings-actions">
          <button type="button" disabled={!!busy} onClick={() => void installFile()}>{busy === 'file' ? 'Installing…' : 'Install from .vsix…'}</button>
        </div>
      </section>
      <section className="settings-section">
        <h4>Open VSX</h4>
        <form className="input-row" onSubmit={search}>
          <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setResults(null) }}
            placeholder="Dracula, GitHub Theme, Material Icon Theme…" aria-label="Search Open VSX for themes" />
          <button type="submit" disabled={!!busy || !query.trim()}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
        </form>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <h4>{results ? 'Results' : 'Popular themes'}</h4>
        <div className="settings-group">
          {!shown && <div className="setting"><small>Loading…</small></div>}
          {shown && !shown.length && <div className="setting"><small>No themes found.</small></div>}
          {shown?.map((result) => (
            <Item key={`${result.namespace}.${result.name}`} title={result.displayName} detail={[resultDetail(result), result.description].filter(Boolean).join('\n')}>
              <span className="input-row">
                <button type="button" aria-label={`Preview ${result.displayName}`} onClick={() => show(result)}>Preview</button>
                {installButton(result)}
              </span>
            </Item>
          ))}
        </div>
        <small className="settings-note">Only the colour and file icon themes an extension contributes are used. Its code is never run.</small>
      </section>
    </>
  )
}
