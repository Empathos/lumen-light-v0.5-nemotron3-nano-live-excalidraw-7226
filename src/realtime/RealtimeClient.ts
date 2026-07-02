export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

export interface RealtimeCallbacks {
  onStatus?: (status: RealtimeStatus, detail?: string) => void
  onUserTranscript?: (text: string) => void
  onAssistantTranscript?: (text: string) => void
  onToolCall?: (name: string, args: unknown, callId: string) => Promise<unknown> | unknown
  onError?: (message: string) => void
  onMic?: (enabled: boolean) => void
  /**
   * Called when the session connects, to re-ground the model in the existing
   * session — what is already on the canvas and what was said earlier (BUG-001).
   * Return the grounding text, or null/empty if there is nothing to ground.
   * Injected as silent context — the model is not asked to respond to it.
   */
  getSessionGrounding?: () => string | null | undefined
}

/** One BidiGenerateContentServerMessage, loosely typed. */
interface LiveServerMessage {
  setupComplete?: Record<string, unknown>
  serverContent?: {
    modelTurn?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] }
    turnComplete?: boolean
    interrupted?: boolean
    inputTranscription?: { text?: string }
    outputTranscription?: { text?: string }
  }
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: unknown }[] }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  error?: { message?: string }
  [key: string]: unknown
}

const TOKEN_ENDPOINT = '/api/live/token'
// Ephemeral tokens only work against the v1alpha constrained endpoint (ADR-0013).
const LIVE_WS_PATH =
  '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'

/**
 * Where to open the Live WebSocket. Production connects straight to Google
 * (that is the whole point of the ephemeral token). Dev goes through the Vite
 * proxy at /live-ws on this origin, because host-side VPNs/filters (e.g.
 * NordVPN on the Windows host) can black-hole a direct browser connection to
 * googleapis.com while the dev server's own egress works fine.
 */
function liveWsUrl(accessToken: string): string {
  const query = `?access_token=${encodeURIComponent(accessToken)}`
  if (import.meta.env.DEV) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/live-ws${LIVE_WS_PATH}${query}`
  }
  return `wss://generativelanguage.googleapis.com${LIVE_WS_PATH}${query}`
}

/** Gemini Live consumes PCM16 mono at 16 kHz and emits PCM16 mono at 24 kHz. */
const INPUT_SAMPLE_RATE = 16000
const OUTPUT_SAMPLE_RATE = 24000

/** Batch mic frames to ~128 ms per message so we don't spam the socket. */
const MIC_CHUNK_SAMPLES = 2048

// Any single WS message this large risks stalling live audio behind it
// (RISK-001 in its Gemini form) — oversized images degrade to an honest note.
const MAX_IMAGE_CHARS = 1_000_000

/**
 * Mic capture worklet: converts float32 frames to PCM16 and posts batched
 * buffers to the main thread. Inlined as a Blob URL so the client stays a
 * single self-contained module.
 */
const CAPTURE_WORKLET_SRC = `
class LumenPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunks = []
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      const pcm = new Int16Array(channel.length)
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      this.chunks.push(pcm)
      this.length += pcm.length
      if (this.length >= ${MIC_CHUNK_SAMPLES}) {
        const merged = new Int16Array(this.length)
        let offset = 0
        for (const c of this.chunks) {
          merged.set(c, offset)
          offset += c.length
        }
        this.chunks = []
        this.length = 0
        this.port.postMessage(merged.buffer, [merged.buffer])
      }
    }
    return true
  }
}
registerProcessor('lumen-pcm-capture', LumenPcmCapture)
`

/**
 * Browser WebSocket client for the Google Gemini Live API (ADR-0013, LL-014).
 *
 * Flow: fetch an ephemeral token + session setup from our server -> open a
 * WebSocket straight to Google (the token is the only credential the browser
 * ever sees) -> send the setup -> stream mic PCM up / play model PCM down.
 * Both voice and typed text go through the same session and produce the same
 * tool calls. The public seam is identical to the previous Inworld client, so
 * App.tsx and the tool loop are provider-agnostic.
 */
export class RealtimeClient {
  private ws?: WebSocket
  private status: RealtimeStatus = 'idle'
  // Mic capture graph (16 kHz) and model playback context (24 kHz) are two
  // separate AudioContexts because they run at different sample rates.
  private micStream?: MediaStream
  private micCtx?: AudioContext
  private playCtx?: AudioContext
  private playNextTime = 0
  private playingSources = new Set<AudioBufferSourceNode>()
  // Transcript accumulators: Gemini streams both transcriptions in fragments;
  // we emit whole turns like the previous client did.
  private userTranscript = ''
  private assistantTranscript = ''
  // Session re-grounding (BUG-001): computed at connect, sent once as silent
  // context (turnComplete: false) after setupComplete. Guarded so it can never
  // block the connect path.
  private groundingSent = false
  // Telemetry (BUG-005): send sizes/backpressure, every message kind received,
  // errors verbatim, and periodic audio counters.
  private tm = {
    sends: [] as { t: number; type: string; size: number; buffered: number }[],
    events: {} as Record<string, number>,
    lastEvents: [] as { t: number; type: string; raw: string }[],
    errors: [] as { t: number; raw: string }[],
    stats: [] as Record<string, unknown>[],
  }
  private audioBytesUp = 0
  private audioBytesDown = 0
  private statsTimer?: ReturnType<typeof setInterval>

  constructor(private readonly callbacks: RealtimeCallbacks = {}) {}

  get state(): RealtimeStatus {
    return this.status
  }

  private setStatus(status: RealtimeStatus, detail?: string) {
    this.status = status
    this.callbacks.onStatus?.(status, detail)
  }

  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') return
    this.setStatus('connecting')
    this.groundingSent = false

    try {
      const tokenRes = await fetch(TOKEN_ENDPOINT)
      const tokenText = await tokenRes.text()
      if (!tokenRes.ok) throw new Error(`Token request failed (${tokenRes.status}): ${tokenText}`)
      const { accessToken, setup } = JSON.parse(tokenText) as {
        accessToken?: string
        setup?: Record<string, unknown>
      }
      if (!accessToken || !setup) throw new Error('Token response missing accessToken/setup.')

      // connect() is triggered by a user click, so creating the playback
      // AudioContext here satisfies browser autoplay policy.
      this.playCtx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
      this.playNextTime = 0

      const ws = new WebSocket(liveWsUrl(accessToken))
      this.ws = ws

      ws.addEventListener('open', () => {
        this.send({ setup })
      })
      ws.addEventListener('message', (e: MessageEvent) => {
        void this.receive(e.data as string | Blob)
      })
      // The error event carries no detail; the close event that follows has
      // Google's code + reason (setup/config errors arrive this way), so all
      // reporting lives in the close handler.
      ws.addEventListener('error', () => {
        console.warn('[lumen telemetry] websocket error event')
      })
      ws.addEventListener('close', (e: CloseEvent) => {
        if (this.status !== 'connecting' && this.status !== 'connected') return
        const detail = `close ${e.code}${e.reason ? `: ${e.reason}` : ''}`
        if (e.code !== 1000) {
          this.tm.errors.push({ t: Date.now(), raw: detail.slice(0, 600) })
          console.warn('[lumen telemetry]', detail)
          this.callbacks.onError?.(`Live session ${detail}`)
        }
        this.cleanup()
        this.setStatus(e.code === 1000 ? 'closed' : 'error', detail)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus('error', message)
      this.callbacks.onError?.(message)
      this.cleanup()
    }
  }

  /** Send a typed message into the same live session; the model responds to it. */
  sendText(text: string): boolean {
    if (!this.isOpen()) return false
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    })
    return true
  }

  /**
   * Inject an image into the session plus an optional text prompt, and ask for
   * a response. Gemini Live only accepts inline base64 (GAP-001: Google rejects
   * http(s) URLs), so data URLs are sent directly and remote URLs are fetched
   * browser-side first (subject to CORS) — hence fire-and-forget async.
   */
  injectImage(imageUrl: string, text?: string): boolean {
    if (!this.isOpen()) return false
    void (async () => {
      try {
        const inline = await this.toInlineData(imageUrl)
        this.send({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [...(text ? [{ text }] : []), { inlineData: inline }],
              },
            ],
            turnComplete: true,
          },
        })
      } catch (err) {
        this.callbacks.onError?.(
          `Could not inject image: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
    return true
  }

  disconnect(): void {
    this.cleanup()
    this.setStatus('closed')
  }

  /** Full telemetry snapshot — sizes, event counts, errors, audio stats. */
  telemetryDump(): Record<string, unknown> {
    return {
      sends: this.tm.sends.slice(-40),
      eventCounts: this.tm.events,
      lastEvents: this.tm.lastEvents.slice(-25),
      errors: this.tm.errors.slice(-10),
      audioStats: this.tm.stats.slice(-12),
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  private send(message: Record<string, unknown>) {
    if (!this.isOpen() || !this.ws) return
    const payload = JSON.stringify(message)
    const kind = Object.keys(message)[0] ?? 'unknown'
    // Mic audio flows continuously; keep it out of the send ring and count bytes.
    if (kind === 'realtimeInput') {
      this.audioBytesUp += payload.length
    } else {
      this.tm.sends.push({ t: Date.now(), type: kind, size: payload.length, buffered: this.ws.bufferedAmount })
      if (this.tm.sends.length > 200) this.tm.sends.shift()
      if (payload.length > 65_536) {
        console.warn('[lumen telemetry] large send', payload.length, 'buffered before:', this.ws.bufferedAmount)
      }
    }
    this.ws.send(payload)
  }

  /** Wait for the socket's send buffer to drain (backpressure guard, BUG-005). */
  private async drainChannel(maxMs = 4000): Promise<number> {
    const start = Date.now()
    while (this.ws && this.ws.bufferedAmount > 0 && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return Date.now() - start
  }

  private sendAudioChunk(buffer: ArrayBuffer) {
    if (!this.isOpen()) return
    this.send({
      realtimeInput: {
        audio: { data: toBase64(buffer), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
      },
    })
  }

  private async toInlineData(imageUrl: string): Promise<{ mimeType: string; data: string }> {
    const m = imageUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
    if (m) return { mimeType: m[1], data: m[2] }
    const res = await fetch(imageUrl)
    if (!res.ok) throw new Error(`image fetch failed (${res.status})`)
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    return { mimeType, data: toBase64(await res.arrayBuffer()) }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private async receive(data: string | Blob) {
    const raw = typeof data === 'string' ? data : await data.text()
    let msg: LiveServerMessage
    try {
      msg = JSON.parse(raw) as LiveServerMessage
    } catch {
      return
    }

    // Telemetry: count message kinds; keep a raw ring of recent non-audio
    // messages; error-ish messages are kept verbatim.
    const kind = messageKind(msg)
    this.tm.events[kind] = (this.tm.events[kind] ?? 0) + 1
    if (kind !== 'serverContent.audio') {
      this.tm.lastEvents.push({ t: Date.now(), type: kind, raw: raw.slice(0, 400) })
      if (this.tm.lastEvents.length > 60) this.tm.lastEvents.shift()
    }
    if (msg.error || msg.goAway) {
      this.tm.errors.push({ t: Date.now(), raw: raw.slice(0, 600) })
      console.warn('[lumen telemetry] error-ish message:', raw.slice(0, 300))
    }

    if (msg.setupComplete) {
      // The session is configured and live. Mark connected BEFORE any grounding
      // or mic work so the session is always usable.
      this.setStatus('connected')
      this.startStatsSampler()
      this.flushGrounding()
      void this.startMic()
      return
    }

    if (msg.toolCall?.functionCalls) {
      for (const call of msg.toolCall.functionCalls) {
        await this.handleFunctionCall(call)
      }
      return
    }

    if (msg.toolCallCancellation) {
      // The model withdrew tool calls (usually because the user barged in).
      // Our tools are fast and idempotent-by-replacement, so just log it.
      console.info('[lumen tool] cancelled:', msg.toolCallCancellation.ids)
      return
    }

    const content = msg.serverContent
    if (!content) {
      if (msg.error) this.callbacks.onError?.(msg.error.message ?? 'Live session error')
      return
    }

    if (content.interrupted) {
      // The user barged in: silence everything we had queued and emit whatever
      // the assistant actually got to say.
      this.flushPlayback()
      this.emitAssistantTranscript()
      return
    }

    if (content.inputTranscription?.text) {
      this.userTranscript += content.inputTranscription.text
    }
    if (content.outputTranscription?.text) {
      // Model output beginning means the user's turn ended — emit it first so
      // the conversation log keeps its natural order.
      this.emitUserTranscript()
      this.assistantTranscript += content.outputTranscription.text
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData
      if (inline?.data && (inline.mimeType ?? '').startsWith('audio/pcm')) {
        this.audioBytesDown += inline.data.length
        this.emitUserTranscript()
        this.playAudioChunk(inline.data, inline.mimeType)
      }
    }

    if (content.turnComplete) {
      this.emitUserTranscript()
      this.emitAssistantTranscript()
    }
  }

  private emitUserTranscript() {
    const text = this.userTranscript.trim()
    this.userTranscript = ''
    if (text) this.callbacks.onUserTranscript?.(text)
  }

  private emitAssistantTranscript() {
    const text = this.assistantTranscript.trim()
    this.assistantTranscript = ''
    if (text) this.callbacks.onAssistantTranscript?.(text)
  }

  /**
   * Inject the session re-grounding (BUG-001) exactly once, as silent context:
   * a user turn with turnComplete false informs the next reply without
   * triggering one. Capped + guarded so it can never disrupt the session.
   */
  private flushGrounding() {
    if (this.groundingSent) return
    this.groundingSent = true
    let text: string | null | undefined
    try {
      text = this.callbacks.getSessionGrounding?.()
    } catch {
      return
    }
    if (!text || !text.trim()) return
    if (text.length > 8000) text = `${text.slice(0, 8000)}…`
    try {
      this.send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: false,
        },
      })
    } catch {
      /* non-fatal: the session still works without the grounding */
    }
  }

  private async handleFunctionCall(call: { id?: string; name?: string; args?: unknown }) {
    const { id, name } = call
    if (!id || !name) return
    const args = call.args ?? {}

    let result: unknown = { ok: true }
    console.info('[lumen tool]', name, JSON.stringify(args).slice(0, 200))
    try {
      result = (await this.callbacks.onToolCall?.(name, args, id)) ?? { ok: true }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    // A tool may return an `image` data URL (e.g. capture_canvas). The function
    // response itself must be a plain JSON object, so we strip the image out
    // and attach it separately as inline image data the model can actually see.
    let image: string | undefined
    if (result && typeof result === 'object' && 'image' in result) {
      const record = result as Record<string, unknown>
      if (typeof record.image === 'string') image = record.image
      delete record.image
    }
    const response: Record<string, unknown> =
      result && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : { result }

    console.info('[lumen tool result]', name, image ? `(+image ${image.length} chars)` : '', JSON.stringify(response).slice(0, 200))

    if (image && image.length > MAX_IMAGE_CHARS) {
      // Never push an oversized payload into the channel — it stalls live audio
      // (RISK-001). The model gets an honest note instead of silence.
      console.warn('[lumen tool] image too large for channel, dropped:', image.length)
      image = undefined
      this.send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [{ text: '[AUTOMATED SYSTEM MESSAGE] The image from your tool call was too large to deliver. Tell the user plainly that you could not see it clearly this time.' }],
            },
          ],
          turnComplete: false,
        },
      })
    }
    if (image) {
      // Deliver the pixels BEFORE the tool response so they are already in
      // context when the model continues its turn. Backpressure guard (BUG-005):
      // let the socket drain around the large message so it never competes with
      // live audio.
      const inline = await this.toInlineData(image).catch(() => undefined)
      if (inline) {
        const preDrain = await this.drainChannel()
        this.send({
          clientContent: {
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: '[AUTOMATED SYSTEM MESSAGE — not from the user] This image is the output of your visual tool call (capture_canvas or look_at_item), generated automatically by the app. The user did NOT send it; do not thank them or mention screenshots being shared. If it is the whole canvas, silently check layout (overlaps, spacing, cut-off elements, misrouted connectors) and redraw if needed. If it is a single item you looked at, read it closely and answer the user from what it actually shows.',
                  },
                  { inlineData: inline },
                ],
              },
            ],
            turnComplete: false,
          },
        })
        const postDrain = await this.drainChannel(8000)
        console.info('[lumen telemetry] image send drain ms — before:', preDrain, 'after:', postDrain)
      }
    }

    // The model resumes its turn on receiving the function response — there is
    // no separate response.create step in the Live protocol.
    this.send({
      toolResponse: {
        functionResponses: [{ id, name, response }],
      },
    })
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  private async startMic() {
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      this.micStream = mic
      // A dedicated 16 kHz context makes the browser do the resampling for us.
      const ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE })
      this.micCtx = ctx
      const workletUrl = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET_SRC], { type: 'application/javascript' }),
      )
      try {
        await ctx.audioWorklet.addModule(workletUrl)
      } finally {
        URL.revokeObjectURL(workletUrl)
      }
      const source = ctx.createMediaStreamSource(mic)
      const capture = new AudioWorkletNode(ctx, 'lumen-pcm-capture')
      capture.port.onmessage = (e: MessageEvent) => this.sendAudioChunk(e.data as ArrayBuffer)
      source.connect(capture)
      // Keep the graph pulled without ever being audible.
      const sink = ctx.createGain()
      sink.gain.value = 0
      capture.connect(sink)
      sink.connect(ctx.destination)
      this.callbacks.onMic?.(true)
    } catch {
      // No mic access: still receive the model's audio and drive via text.
      this.callbacks.onMic?.(false)
    }
  }

  /** Decode one base64 PCM16 chunk and schedule it gapless after the last one. */
  private playAudioChunk(b64: string, mimeType?: string) {
    const ctx = this.playCtx
    if (!ctx) return
    try {
      if (ctx.state === 'suspended') void ctx.resume()
      const rate = Number(mimeType?.match(/rate=(\d+)/)?.[1]) || OUTPUT_SAMPLE_RATE
      const binary = atob(b64)
      const byteLen = binary.length
      const bytes = new Uint8Array(byteLen)
      for (let i = 0; i < byteLen; i++) bytes[i] = binary.charCodeAt(i)

      const sampleCount = Math.floor(byteLen / 2)
      if (sampleCount === 0) return
      const view = new DataView(bytes.buffer)
      const samples = new Float32Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) {
        // PCM16 little-endian -> normalized float.
        samples[i] = view.getInt16(i * 2, true) / 32768
      }

      const buffer = ctx.createBuffer(1, sampleCount, rate)
      buffer.copyToChannel(samples, 0)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      this.playingSources.add(source)
      source.onended = () => this.playingSources.delete(source)

      const startAt = Math.max(ctx.currentTime, this.playNextTime)
      source.start(startAt)
      this.playNextTime = startAt + buffer.duration
    } catch {
      /* drop malformed chunk */
    }
  }

  /** Stop everything queued for playback (user barged in / disconnect). */
  private flushPlayback() {
    for (const source of this.playingSources) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
    }
    this.playingSources.clear()
    this.playNextTime = 0
  }

  private startStatsSampler() {
    clearInterval(this.statsTimer)
    this.statsTimer = setInterval(() => {
      this.tm.stats.push({
        t: Date.now(),
        audioBytesUp: this.audioBytesUp,
        audioBytesDown: this.audioBytesDown,
        buffered: this.ws?.bufferedAmount ?? 0,
        queuedPlayback: this.playingSources.size,
      })
      if (this.tm.stats.length > 120) this.tm.stats.shift()
    }, 2000)
  }

  private cleanup() {
    clearInterval(this.statsTimer)
    this.flushPlayback()
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = undefined
    if (this.micCtx) {
      void this.micCtx.close().catch(() => {})
      this.micCtx = undefined
    }
    if (this.playCtx) {
      void this.playCtx.close().catch(() => {})
      this.playCtx = undefined
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = undefined
      try {
        ws.close(1000)
      } catch {
        /* noop */
      }
    }
    this.userTranscript = ''
    this.assistantTranscript = ''
  }
}

/** Which kind of server message is this, for telemetry counting. */
function messageKind(msg: LiveServerMessage): string {
  if (msg.setupComplete) return 'setupComplete'
  if (msg.toolCall) return 'toolCall'
  if (msg.toolCallCancellation) return 'toolCallCancellation'
  if (msg.goAway) return 'goAway'
  if (msg.serverContent) {
    const c = msg.serverContent
    if (c.modelTurn?.parts?.some((p) => p.inlineData)) return 'serverContent.audio'
    if (c.interrupted) return 'serverContent.interrupted'
    if (c.turnComplete) return 'serverContent.turnComplete'
    if (c.inputTranscription) return 'serverContent.inputTranscription'
    if (c.outputTranscription) return 'serverContent.outputTranscription'
    return 'serverContent'
  }
  if (msg.error) return 'error'
  return Object.keys(msg)[0] ?? 'unknown'
}

/** ArrayBuffer -> base64 without blowing the call stack on large buffers. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
