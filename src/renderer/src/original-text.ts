import type { DiffHunk } from '../../main/git/diff'

// Rebuilds the old side of a working-tree diff from the current file: lines outside the hunks are unchanged, and each hunk
// swaps its new lines for its old ones. Null when the diff no longer describes this text, such as after a change on disk.
// Context lines come from the file, so with whitespace hidden a whitespace-only change stays hidden.
// shortcut: a final newline added or removed on one side only is not rebuilt; upgrade if that one-line diff confuses.
export function originalText(current: string, hunks: DiffHunk[]): string | null {
  const lines = current.split('\n')
  const out: string[] = []
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
  let next = 1
  for (const hunk of hunks) {
    const match = /\+(\d+)(?:,(\d+))? @@/.exec(hunk.header)
    if (!match) return null
    // A hunk with no new lines sits after its start line; any other hunk starts on it.
    const before = Number(match[1]) - (match[2] === '0' ? 0 : 1)
    if (before < next - 1 || before > lines.length) return null
    while (next <= before) out.push(lines[next++ - 1])
    for (const line of hunk.lines) {
      if (line.type === 'del') out.push(line.text)
      else if (line.type !== 'note') {
        const actual = lines[next++ - 1]
        if (actual === undefined || (line.type === 'add' ? actual.replace(/\r$/, '') !== line.text.replace(/\r$/, '') : !same(actual, line.text))) return null
        if (line.type === 'context') out.push(actual)
      }
    }
  }
  return [...out, ...lines.slice(next - 1)].join('\n')
}
