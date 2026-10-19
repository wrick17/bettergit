import type { DiffFile, DiffLine, LineRef, MovedBlock } from '../../main/git/diff'

interface Working {
  files: DiffFile[]
  moves: MovedBlock[]
}

// The files in the order of `paths`, the order the file list shows them. Files the list does not name keep their
// order after the rest. Moves name files by index, so they follow their files.
export function orderFiles(working: Working, paths: readonly string[]): Working {
  const rank = new Map(paths.map((path, index) => [path, index]))
  const at = (file: DiffFile) => rank.get(file.newPath ?? file.oldPath ?? '') ?? paths.length
  const order = working.files.map((_, index) => index).sort((a, b) => at(working.files[a]) - at(working.files[b]) || a - b)
  if (order.every((from, to) => from === to)) return working
  const moved = new Map(order.map((from, to) => [from, to]))
  const remap = (ref: LineRef): LineRef => ({ ...ref, file: moved.get(ref.file)! })
  return {
    files: order.map((index) => working.files[index]),
    moves: working.moves.map((move) => ({ from: move.from.map(remap), to: move.to.map(remap) })),
  }
}

// A reload that finds a file unchanged keeps the loaded object, so its section does not re-render and its colours stay.
// An unchanged reload returns the previous result itself.
export function shareFiles(previous: Working | undefined, next: Working): Working {
  if (!previous) return next
  const kept = new Map(previous.files.map((file) => [JSON.stringify(file), file]))
  const files = next.files.map((file) => kept.get(JSON.stringify(file)) ?? file)
  const sameMoves = JSON.stringify(previous.moves) === JSON.stringify(next.moves)
  if (sameMoves && files.length === previous.files.length && files.every((file, index) => file === previous.files[index])) return previous
  return { files, moves: sameMoves ? previous.moves : next.moves }
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
