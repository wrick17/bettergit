import { describe, expect, test } from 'bun:test'
import { layoutGraph, rollbackTargets, startGraph, type GraphRow } from '../src/main/git/graph'

// Each commit sits on exactly one lane inside the row's width, and a line passes there: the line coming down into the
// commit, or one leaving it for a parent.
function expectMarkersOnLines(rows: GraphRow[]) {
  for (const { commit, lane, input, output, laneCount } of rows) {
    expect(lane).toBeLessThan(laneCount)
    expect(input.flatMap((slot, index) => (slot?.hash === commit.hash ? [index] : []))).toEqual(input[lane]?.hash === commit.hash ? [lane] : [])
    expect(input[lane]?.hash === commit.hash || commit.parents.some((parent) => output.some((slot) => slot?.hash === parent))).toBe(true)
  }
}

describe('layoutGraph', () => {
  test('a merged branch joins its parent lane at the fork instead of holding a lane to the parent commit', () => {
    const rows = layoutGraph([
      { hash: 'a', parents: ['b', 'c'] },
      { hash: 'b', parents: ['d'] },
      { hash: 'c', parents: ['d'] },
      { hash: 'd', parents: [] },
    ])
    expect(rows.map(({ lane, color, input, output }) => ({ lane, color, input, output }))).toEqual([
      { lane: 0, color: 0, input: [], output: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }] },
      { lane: 0, color: 0, input: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }] },
      { lane: 1, color: 1, input: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }] },
      { lane: 0, color: 0, input: [{ hash: 'd', color: 0 }], output: [] },
    ])
  })

  test('branches merged one after another share a few lanes, and a freed lane is reused', () => {
    // Eight feature branches forked from one base and merged into main in turn, listed newest first.
    const commits = [{ hash: 'm8', parents: ['m7', 'f8'] }]
    for (let i = 8; i >= 1; i--) {
      commits.push({ hash: `f${i}`, parents: ['base'] })
      if (i > 1) commits.push({ hash: `m${i - 1}`, parents: [i > 2 ? `m${i - 2}` : 'base', `f${i - 1}`] })
    }
    commits.push({ hash: 'base', parents: [] })
    const rows = layoutGraph(commits)
    expectMarkersOnLines(rows)
    expect(Math.max(...rows.map((row) => row.laneCount))).toBe(3)
    expect(rows.filter((row) => row.commit.hash.startsWith('m')).every((row) => row.lane === 0)).toBe(true)
    // The first branch opens the lane to the base. Every later one reuses the slot the one before it freed.
    expect(rows.filter((row) => /^f[2-7]$/.test(row.commit.hash)).map((row) => row.lane)).toEqual([2, 2, 2, 2, 2, 2])
  })

  test('HEAD keeps the first lane below newer branch tips', () => {
    const commits = [
      { hash: 'remote', parents: ['head'] },
      { hash: 'head', parents: ['old'] },
      { hash: 'old', parents: [] },
    ]
    const rows = layoutGraph(commits, startGraph(commits, 'head'))
    expectMarkersOnLines(rows)
    expect(rows.map((row) => row.lane)).toEqual([1, 0, 0])
    expect(rows[0].output).toEqual([{ hash: 'head', color: 0 }])
  })

  test('ending one root keeps the lane and color of an unrelated history', () => {
    const rows = layoutGraph([
      { hash: 'a', parents: ['root-a'] },
      { hash: 'b', parents: ['root-b'] },
      { hash: 'root-a', parents: [] },
      { hash: 'root-b', parents: [] },
    ])
    expect(rows[2].output).toEqual([null, { hash: 'root-b', color: rows[1].color }])
    expect(rows[3].input).toEqual(rows[2].output)
    expect(rows[2].color).toBe(rows[0].color)
    expect(rows[3].color).toBe(rows[1].color)
    expect(rows[3].output).toEqual([])
  })
})

test('laying out an appended page from the saved state matches one layout of the whole list', () => {
  const commits = [
    { hash: 'a', parents: ['b', 'x'] },
    { hash: 'x', parents: ['c'] },
    { hash: 'b', parents: ['c'] },
    { hash: 'c', parents: ['d', 'y'] },
    { hash: 'y', parents: ['d'] },
    { hash: 'd', parents: [] },
  ]
  const state = { lanes: [], nextColor: 0 }
  expect([...layoutGraph(commits.slice(0, 3), state), ...layoutGraph(commits.slice(3), state)]).toEqual(layoutGraph(commits))
})

describe('rollbackTargets', () => {
  test('only loaded ancestors of HEAD can be reset to', () => {
    const targets = rollbackTargets([
      { hash: 'head', parents: ['parent'] },
      { hash: 'parent', parents: ['root'] },
      { hash: 'root', parents: [] },
      { hash: 'other', parents: [] },
    ], 'head')
    expect([...targets].sort()).toEqual(['parent', 'root'])
  })
})
