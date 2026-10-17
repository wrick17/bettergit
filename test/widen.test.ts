import { expect, test } from 'bun:test'
import { detectMoves, parseDiff, type LineRef, type DiffFile } from '../src/main/git/diff'
import { swapFile } from '../src/renderer/src/widen'

// Three lines leave a.ts and arrive in b.ts. a.ts is shown again with more context, as a per-file widen does.
const NARROW_A = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -4,5 +4,2 @@
 keep4
-moved one
-moved two
-moved three
 keep8
`
const WIDE_A = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,9 +1,6 @@
 line1
 line2
 line3
 keep4
-moved one
-moved two
-moved three
 keep8
 line9
`
const NARROW_B = `diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,5 @@
 top1
+moved one
+moved two
+moved three
 bottom
`

const textAt = (files: DiffFile[], ref: LineRef) => files[ref.file].hunks[ref.hunk].lines[ref.line].text

test('widening a file keeps its move, and each endpoint still points at its own line', () => {
  const [a] = parseDiff(NARROW_A)
  const [b] = parseDiff(NARROW_B)
  const before = { files: [a, b], moves: detectMoves([a, b]) }
  expect(before.moves).toHaveLength(1)

  const after = swapFile(before, 0, parseDiff(WIDE_A)[0])
  expect(after.moves).toHaveLength(1)
  const [move] = after.moves
  const moved = ['moved one', 'moved two', 'moved three']
  expect(move.from.map((ref) => textAt(after.files, ref))).toEqual(moved)
  expect(move.to.map((ref) => textAt(after.files, ref))).toEqual(moved)
  // The widened file's endpoints moved down by the three added context lines. The other file's endpoints are unchanged.
  expect(move.from[0]).toEqual({ file: 0, hunk: 0, line: 4 })
  expect(move.to).toEqual(before.moves[0].to)
})
