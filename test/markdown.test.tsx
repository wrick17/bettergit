import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseDiff, type DiffFile, type DiffLine, type MovedBlock } from '../src/main/git/diff'
import { isMarkdownPath, MarkdownContent, markdownHunk } from '../src/renderer/src/MarkdownLine'

const line = (text: string, type: DiffLine['type'] = 'context', number = 1): DiffLine => ({
  text, type, oldNo: type === 'add' || type === 'note' ? null : number, newNo: type === 'del' || type === 'note' ? null : number,
})
const file = (path: string, lines: DiffLine[], header = '@@ -1 +1 @@'): DiffFile => ({
  oldPath: path, newPath: path, status: 'modified', binary: false, hunks: [{ header, lines }],
})

test('long malformed syntax stays bounded without dropping source', () => {
  const text = '*['.repeat(10_000)
  const started = performance.now()
  const result = markdownHunk([line(text)])
  expect(result.new.entries[0].line.text).toBe(text)
  expect((renderToStaticMarkup(<MarkdownContent nodes={result.new.nodes} side={result.new} />).match(/\[/g) ?? []).length).toBe(10_000)
  expect(performance.now() - started).toBeLessThan(2000)
})
