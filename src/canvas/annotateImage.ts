import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { mergeTagsIntoElement } from './inventory/excalidrawAdapter'

/**
 * Buffered vision (LL-012): pre-read an image the moment it lands on the board.
 * The description is computed server-side over HTTP (no data-channel traffic)
 * while the conversation continues, then stored as an ai.* tag ON the element —
 * so it persists with the scene and read_canvas can answer "what does it say?"
 * instantly, without moving pixels at question time. Best-effort by design:
 * failures leave the board exactly as it was, and look_at_item still works.
 */
export async function preReadImage(
  api: ExcalidrawImperativeAPI,
  elementId: string | undefined,
  dataURL: string,
): Promise<void> {
  if (!elementId) return
  try {
    const resp = await fetch('/api/image/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataURL }),
    })
    const data = (await resp.json()) as { description?: string }
    const description = (data.description ?? '').trim()
    if (!resp.ok || !description) return
    const elements = api.getSceneElements()
    const target = elements.find((e) => e.id === elementId && !e.isDeleted)
    if (!target) return
    const tagged = mergeTagsIntoElement(target, { 'ai.description': description })
    api.updateScene({ elements: elements.map((e) => (e.id === elementId ? tagged : e)) })
    console.info('[lumen pre-read]', elementId, description.slice(0, 120))
  } catch {
    // Pre-reading is an optimization, never a failure the user should see.
  }
}
