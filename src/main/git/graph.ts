// Lane layout for the commit graph. Lanes are fixed slots that stay put while they live, like Sublime Merge's graph: a
// commit takes its own lane or the leftmost free slot, its first parent continues in that lane, and a parent that already
// has a lane is joined rather than given a second one. A slot frees the moment its line ends and is reused by the next
// line that needs one, so the width follows how many lines are open at once, not how many branches the history has.

export interface GraphCommit {
  hash: string
  parents: string[]
}

export interface Lane {
  hash: string
  color: number
}

// input and output are the slots at the top and bottom edge of the row. A null slot is free; slots keep their index.
export interface GraphRow<T extends GraphCommit = GraphCommit> {
  commit: T
  lane: number
  color: number
  input: (Lane | null)[]
  output: (Lane | null)[]
  laneCount: number
}

const COLOR_COUNT = 5

// Where a layout left off: the slots below its last row and the next color. Passing the state from one call to the next
// lays out an appended page without laying out the rows before it again.
export interface GraphState {
  lanes: (Lane | null)[]
  nextColor: number
  // The rows of the layout this one replaces, by commit. A background refresh lays out against them, so a commit already
  // on screen keeps its lane and color while that slot is free at its row, and new lines keep clear of the old ones.
  previous?: Map<string, GraphRow>
}

// A fresh layout. With the checked-out commit in the list, slot 0 waits for it, so HEAD's first-parent chain runs down
// the left edge however many newer branch tips sit above it. Given the layout it replaces, HEAD's line keeps the slot and
// color HEAD (or, for a new HEAD commit, its parent) had there instead.
export function startGraph(commits: GraphCommit[], head: string | null, previous?: { rows: GraphRow[]; state: GraphState }): GraphState {
  const headCommit = head ? commits.find((commit) => commit.hash === head) : undefined
  if (!previous?.rows.length) return headCommit ? { lanes: [{ hash: headCommit.hash, color: 0 }], nextColor: 1 } : { lanes: [], nextColor: 0 }
  const rows = new Map(previous.rows.map((row) => [row.commit.hash, row]))
  const state: GraphState = { lanes: [], nextColor: previous.state.nextColor, previous: rows }
  if (headCommit) {
    const was = rows.get(headCommit.hash) ?? rows.get(headCommit.parents[0] ?? '')
    put(state.lanes, was?.lane ?? 0, { hash: headCommit.hash, color: was?.color ?? 0 })
  }
  return state
}

// Sets a slot, filling any gap before it with free slots.
function put(lanes: (Lane | null)[], slot: number, lane: Lane) {
  while (lanes.length < slot) lanes.push(null)
  lanes[slot] = lane
}

// The free slot nearest to `from`, the right side first on a tie, or a new slot past the end. `clear` can rule slots out.
function freeSlot(lanes: (Lane | null)[], from: number, clear: (slot: number) => boolean = () => true) {
  const open = (slot: number) => slot >= 0 && slot < lanes.length && !lanes[slot] && clear(slot)
  for (let distance = 0; distance < lanes.length; distance++) {
    if (open(from + distance)) return from + distance
    if (distance > 0 && open(from - distance)) return from - distance
  }
  let slot = lanes.length
  while (!clear(slot)) slot++
  return slot
}

export function layoutGraph<T extends GraphCommit>(commits: T[], state: GraphState = { lanes: [], nextColor: 0 }): GraphRow<T>[] {
  const { previous } = state
  const color = () => {
    const value = state.nextColor
    state.nextColor = value === COLOR_COUNT ? 1 : value + 1
    return value
  }
  const listed = previous ? new Map(commits.map((commit) => [commit.hash, commit])) : null
  // Whether a new line in a slot, from below row `from` to `parent` and on down its new first parents to a commit already
  // laid out, misses every commit and line the previous layout drew in that slot on the rows between, so those commits can
  // keep their lanes.
  const clear = (from: number, parent: string | undefined) => (slot: number) => {
    if (!previous || !parent) return true
    let target: string | undefined = parent
    while (target && !previous.has(target)) target = listed!.get(target)?.parents[0]
    for (let row = from + 1; row < commits.length && commits[row].hash !== target; row++) {
      const was = previous.get(commits[row].hash)
      if (was && (was.lane === slot || [was.input[slot], was.output[slot]].some((line) => line && line.hash !== target))) return false
    }
    return true
  }

  return commits.map((commit, row) => {
    const input = state.lanes
    const lanes = input.slice()
    const was = previous?.get(commit.hash)
    let lane = lanes.findIndex((slot) => slot?.hash === commit.hash)
    // A new commit continues its parent's old line and color where it can, so a branch that grew keeps its look.
    const parentWas = was ? undefined : previous?.get(commit.parents[0] ?? '')
    const commitColor = was?.color ?? (lane !== -1 ? lanes[lane]!.color : parentWas?.color ?? color())
    // A commit already laid out keeps its lane while the slot is free here. A new one stays on its incoming line while that
    // slot is clear of old lanes further down. Otherwise it takes a clear slot, and a line coming in elsewhere bends into it.
    const keep = clear(row, commit.parents[0])
    if (was && (!lanes[was.lane] || lanes[was.lane]!.hash === commit.hash)) lane = was.lane
    else if (lane === -1 || (!was && !keep(lane))) {
      lane = parentWas && !lanes[parentWas.lane] && keep(parentWas.lane) ? parentWas.lane : freeSlot(lanes, 0, keep)
    }
    for (let index = 0; index < lanes.length; index++) if (lanes[index]?.hash === commit.hash) lanes[index] = null
    commit.parents.forEach((parent, index) => {
      const at = lanes.findIndex((slot) => slot?.hash === parent)
      if (index === 0) {
        // The first parent stays in the commit's lane. A lane already waiting for it further right moves over into this
        // one, so a line never drifts right; one further left takes this line in instead, and this lane frees.
        if (at === -1 || at > lane) {
          put(lanes, lane, { hash: parent, color: commitColor })
          if (at !== -1) lanes[at] = null
        }
      } else if (at === -1) {
        const line = was ? was.output.findIndex((slot) => slot?.hash === parent) : -1
        const slot = line !== -1 && !lanes[line] ? line : freeSlot(lanes, lane, clear(row, parent))
        put(lanes, slot, { hash: parent, color: line !== -1 ? was!.output[line]!.color : color() })
      }
    })
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop()
    state.lanes = lanes
    return { commit, lane, color: commitColor, input, output: lanes, laneCount: Math.max(input.length, lanes.length, lane + 1) }
  })
}

// Commits reachable from HEAD among the loaded history can be reset to.
export function rollbackTargets(commits: GraphCommit[], head: string): Set<string> {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]))
  const ancestors = new Set<string>()
  const pending = [head]
  while (pending.length) {
    const hash = pending.pop()
    if (!hash || ancestors.has(hash)) continue
    ancestors.add(hash)
    pending.push(...(byHash.get(hash)?.parents ?? []))
  }
  ancestors.delete(head)
  return ancestors
}
