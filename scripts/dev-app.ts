import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import metadata from '../package.json'

export function prepareDevApp(root: string): string {
  const stockExecutable = createRequire(path.join(root, 'package.json'))('electron') as string
  const source = realpathSync(path.resolve(stockExecutable, '../../..'))
  const icon = readFileSync(path.join(root, 'build/icon.icns'))
  const fields = {
    CFBundleName: metadata.productName,
    CFBundleDisplayName: metadata.productName,
    CFBundleIdentifier: `${metadata.build.appId}.dev`,
    CFBundleIconFile: 'icon.icns',
  }
  const key = createHash('sha256').update(source).update(readFileSync(path.join(source, 'Contents/Info.plist')))
    .update(icon).update(JSON.stringify(fields)).digest('hex').slice(0, 16)
  const cache = path.join(root, '.dev', key)
  const executable = path.join(cache, 'BetterGit.app/Contents/MacOS/Electron')
  if (existsSync(executable)) return executable

  // Native app icons come from the bundle; keep the shared Electron installation untouched.
  mkdirSync(path.dirname(cache), { recursive: true })
  const staging = mkdtempSync(path.join(root, '.dev/prepare-'))
  try {
    const bundle = path.join(staging, 'BetterGit.app')
    execFileSync('/usr/bin/ditto', [source, bundle])
    for (const [key, value] of Object.entries(fields)) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, path.join(bundle, 'Contents/Info.plist')])
    }
    writeFileSync(path.join(bundle, 'Contents/Resources/icon.icns'), icon)
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags', bundle])
    renameSync(staging, cache)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return executable
}
