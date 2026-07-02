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

/** OpenAI-style chat message; the whole conversation lives client-side. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

interface ToolCall {
  id: string
  type: string
  function?: { name?: string; arguments?: string }
}

const CHAT_ENDPOINT = '/api/chat'
const DESCRIBE_ENDPOINT = '/api/image/describe'

/** Most tool hops one user turn may take before we force a plain reply. */
const MAX_TOOL_HOPS = 8

/** Keep the client-held history bounded; the canvas is the durable state. */
const MAX_HISTORY_MESSAGES = 80

/**
 * The question sent to the server-side vision reader when a tool returns a
 * canvas screenshot: the model is text-only, so pixels become this report
 * (ADR-0014 — LL-013's "pixels never cross the channel", applied everywhere).
 */
const LAYOUT_QUESTION =
  'This is a whiteboard render. Report the layout precisely: list the visible elements with approximate positions, then call out overlapping shapes, awkward spacing, cut-off or off-screen elements, and connectors that attach to the wrong place. If the layout looks clean, say so. Max 120 words.'

// Minimal Web Speech typings (lib.dom omits SpeechRecognition in some configs).
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: { transcript: string }
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start: () => void
  stop: () => void
}

/**
 * Chat-loop client for the NVIDIA Nemotron 3 Nano brain via OpenRouter
 * (ADR-0014, LL-015). Fourth provider behind the same seam as the OpenAI /
 * Inworld / Gemini Live clients, so App.tsx and the tool loop are untouched.
 *
 * Flow: sendText (typed, or a final speech-recognition transcript) appends a
 * user message and runs the agentic loop — POST history to our server proxy,
 * execute any tool_calls via onToolCall, append role:"tool" results, repeat
 * until a plain assistant message, which is emitted and spoken via the
 * browser's speechSynthesis. Voice in is the browser's SpeechRecognition;
 * both degrade gracefully to a text-only session when unavailable.
 */
export class RealtimeClient {
  private status: RealtimeStatus = 'idle'
  private history: ChatMessage[] = []
  private queue: string[] = []
  private turnActive = false
  private closed = false
  // Voice cascade state
  private recognition?: SpeechRecognitionLike
  private voiceOn = false
  private speaking = false
  // Telemetry (BUG-005 shape preserved): request sizes, message kinds seen,
  // errors verbatim, and cumulative usage/latency snapshots.
  private tm = {
    sends: [] as { t: number; type: string; size: number; buffered: number }[],
    events: {} as Record<string, number>,
    lastEvents: [] as { t: number; type: string; raw: string }[],
    errors: [] as { t: number; raw: string }[],
    stats: [] as Record<string, unknown>[],
  }
  private totalTokens = 0
  private turnCount = 0

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
    this.closed = false
    try {
      const res = await fetch(CHAT_ENDPOINT)
      const cfg = (await res.json()) as { model?: string; hasKey?: boolean; error?: string }
      if (!res.ok) throw new Error(cfg.error || `config request failed (${res.status})`)
      if (!cfg.hasKey) throw new Error('OPENROUTER_API_KEY is not set on the server.')

      // Session re-grounding (BUG-001): silent context — a system message the
      // model is never asked to respond to. Guarded so it can't block connect.
      try {
        let grounding = this.callbacks.getSessionGrounding?.()
        if (grounding && grounding.trim()) {
          if (grounding.length > 8000) grounding = `${grounding.slice(0, 8000)}…`
          this.history.push({
            role: 'system',
            content: `Session re-grounding (current canvas + earlier conversation — context only, do not respond to this):\n\n${grounding}`,
          })
        }
      } catch {
        /* non-fatal */
      }

      this.setStatus('connected', cfg.model)
      this.startVoice()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus('error', message)
      this.callbacks.onError?.(message)
    }
  }

  /** Send a typed message into the session; the model responds to it. */
  sendText(text: string): boolean {
    if (this.status !== 'connected') return false
    this.enqueueUserTurn(text)
    return true
  }

  /**
   * Inject an image plus an optional text prompt. The brain is text-only, so
   * the image is read server-side (Gemini describe) and the description is
   * what enters the conversation — same delegation as capture_canvas.
   */
  injectImage(imageUrl: string, text?: string): boolean {
    if (this.status !== 'connected') return false
    void (async () => {
      try {
        const dataURL = imageUrl.startsWith('data:') ? imageUrl : await toDataURL(imageUrl)
        const description = await this.describe(dataURL, text)
        this.enqueueUserTurn(
          `[An image was shared into the session. Automated reading of it: ${description}]${text ? `\n${text}` : ''}`,
        )
      } catch (err) {
        this.callbacks.onError?.(
          `Could not inject image: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })()
    return true
  }

  disconnect(): void {
    this.closed = true
    this.stopVoice()
    this.queue = []
    this.setStatus('closed')
  }

  /** Full telemetry snapshot — sizes, event counts, errors, usage stats. */
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
  // Turn loop
  // -------------------------------------------------------------------------

  private enqueueUserTurn(text: string) {
    this.queue.push(text)
    void this.drainQueue()
  }

  private async drainQueue() {
    if (this.turnActive) return
    this.turnActive = true
    try {
      while (this.queue.length > 0 && !this.closed) {
        const text = this.queue.shift()!
        this.history.push({ role: 'user', content: text })
        await this.runTurn()
      }
    } finally {
      this.turnActive = false
    }
  }

  private async runTurn() {
    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      this.pruneHistory()
      let message: ChatMessage
      try {
        message = await this.requestCompletion()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        this.tm.errors.push({ t: Date.now(), raw: detail.slice(0, 600) })
        this.callbacks.onError?.(detail)
        return
      }
      this.history.push(message)

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        const text = (message.content ?? '').trim()
        this.count('assistant.message')
        if (text) {
          this.callbacks.onAssistantTranscript?.(text)
          this.speak(text)
        }
        return
      }

      // Say any preamble that rode along with the tool calls ("let me check").
      const preamble = (message.content ?? '').trim()
      if (preamble) {
        this.callbacks.onAssistantTranscript?.(preamble)
        this.speak(preamble)
      }

      for (const call of calls) {
        this.count('toolCall')
        this.history.push(await this.executeToolCall(call))
      }
    }
    // Hop budget exhausted: ask for a wrap-up without tools next request.
    this.history.push({
      role: 'system',
      content:
        'Tool budget for this turn is exhausted. Reply to the user in plain words now, without calling any tool.',
    })
    try {
      const closing = await this.requestCompletion()
      this.history.push(closing)
      const text = (closing.content ?? '').trim()
      if (text) {
        this.callbacks.onAssistantTranscript?.(text)
        this.speak(text)
      }
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  private async requestCompletion(): Promise<ChatMessage> {
    const payload = JSON.stringify({ messages: this.history })
    this.tm.sends.push({ t: Date.now(), type: 'chat', size: payload.length, buffered: this.queue.length })
    if (this.tm.sends.length > 200) this.tm.sends.shift()

    const started = Date.now()
    const res = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    const data = (await res.json().catch(() => ({}))) as {
      message?: ChatMessage
      usage?: { total_tokens?: number }
      error?: string
    }
    if (!res.ok || data.error) throw new Error(data.error || `chat request failed (${res.status})`)
    if (!data.message) throw new Error('chat response had no message')

    this.turnCount += 1
    this.totalTokens += data.usage?.total_tokens ?? 0
    this.tm.stats.push({
      t: Date.now(),
      ms: Date.now() - started,
      turns: this.turnCount,
      totalTokens: this.totalTokens,
    })
    if (this.tm.stats.length > 120) this.tm.stats.shift()
    this.tm.lastEvents.push({
      t: Date.now(),
      type: data.message.tool_calls?.length ? 'assistant.tool_calls' : 'assistant.message',
      raw: JSON.stringify(data.message).slice(0, 400),
    })
    if (this.tm.lastEvents.length > 60) this.tm.lastEvents.shift()

    // Keep only the fields the API needs back; strip provider extras.
    const { role, content, tool_calls } = data.message
    return {
      role: role ?? 'assistant',
      content: content ?? '',
      ...(tool_calls?.length ? { tool_calls } : {}),
    }
  }

  private async executeToolCall(call: ToolCall): Promise<ChatMessage> {
    const name = call.function?.name ?? ''
    let args: unknown = {}
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
    } catch {
      args = {}
    }

    let result: unknown = { ok: true }
    console.info('[lumen tool]', name, JSON.stringify(args).slice(0, 200))
    try {
      result = (await this.callbacks.onToolCall?.(name, args, call.id)) ?? { ok: true }
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    // A tool may return an `image` data URL (capture_canvas). The brain cannot
    // see, so the pixels are read server-side and the report text replaces
    // them in the tool result (ADR-0014).
    if (result && typeof result === 'object' && 'image' in result) {
      const record = result as Record<string, unknown>
      const image = typeof record.image === 'string' ? record.image : undefined
      delete record.image
      if (image) {
        try {
          record.rendered_layout_report = await this.describe(image, LAYOUT_QUESTION)
        } catch (err) {
          record.rendered_layout_report_error =
            err instanceof Error ? err.message : 'layout read failed'
        }
      }
    }

    console.info('[lumen tool result]', name, JSON.stringify(result).slice(0, 200))
    return {
      role: 'tool',
      tool_call_id: call.id,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    }
  }

  private async describe(dataURL: string, question?: string): Promise<string> {
    const res = await fetch(DESCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataURL, question }),
    })
    const data = (await res.json().catch(() => ({}))) as { description?: string; error?: string }
    if (!res.ok || !data.description) throw new Error(data.error || `describe failed (${res.status})`)
    return data.description
  }

  /**
   * Bound the history: keep leading system context (grounding) plus the most
   * recent messages, never letting a role:"tool" result lead without its
   * assistant tool_calls message (an orphaned tool message is an API error).
   */
  private pruneHistory() {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return
    const head = this.history.filter((m) => m.role === 'system')
    let tail = this.history.slice(-(MAX_HISTORY_MESSAGES - head.length))
    while (tail.length && tail[0].role === 'tool') tail = tail.slice(1)
    this.history = [...head, ...tail]
  }

  private count(kind: string) {
    this.tm.events[kind] = (this.tm.events[kind] ?? 0) + 1
  }

  // -------------------------------------------------------------------------
  // Voice cascade (Web Speech API) — best effort; text always works without it
  // -------------------------------------------------------------------------

  private startVoice() {
    type SRCtor = new () => SpeechRecognitionLike
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) {
      this.callbacks.onMic?.(false)
      return
    }
    try {
      const rec = new Ctor()
      rec.continuous = true
      rec.interimResults = false
      rec.lang = 'en-US'
      rec.onresult = (e) => {
        const last = e.results[e.results.length - 1]
        if (!last?.isFinal) return
        const transcript = last[0]?.transcript?.trim()
        // Ignore anything "heard" while we are speaking (self-echo guard).
        if (!transcript || this.speaking) return
        this.callbacks.onUserTranscript?.(transcript)
        this.enqueueUserTurn(transcript)
      }
      rec.onend = () => {
        // Chrome ends continuous recognition every ~60s; restart while live.
        if (this.voiceOn && !this.closed && !this.speaking) {
          try {
            rec.start()
          } catch {
            /* already restarting */
          }
        }
      }
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.voiceOn = false
          this.callbacks.onMic?.(false)
        }
      }
      rec.start()
      this.recognition = rec
      this.voiceOn = true
      this.callbacks.onMic?.(true)
    } catch {
      this.callbacks.onMic?.(false)
    }
  }

  private stopVoice() {
    this.voiceOn = false
    try {
      this.recognition?.stop()
    } catch {
      /* noop */
    }
    this.recognition = undefined
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* noop */
    }
    this.speaking = false
  }

  /** Speak a reply with the browser voice, pausing recognition meanwhile. */
  private speak(text: string) {
    const synth = window.speechSynthesis
    if (!synth || !this.voiceOn) return
    try {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.rate = 1.05
      const done = () => {
        this.speaking = false
        if (this.voiceOn && !this.closed) {
          try {
            this.recognition?.start()
          } catch {
            /* already running */
          }
        }
      }
      utterance.onend = done
      utterance.onerror = done
      this.speaking = true
      try {
        this.recognition?.stop()
      } catch {
        /* noop */
      }
      synth.speak(utterance)
    } catch {
      this.speaking = false
    }
  }
}

/** Fetch a remote image in the browser and re-encode as a data URL. */
async function toDataURL(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`image fetch failed (${res.status})`)
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
}
