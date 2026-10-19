import { useState, type FormEvent, type ReactNode } from 'react'
import type { ExtensionResult, InstalledExtension } from '../../shared/themes'

const api = window.bettergit

const count = (number: number, noun: string) => `${number} ${noun}${number === 1 ? '' : 's'}`

function summary(extension: InstalledExtension) {
  const parts = [extension.themes.length && count(extension.themes.length, 'colour theme'), extension.iconThemes.length && count(extension.iconThemes.length, 'icon theme')]
  return [extension.publisher, extension.version && `v${extension.version}`, ...parts].filter(Boolean).join(' · ')
}

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

// Installs VS Code extensions from Open VSX or a .vsix file, for their colour and file icon themes.
export function ExtensionSettings({ extensions, onChanged }: {
  extensions: InstalledExtension[] | null
  onChanged: (id: string, removed: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ExtensionResult[] | null>(null)
  // The running action, such as `install:dracula-theme.theme-dracula`. One at a time.
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))
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
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Dracula, GitHub Theme, Material Icon Theme…" aria-label="Search Open VSX for themes" />
          <button type="submit" disabled={!!busy || !query.trim()}>{busy === 'search' ? 'Searching…' : 'Search'}</button>
        </form>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        {results && (
          <div className="settings-group">
            {!results.length && <div className="setting"><small>No themes found.</small></div>}
            {results.map((result) => {
              const key = `${result.namespace}.${result.name}`
              const installed = extensions?.find((extension) => extension.id === key.toLowerCase())
              const current = installed?.version === result.version
              const label = current ? 'Installed' : installed ? 'Update' : 'Install'
              return (
                <Item key={key} title={result.displayName} detail={[`${result.namespace} · v${result.version} · ${result.downloads.toLocaleString()} downloads`, result.description].filter(Boolean).join('\n')}>
                  <button type="button" disabled={!!busy || current} aria-label={`${label} ${result.displayName}`} onClick={() => void install(result)}>
                    {busy === `install:${key}` ? 'Installing…' : label}
                  </button>
                </Item>
              )
            })}
          </div>
        )}
        <small className="settings-note">Only the colour and file icon themes an extension contributes are used. Its code is never run.</small>
      </section>
    </>
  )
}
