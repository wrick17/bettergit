import { describe, expect, test } from 'bun:test'
import {
  applyChoices, conflictBlocks, fromMergeOutput, matchBases, matchBasesAcrossRuns, parseConflictReset, parseConflicts, parseConflictSave, splitTokens, toMergeInput,
  withStageEnds, type ApplyResult, type Choice, type Combine, type ConflictSave, type Part, type StageBlock,
} from '../src/shared/conflict'

// The parts of a text that is known to parse. A failing parse fails the test with its message.
function partsOf(text: string, size?: number): Part[] {
  const parsed = parseConflicts(text, size)
  if (!parsed.ok) throw new Error(parsed.failure.message)
  return parsed.parts
}

// The text of a result that must apply. A refused result fails the test with its reason.
function textOf(result: ApplyResult): string {
  if (!result.ok) throw new Error(result.reason)
  return result.text
}

// The same strings on every run: a 32-bit linear congruential generator over characters that stress the framing.
function pseudoRandomText(seed: number, count: number): string[] {
  const alphabet = ['a', 'Z', '_', '9', 'é', '́', '😀', ' ', '\t', '\r', '\n', ' ', ' ', '　', '﻿', '\v', '\f', '-', '=', '<', '>', '|']
  let state = seed
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  return Array.from({ length: count }, () => {
    const length = next() % 24
    return Array.from({ length }, () => alphabet[next() % alphabet.length]).join('')
  })
}

const ready = (text: string): Combine => ({ state: 'ready', text })
const unavailable: Combine = { state: 'unavailable', reason: 'not used here' }

const samples = {
  lf: 'top\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> topic\nend\n',
  crlf: 'top\r\n<<<<<<< HEAD\r\nA\r\n=======\r\nB\r\n>>>>>>> topic\r\nend\r\n',
  unicode: 'café 😀\n<<<<<<< HEAD\nnaïve = "é"\n=======\n\tx = 😀\n\n>>>>>>> topic\n\n',
  diff3: 'a\n<<<<<<< HEAD\nA\n||||||| base\nO\n=======\nB\n>>>>>>> topic\nz\n',
  noFinalNewline: 'x\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> topic',
  bom: '﻿<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> topic\n',
  twoBlocks: 'a\n<<<<<<< one\nA1\n=======\nB1\n>>>>>>> two\nb\n<<<<<<< one\nA2\n=======\nB2\n>>>>>>> two\n',
}

describe('parseConflicts', () => {
  for (const [name, text] of Object.entries(samples)) {
    test(`resolving nothing returns the input exactly: ${name}`, () => {
      const parts = partsOf(text)
      expect(textOf(applyChoices(parts, [], []))).toBe(text)
    })
  }

  test('current, incoming, and both keep CRLF lines and join the sides in order', () => {
    const parts = partsOf(samples.crlf)
    expect(textOf(applyChoices(parts, ['current'], []))).toBe('top\r\nA\r\nend\r\n')
    expect(textOf(applyChoices(parts, ['incoming'], []))).toBe('top\r\nB\r\nend\r\n')
    expect(textOf(applyChoices(parts, ['both'], []))).toBe('top\r\nA\r\nB\r\nend\r\n')
  })

  test('labels come from the marker lines, not from the terminator', () => {
    const block = conflictBlocks(partsOf(samples.crlf))[0]
    expect(block).toMatchObject({ currentLabel: 'HEAD', incomingLabel: 'topic' })
    // A closing marker that ends the file with a bare carriage return must not leave the CR in its label.
    const bare = conflictBlocks(partsOf('x\n<<<<<<< a\nA\n=======\nB\n>>>>>>> b\r'))[0]
    expect(bare.incomingLabel).toBe('b')
  })

  test('an empty side removes its lines and keeps the surrounding text', () => {
    const parts = partsOf('x\n<<<<<<< a\n=======\nB\n>>>>>>> b\ny\n')
    expect(applyChoices(parts, ['current'], [])).toMatchObject({ ok: true, text: 'x\ny\n' })
  })

  test('a file with no final newline still has none after a resolution', () => {
    expect(applyChoices(partsOf(samples.noFinalNewline), ['incoming'], [])).toMatchObject({ ok: true, text: 'x\nB' })
    const crlf = partsOf('x\r\n<<<<<<< a\r\nA\r\n=======\r\nB\r\n>>>>>>> b')
    expect(applyChoices(crlf, ['current'], [])).toMatchObject({ ok: true, text: 'x\r\nA' })
  })

  // Git writes these exact markers for a conflict at the end of the file whether or not either side ends with a newline.
  test('a side whose stage ends without a newline is chosen without the newline Git added', () => {
    const markers = 'prefix\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> incoming\n'
    for (const ours of ['prefix\ncurrent', 'prefix\ncurrent\n']) {
      for (const theirs of ['prefix\nincoming', 'prefix\nincoming\n']) {
        const parts = withStageEnds(partsOf(markers), ours, theirs)
        expect(textOf(applyChoices(parts, ['current'], []))).toBe(ours)
        expect(textOf(applyChoices(parts, ['incoming'], []))).toBe(theirs)
        expect(textOf(applyChoices(parts, ['both'], []))).toBe(`prefix\ncurrent\n${theirs.slice('prefix\n'.length)}`)
        const bothEnd = ours.endsWith('\n') || theirs.endsWith('\n') ? '\n' : ''
        expect(textOf(applyChoices(parts, ['combine'], [ready('merged\n')]))).toBe(`prefix\nmerged${bothEnd}`)
        expect(textOf(applyChoices(parts, [], []))).toBe(markers)
      }
    }
    const crlf = withStageEnds(partsOf('p\r\n<<<<<<< a\r\nA\r\n=======\r\nB\r\n>>>>>>> b\r\n'), 'p\r\nA', 'p\r\nB\r\n')
    expect(textOf(applyChoices(crlf, ['current'], []))).toBe('p\r\nA')
    expect(textOf(applyChoices(crlf, ['incoming'], []))).toBe('p\r\nB\r\n')
  })

  test("a side keeps its newline unless it ends with its stage's last line at the end of the file", () => {
    const edited = withStageEnds(partsOf('p\n<<<<<<< a\nprecurrent\n=======\nincoming\n>>>>>>> b\n'), 'p\ncurrent', 'p\nincoming')
    expect(textOf(applyChoices(edited, ['current'], []))).toBe('p\nprecurrent\n')
    expect(textOf(applyChoices(edited, ['incoming'], []))).toBe('p\nincoming')
    const suffix = partsOf('p\n<<<<<<< a\ncurrent\n=======\nincoming\n>>>>>>> b\nend')
    expect(withStageEnds(suffix, 'p\ncurrent\nend', 'p\nincoming\nend')).toBe(suffix)
  })

  test('an unresolved block keeps its markers byte for byte and is counted', () => {
    const parts = partsOf(samples.diff3)
    const result = applyChoices(parts, [null], [])
    expect(result).toMatchObject({ ok: true, unresolved: 1 })
    expect(result.ok && result.text).toBe(samples.diff3)
  })

  test('each block takes its own choice, and an unresolved block keeps its markers', () => {
    const parts = partsOf(samples.twoBlocks)
    const choices: Choice[] = ['both', null]
    const result = applyChoices(parts, choices, [])
    expect(result).toMatchObject({ ok: true, unresolved: 1 })
    expect(result.ok && result.text).toBe('a\nA1\nB1\nb\n<<<<<<< one\nA2\n=======\nB2\n>>>>>>> two\n')
  })

  test('combine uses ready text, and is refused when the block is not ready', () => {
    const parts = partsOf(samples.lf)
    expect(applyChoices(parts, ['combine'], [ready('M\n')])).toMatchObject({ ok: true, text: 'top\nM\nend\n' })
    expect(applyChoices(parts, ['combine'], [{ state: 'overlap' }])).toMatchObject({ ok: false, index: 0 })
    expect(applyChoices(parts, ['combine'], [unavailable])).toMatchObject({ ok: false, index: 0 })
  })

  test('a byte order mark stays in front of a leading conflict', () => {
    const parts = partsOf(samples.bom)
    expect(textOf(applyChoices(parts, ['current'], []))).toBe('﻿A\n')
    expect(textOf(applyChoices(parts, [], []))).toBe(samples.bom)
  })

  test('NUL bytes are reported as binary', () => {
    expect(parseConflicts('a\0b')).toMatchObject({ ok: false, failure: { code: 'binary' } })
  })

  test('a conflict that never ends reports the line where it starts', () => {
    const parsed = parseConflicts('a\n<<<<<<< x\nA\n')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.failure.message).toContain('Line 2')
  })

  test('nested and out-of-order markers are malformed, and say which line', () => {
    const nested = parseConflicts('<<<<<<< a\n<<<<<<< b\n')
    expect(!nested.ok && nested.failure.message).toContain('Line 2 starts a conflict inside another conflict')
    const out = parseConflicts('<<<<<<< a\nA\n>>>>>>> b\n')
    expect(!out.ok && out.failure.message).toContain('Line 3 has a conflict marker out of order')
  })

  test('a separator outside a conflict is ordinary text', () => {
    const text = 'Title\r\n=======\r\n> quoted café 😀\r\nAnother title\r\n========\r\n'
    expect(conflictBlocks(partsOf(text))).toEqual([])
    expect(textOf(applyChoices(partsOf(text), [], []))).toBe(text)
  })

  test('markers use the configured length, and unsupported lengths are refused', () => {
    const text = '<<<<<<<< a\nX\n========\nY\n>>>>>>>> b\n'
    expect(conflictBlocks(partsOf(text, 8))).toHaveLength(1)
    expect(parseConflicts(text)).toMatchObject({ ok: false, failure: { code: 'malformed' } })
    expect(parseConflicts('<<<<<<< a\nX\n========\nY\n>>>>>>>> b\n')).toMatchObject({ ok: false, failure: { code: 'malformed' } })
  })

  test('orphan closing and base markers cannot make an incomplete conflict appear clean', () => {
    for (const text of [
      samples.lf.replace('<<<<<<< HEAD\n', ''),
      samples.diff3.replace('<<<<<<< HEAD\n', ''),
      '﻿>>>>>>> topic\r\n',
      '|||||||| base\nold\n========\nnew\n>>>>>>>> topic\n',
    ]) {
      expect(parseConflicts(text)).toMatchObject({ ok: false, failure: { code: 'malformed' } })
    }
  })

  test('complete short marker structures are refused for different positive widths', () => {
    for (const width of [1, 3, 6]) {
      const open = '<'.repeat(width)
      const split = '='.repeat(width)
      const close = '>'.repeat(width)
      const text = `﻿${open} ours\r\n${close} literal before separator\r\n${split}\r\ncafé 😀\r\n${close} theirs`
      expect(parseConflicts(text)).toMatchObject({ ok: false, failure: { code: 'malformed', message: expect.stringContaining('unsupported') } })
    }
    expect(conflictBlocks(partsOf('<<< ours\nA\n===\nB\n>>> theirs\n', 3))).toHaveLength(1)
  })

  test('literal body markers cannot erase a short opening or separator already observed', () => {
    for (const width of [1, 6]) {
      const open = '<'.repeat(width)
      const base = '|'.repeat(width)
      const split = '='.repeat(width)
      const close = '>'.repeat(width)
      const template = `﻿${open} ours\r\nCURRENT\r\n${base} ancestor\r\nBASE\r\n${split}\r\nINCOMING\r\n${close} theirs`
      for (const marker of [`${open} literal`, `${base} literal`, split, `${close} literal`]) {
        for (const phase of ['CURRENT', 'BASE', 'INCOMING']) {
          expect(parseConflicts(template.replace(phase, marker))).toMatchObject({ ok: false, failure: { code: 'malformed' } })
        }
      }
    }
  })

  test('short separators, blockquotes, code, and mismatched boundaries remain ordinary text', () => {
    const text = 'Title\n=\n> quoted text\nSecond title\n======\n>> nested quote\nconst shifted = value << 2\n<< expression\n===\n>> result\n< literal\n= not a separator\n> quote\n'
    expect(conflictBlocks(partsOf(text))).toEqual([])
    expect(textOf(applyChoices(partsOf(text), [], []))).toBe(text)
  })
})

describe('tokens and merge input', () => {
  const texts = [
    'héllo wörld\r\n\r\n\tx = 😀;  \n',
    'é tail',
    'no final newline',
    '',
    '\n\n\n',
    'a\r\nb',
  ]

  for (const text of texts) {
    test(`tokens join back to ${JSON.stringify(text)}`, () => {
      expect(splitTokens(text).join('')).toBe(text)
    })
    test(`merge input round trips ${JSON.stringify(text)}`, () => {
      expect(fromMergeOutput(toMergeInput(text))).toBe(text)
    })
  }

  // Every whitespace character JavaScript recognises, plus the byte order mark, must survive both framings.
  const whitespace = ['\t', '\v', '\f', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿', '\r', '\n']
  for (const character of whitespace) {
    test(`whitespace ${JSON.stringify(character)} round trips between words`, () => {
      const text = `a${character}b`
      expect(splitTokens(text).join('')).toBe(text)
      expect(fromMergeOutput(toMergeInput(text))).toBe(text)
    })
  }

  test('pseudo-random text built from framing characters round trips, with a fixed seed', () => {
    for (const text of pseudoRandomText(7, 300)) {
      expect(fromMergeOutput(toMergeInput(text))).toBe(text)
    }
  })

  test('a newline is its own token and a word stays whole', () => {
    expect(splitTokens('ab cd\n')).toEqual(['ab', ' ', 'cd', '\n'])
  })

  test('each token is one hex record of its UTF-8 bytes', () => {
    expect(toMergeInput('a\n')).toBe('61\n0a\n')
    expect(toMergeInput('﻿')).toBe('efbbbf\n')
  })

  test('merge output that is not hex records, or not UTF-8, is refused', () => {
    expect(() => fromMergeOutput('zz\n')).toThrow()
    expect(() => fromMergeOutput('61')).toThrow()
    expect(() => fromMergeOutput('ff\n')).toThrow()
  })

  test('a lone surrogate cannot be encoded', () => {
    expect(() => toMergeInput('a\uD800b')).toThrow()
  })
})

describe('matchBases', () => {
  const blocksOf = (text: string) => conflictBlocks(partsOf(text))
  const stage = (current: string, base: string | null, incoming: string): StageBlock => ({ current, base, incoming })

  test('one exact match takes its base', () => {
    const blocks = blocksOf('<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n')
    expect(matchBases(blocks, [stage('A\n', 'O\n', 'B\n')])).toEqual([{ state: 'matched', base: 'O\n' }])
  })

  test('identical conflicts with different bases are not guessed', () => {
    const block = '<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n'
    const blocks = blocksOf(block + block)
    const stages = [stage('A\n', 'O1\n', 'B\n'), stage('A\n', 'O2\n', 'B\n')]
    expect(matchBases(blocks, stages)).toEqual([
      { state: 'unavailable', reason: 'ambiguous' },
      { state: 'unavailable', reason: 'ambiguous' },
    ])
  })

  test('identical conflicts that share one base are matched, one stage each', () => {
    const block = '<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n'
    const stages = [stage('A\n', 'O\n', 'B\n'), stage('A\n', 'O\n', 'B\n')]
    expect(matchBases(blocksOf(block + block), stages)).toEqual([
      { state: 'matched', base: 'O\n' },
      { state: 'matched', base: 'O\n' },
    ])
  })

  test('a duplicate that the stages do not hold is ambiguous, not matched once', () => {
    const block = '<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n'
    expect(matchBases(blocksOf(block + block), [stage('A\n', 'O\n', 'B\n')])[0]).toEqual({ state: 'unavailable', reason: 'ambiguous' })
  })

  test('a block edited after the merge has no stage match, so its base is a boundary refusal', () => {
    const blocks = blocksOf('<<<<<<< a\nA changed\n=======\nB\n>>>>>>> b\n')
    expect(matchBases(blocks, [stage('A\n', 'O\n', 'B\n')])).toEqual([{ state: 'unavailable', reason: 'boundary' }])
  })

  // Regression: normal markers keep only the differing first line. A diff3 stage block also keeps the shared
  // line and the base line 'old'. Exact sides cannot match across the two region edges, so no base is guessed.
  test('regression: first-line markers do not match the wider diff3 region of the same conflict', () => {
    const base = 'red fox jumps\nold\nend\n'
    const current = 'blue fox jumps\nshared\nend\n'
    const incoming = 'red fox sleeps\nshared\nend\n'
    const blocks = blocksOf('<<<<<<< HEAD\nblue fox jumps\n=======\nred fox sleeps\n>>>>>>> topic\n')
    expect(blocks[0]).toMatchObject({ current: 'blue fox jumps\n', incoming: 'red fox sleeps\n' })
    expect(matchBases(blocks, [stage(current, base, incoming)])).toEqual([{ state: 'unavailable', reason: 'boundary' }])
  })

  test('regression: a wider stage region is never used for a block with different sides', () => {
    const blocks = blocksOf('<<<<<<< HEAD\nblue fox jumps\n=======\nred fox sleeps\n>>>>>>> topic\n')
    const wider = stage('blue fox jumps\nshared\n', 'red fox jumps\nold\n', 'red fox sleeps\nshared\n')
    expect(matchBases(blocks, [wider, wider])).toEqual([{ state: 'unavailable', reason: 'boundary' }])
  })

  test('a missing ancestor is reported as no ancestor', () => {
    const blocks = blocksOf('<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n')
    expect(matchBases(blocks, [stage('A\n', null, 'B\n')])).toEqual([{ state: 'unavailable', reason: 'no-ancestor' }])
  })
})

describe('matchBasesAcrossRuns and the save contract', () => {
  const block = (text: string) => conflictBlocks(partsOf(text))
  const stage = (current: string, base: string | null, incoming: string): StageBlock => ({ current, base, incoming })
  const conflict = '<<<<<<< a\nA\n=======\nB\n>>>>>>> b\n'

  test('a block that one run matches and the other run does not takes that base', () => {
    const runs = [[stage('A\n', 'O\n', 'B\n')], [stage('A-wider\n', 'O2\n', 'B\n')]]
    expect(matchBasesAcrossRuns(block(conflict), runs)).toEqual([{ state: 'matched', base: 'O\n' }])
  })

  test('runs that match with different bases are ambiguous, never a guess', () => {
    const runs = [[stage('A\n', 'O1\n', 'B\n')], [stage('A\n', 'O2\n', 'B\n')]]
    expect(matchBasesAcrossRuns(block(conflict), runs)).toEqual([{ state: 'unavailable', reason: 'ambiguous' }])
  })

  test('no run matching gives a boundary, and only ancestor-less runs give no ancestor', () => {
    expect(matchBasesAcrossRuns(block(conflict), [[stage('X\n', 'O\n', 'Y\n')]])).toEqual([{ state: 'unavailable', reason: 'boundary' }])
    expect(matchBasesAcrossRuns(block(conflict), [[stage('A\n', null, 'B\n')]])).toEqual([{ state: 'unavailable', reason: 'no-ancestor' }])
  })

  const digest = 'a'.repeat(64)
  const request: ConflictSave = { fingerprint: { working: digest, stages: digest }, choices: ['current', null] }

  test('a save request that matches the contract passes through unchanged', () => {
    expect(parseConflictSave(request)).toEqual(request)
  })

  test('a save request with extra fields, a bad digest, or an unknown choice is refused', () => {
    expect(() => parseConflictSave({ ...request, text: 'file text' })).toThrow('unexpected fields')
    expect(() => parseConflictSave({ ...request, fingerprint: { working: 'short', stages: digest } })).toThrow('working digest')
    expect(() => parseConflictSave({ ...request, choices: ['yours'] })).toThrow('not one of the resolutions')
    expect(() => parseConflictSave({ ...request, choices: 'current' })).toThrow('invalid list')
  })

  test('a reset request is the fingerprint alone, with no text, stages, or destination', () => {
    const reset = { fingerprint: request.fingerprint }
    expect(parseConflictReset(reset)).toEqual(reset)
    for (const extra of [{ text: 'file text' }, { stages: ['abc'] }, { path: '/tmp/elsewhere' }, { choices: [] }]) {
      expect(() => parseConflictReset({ ...reset, ...extra })).toThrow('The reset request has unexpected fields.')
    }
    expect(() => parseConflictReset({ fingerprint: { ...reset.fingerprint, sha: digest } })).toThrow('unexpected fields')
    expect(() => parseConflictReset({ fingerprint: { working: digest, stages: 'A'.repeat(64) } })).toThrow('stage digest')
    expect(() => parseConflictReset(null)).toThrow('not an object')
  })
})
