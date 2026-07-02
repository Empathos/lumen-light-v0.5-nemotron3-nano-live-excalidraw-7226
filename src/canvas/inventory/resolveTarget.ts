import type { BoardInventory, BoardNode } from './schema'

/**
 * Resolve a spoken/typed reference ("the wikipedia screenshot", "selected",
 * "the mini cooper") to ONE board node (LL-011). Pure and engine-free so the
 * ranking is unit-testable. Precedence mirrors how a person points:
 *   1. "selected"/"this" → the user's live selection
 *   2. exact label match
 *   3. label/host substring match
 *   4. kind word ("screenshot", "image", "document", …) — unique match only
 * Returns the node, or all candidates when the reference is ambiguous.
 */
export function resolveTarget(
  inv: BoardInventory,
  query: string,
): { node: BoardNode } | { ambiguous: BoardNode[] } | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const nodes = inv.nodes

  if (q === 'selected' || q === 'this' || q === 'this one') {
    const sel = nodes.filter((n) => n.selected)
    if (sel.length === 1) return { node: sel[0] }
    if (sel.length > 1) return { ambiguous: sel }
    return null
  }

  const label = (n: BoardNode) => (n.label ?? '').toLowerCase()
  const exact = nodes.filter((n) => label(n) === q)
  if (exact.length === 1) return { node: exact[0] }
  if (exact.length > 1) return { ambiguous: exact }

  const contains = nodes.filter((n) => {
    const l = label(n)
    return l ? l.includes(q) || q.includes(l) : false
  })
  if (contains.length === 1) return { node: contains[0] }
  if (contains.length > 1) return { ambiguous: contains }

  const KIND_WORDS: Record<string, BoardNode['kind'][]> = {
    screenshot: ['screenshot'],
    website: ['screenshot'],
    image: ['screenshot', 'generated-image', 'image'],
    picture: ['generated-image', 'image', 'screenshot'],
    photo: ['generated-image', 'image', 'screenshot'],
    document: ['document'],
    doc: ['document'],
    drawing: ['unknown'],
    sketch: ['unknown'],
  }
  for (const [word, kinds] of Object.entries(KIND_WORDS)) {
    if (!q.includes(word)) continue
    const byKind = nodes.filter((n) => kinds.includes(n.kind))
    if (byKind.length === 1) return { node: byKind[0] }
    if (byKind.length > 1) {
      // A selected item of the right kind disambiguates ("this screenshot").
      const sel = byKind.filter((n) => n.selected)
      if (sel.length === 1) return { node: sel[0] }
      return { ambiguous: byKind }
    }
  }
  return null
}
