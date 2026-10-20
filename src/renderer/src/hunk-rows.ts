import type { DiffHunk } from '../../main/git/diff'
import type { Preview, Stretch } from './cm-editor'

// The change each Git hunk's actions sit above: the first one not yet taken whose current-side lines meet the hunk's.
// The editor's diff can align a change a line or so apart from Git's, so each side gets a line of slack.
export function hunkStarts(model: Preview, hunks: DiffHunk[]): Map<Stretch, number> {
  const starts = new Map<Stretch, number>()
  hunks.forEach((hunk, index) => {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header)
    if (!match) return
    const from = Number(match[1])
    const to = from + Math.max(1, match[2] === undefined ? 1 : Number(match[2])) - 1
    const chunk = model.stretches.find((stretch) => stretch.kind === 'chunk' && !starts.has(stretch)
      && stretch.b <= to + 1 && stretch.b + Math.max(1, stretch.countB) - 1 >= from - 1)
    if (chunk) starts.set(chunk, index)
  })
  return starts
}
