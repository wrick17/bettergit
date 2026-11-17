// Image types Chromium can show, by file extension. A binary diff of one of these previews both sides as images.
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

export function imageType(path: string): string | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null
}
