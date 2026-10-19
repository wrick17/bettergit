// A native confirmation sheet blocks the renderer until it is answered, and a blocked renderer draws nothing new. So the
// blurred underlay goes on screen first: a scrim beside the app root (styles.css blurs the root under any scrim), then two
// frames, then the sheet. The scrim leaves on either answer. Anything that goes wrong counts as a cancel.
let asking = false

export async function confirmOverBlur(message: string): Promise<boolean> {
  // One sheet at a time. A second request while one is pending, such as a double click, is a cancel.
  if (asking) return false
  asking = true
  const scrim = document.createElement('div')
  scrim.className = 'scrim confirm-scrim'
  try {
    document.body.append(scrim)
    // The first frame commits the blur. The second starts only after that frame was drawn.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return window.confirm(message)
  } catch {
    return false
  } finally {
    scrim.remove()
    asking = false
  }
}
