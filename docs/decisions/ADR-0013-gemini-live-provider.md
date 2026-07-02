# ADR-0013: Gemini Live realtime provider (ephemeral tokens over WebSocket)

## Status
Accepted (repo `lumen-light-v0.5-gemini-live-excalidraw-7226`, branch `v0.5-gemini-live-7226`)

## Date
2026-07-02

## Context
This fork swaps the realtime "brain + voice" from Inworld (ADR-0007) to the
Google **Gemini Live API** (LL-014). Motivations:

- **One vendor for the whole intelligence stack.** This codebase already calls
  Gemini server-side for image generation (`generate_image`), image pre-reads
  (LL-012), and delegated vision (LL-013). Moving the realtime session to
  Gemini Live collapses three provider relationships into one key.
- **Vision without the detour.** GAP-001 found that http(s) `image_url`s are
  rejected by Google-backed models — inline base64 is the sanctioned path.
  Gemini Live accepts inline images natively in `clientContent`, so the
  capture/look loops stay on the same rules we already follow.
- **Native audio.** `gemini-2.5-flash-native-audio-latest` generates speech in
  the model (no separate TTS hop), with current-generation prosody and
  sharpened function calling.

What is genuinely different from Inworld:

1. **Transport & protocol.** WebSocket (`BidiGenerateContent`), not WebRTC;
   Gemini's own message vocabulary (`setup` / `realtimeInput` /
   `clientContent` / `toolCall` / `toolResponse` / `serverContent`), not the
   OpenAI Realtime events. Audio is raw base64 PCM16 in JSON messages —
   16 kHz up, 24 kHz down — so mic capture and playback are our job
   (AudioWorklet in, scheduled WebAudio buffers out), where WebRTC previously
   gave us media tracks for free.
2. **Auth.** Gemini has a real **ephemeral token** mechanism (the thing
   Inworld lacked, forcing ADR-0007's SDP proxy): the server mints a
   short-lived, single-use token and the browser connects **directly** to
   Google with it. No signaling proxy at all — and serverless-friendly, since
   Netlify functions cannot hold a WebSocket open anyway.
3. **Composed pipeline collapses.** No separate STT/TTS/router models; one
   model id plus a prebuilt voice name.

## Decision
- **`GET /api/live/token`** (Vite middleware in dev, Netlify function in
  prod) mints an ephemeral token via `@google/genai` (`authTokens.create`,
  `uses: 1`, ~1 min to start, ~30 min session) and returns it **with the full
  session `setup`** (model, voice, system instructions, tool declarations).
  The API key never leaves the server; the browser sends the returned setup
  as its first WebSocket message to
  `wss://…/v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=…`.
- **Keep the `RealtimeClient` seam identical** (`connect` / `disconnect` /
  `sendText` / `injectImage` / `telemetryDump` + the same callbacks), so
  `App.tsx`, the tool loop, and the canvas seam (ADR-0003/0004) are untouched.
- **Default model `gemini-2.5-flash-native-audio-latest`** (the Developer API's
  native-audio alias — note the Vertex AI docs use different ids that the
  `generativelanguage` endpoint rejects; verified live 2026-07-02), voice and
  model overridable via `GEMINI_LIVE_MODEL` / `GEMINI_LIVE_VOICE`.
- **Enable input+output transcription** in the setup (transcripts come from
  the same session — no separate STT), and **sliding-window context
  compression** so sessions are not killed by the native-audio context limit.
- **Branch-local swap**, same as ADR-0007: still no cross-provider
  abstraction; this is the fourth data point (OpenAI, Inworld, Ultravox,
  Gemini) for factoring one later.

## Alternatives Considered

### Server-side WebSocket proxy (browser → our server → Google)
- Pros: key never even reaches a token mint; central place for telemetry.
- Cons: Netlify functions can't hold long-lived WebSockets; would force a new
  hosting story. Rejected — ephemeral tokens exist precisely for this.

### `@google/genai` `ai.live.connect()` in the browser
- Pros: SDK owns the wire protocol and reconnects.
- Cons: still needs the ephemeral token flow; hides the message stream our
  telemetry (BUG-005) inspects; heavier client bundle. Deferred — raw WS
  keeps parity with the previous hand-rolled clients.

### `gemini-3.1-flash-live-preview` instead of 2.5 native audio
- Pros: a full model generation newer; likely stronger tool calling.
- Cons: preview-tier stability, and unverified here (the ephemeral-token smoke
  ran against the 2.5 default). Kept as a one-line env override
  (`GEMINI_LIVE_MODEL`) if 13-tool calling proves unreliable on native audio
  (the `M: ?` in LL-014).

## Consequences
- **The audio pipeline is ours now**: AudioWorklet mic capture at 16 kHz
  PCM16, gapless scheduled playback at 24 kHz, and explicit flush of queued
  audio on `serverContent.interrupted`. The old backchannel PCM player
  generalized into the main output path.
- **Inworld-only features dropped**: backchannel ("mm-hm" while the user
  talks), `[speak …]` steering tags, and bracketed non-verbals are gone from
  the instructions; native audio carries prosody on its own.
- **RISK-001 (big payloads) survives in new form**: tool-result images now
  travel as inline base64 over the WS; the size guard stays (relaxed to 1 MB)
  and oversized images still degrade to an honest "couldn't see it" note.
- `INWORLD_*` env vars are gone; live voice now needs only the
  `GEMINI_API_KEY` the repo already required for images.
- The offline mock provider still works with no key at all.
