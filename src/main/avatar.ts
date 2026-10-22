import { createHash } from 'node:crypto'
import { fetchOk, readBody } from './extensions'

// GitHub noreply addresses identify an author directly; other emails keep the hashed Gravatar lookup.
// Main constructs every URL, restricts redirect hosts, and returns only decoded image data to the renderer.
const SIZE = 64
const MAX_BYTES = 512 * 1024
const MAX_EMAIL = 320
const CACHE = 500
// A failure is retried after a while, so being offline once does not hide pictures for the whole session.
const RETRY_MS = 15 * 60_000
const LOADS = 4

const IMAGE = /^image\/(?:png|jpeg|gif|webp)$/
const GITHUB_EMAIL = /^(?:([1-9][0-9]*)\+)?([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)@users\.noreply\.github\.com$/

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
  const load = async (url: string): Promise<string | null> => {
    try {
      const host = new URL(url).hostname
      const allowed = async (next: URL) => next.protocol === 'https:' && !next.port && !next.username && !next.password
        && (next.hostname === host || (host === 'github.com' && next.hostname === 'avatars.githubusercontent.com'))
      const response = await fetchOk(url, allowed)
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
      const github = address.match(GITHUB_EMAIL)
      // The numeric ID stays with the author after a GitHub username change.
      const source = github
        ? github[1] ? `https://avatars.githubusercontent.com/u/${github[1]}?s=${SIZE}` : `https://github.com/${github[2]}.png?size=${SIZE}`
        : `https://gravatar.com/avatar/${hash}?s=${SIZE}&d=404`
      request = slot(() => load(source)).then((url) => {
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
