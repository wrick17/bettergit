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
}

// A fresh layout. With the checked-out commit in the list, slot 0 waits for it, so HEAD's first-parent chain runs down
// the left edge however many newer branch tips sit above it.
export function startGraph(commits: GraphCommit[], head: string | null): GraphState {
  return head && commits.some((commit) => commit.hash === head) ? { lanes: [{ hash: head, color: 0 }], nextColor: 1 } : { lanes: [], nextColor: 0 }
}

// The free slot nearest to `from`, the right side first on a tie, or a new slot past the end.
function freeSlot(lanes: (Lane | null)[], from: number) {
  for (let distance = 0; distance < lanes.length; distance++) {
    if (from + distance < lanes.length && !lanes[from + distance]) return from + distance
    if (distance > 0 && from - distance >= 0 && from - distance < lanes.length && !lanes[from - distance]) return from - distance
  }
  return lanes.length
}

export function layoutGraph<T extends GraphCommit>(commits: T[], state: GraphState = { lanes: [], nextColor: 0 }): GraphRow<T>[] {
  const color = () => {
    const value = state.nextColor
    state.nextColor = value === COLOR_COUNT ? 1 : value + 1
    return value
  }

  return commits.map((commit) => {
    const input = state.lanes
    const lanes = input.slice()
    let lane = lanes.findIndex((slot) => slot?.hash === commit.hash)
    const commitColor = lane === -1 ? color() : lanes[lane]!.color
    if (lane === -1) lane = freeSlot(lanes, 0)
    for (let index = 0; index < lanes.length; index++) if (lanes[index]?.hash === commit.hash) lanes[index] = null
    commit.parents.forEach((parent, index) => {
      const at = lanes.findIndex((slot) => slot?.hash === parent)
      if (index === 0) {
        // The first parent stays in the commit's lane. A lane already waiting for it further right moves over into this
        // one, so a line never drifts right; one further left takes this line in instead, and this lane frees.
        if (at === -1 || at > lane) {
          lanes[lane] = { hash: parent, color: commitColor }
          if (at !== -1) lanes[at] = null
        }
      } else if (at === -1) {
        lanes[freeSlot(lanes, lane)] = { hash: parent, color: color() }
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
