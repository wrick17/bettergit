import { afterEach, expect, test } from 'bun:test'
import { avatars } from '../src/main/avatar'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('author pictures: one fixed host, one request per email, and every failure falls back to null', async () => {
  const asked: string[] = []
  const reply = new Map<string, () => Response>()
  globalThis.fetch = (async (input: string | URL | Request) => {
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

  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  expect(await avatarFor('offline@example.com')).toBeNull()
})
