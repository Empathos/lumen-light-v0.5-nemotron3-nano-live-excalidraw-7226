import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { sceneInventory } from './summarizeScene'
import { resolveTarget } from './inventory/resolveTarget'
import { truncate, hostOf } from '../lib/text'

/**
 * look_at_item (LL-013, supersedes the LL-011 mechanism): let the model examine
 * ONE board item closely — WITHOUT any pixels crossing the WebRTC channel.
 * The item's ORIGINAL bytes (full resolution — the canvas only displays a
 * scaled copy) plus the model's question go to our server over HTTP, a fast
 * vision model reads them there, and only the short TEXT answer returns to the
 * session. No blip, no size budget, no channel risk — pixels ride HTTP,
 * conversation rides the voice pipe.
 */

function describeNode(kind: string, label?: string): string {
  if (kind === 'screenshot') return `the website screenshot${label ? ` of ${hostOf(label)}` : ''}`
  if (kind === 'generated-image') return `the generated image${label ? ` "${truncate(label, 50)}"` : ''}`
  if (kind === 'document') return 'the briefing document'
  return `${kind === 'unknown' ? 'the hand-drawn item' : `the ${kind}`}${label ? ` "${truncate(label, 50)}"` : ''}`
}

/** Ask the server's vision model about an image; returns a short text answer. */
async function delegateLook(dataURL: string, question: string): Promise<Record<string, unknown>> {
  const resp = await fetch('/api/image/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataURL, question }),
  })
  const data = (await resp.json()) as { description?: string; error?: string }
  if (!resp.ok || !data.description) {
    return { ok: false, error: data.error || 'vision service unavailable' }
  }
  return { ok: true, answer: data.description }
}

export async function lookAtItem(
  api: ExcalidrawImperativeAPI,
  target: string,
  question: string,
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
    // Images: the ORIGINAL stored bytes go to the vision service — full
    // resolution, over HTTP, nothing on the data channel.
    if (element.type === 'image' && element.fileId) {
      const file = api.getFiles()[element.fileId]
      if (file?.dataURL) {
        return { looking_at, ...(await delegateLook(file.dataURL, question)) }
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
    return { looking_at, ...(await delegateLook(dataURL, question)) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
