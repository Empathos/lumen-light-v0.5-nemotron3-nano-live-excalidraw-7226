import { describe, it, expect } from 'vitest'
import { resolveTarget } from './resolveTarget'
import type { BoardInventory, BoardNode } from './schema'

function inv(nodes: Partial<BoardNode>[]): BoardInventory {
  return {
    version: 1,
    links: [],
    tags: {},
    nodes: nodes.map((n, i) => ({
      id: n.id ?? `n${i}`,
      kind: n.kind ?? 'shape',
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      tags: {},
      ...n,
    })) as BoardNode[],
  }
}

describe('resolveTarget', () => {
  const board = inv([
    { id: 'wiki', kind: 'screenshot', label: 'https://en.wikipedia.org/wiki/Main_Page' },
    { id: 'mini', kind: 'generated-image', label: 'a green mini cooper' },
    { id: 'box', kind: 'shape', label: 'Budget Review' },
    { id: 'sketch', kind: 'unknown' },
  ])

  it('resolves "selected" to the selection', () => {
    const b = inv([{ id: 'a' }, { id: 'b', selected: true }])
    expect(resolveTarget(b, 'selected')).toMatchObject({ node: { id: 'b' } })
    expect(resolveTarget(b, 'this one')).toMatchObject({ node: { id: 'b' } })
  })

  it('matches labels by substring, case-insensitively', () => {
    expect(resolveTarget(board, 'the wikipedia screenshot')).toMatchObject({ node: { id: 'wiki' } })
    expect(resolveTarget(board, 'mini cooper')).toMatchObject({ node: { id: 'mini' } })
    expect(resolveTarget(board, 'budget review')).toMatchObject({ node: { id: 'box' } })
  })

  it('resolves a unique kind word', () => {
    expect(resolveTarget(board, 'the screenshot')).toMatchObject({ node: { id: 'wiki' } })
    expect(resolveTarget(board, 'the drawing')).toMatchObject({ node: { id: 'sketch' } })
  })

  it('reports ambiguity instead of guessing', () => {
    const b = inv([
      { id: 's1', kind: 'screenshot', label: 'https://a.example' },
      { id: 's2', kind: 'screenshot', label: 'https://b.example' },
    ])
    const hit = resolveTarget(b, 'screenshot')
    expect(hit && 'ambiguous' in hit && hit.ambiguous.length).toBe(2)
  })

  it('selection disambiguates a kind word', () => {
    const b = inv([
      { id: 's1', kind: 'screenshot', label: 'https://a.example' },
      { id: 's2', kind: 'screenshot', label: 'https://b.example', selected: true },
    ])
    expect(resolveTarget(b, 'this screenshot')).toMatchObject({ node: { id: 's2' } })
  })

  it('returns null when nothing matches', () => {
    expect(resolveTarget(board, 'the kraken')).toBeNull()
    expect(resolveTarget(board, '')).toBeNull()
  })
})
