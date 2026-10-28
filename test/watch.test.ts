import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SourceWatcher, type WatchEvent } from '../src/main/watch'

// Feeds file events straight to the watcher's batching, without a real file-system subscription.
function eventsFor(source: string, files: string[]): Promise<WatchEvent> {
  return new Promise((resolve) => {
    const watcher = new SourceWatcher(resolve, 0) as unknown as { record: (source: string, file: string) => void }
    for (const file of files) watcher.record(source, path.join(source, file))
  })
}

test('a nested repo edit refreshes each repo around it, and a no-op fetch refreshes nothing', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'bettergit-watch-'))
  try {
    mkdirSync(path.join(source, 'parent/.git'), { recursive: true })
    mkdirSync(path.join(source, 'parent/sub/.git'), { recursive: true })
    mkdirSync(path.join(source, 'parent/sub/src'), { recursive: true })
    const nested = await eventsFor(source, ['parent/sub/src/a.ts'])
    expect(nested.repos.sort()).toEqual([path.join(source, 'parent'), path.join(source, 'parent/sub')])
    // FETCH_HEAD and lock files alone are dropped; the real ref change after them is kept.
    const fetch = await eventsFor(source, ['parent/.git/FETCH_HEAD', 'parent/.git/refs/remotes/origin/HEAD.lock', 'parent/.git/refs/remotes/origin/main'])
    expect(fetch.repos).toEqual([path.join(source, 'parent')])
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

test('a repo moved into or out of a sources folder rebuilds the tree, and a dot file there does not', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'bettergit-watch-'))
  try {
    mkdirSync(path.join(source, 'group/added/.git'), { recursive: true })
    // Finder and mv report only the moved folder, never its .git.
    expect((await eventsFor(source, ['group/added'])).tree).toBe(true)
    expect((await eventsFor(source, ['removed'])).tree).toBe(true)
    expect((await eventsFor(source, ['.DS_Store'])).tree).toBe(false)
    expect((await eventsFor(source, ['group/added/file.txt'])).tree).toBe(false)
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})
