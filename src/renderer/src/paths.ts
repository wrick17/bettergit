// Splits a repo-relative path so the file name can lead and the folder can truncate behind it.
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return { name: path.slice(slash + 1), dir: slash === -1 ? '' : path.slice(0, slash) }
}

// Lock files churn without being read, so the list shows their status marker but not their line counts.
const LOCK_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml'])
export function isLockFile(name: string): boolean {
  return name.endsWith('.lock') || LOCK_NAMES.has(name)
}
