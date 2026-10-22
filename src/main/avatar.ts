import { createHash } from 'node:crypto'
import { fetchOk, readBody } from './extensions'

// Author pictures from Gravatar, by the SHA-256 of the trimmed, lowercased email. d=404 makes an author without one a
// 404, so the renderer keeps its initial. Main fetches from this one host only, never a URL from the renderer, sends no
// cookies, caps the size, and hands back the picture re-encoded by `decode` as a data URL, which the renderer's CSP allows.
const HOST = 'gravatar.com'
const SIZE = 64
const MAX_BYTES = 512 * 1024
const MAX_EMAIL = 320
const CACHE = 500
// A failure is retried after a while, so being offline once does not hide pictures for the whole session.
const RETRY_MS = 15 * 60_000
const LOADS = 4

const allowed = async (url: URL) => url.protocol === 'https:' && url.hostname === HOST && !url.port && !url.username && !url.password
const IMAGE = /^image\/(?:png|jpeg|gif|webp)$/

export function avatars(decode: (data: Buffer) => string | null) {
  const cache = new Map<string, { url: string | null; at: number }>()
  const pending = new Map<string, Promise<string | null>>()
  const queue: Array<() => void> = []
  let running = 0
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= LOADS) await new Promise<void>((resolve) => queue.push(resolve))
    running++
    try {
      return await work()
    } finally {
      running--
      queue.shift()?.()
    }
  }
  const load = async (hash: string): Promise<string | null> => {
    try {
      const response = await fetchOk(`https://${HOST}/avatar/${hash}?s=${SIZE}&d=404`, allowed)
      if (!IMAGE.test(response.headers.get('content-type')?.split(';')[0].trim() ?? '')) {
        await response.body?.cancel()
        return null
      }
      return decode(await readBody(response, MAX_BYTES, 'The picture is too large.'))
    } catch {
      return null
    }
  }
  return (email: unknown): Promise<string | null> => {
    if (typeof email !== 'string') return Promise.resolve(null)
    const address = email.trim().toLowerCase()
    if (!address.includes('@') || address.length > MAX_EMAIL) return Promise.resolve(null)
    const hash = createHash('sha256').update(address).digest('hex')
    const hit = cache.get(hash)
    if (hit && (hit.url || Date.now() - hit.at < RETRY_MS)) return Promise.resolve(hit.url)
    let request = pending.get(hash)
    if (!request) {
      request = slot(() => load(hash)).then((url) => {
        pending.delete(hash)
        cache.delete(hash)
        cache.set(hash, { url, at: Date.now() })
        // shortcut: drops the oldest entry past CACHE by insertion order; an LRU only matters past hundreds of authors.
        if (cache.size > CACHE) cache.delete(cache.keys().next().value!)
        return url
      })
      pending.set(hash, request)
    }
    return request
  }
}
