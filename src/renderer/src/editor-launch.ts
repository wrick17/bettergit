import { createContext, useRef, useState } from 'react'

// The Open in … app chosen in Settings, or its default. icon is a data URL, or null until it loads or when the app has none.
export interface SelectedApp {
  name: string
  icon: string | null
}

// Supplied by the owner of the diff (App, once the preload bridge exists). Without it, no open buttons render.
export interface EditorBridge {
  app: SelectedApp
  // Opens a repo-relative path in the working copy. Rejects with a readable message.
  openFile: (relPath: string) => Promise<unknown>
  onError: (error: unknown) => void
  // A commit diff opens the working copy, which may differ from the commit. Omitted when the view is unknown.
  source?: 'working' | 'commit'
}

export const EditorContext = createContext<EditorBridge | null>(null)

// One launch at a time per owner. The launch is read-only, so it never waits for a Git write and never takes the repo lock.
export function useEditorLaunch(launch: () => Promise<unknown>, onError: (error: unknown) => void) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const open = () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    launch().catch(onError).finally(() => {
      pending.current = false
      setBusy(false)
    })
  }
  return { busy, open }
}
