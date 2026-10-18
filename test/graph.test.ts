import { describe, expect, test } from 'bun:test'
import { layoutGraph, rollbackTargets } from '../src/main/git/graph'

describe('layoutGraph', () => {
  test('keeps colored merge lanes separate until their parent commit', () => {
    const rows = layoutGraph([
      { hash: 'a', parents: ['b', 'c'] },
      { hash: 'b', parents: ['d'] },
      { hash: 'c', parents: ['d'] },
      { hash: 'd', parents: [] },
    ])
    expect(rows.map(({ lane, color, input, output }) => ({ lane, color, input, output }))).toEqual([
      { lane: 0, color: 0, input: [], output: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }] },
      { lane: 0, color: 0, input: [{ hash: 'b', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }] },
      { lane: 1, color: 1, input: [{ hash: 'd', color: 0 }, { hash: 'c', color: 1 }], output: [{ hash: 'd', color: 0 }, { hash: 'd', color: 1 }] },
      { lane: 0, color: 0, input: [{ hash: 'd', color: 0 }, { hash: 'd', color: 1 }], output: [] },
    ])
  })

  test('ending one root keeps the lane and color of an unrelated history', () => {
    const rows = layoutGraph([
      { hash: 'a', parents: ['root-a'] },
      { hash: 'b', parents: ['root-b'] },
      { hash: 'root-a', parents: [] },
      { hash: 'root-b', parents: [] },
    ])
    expect(rows[2].output).toEqual([{ hash: 'root-b', color: rows[1].color }])
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
