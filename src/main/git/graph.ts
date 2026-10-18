// Lane layout for the commit graph. Ported from better-source-control/graph.js.

export interface GraphCommit {
  hash: string
  parents: string[]
}

export interface Lane {
  hash: string
  color: number
}

export interface GraphRow<T extends GraphCommit = GraphCommit> {
  commit: T
  lane: number
  color: number
  input: Lane[]
  output: Lane[]
  laneCount: number
}

const COLOR_COUNT = 5

// Where a layout left off: the lanes below its last row and the next color. Passing the state from one call to the next
// lays out an appended page without laying out the rows before it again.
export interface GraphState {
  lanes: Lane[]
  nextColor: number
}

export function layoutGraph<T extends GraphCommit>(commits: T[], state: GraphState = { lanes: [], nextColor: 0 }): GraphRow<T>[] {
  const color = () => {
    const value = state.nextColor
    state.nextColor = value === COLOR_COUNT ? 1 : value + 1
    return value
  }

  return commits.map((commit) => {
    const input = state.lanes.map((node) => ({ ...node }))
    const output: Lane[] = []
    const parents = commit.parents
    let firstParentAdded = false
    for (const node of input) {
      if (node.hash === commit.hash) {
        if (parents.length && !firstParentAdded) {
          output.push({ hash: parents[0], color: node.color })
          firstParentAdded = true
        }
      } else {
        output.push({ ...node })
      }
    }
    for (let index = firstParentAdded ? 1 : 0; index < parents.length; index++) {
      output.push({ hash: parents[index], color: color() })
    }
    state.lanes = output
    const inputIndex = input.findIndex((node) => node.hash === commit.hash)
    const lane = inputIndex === -1 ? input.length : inputIndex
    const commitColor = input[lane]?.color ?? output[lane]?.color ?? color()
    return {
      commit,
      lane,
      color: commitColor,
      input,
      output,
      laneCount: Math.max(input.length, output.length, 1),
    }
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
