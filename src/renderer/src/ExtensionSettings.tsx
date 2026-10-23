import { Fragment, createElement, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Definition, Nodes } from 'mdast'
import type { ExtensionDetails, ExtensionMetadata, ExtensionResult, InstalledExtension } from '../../shared/themes'
import { Code } from './DiffView'
import { Icon } from './Icons'
import { languageFor, tokenize, type Segment } from './highlight'
import { useLanguageOverrides } from './prefs'

const api = window.bettergit

const count = (number: number, noun: string) => `${number} ${noun}${number === 1 ? '' : 's'}`

function summary(extension: InstalledExtension) {
  const parts = [extension.themes.length && count(extension.themes.length, 'colour theme'), extension.iconThemes.length && count(extension.iconThemes.length, 'icon theme')]
  return [extension.publisher, extension.version && `v${extension.version}`, ...parts].filter(Boolean).join(' · ')
}

const resultDetail = (result: ExtensionResult) => `${result.namespace} · v${result.version}`

const message = (failure: unknown) => (failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))

export interface ExtensionDetailRequest { namespace: string; name: string; label: string }

function safeUrl(value: string, base?: string | null): string | null {
  if (!value.trim()) return null
  try {
    const url = new URL(value, base ?? undefined)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null
  } catch { return null }
}

function ExtensionImage({ source, alt, logo = false, inline = false, width }: { source?: string | null; alt: string; logo?: boolean; inline?: boolean; width?: number }) {
  const [loaded, setLoaded] = useState<{ source: string; data: string | null } | null>(null)
  useEffect(() => {
    if (!source) return
    let live = true
    const request = source.startsWith('data:image/') ? Promise.resolve(source) : api.extensionImage(source)
    request.then((data) => { if (live) setLoaded({ source, data }) }, () => { if (live) setLoaded({ source, data: null }) })
    return () => { live = false }
  }, [source])
  const data = loaded?.source === source ? loaded?.data : null
  if (data) return <img className={logo ? 'extension-logo' : `extension-readme-image${inline ? ' inline' : ''}`} src={data} alt={alt} width={width} onError={() => setLoaded({ source: source!, data: null })} />
  if (logo) return <span className="extension-logo extension-logo-fallback" role="img" aria-label={`${alt} logo unavailable`}><Icon name="extensions" /></span>
  const url = source && safeUrl(source)
  return url ? <a href={url} onClick={(event) => { event.preventDefault(); void api.openExternal(url).catch(() => {}) }}>{alt || 'View image'}</a> : <span>{alt || 'Image unavailable'}</span>
}

function ExtensionStats({ value }: { value: Pick<InstalledExtension, 'downloads' | 'averageRating' | 'reviewCount'> }) {
  return <small className="extension-stats">Open VSX · {value.downloads == null ? 'Downloads unavailable' : `${value.downloads.toLocaleString()} downloads`} · {value.averageRating == null ? 'Unrated' : `${value.averageRating.toFixed(1)}/5${value.reviewCount == null ? '' : ` (${value.reviewCount.toLocaleString()} reviews)`}`}</small>
}

const README_HTML_TAGS = new Set('a b blockquote br caption code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li ol p picture pre s samp small span strong sub summary sup table tbody td tfoot th thead tr ul'.split(' '))

function ExtensionCode({ text, hint }: { text: string; hint?: string | null }) {
  const lang = (hint ?? '').toLowerCase()
  const language = lang === 'json' ? 'jsonc' : languageFor(`code.${lang}`, {}) ?? languageFor(`code.${lang}`, { [lang]: lang })
  const recoloured = useLanguageOverrides()
  const [colours, setColours] = useState<{ text: string; language: string; lines: Segment[][] | null }>()
  useEffect(() => {
    let stale = false
    if (language) void tokenize(text, language, () => stale).then((lines) => { if (!stale) setColours({ text, language, lines }) }, () => {})
    return () => { stale = true }
  }, [text, language, recoloured])
  const lines = colours?.text === text && colours.language === language ? colours.lines : null
  const segments = lines?.flatMap((line, index) => index ? [{ text: '\n' }, ...line] : line)
  return <pre><Code text={text} segments={segments} /></pre>
}

function ExtensionReadme({ source, base, onError }: { source: string; base: string | null; onError: (error: unknown) => void }) {
  return useMemo(() => {
    try {
      // Use the diff reader's delimiter guard for untrusted, pathologically dense Markdown.
      const dense = (source.match(/\*+|_+|~+|]/g)?.length ?? 0) > 1000
      const tree = fromMarkdown(source, { extensions: [gfm(), ...(dense ? [{ disable: { null: ['attention', 'strikethrough', 'labelStartLink', 'labelStartImage', 'labelEnd', 'gfmFootnoteCall', 'gfmPotentialFootnoteCall'] } }] : [])], mdastExtensions: [gfmFromMarkdown()] })
      const definitions = new Map<string, Definition>()
      const collect = (node: Nodes, depth = 0) => {
        if (depth > 128) throw new Error('README nesting limit exceeded')
        if (node.type === 'definition') definitions.set(node.identifier, node)
        if ('children' in node) node.children.forEach((child) => collect(child, depth + 1))
      }
      collect(tree)
      const link = (value: string, children: ReactNode, key: number) => {
        const url = safeUrl(value, base)
        return url ? <a key={key} href={url} onClick={(event) => { event.preventDefault(); void api.openExternal(url).catch(onError) }}>{children}</a> : <span key={key}>{children}</span>
      }
      const html = (value: string, slots = new Map<string, ReactNode>()) => {
        // Template contents are inert and never attached; only allowlisted React elements leave this parser.
        const template = document.createElement('template')
        template.innerHTML = value
        const image = (element: Element, key: number, selected?: string) => {
          const size = element.getAttribute('width') ?? ''
          const width = /^\d{1,4}$/.test(size) && Number(size) > 0 && Number(size) <= 4096 ? Number(size) : undefined
          return <ExtensionImage key={key} source={safeUrl(selected ?? element.getAttribute('src') ?? '', base)} alt={element.getAttribute('alt') || 'README image'} width={width} inline />
        }
        const visit = (node: ChildNode, key: number, depth = 0): ReactNode => {
          if (depth > 128) throw new Error('README HTML nesting limit exceeded')
          if (node.nodeType === Node.TEXT_NODE) return node.textContent
          if (!(node instanceof Element) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null
          const slot = node.getAttribute('data-readme-slot')
          if (slot && slots.has(slot)) return <Fragment key={key}>{slots.get(slot)}</Fragment>
          const tag = node.localName
          if (!README_HTML_TAGS.has(tag)) return null
          if (tag === 'img') return image(node, key)
          if (tag === 'picture') {
            const children = [...node.children]
            const fallback = children.find((child) => child.localName === 'img')
            if (!fallback) return null
            const selected = children.filter((child) => child.localName === 'source').find((child) => {
              const media = child.getAttribute('media')
              return (!media || window.matchMedia(media).matches) && safeUrl(child.getAttribute('srcset')?.trim().split(/[\s,]+/)[0] ?? '', base)
            })
            // Resolve the picture candidate through the image bridge, never a remote DOM srcset.
            return <picture key={key}>{image(fallback, 0, selected?.getAttribute('srcset')?.trim().split(/[\s,]+/)[0])}</picture>
          }
          if (tag === 'br' || tag === 'hr') return createElement(tag, { key })
          const children = [...node.childNodes].map((child, index) => visit(child, index, depth + 1))
          if (tag === 'a') return link(node.getAttribute('href') ?? '', children, key)
          const align = node.getAttribute('align')
          const textAlign = align === 'center' || align === 'left' || align === 'right' ? align : undefined
          const props = { key, title: node.getAttribute('title') ?? undefined, style: textAlign ? { textAlign } : undefined,
            ...(tag === 'details' ? { open: node.hasAttribute('open') } : {}),
            ...(tag === 'ol' && /^-?\d{1,6}$/.test(node.getAttribute('start') ?? '') ? { start: Number(node.getAttribute('start')) } : {}) }
          const result = createElement(tag, props, children)
          return tag === 'table' ? <div key={key} className="extension-readme-table">{result}</div> : result
        }
        return [...template.content.childNodes].map((node, index) => visit(node, index))
      }
      const renderNodes = (nodes: Nodes[]): ReactNode[] => {
        if (!nodes.some((node) => node.type === 'html')) return nodes.map(render)
        const slots = new Map<string, ReactNode>()
        const value = nodes.map((node, index) => {
          if (node.type === 'html') return node.value
          // Opaque slots keep Markdown siblings intact across inline HTML opening/closing tags.
          const slot = crypto.getRandomValues(new Uint32Array(4)).join('-')
          slots.set(slot, render(node, index))
          return `<span data-readme-slot="${slot}"></span>`
        }).join('')
        return html(value, slots)
      }
      const render = (node: Nodes, key: number): ReactNode => {
        const children = () => 'children' in node ? renderNodes(node.children) : null
        switch (node.type) {
          case 'text': return node.value
          case 'paragraph': return <p key={key}>{children()}</p>
          case 'heading': return createElement(`h${node.depth}`, { key }, children())
          case 'strong': return <strong key={key}>{children()}</strong>
          case 'emphasis': return <em key={key}>{children()}</em>
          case 'delete': return <del key={key}>{children()}</del>
          case 'inlineCode': return <code key={key}>{node.value}</code>
          case 'code': return <ExtensionCode key={key} text={node.value} hint={node.lang} />
          case 'blockquote': return <blockquote key={key}>{children()}</blockquote>
          case 'list': return node.ordered ? <ol key={key} start={node.start ?? 1}>{children()}</ol> : <ul key={key}>{children()}</ul>
          case 'listItem': return <li key={key}>{node.checked != null && <input type="checkbox" checked={node.checked} disabled aria-label="README task" />}{children()}</li>
          case 'table': return <div key={key} className="extension-readme-table"><table><tbody>{children()}</tbody></table></div>
          case 'tableRow': return <tr key={key}>{children()}</tr>
          case 'tableCell': return <td key={key}>{children()}</td>
          case 'link': return link(node.url, children(), key)
          case 'linkReference': return link(definitions.get(node.identifier)?.url ?? '', children(), key)
          case 'image': return <ExtensionImage key={key} source={safeUrl(node.url, base)} alt={node.alt || 'README image'} />
          case 'imageReference': return <ExtensionImage key={key} source={safeUrl(definitions.get(node.identifier)?.url ?? '', base)} alt={node.alt || 'README image'} />
          case 'thematicBreak': return <hr key={key} />
          case 'break': return <br key={key} />
          case 'html': return <Fragment key={key}>{html(node.value)}</Fragment>
          default: return null
        }
      }
      return <div className="extension-readme">{renderNodes(tree.children)}</div>
    } catch {
      // Keep untrusted Markdown failures inside the scrollable body, away from the modal controls.
      return <div className="extension-readme"><p role="status">README formatting is too complex to display. Showing plain text.</p><pre><code>{source}</code></pre></div>
    }
  }, [source, base, onError])
}

export function ExtensionDetailsContent({ namespace, name }: { namespace: string; name: string }) {
  const [details, setDetails] = useState<ExtensionDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.extensionDetails(namespace, name).then((value) => { if (live) setDetails(value) }, (failure: unknown) => { if (live) setError(message(failure)) })
    return () => { live = false }
  }, [namespace, name])
  return <>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {!details && !error && <p role="status">Loading extension details…</p>}
    {details && <>
      <div className="extension-details-meta">
        <ExtensionImage source={details.icon} alt={details.displayName} logo />
        <div><h3>{details.displayName}</h3><p>{details.description}</p><p>{details.namespace}.{details.name} · v{details.version}</p><ExtensionStats value={details} /></div>
      </div>
      {details.readme?.trim() ? <ExtensionReadme source={details.readme} base={details.readmeBaseUrl} onError={(failure) => setError(message(failure))} /> : <p>No README is available for this extension.</p>}
    </>}
  </>
}

function Item({ title, detail, metadata, children }: { title: string; detail: string; metadata?: Pick<InstalledExtension, 'icon' | 'downloads' | 'averageRating' | 'reviewCount'>; children?: ReactNode }) {
  return (
    <div className="setting extension-item">
      <ExtensionImage source={metadata?.icon} alt={title} logo />
      <span className="setting-label">
        <span>{title}</span>
        <small className="extension-detail">{detail}</small>
        <ExtensionStats value={metadata ?? {}} />
      </span>
      {children}
    </div>
  )
}

// Installs VS Code extensions from Open VSX or a .vsix file, for their colour and file icon themes. An empty search lists
// the most downloaded themes.
export function ExtensionSettings({ extensions, onChanged, onDetails }: {
  extensions: InstalledExtension[] | null
  onChanged: (id: string, removed: boolean) => void
  onDetails: (request: ExtensionDetailRequest) => void
}) {
  const [query, setQuery] = useState('')
  const [popular, setPopular] = useState<ExtensionResult[] | null>(null)
  const [results, setResults] = useState<ExtensionResult[] | null>(null)
  const [metadata, setMetadata] = useState<Record<string, ExtensionMetadata>>({})
  useEffect(() => {
    let live = true
    for (const extension of extensions ?? []) {
      const [namespace, name] = extension.id.split('.')
      api.extensionMetadata(namespace, name).then((value) => {
        if (live) setMetadata((current) => ({ ...current, [extension.id]: value }))
      }, () => {})
    }
    return () => { live = false }
  }, [extensions])
  // The running action, such as `install:dracula-theme.theme-dracula`. One at a time.
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  const detailsButton = (namespace: string, name: string, label: string) => (
    <button type="button" disabled={!!busy} aria-label={`Details for ${label}`}
      onClick={() => onDetails({ namespace, name, label })}>
      Details
    </button>
  )
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

  const shown = results ?? popular
  return (
    <>
      <section className="settings-section">
        <h4>Installed</h4>
        <div className="settings-group">
          {!extensions?.length && (
            <div className="setting"><small>{extensions ? 'No extensions yet. Install a theme from Open VSX or a .vsix file.' : 'Loading…'}</small></div>
          )}
          {extensions?.map((extension) => {
            const [namespace, name] = extension.id.split('.')
            return (
              <Item key={extension.id} title={extension.name} detail={summary(extension)} metadata={metadata[extension.id] ?? extension}>
                <span className="settings-actions">
                  {detailsButton(namespace, name, extension.name)}
                  <button type="button" disabled={!!busy} aria-label={`Remove ${extension.name}`} onClick={() => void remove(extension)}>
                    {busy === `remove:${extension.id}` ? 'Removing…' : 'Remove'}
                  </button>
                </span>
              </Item>
            )
          })}
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
            <Item key={`${result.namespace}.${result.name}`} title={result.displayName} detail={[resultDetail(result), result.description].filter(Boolean).join('\n')} metadata={result}>
              <span className="settings-actions">
                {detailsButton(result.namespace, result.name, result.displayName)}
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
