import { afterEach, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { systemRequestWithFetch } from './system-request'

const realFetch = globalThis.fetch
let mockFetch = realFetch
const realNow = Date.now
const compiled = await Bun.build({ entrypoints: [new URL('../src/main/avatar.ts', import.meta.url).pathname], format: 'cjs', target: 'node', external: ['electron'] })
if (!compiled.success) throw new Error('Could not build avatar test module.')
const module = { exports: {} as typeof import('../src/main/avatar') }
runInNewContext(await compiled.outputs[0].text(), {
  module, exports: module.exports, URL, URLSearchParams, AbortSignal, Buffer, Date, Response, Headers,
  require: (id: string) => id === 'electron' ? { net: { request: systemRequestWithFetch((url, options) => mockFetch(url, options)) } } : require(id),
})
const { avatars } = module.exports
afterEach(() => {
  mockFetch = realFetch
  Date.now = realNow
})

test('author pictures: one fixed host, one request per email, and every failure falls back to null', async () => {
  const asked: string[] = []
  const reply = new Map<string, () => Response>()
  mockFetch = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    const hash = new URL(url).pathname.split('/').pop()!
    return (reply.get(hash) ?? (() => new Response('nope', { status: 404 })))()
  }) as typeof fetch
  const decoded: number[] = []
  const avatarFor = avatars((data) => {
    decoded.push(data.length)
    return data[0] === 0x89 ? 'data:image/png;base64,AAAA' : null
  })
  const hashOf = (email: string) => new Bun.CryptoHasher('sha256').update(email).digest('hex')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  reply.set(hashOf('ann@example.com'), () => new Response(png, { headers: { 'content-type': 'image/png' } }))
  reply.set(hashOf('html@example.com'), () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }))
  reply.set(hashOf('big@example.com'), () => new Response(new Uint8Array(600 * 1024), { headers: { 'content-type': 'image/png' } }))
  reply.set(hashOf('junk@example.com'), () => new Response(Buffer.from('GIF89a'), { headers: { 'content-type': 'image/gif' } }))

  // Trimmed and lowercased before hashing; two requests at once share one fetch.
  const [first, second] = await Promise.all([avatarFor(' Ann@Example.com '), avatarFor('ann@example.com')])
  expect(first).toBe('data:image/png;base64,AAAA')
  expect(second).toBe(first)
  expect(asked).toEqual([`https://gravatar.com/avatar/${hashOf('ann@example.com')}?s=64&d=404`])
  // Cached: no second request.
  expect(await avatarFor('ann@example.com')).toBe(first)
  expect(asked.length).toBe(1)

  expect(await avatarFor('none@example.com')).toBeNull() // 404 from d=404
  expect(await avatarFor('html@example.com')).toBeNull() // not a raster type
  expect(await avatarFor('big@example.com')).toBeNull() // over the size cap
  expect(await avatarFor('junk@example.com')).toBeNull() // does not decode
  expect(decoded).toEqual([4, 6])
  // Not an email, or not a string: no request at all.
  const before = asked.length
  for (const bad of ['', 'no-at-sign', 42, null, `${'a'.repeat(320)}@x.y`]) expect(await avatarFor(bad)).toBeNull()
  expect(asked.length).toBe(before)

  mockFetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  expect(await avatarFor('offline@example.com')).toBeNull()
})

test('GitHub noreply pictures use the author identity, with numeric IDs surviving username changes', async () => {
  const asked: string[] = []
  mockFetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input)
    asked.push(url)
    expect(options?.redirect).toBe('manual')
    expect(options?.headers).toBeUndefined() // No account token or cookies are sent.
    if (new URL(url).hostname === 'github.com') {
      return new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/u/42?s=64' } })
    }
    return new Response(Buffer.from([0x89]), { headers: { 'content-type': 'image/png' } })
  }) as typeof fetch
  const avatarFor = avatars(() => 'data:image/png;base64,AAAA')
  const [first, second] = await Promise.all([
    avatarFor(' 123+Old-Name@users.noreply.github.com '),
    avatarFor('123+old-name@users.noreply.github.com'),
  ])
  expect(first).toBe('data:image/png;base64,AAAA')
  expect(second).toBe(first)
  expect(await avatarFor('123+old-name@users.noreply.github.com')).toBe(first)
  expect(asked).toEqual(['https://avatars.githubusercontent.com/u/123?s=64'])

  expect(await avatarFor('Other-Author@users.noreply.github.com')).toBe(first)
  expect(asked.slice(1)).toEqual([
    'https://github.com/other-author.png?size=64',
    'https://avatars.githubusercontent.com/u/42?s=64',
  ])

  // An ordinary email, even with the same local part, retains the existing email lookup.
  expect(await avatarFor('other-author@example.com')).toBe(first)
  const hash = new Bun.CryptoHasher('sha256').update('other-author@example.com').digest('hex')
  expect(asked.at(-1)).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404`)
})

test('picture redirects stay within their provider and failures are cached only until retry', async () => {
  const asked: string[] = []
  let location = 'https://untrusted.example/picture.png'
  let now = 0
  Date.now = () => now
  mockFetch = (async (input: string | URL | Request) => {
    const url = String(input)
    asked.push(url)
    return new Response(null, { status: 302, headers: { location } })
  }) as typeof fetch
  const avatarFor = avatars(() => 'data:image/png;base64,AAAA')
  const email = 'author@users.noreply.github.com'
  expect(await avatarFor(email)).toBeNull()
  expect(await avatarFor(email)).toBeNull()
  expect(asked).toEqual(['https://github.com/author.png?size=64'])

  // Each forbidden redirect must be rejected before its destination is fetched.
  for (const destination of [
    'http://avatars.githubusercontent.com/u/42',
    'https://avatars.githubusercontent.com:444/u/42',
    'https://user:password@avatars.githubusercontent.com/u/42',
    'https://avatars.githubusercontent.com.untrusted.example/u/42',
    'https://gravatar.com/avatar/42',
  ]) {
    location = destination
    now += 15 * 60_000
    const before = asked.length
    expect(await avatarFor(email)).toBeNull()
    expect(asked.slice(before)).toEqual(['https://github.com/author.png?size=64'])
  }
  location = 'https://avatars.githubusercontent.com/u/42'
  expect(await avatarFor('ordinary@example.com')).toBeNull() // Gravatar cannot redirect to a new provider.
  expect(asked.at(-1)).toStartWith('https://gravatar.com/avatar/')

  now += 15 * 60_000
  mockFetch = (async (input: string | URL | Request) => {
    asked.push(String(input))
    return new Response(Buffer.from([0x89]), { headers: { 'content-type': 'image/png' } })
  }) as typeof fetch
  expect(await avatarFor(email)).toBe('data:image/png;base64,AAAA')
})
