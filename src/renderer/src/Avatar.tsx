import { useEffect, useState } from 'react'

// Pictures by email, kept for the window's life. Main fetches and caches them; a miss or a failure leaves the initial,
// and is asked again on a later mount, which main answers from its own cache until it retries.
const pictures = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

function pictureOf(email: string): Promise<string | null> {
  let load = pending.get(email)
  if (!load) {
    load = Promise.resolve().then(() => window.bettergit.avatar(email)).catch(() => null).then((url) => {
      pending.delete(email)
      if (typeof url === 'string' && url.startsWith('data:image/')) {
        pictures.set(email, url)
        return url
      }
      return null
    })
    pending.set(email, load)
  }
  return load
}

// The author's picture once it loads, else the first letter of the name. Decorative: the name is always shown beside it.
export function Avatar({ name, email, className = 'avatar' }: { name: string; email?: string; className?: string }) {
  const address = email?.trim().toLowerCase() ?? ''
  const [picture, setPicture] = useState(() => ({ email: address, url: pictures.get(address) ?? null }))
  const url = picture.email === address ? picture.url : pictures.get(address) ?? null
  useEffect(() => {
    if (!address) return setPicture({ email: address, url: null })
    let stale = false
    setPicture({ email: address, url: pictures.get(address) ?? null })
    void pictureOf(address).then((next) => { if (!stale) setPicture({ email: address, url: next }) })
    return () => { stale = true }
  }, [address])
  return (
    <span className={className} aria-hidden="true">
      {url ? <img key={address} src={url} alt="" draggable={false} onError={() => {
        pictures.delete(address)
        setPicture({ email: address, url: null })
      }} /> : name.charAt(0).toUpperCase()}
    </span>
  )
}
