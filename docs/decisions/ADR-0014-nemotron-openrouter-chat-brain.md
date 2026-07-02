# ADR-0014: Nemotron 3 Nano chat brain via OpenRouter (cascade voice)

## Status
Accepted (repo `lumen-light-v0.5-nemotron3-nano-live-excalidraw-7226`, branch `v0.5-nemotron3-nano-live-7226`)

## Date
2026-07-02

## Context
This fork swaps the "brain" from Gemini Live (ADR-0013) to **NVIDIA Nemotron 3
Nano** (`nvidia/nemotron-3-nano-30b-a3b`) served through **OpenRouter**
(LL-015). The motivation is a provider data point at the opposite end of the
cost/latency spectrum: measured ~$0.00005 and ~3.3 s for a full
tool-calling turn.

The fundamental difference from every previous provider (OpenAI ADR-0002,
Inworld ADR-0007, Gemini Live ADR-0013): **OpenRouter is a text chat API.**
There is no bidirectional audio, no session, no server VAD, no transcription
— just stateless `chat/completions` with OpenAI-style tool calling. Three
consequences shape the design:

1. **The session must live in the client.** The conversation history is an
   array of chat messages held by the browser; each turn round-trips the
   whole history through our server proxy.
2. **Voice must be a cascade.** Speech-to-text and text-to-speech have to
   come from somewhere else. The zero-key option is the browser's own Web
   Speech APIs (`SpeechRecognition` for STT, `speechSynthesis` for TTS).
3. **The model cannot see.** No image inputs on this model. Every visual
   loop must return text.

Also learned in smoke testing: Nemotron 3 is a **reasoning model** — left to
think it takes 60+ s per turn; with `reasoning: {enabled: false}` it answers
tool calls in ~3 s. This is the exact lesson the Inworld branch learned with
its router (`reasoning.effort: NONE`), now re-applied.

## Decision
- **`POST /api/chat`** (Vite middleware in dev, Netlify function in prod)
  proxies `{messages}` to OpenRouter, prepending the system instructions and
  the 13 tool schemas server-side (single source of truth, key never leaves
  the server). `GET /api/chat` returns `{model, hasKey}` so the client can
  fail fast. Reasoning disabled, temperature 0.8.
- **Keep the `RealtimeClient` seam identical** (fourth provider behind the
  same interface): `connect/disconnect/sendText/injectImage/telemetryDump`
  plus the same callbacks, so `App.tsx` and the canvas/tool loop are
  untouched. Inside, the client runs the agentic loop: send history → execute
  `tool_calls` via `onToolCall` → append `role:"tool"` results → repeat
  (capped) until a plain assistant message, which is emitted and spoken.
- **Voice = Web Speech cascade**: continuous `SpeechRecognition` feeds final
  transcripts into the same text path; assistant replies are spoken with
  `speechSynthesis`. Recognition pauses while speaking (no echo loop). If the
  browser lacks the APIs, the session degrades to text — same as no-mic
  behavior on previous providers.
- **All vision is delegated to text** (extends LL-013's "pixels never cross
  the channel" to the whole session): `capture_canvas` output is sent to the
  existing server-side Gemini describe endpoint with a layout-inspection
  question, and the model receives the returned *description text* in the
  tool result. `look_at_item` already worked this way. The instructions and
  the `capture_canvas` schema description are rewritten accordingly.

## Alternatives Considered

### NVIDIA NIM / build.nvidia.com directly
- Pros: first-party, no middleman margin.
- Cons: another key + endpoint shape to maintain; no ephemeral-token story
  either; OpenRouter gives the same model with the OpenAI schema we already
  speak and instant A/B against other models. Deferred.

### `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (omni variant)
- Pros: multimodal input could restore true canvas vision.
- Cons: free-tier only right now, reasoning-tuned (the exact latency failure
  mode we just avoided). Revisit if delegated text vision proves too lossy.

### Keep Gemini Live for voice, Nemotron for thinking
- Pros: real voice + cheap brain.
- Cons: two live providers in one session, split-brain instructions, unclear
  hand-off; this fork exists to isolate the Nemotron data point. Rejected.

### Streaming responses (SSE)
- Pros: lower perceived latency for long replies.
- Cons: complicates the tool loop for a model whose replies are 5–12 words by
  instruction; ~3 s turns are acceptable v1. Deferred.

## Consequences
- **Latency profile inverts**: turns are ~3 s flat (no VAD wait, no audio
  generation), but voice quality drops to the OS/browser TTS voice, and
  there is no barge-in — the model can't be interrupted mid-generation.
- **Netlify function timeout (10 s default)** bounds a single hop; multi-tool
  turns make several short hops (one per loop iteration), so each stays well
  under it. A pathological reasoning-on turn would blow it — reasoning stays
  hard-disabled server-side.
- **History is client-held and capped**; a page refresh starts a fresh brain
  (the canvas + transcript re-grounding from LL-001/LL-002 covers recovery,
  now injected as a system message).
- Chrome's `SpeechRecognition` ships audio to Google's recognizer — the
  "keys never leave the server" principle is intact, but voice audio itself
  now transits a third party in dev/demo use. Documented, accepted for a demo.
- `@google/genai` dependency dropped (it existed only for Live token mints);
  Gemini stays for image generate/describe via plain fetch. `GEMINI_LIVE_*`
  env vars replaced by `OPENROUTER_API_KEY` / `NEMOTRON_MODEL`.
- The offline mock provider still works with no keys at all.
