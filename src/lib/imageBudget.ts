/**
 * Shrink a data URL to fit the WebRTC data channel's safe message budget
 * (RISK-001: ~256KB ceiling; a 609K-char payload has silenced a live session).
 * Only ever shrinks. Used by capture_canvas — the one remaining image that
 * must cross the channel, because the model needs to SEE layout itself to
 * self-correct drawings. Everything else rides HTTP (LL-013).
 */

const MAX_DATAURL_CHARS = 220_000
const MAX_EDGE = 1280

export async function fitChannelBudget(dataURL: string): Promise<string> {
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
  const g = canvas.getContext('2d')
  if (!g) return dataURL
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, w, h)
  g.drawImage(img, 0, 0, w, h)
  for (const q of [0.8, 0.65, 0.5]) {
    const out = canvas.toDataURL('image/jpeg', q)
    if (out.length <= MAX_DATAURL_CHARS) return out
  }
  return canvas.toDataURL('image/jpeg', 0.35)
}
