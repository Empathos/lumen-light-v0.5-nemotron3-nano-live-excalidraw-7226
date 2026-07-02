import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { inventoryFromApi } from './inventory/excalidrawAdapter'
import type { BoardInventory } from './inventory/schema'
import { DOC_VIEWER_PATH, readDocInfo } from './docStorage'
import { truncate, hostOf } from '../lib/text'

/**
 * Textual description of what is on the canvas, rendered from the board
 * inventory (ADR-0012). Two consumers:
 *
 * - `summarizeScene` — re-grounding for resumed sessions (BUG-001): when a new
 *   realtime session connects on a non-empty board, the model gets this as
 *   automated context so its understanding and the canvas refer to the same thing.
 * - `describeScene` — the `read_canvas` tool: the same inventory, on demand,
 *   without the resume framing, so the model can re-check the board mid-session.
 *
 * Derived, not stored: we read the live scene on every call, so the summary can
 * never drift from what the user actually sees (unlike a saved transcript). For
 * exact layout the model can still call `capture_canvas`; this is the cheap,
 * always-on baseline.
 */

/** The live board inventory (ADR-0012) — the addressable model behind the text. */
export function sceneInventory(api: ExcalidrawImperativeAPI): BoardInventory {
  // The doc reader is lazy: it only runs if the scene contains the doc window.
  return inventoryFromApi(api, { doc: readDocInfo, docLink: DOC_VIEWER_PATH })
}

/**
 * Plain inventory of the current scene, or `null` if the canvas is empty / has
 * nothing worth describing. No session framing — this is what the `read_canvas`
 * tool returns, and what `summarizeScene` wraps for re-grounding.
 */
export function describeScene(api: ExcalidrawImperativeAPI | null): string | null {
  if (!api) return null
  const inv = sceneInventory(api)

  const shapes = inv.nodes.filter((n) => n.kind === 'shape').length
  const connectors = inv.links.length
  const screenshots = inv.nodes.filter((n) => n.kind === 'screenshot').map((n) => hostOf(n.label))
  const generated = inv.nodes
    .filter((n) => n.kind === 'generated-image')
    .map((n) => truncate(n.label ?? '', 50))
  const untaggedImages = inv.nodes.filter((n) => n.kind === 'image').length
  // Hand-drawn strokes, lines, frames, foreign embeds — everything outside
  // Lumen's own drawing vocabulary. Without this line, a board of only
  // user-drawn content reads as "empty" (BUG-004).
  const other = inv.nodes.filter((n) => n.kind === 'unknown').length
  const doc = inv.nodes.find((n) => n.kind === 'document')

  const parts: string[] = []
  if (shapes) parts.push(`${shapes} shape${shapes > 1 ? 's' : ''}/node${shapes > 1 ? 's' : ''}`)
  if (connectors) parts.push(`${connectors} connector${connectors > 1 ? 's' : ''} (arrows)`)
  if (screenshots.length) {
    const named = screenshots.filter(Boolean)
    parts.push(
      `${screenshots.length} website screenshot${screenshots.length > 1 ? 's' : ''}${
        named.length ? ` (${named.join(', ')})` : ''
      }`,
    )
  }
  if (generated.length) {
    const named = generated.filter(Boolean)
    parts.push(
      `${generated.length} generated image${generated.length > 1 ? 's' : ''}${
        named.length ? ` (${named.map((l) => `"${l}"`).join(', ')})` : ''
      }`,
    )
  }
  if (untaggedImages) parts.push(`${untaggedImages} image${untaggedImages > 1 ? 's' : ''}`)
  if (other) {
    parts.push(
      `${other} other element${other > 1 ? 's' : ''} (e.g. hand-drawn strokes or lines added by the user)`,
    )
  }

  if (doc) {
    const words = doc.tags['source.doc-words']
    parts.push(
      `an open briefing document${doc.label ? ` titled "${truncate(doc.label, 80)}"` : ''}${
        typeof words === 'number' && words ? ` (~${words} words)` : ''
      }`,
    )
  }

  // De-duplicate labels (bound shape labels + free text), cap count + length so
  // the description stays small even on a busy canvas.
  const uniqLabels = [
    ...new Set(
      inv.nodes.filter((n) => n.kind === 'text').map((n) => truncate(n.label ?? '', 60)),
    ),
  ]
    .filter(Boolean)
    .slice(0, 40)

  if (parts.length === 0 && uniqLabels.length === 0) return null

  // Live focus (IDEA-007): what the user has selected / can see right now.
  // Selection is the strongest "this" signal; the viewport is the fallback.
  const nameNode = (n: (typeof inv.nodes)[number]): string => {
    const label = n.label ? ` "${truncate(n.label, 40)}"` : ''
    if (n.kind === 'screenshot') return `a website screenshot${n.label ? ` (${hostOf(n.label)})` : ''}`
    if (n.kind === 'generated-image') return `a generated image${label}`
    if (n.kind === 'document') return 'the briefing document'
    if (n.kind === 'text') return `the text${label}`
    if (n.kind === 'shape') return `a shape${label}`
    return `an item${label}`
  }
  const selectedNodes = inv.nodes.filter((n) => n.selected)
  const inView = inv.nodes.filter((n) => n.inView).length
  const viewKnown = inv.nodes.some((n) => n.inView !== undefined)

  const lines: string[] = []
  if (selectedNodes.length) {
    const named = selectedNodes.slice(0, 3).map(nameNode).join(', ')
    const more = selectedNodes.length > 3 ? ` and ${selectedNodes.length - 3} more` : ''
    lines.push(
      `USER FOCUS: the user currently has ${named}${more} selected — "this" / "this one" means that selection.`,
    )
  } else if (viewKnown && inView < inv.nodes.length) {
    lines.push(
      `USER FOCUS: ${inView} of ${inv.nodes.length} items are on the user's screen right now — "this" likely refers to what is in view, not off-screen items.`,
    )
  }

  lines.push(`On the canvas now: ${parts.join(', ') || 'various elements'}.`)
  if (uniqLabels.length) {
    lines.push(`Text and labels present: ${uniqLabels.map((l) => `"${l}"`).join(', ')}.`)
  }
  // Buffered vision (LL-012): pre-read notes stored on image elements make
  // "what does it say?" answerable instantly, without moving pixels.
  const preRead = inv.nodes
    .filter((n) => ['screenshot', 'generated-image', 'image'].includes(n.kind))
    .filter((n) => typeof n.tags['ai.description'] === 'string' && n.tags['ai.description'])
    .slice(0, 6)
  if (preRead.length) {
    lines.push(
      'Image contents (pre-read, literal): ' +
        preRead
          .map((n) => {
            const who = n.kind === 'screenshot' ? `screenshot${n.label ? ` of ${hostOf(n.label)}` : ''}` : n.kind === 'generated-image' ? 'generated image' : 'image'
            return `[${who}] ${truncate(String(n.tags['ai.description']), 220)}`
          })
          .join(' · '),
    )
  }

  // Anything visual — images OR hand-drawn content — can only be understood by
  // looking. Point the model at capture_canvas so it recognizes, not just counts.
  const hasVisual = screenshots.length > 0 || generated.length > 0 || untaggedImages > 0 || other > 0
  lines.push(
    hasVisual
      ? 'Some items are visual (images, website snapshots, generated pictures, or hand-drawn strokes) whose content you cannot read from this text — if the user asks what something is, shows, or looks like, call capture_canvas to actually see the board before answering.'
      : 'To see the exact layout, call capture_canvas.',
  )
  return lines.join('\n')
}

/**
 * Build the grounding message for the current scene, or `null` if the canvas is
 * empty / has nothing worth describing. The string is framed as automated
 * context (the model must not thank the user for it), mirroring the
 * `capture_canvas` convention.
 */
export function summarizeScene(api: ExcalidrawImperativeAPI | null): string | null {
  const description = describeScene(api)
  if (!description) return null
  return [
    '[AUTOMATED CONTEXT — not from the user] You are resuming an existing canvas: the user stopped a previous session and has come back to the same board. The following is already on the canvas. Do NOT thank the user for this or announce it — just use it so you can refer to and build on what is already there.',
    '',
    description,
    'If the user refers to "this", "the diagram", "what we made", etc., they mean the above.',
  ].join('\n')
}
