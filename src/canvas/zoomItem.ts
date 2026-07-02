import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { sceneInventory } from './summarizeScene'
import { resolveTarget } from './inventory/resolveTarget'
import { truncate, hostOf } from '../lib/text'

/**
 * look_at_item (LL-011): let the model examine ONE board item at full
 * sharpness. Whole-board captures shrink busy boards until screenshot text is
 * unreadable; this returns just the target — and for images it returns the
 * ORIGINAL stored bytes (the file store keeps full resolution even though the
 * canvas displays a scaled-down element), so nothing is lost to re-export.
 *
 * The result stays channel-safe: original bytes are re-encoded down only when
 * they exceed the size budget, never up.
 */

// The WebRTC data channel rejects large messages (~256KB typical ceiling —
// RISK-001; verified live: a 609K-char data URL silenced the session). Budget
// well under it: ~180K chars ≈ ~135KB binary — verified legible (read a real
// Wikipedia date at 225K; extra headroom cuts channel strain and read latency).
const MAX_DATAURL_CHARS = 180_000
const MAX_EDGE = 1400

function describeNode(kind: string, label?: string): string {
  if (kind === 'screenshot') return `the website screenshot${label ? ` of ${hostOf(label)}` : ''}`
  if (kind === 'generated-image') return `the generated image${label ? ` "${truncate(label, 50)}"` : ''}`
  if (kind === 'document') return 'the briefing document'
  return `${kind === 'unknown' ? 'the hand-drawn item' : `the ${kind}`}${label ? ` "${truncate(label, 50)}"` : ''}`
}

/** Downscale a data URL to fit the byte/edge budget. Only ever shrinks. */
async function fitBudget(dataURL: string): Promise<string> {
  if (dataURL.length <= MAX_DATAURL_CHARS) return dataURL
  const img = new Image()
  await new Promise((res, rej) => {
    img.onload = res
    img.onerror = rej
    img.src = dataURL
  })
  let { naturalWidth: w, naturalHeight: h } = img
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  w = Math.max(1, Math.round(w * scale))
  h = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
  // JPEG at declining quality until it fits — busy screenshots compress fine.
  for (const q of [0.85, 0.7, 0.55]) {
    const out = canvas.toDataURL('image/jpeg', q)
    if (out.length <= MAX_DATAURL_CHARS) return out
  }
  return canvas.toDataURL('image/jpeg', 0.4)
}

export async function lookAtItem(
  api: ExcalidrawImperativeAPI,
  target: string,
): Promise<Record<string, unknown>> {
  const inv = sceneInventory(api)
  const hit = resolveTarget(inv, target)
  if (!hit) {
    return {
      ok: false,
      error: `nothing on the board matches "${truncate(target, 60)}" — call read_canvas to see what is here`,
    }
  }
  if ('ambiguous' in hit) {
    return {
      ok: false,
      error: 'more than one item matches',
      candidates: hit.ambiguous.slice(0, 5).map((n) => describeNode(n.kind, n.label)),
      hint: 'ask the user which one, or have them select it and call look_at_item with target "selected"',
    }
  }

  const node = hit.node
  const element = api
    .getSceneElements()
    .find((e) => e.id === node.id) as (ExcalidrawElement & { fileId?: string | null }) | undefined
  if (!element) return { ok: false, error: 'item vanished from the board' }

  const looking_at = describeNode(node.kind, node.label)
  try {
    // Images: hand back the ORIGINAL stored bytes — the sharpest view that exists.
    if (element.type === 'image' && element.fileId) {
      const file = api.getFiles()[element.fileId]
      if (file?.dataURL) {
        return { ok: true, looking_at, image: await fitBudget(file.dataURL) }
      }
    }
    // Everything else: export just this element (with its bound label) crisply.
    const withLabel = api
      .getSceneElements()
      .filter((e) => e.id === node.id || (e as { containerId?: string | null }).containerId === node.id)
    const blob = await exportToBlob({
      elements: withLabel,
      appState: { theme: 'light', exportBackground: true, viewBackgroundColor: '#ffffff' },
      files: api.getFiles(),
      mimeType: 'image/png',
      exportPadding: 24,
      getDimensions: (w: number, h: number) => {
        const scale = Math.min(3, Math.max(1, 900 / Math.max(w, h)))
        return { width: Math.round(w * scale), height: Math.round(h * scale), scale }
      },
    })
    const dataURL = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(blob)
    })
    return { ok: true, looking_at, image: await fitBudget(dataURL) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
