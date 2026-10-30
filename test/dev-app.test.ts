import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { loadConfigFromFile } from 'electron-vite'
import metadata from '../package.json'

test.skipIf(process.platform !== 'darwin')('dev uses a signed BetterGit icon bundle without changing the shared Electron app', async () => {
  const stockExecutable = createRequire(import.meta.url)('electron') as string
  const stockContents = path.resolve(stockExecutable, '../..')
  const stockPlist = readFileSync(path.join(stockContents, 'Info.plist'))
  const stockIcon = readFileSync(path.join(stockContents, 'Resources/electron.icns'))
  const configFile = path.resolve(import.meta.dir, '../electron.vite.config.ts')
  const previousExecutable = process.env.ELECTRON_EXEC_PATH
  delete process.env.ELECTRON_EXEC_PATH
  try {
    await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile)
    expect(process.env.ELECTRON_EXEC_PATH).toBeUndefined()
    await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile)
    const executable = process.env.ELECTRON_EXEC_PATH || stockExecutable
    const contents = path.resolve(executable, '../..')
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }))
    expect(executable).not.toBe(stockExecutable)
    expect(plist.CFBundleIdentifier).toBe(`${metadata.build.appId}.dev`)
    expect(plist.CFBundleName).toBe(metadata.productName)
    expect(readFileSync(path.join(contents, 'Resources', plist.CFBundleIconFile))).toEqual(readFileSync(path.resolve(import.meta.dir, '../build/icon.icns')))
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.resolve(contents, '..')])
    const preparedInode = statSync(executable).ino
    delete process.env.ELECTRON_EXEC_PATH
    await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile)
    expect(process.env).toHaveProperty('ELECTRON_EXEC_PATH', executable)
    expect(statSync(executable).ino).toBe(preparedInode)
    process.env.ELECTRON_EXEC_PATH = '/explicit/electron'
    await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile)
    expect(process.env).toHaveProperty('ELECTRON_EXEC_PATH', '/explicit/electron')
    expect(readFileSync(path.join(stockContents, 'Info.plist'))).toEqual(stockPlist)
    expect(readFileSync(path.join(stockContents, 'Resources/electron.icns'))).toEqual(stockIcon)
  } finally {
    if (previousExecutable === undefined) delete process.env.ELECTRON_EXEC_PATH
    else process.env.ELECTRON_EXEC_PATH = previousExecutable
  }
}, 30_000)
