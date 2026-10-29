import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

// Model Electron's manual redirect event, which must be cancelled before async validation.
export function systemRequestWithFetch(fetch: (url: string, options: RequestInit) => Promise<Response>) {
  return (options: RequestInit & { url: string }) => {
    const request = new EventEmitter()
    const controller = new AbortController()
    let incoming: Readable | undefined
    let aborted = false
    return Object.assign(request, {
      abort() {
        aborted = true
        controller.abort()
        incoming?.destroy()
      },
      end() {
        void (async () => {
          const response = await fetch(options.url, { ...options, signal: controller.signal })
          if (aborted) return
          const location = response.headers.get('location')
          if (response.status >= 300 && response.status < 400 && location) {
            request.emit('redirect', response.status, 'GET', new URL(location, options.url).href, {})
            await response.body?.cancel()
            if (!aborted) throw new Error('Redirect was cancelled')
          } else {
            incoming = response.body ? Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream) : Readable.from([])
            Object.assign(incoming, { statusCode: response.status, headers: Object.fromEntries(response.headers) })
            request.emit('response', incoming)
          }
        })().catch(error => { if (!aborted) request.emit('error', error) })
      },
    })
  }
}
