// Lane positions for the commit graph. The first lane sits one full step in, and each lane to its right sits closer to
// the one before, down to MIN_GAP, like Sublime Merge: a history with many branches stays narrow, and the first lanes,
// where most commits are, keep their room.
export const LANE_STEP = 11
const MIN_GAP = 4
const SHRINK = 0.85
// How far a marker reaches past its lane's centre (HEAD's ring is 7px), plus a pixel, so the graph never clips it.
const MARKER_REACH = 8
const xs = [LANE_STEP]

// The centre of a lane. Each lane's position is computed once and kept, so drawing a row reads a table.
export function laneX(slot: number): number {
  while (xs.length <= slot) xs.push(xs[xs.length - 1] + Math.max(MIN_GAP, Math.round(LANE_STEP * SHRINK ** xs.length)))
  return xs[slot]
}

// The width of a row's graph: through its last lane and the marker on it. The row's text starts after it.
export const graphWidth = (laneCount: number) => laneX(Math.max(laneCount, 1) - 1) + MARKER_REACH
