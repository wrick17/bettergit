import type { DiffFile, DiffLine, LineRef, MovedBlock } from '../../main/git/diff'

interface Working {
  files: DiffFile[]
  moves: MovedBlock[]
}

// Widening only adds unchanged lines, so every add and delete keeps its line number on its side. A move endpoint is
// matched to the same change in the new file by that number, so no endpoint points at a stale line.
// An endpoint with no match drops its move rather than drawing it at a guessed line.
export function swapFile(working: Working, index: number, next: DiffFile): Working {
  const old = working.files[index]
  const files = working.files.map((file, position) => (position === index ? next : file))
  if (!old) return { ...working, files }

  const keyOf = (line: DiffLine) => (line.type === 'del' ? `del:${line.oldNo}` : line.type === 'add' ? `add:${line.newNo}` : null)
  const placed = new Map<string, LineRef>()
  next.hunks.forEach((hunk, hunkIndex) => hunk.lines.forEach((line, lineIndex) => {
    const key = keyOf(line)
    if (key) placed.set(key, { file: index, hunk: hunkIndex, line: lineIndex })
  }))
  const remap = (ref: LineRef): LineRef | null => {
    if (ref.file !== index) return ref
    const line = old.hunks[ref.hunk]?.lines[ref.line]
    const key = line && keyOf(line)
    return (key && placed.get(key)) || null
  }
  const remapAll = (refs: LineRef[]): LineRef[] | null => {
    const out = refs.map(remap)
    return out.every((ref): ref is LineRef => ref !== null) ? out : null
  }
  const moves = working.moves.flatMap((move) => {
    const from = remapAll(move.from)
    const to = remapAll(move.to)
    return from && to ? [{ from, to }] : []
  })
  return { files, moves }
}
