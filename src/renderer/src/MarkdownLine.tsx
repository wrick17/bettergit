import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, RootContent, Definition, FootnoteDefinition, Code } from 'mdast'
import type { DiffLine } from '../../main/git/diff'
import { emphasize, type Span } from './intraline'
import { highlightLines, languageFor, type Segment } from './highlight'
import './markdown.css'

export const isMarkdownPath = (path: string) => /\.(md|markdown)$/i.test(path)
export interface MarkdownSource { index: number; line: DiffLine; start: number; end: number }
export interface MarkdownSide {
  source: string
  entries: MarkdownSource[]
  nodes: RootContent[]
  definitions: Map<string, Definition>
  footnotes: Map<string, FootnoteDefinition>
  changes: Map<number, Span[]>
  moved: Set<number>
  // Length of a synthetic table header put before the first row. It has no source rows and is never rendered.
  prefix: number
}
export interface MarkdownGroup { start: number; end: number; old: RootContent[]; new: RootContent[]; rows: Array<[number | null, number | null]>; unchanged: boolean }
export interface MarkdownPlan { old: MarkdownSide; new: MarkdownSide; groups: MarkdownGroup[] }

const TABLE_ROW = /^ {0,3}\|/
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const isDelimiter = (text: string) => text.includes('|') && TABLE_DELIMITER.test(text)
const cellCount = (text: string) => text.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).length

// A hunk often starts inside a table, below its header. Without a header and delimiter GFM reads the rows as a
// paragraph of pipes, so an empty header (and delimiter, when that was cut too) is put back in front of them.
// A lone pipe-led prose line (`| note`, `| --- |`) stays a paragraph: rows need two cells, or a delimiter a matching row.
// shortcut: only pipe-led rows are recognised and one-column rows stay raw; widen context to show the header.
function tablePrefix(texts: string[]): string {
  const [first, second] = texts
  if (first === undefined) return ''
  const cells = cellCount(first)
  if (isDelimiter(first)) {
    const matched = cells >= 2 || (second !== undefined && TABLE_ROW.test(second) && cellCount(second) === cells)
    return matched ? `|${' |'.repeat(cells)}\n` : ''
  }
  if (!TABLE_ROW.test(first) || cells < 2 || (second !== undefined && isDelimiter(second))) return ''
  return `|${' |'.repeat(cells)}\n|${' --- |'.repeat(cells)}\n`
}

function parseSide(lines: DiffLine[], excluded: 'add' | 'del', changes: Map<number, Span[]>): MarkdownSide {
  const entries: MarkdownSource[] = []
  const kept = lines.filter(line => line.type !== excluded && line.type !== 'note')
  let source = tablePrefix(kept.slice(0, 2).map(line => line.text))
  const prefix = source.length
  lines.forEach((line, index) => {
    if (line.type === excluded || line.type === 'note') return
    if (entries.length) source += '\n'
    const start = source.length
    source += line.text
    entries.push({ line, index, start, end: source.length })
  })
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const definitions = new Map<string, Definition>()
  const footnotes = new Map<string, FootnoteDefinition>()
  const collect = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    if (node.type === 'footnoteDefinition' && !footnotes.has(node.identifier)) footnotes.set(node.identifier, node)
    if ('children' in node) node.children.forEach(collect)
  }
  collect(tree)
  return { source, entries, nodes: tree.children, definitions, footnotes, changes, moved: new Set(), prefix }
}

function sourceRange(node: Nodes, side: MarkdownSide): [number, number] | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined || end < start) return
  // Markdown also counts bare CR as a newline. Git rows are LF-delimited, so use UTF-16 offsets and an exclusive end.
  const entryAt = (offset: number) => {
    let low = 0
    let high = side.entries.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (side.entries[middle].start <= offset) low = middle + 1
      else high = middle
    }
    // An offset inside the synthetic table prefix belongs to the first real row.
    return side.entries[Math.max(low - 1, 0)]
  }
  const first = entryAt(start)
  const last = entryAt(Math.max(start, end - 1))
  return first && last ? [first.index, last.index] : undefined
}

function signature(nodes: Nodes[], side: MarkdownSide): string {
  return JSON.stringify(nodes, (key, value) => {
    if (key === 'position' || key === 'data') return undefined
    if (value?.type === 'linkReference' || value?.type === 'imageReference') {
      const definition = side.definitions.get(value.identifier)
      return { ...value, resolved: definition ? [definition.url, definition.title] : null }
    }
    return value
  })
}

// Every interval is closed over both AST blocks and replacement pairs. Neither side is reparsed or cut at a diff row.
export function markdownHunk(lines: DiffLine[], changes = new Map<number, Span[]>(), pairs: Array<[number | null, number | null]> = [], moved = new Set<number>()): MarkdownPlan {
  const old = parseSide(lines, 'add', changes)
  const next = parseSide(lines, 'del', changes)
  old.moved = next.moved = moved
  const ranges: Array<[number, number]> = lines.map((_, index) => [index, index])
  for (const side of [old, next]) for (const node of side.nodes) {
    const range = sourceRange(node, side)
    if (range) ranges.push(range)
  }
  for (const [left, right] of pairs) if (left !== null && right !== null) ranges.push([Math.min(left, right), Math.max(left, right)])
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push([...range])
  }
  const groups: MarkdownGroup[] = merged.map(([start, end]) => ({ start, end, old: [], new: [], rows: [], unchanged: false }))
  for (const [name, side] of [['old', old], ['new', next]] as const) {
    let at = 0
    for (const node of side.nodes) {
      const range = sourceRange(node, side)
      if (!range) continue
      while (at < groups.length && groups[at].end < range[0]) at++
      groups[at]?.[name].push(node)
    }
  }
  let at = 0
  for (const pair of pairs) {
    const first = Math.min(...pair.filter((index): index is number => index !== null))
    while (at < groups.length && groups[at].end < first) at++
    groups[at]?.rows.push(pair)
  }
  for (const group of groups) group.unchanged = lines.slice(group.start, group.end + 1).every(line => line.type === 'context' || line.type === 'note') && signature(group.old, old) === signature(group.new, next)
  return { old, new: next, groups }
}

// A normalized leaf cannot be indexed as though it were raw source. A unique exact substring is safe to project.
function project(node: Nodes, source: string): Span | undefined {
  if (!['text', 'inlineCode', 'code', 'html'].includes(node.type) || !('value' in node) || !node.value) return
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return
  const raw = source.slice(start, end)
  if (raw === node.value) return [start, end]
  const at = raw.indexOf(node.value)
  if (at >= 0 && at === raw.lastIndexOf(node.value)) return [start + at, start + at + node.value.length]
}

// Positions and intraline spans both use UTF-16 offsets. Normalized leaves receive a coarse tint.
function entriesWithin(side: MarkdownSide, start: number, end: number): MarkdownSource[] {
  let low = 0
  let high = side.entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (side.entries[middle].end <= start) low = middle + 1
    else high = middle
  }
  const entries: MarkdownSource[] = []
  for (let at = low; at < side.entries.length && side.entries[at].start < end; at++) entries.push(side.entries[at])
  return entries
}

function changedRanges(side: MarkdownSide, start: number, end: number): Span[] {
  if (!side.changes.size) return []
  const result: Span[] = []
  for (const entry of entriesWithin(side, start, end)) {
    for (const [a, b] of side.changes.get(entry.index) ?? []) {
      const left = Math.max(start, entry.start + a)
      const right = Math.min(end, entry.start + b)
      if (left < right) result.push([left, right])
    }
  }
  return result
}

function movedRanges(side: MarkdownSide, start: number, end: number): Span[] {
  if (!side.moved.size) return []
  return entriesWithin(side, start, end).filter(entry => side.moved.has(entry.index))
    .map(entry => [Math.max(start, entry.start), Math.min(end, entry.end)])
}

function leaf(value: string, node: Nodes, side: MarkdownSide): ReactNode {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return value
  const projection = project(node, side.source)
  if (!projection) return <span className={movedRanges(side, start, end).length ? 'md-moved-text' : changedRanges(side, start, end).length ? 'intra' : undefined}>{value}</span>
  const [from, to] = projection
  const ranges = changedRanges(side, from, to)
  const moved = movedRanges(side, from, to)
  const cuts = [...new Set([from, to, ...ranges.flat(), ...moved.flat()])].sort((a, b) => a - b)
  return cuts.slice(0, -1).map((at, index) => <span key={at} className={moved.some(([a, b]) => a <= at && at < b) ? 'md-moved-text' : ranges.some(([a, b]) => a <= at && at < b) ? 'intra' : undefined}>{side.source.slice(at, cuts[index + 1])}</span>)
}

function MarkdownCode({ node, side }: { node: Code; side: MarkdownSide }) {
  const [colors, setColors] = useState<{ value: string; lang: string | null | undefined; segments: Segment[][] }>()
  useEffect(() => {
    let stale = false
    setColors(undefined)
    const lang = node.lang ?? ''
    const language = languageFor(`code.${lang}`, {}) ?? languageFor(`code.${lang}`, { [lang]: lang })
    if (language) highlightLines(node.value.split('\n'), language).then(segments => { if (!stale) setColors({ value: node.value, lang: node.lang, segments }) })
    return () => { stale = true }
  }, [node.value, node.lang])
  const projection = project(node, side.source)
  let content: ReactNode = leaf(node.value, node, side)
  if (colors?.value === node.value && colors.lang === node.lang && projection && !movedRanges(side, ...projection).length) {
    const segments = colors.segments.flatMap((line, index) => index ? [{ text: '\n' }, ...line] : line)
    const changes = changedRanges(side, ...projection).map(([a, b]): Span => [a - projection[0], b - projection[0]])
    content = emphasize(node.value, segments, changes).map((piece, index) => <span key={index} className={`tok${piece.changed ? ' intra' : ''}`} style={{ '--tok-light': piece.light, '--tok-dark': piece.dark } as CSSProperties}>{piece.text}</span>)
  }
  return <pre data-source-range={sourceRange(node, side)?.join(':')}><code>{content}</code></pre>
}

export function MarkdownContent({ nodes, side }: { nodes: RootContent[]; side: MarkdownSide }) {
  const render = (node: Nodes, index: number): ReactNode => {
    const children = () => 'children' in node ? node.children.map(render) : null
    const range = sourceRange(node, side)
    const association = range ? `${range[0]}:${range[1]}` : undefined
    switch (node.type) {
      case 'text': return <Fragment key={index}>{leaf(node.value, node, side)}</Fragment>
      case 'paragraph': return <p key={index} data-source-range={association}>{children()}</p>
      case 'heading': {
        const Tag = `h${node.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index} data-source-range={association}>{children()}</Tag>
      }
      case 'emphasis': return <em key={index}>{children()}</em>
      case 'strong': return <strong key={index}>{children()}</strong>
      case 'delete': return <del key={index}>{children()}</del>
      case 'inlineCode': return <code key={index}>{leaf(node.value, node, side)}</code>
      case 'code': return <MarkdownCode key={index} node={node} side={side} />
      case 'blockquote': return <blockquote key={index} data-source-range={association}>{children()}</blockquote>
      case 'list': return node.ordered
        ? <ol key={index} start={node.start ?? 1} data-source-range={association}>{children()}</ol>
        : <ul key={index} data-source-range={association}>{children()}</ul>
      case 'listItem': return <li key={index} data-source-range={association}>{node.checked !== null && node.checked !== undefined && <input type="checkbox" checked={node.checked} disabled aria-label={node.checked ? 'Completed task' : 'Incomplete task'} />}{children()}</li>
      case 'table': {
        const synthetic = (node.position?.start.offset ?? 0) < side.prefix
        const row = (row: (typeof node.children)[number], index: number, header: boolean) => {
          const Cell = header ? 'th' : 'td'
          return (
            <tr key={index} data-source-range={sourceRange(row, side)?.join(':')}>
              {row.children.map((cell, at) => (
                <Cell key={at} scope={header ? 'col' : undefined} data-source-range={sourceRange(cell, side)?.join(':')} className={node.align?.[at] ? `md-align-${node.align[at]}` : undefined}>
                  {cell.children.map(render)}
                </Cell>
              ))}
            </tr>
          )
        }
        return (
          <div key={index} className="md-table-scroll">
            <table data-source-range={association}>
              {!synthetic && <thead>{node.children.slice(0, 1).map((value, index) => row(value, index, true))}</thead>}
              <tbody>{node.children.slice(1).map((value, index) => row(value, index, false))}</tbody>
            </table>
          </div>
        )
      }
      case 'link': return <span key={index} className="md-link">{children()}<span className="md-destination"> ({node.url})</span></span>
      case 'image': return <span key={index} className="md-image" role="img" aria-label={node.alt || 'Image'}>[image: {node.alt || 'Image'}] ({node.url})</span>
      case 'linkReference': {
        const definition = side.definitions.get(node.identifier)
        return <span key={index} className="md-link">{children()}{definition && <span className="md-destination"> ({definition.url})</span>}</span>
      }
      case 'imageReference': {
        const definition = side.definitions.get(node.identifier)
        return <span key={index} className="md-image" role="img" aria-label={node.alt || 'Image'}>[image: {node.alt || 'Image'}]{definition && ` (${definition.url})`}</span>
      }
      case 'definition': return <p key={index} className="md-definition" data-source-range={association}>Reference [{node.label ?? node.identifier}]: {node.url}{node.title ? ` "${node.title}"` : ''}</p>
      case 'footnoteReference': return side.footnotes.has(node.identifier)
        ? <sup key={index} className="md-footnote">[{node.label ?? node.identifier}]</sup>
        : <span key={index}>{side.source.slice(node.position?.start.offset, node.position?.end.offset)}</span>
      case 'footnoteDefinition': return <div key={index} className="md-footnote-definition" data-source-range={association}><span>[{node.label ?? node.identifier}] </span>{children()}</div>
      case 'thematicBreak': return <hr key={index} data-source-range={association} />
      case 'break': return <br key={index} />
      case 'html': return <code key={index} className="md-html" data-source-range={association}>{leaf(node.value, node, side)}</code>
      default: return null
    }
  }
  return <>{nodes.map(render)}</>
}
