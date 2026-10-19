// The renderer API over HTTP (see server.ts). Events never fire; writes reject. `__perf.inflight` lets the bench wait for replies.
const perf = { inflight: 0, calls: [] as string[] }
;(window as any).__perf = perf
const call = async (name: string, args: unknown[]) => {
  perf.inflight++
  perf.calls.push(name)
  try {
    const response = await fetch(`http://127.0.0.1:5792/${name}`, { method: 'POST', body: JSON.stringify(args) })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    return body.value
  } finally {
    perf.inflight--
  }
}
;(window as any).bettergit = new Proxy({}, {
  get: (_target, name: string) => name === 'onEvent' ? () => () => undefined : (...args: unknown[]) => call(name, args),
})
await import('../../src/renderer/src/main')
export {}
