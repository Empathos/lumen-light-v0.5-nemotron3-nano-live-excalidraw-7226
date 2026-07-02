# Spec: Lumen-Light

The shared source of truth for what we're building, how to run it, and how the
runtime contract behaves. Product rationale lives in [`../PRD.md`](../PRD.md);
structure in [`ARCHITECTURE.md`](ARCHITECTURE.md); decisions in
[`decisions/`](decisions/).

> "Beacon Table" is a legacy name kept only cosmetically in the PRD for
> historical reasons. The project name is **Lumen Light**.

## Objective

A voice-and-text thinking canvas: the user thinks out loud (or types), and an AI
collaborator draws on a shared Excalidraw whiteboard in real time — diagrams,
sticky notes, shapes, connectors, generated images, web-page screenshots — and
can brief the user through a document. Success = the agent visualizes ideas live,
the user stays in control of the canvas, and input modality (voice/text) makes no
difference to behavior.

## Tech Stack

- React 18, TypeScript 5, Vite 5
- Excalidraw 0.18 (canvas), dark theme by default
- Inworld Realtime API over WebRTC (voice + text + tools); LLM via an Inworld
  router, voice via `inworld-tts-2` + `inworld-stt-1` + `semantic_vad`
- Google Gemini ("Nano Banana") for `generate_image`; Tavily/Brave for
  `web_search`; thum.io for `screenshot_website`
- Server logic in `server/backend.ts`, exposed locally by a Vite dev middleware
  and in production by Netlify Functions (no other backend)
- localStorage scene persistence; installable PWA (manifest + service worker)
- browser-local Markdown session export for a leave-with artifact

## Commands

```text
Install: npm install
Dev:     npm run dev        # http://localhost:5180
Build:   npm run build      # tsc -b && vite build
Preview: npm run preview
Types:   npm run typecheck  # tsc -b --noEmit
```

Environment (`.env.local`, gitignored). The Inworld key is required for the live
session; each optional key unlocks one tool (omit to disable it):

```text
INWORLD_API_KEY=your-inworld-api-key
INWORLD_REALTIME_MODEL=inworld/lumen-router   # router id (see scripts/create-inworld-router.sh)
INWORLD_REALTIME_VOICE=Sarah
# optional: INWORLD_STT_MODEL=inworld/inworld-stt-1, INWORLD_TTS_MODEL=inworld-tts-2
GEMINI_API_KEY=...        # generate_image
TAVILY_API_KEY=...        # web_search (preferred); or BRAVE_API_KEY (fallback)
THUM_IO_KEY=...           # screenshot_website
```

## Project Structure

```text
./                            # Lumen-Light root
├── index.html
├── package.json, tsconfig*.json, vite.config.ts, netlify.toml
├── public/                      # PWA manifest, service worker, icons
├── server/
│   ├── backend.ts               # framework-agnostic logic (sessions, tools, image/search/screenshot)
│   └── realtimePlugin.ts        # Vite dev middleware wiring backend.ts to /api/*
├── netlify/functions/           # production /api/* (same backend.ts logic)
│   ├── realtime-{ice,session,call}.mts, image-generate.mts, search.mts, screenshot.mts
├── scripts/
│   └── create-inworld-router.sh # one-shot Inworld router creation
├── src/
│   ├── main.tsx, App.tsx, styles.css, vite-env.d.ts
│   ├── assistant/               # shared assistant contracts (types.ts, mockProvider.ts)
│   ├── canvas/                  # tool args -> Excalidraw scene
│   │   ├── LumenCanvas.tsx       # Excalidraw surface (dark default)
│   │   ├── drawCanvas.ts         # primary element list -> scene
│   │   ├── drawFlow.ts           # linear flow shortcut
│   │   ├── normalizeFlow.ts      # validate/coerce flow args
│   │   ├── excalidrawScene.ts    # connector routing/binding
│   │   ├── addImage.ts           # generated images / screenshots -> canvas
│   │   ├── docWindow.ts          # on-canvas briefing window
│   │   ├── markdownDoc.ts        # Markdown render + highlight
│   │   └── persistence.ts        # localStorage scene persistence
│   ├── realtime/
│   │   └── RealtimeClient.ts    # WebRTC + function calling
│   └── ui/
│       └── ConversationPanel.tsx # resizable + hideable panel
└── docs/                        # this suite
```

## Code Style

TypeScript, strict mode, function components, no default exports for modules.
Comments explain *why*, not *what*. Conventions: validate untrusted input before
it touches the canvas; mirror Excalidraw values from the installed package rather
than guessing.

## Runtime Contract (tools)

The agent drives the canvas exclusively through these tools. The two **draw**
tools replace what the previous draw call produced; images, screenshots, and the
document window are not erased by a redraw.

### `draw_canvas` (primary)

`{ title?, elements: Element[] }` where each `Element` is:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | unique; referenced by connectors |
| `type` | `shape` \| `text` \| `note` \| `connector` | |
| `geo` | enum | for `shape`: `rectangle, ellipse, diamond` (Excalidraw's only closed shapes; anything else falls back to `rectangle`) |
| `text` | string | label / note / connector label |
| `x,y,w,h` | number | optional; missing x/y auto-grids |
| `color` | enum | `black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red, white` |
| `fill` | enum | `none, semi, solid, pattern, fill` |
| `size` | enum | `s, m, l, xl` |
| `from,to` | string | for `connector`: source/target element ids |

### `draw_flow` (shortcut)

`{ title?, nodes: {id,label,kind}[], edges: {from,to,label?}[] }`,
`kind ∈ {start, process, decision, end}`. Maps start/end→ellipse,
decision→diamond, process→rectangle, joined by bound arrows.

### `capture_canvas` (vision feedback)

No args. Screenshots the canvas (Excalidraw `exportToBlob`, forced light theme
for legibility, PNG) and returns it to the model as an `input_image` so it can
verify layout and call a draw tool again to realign. See
[ADR-0005](decisions/ADR-0005-screenshot-feedback-loop.md).

### `read_canvas` (state inventory)

No args. Returns the same live-scene description used for session re-grounding
(`describeScene` in `src/canvas/summarizeScene.ts`) — shapes/connectors,
screenshots by host, generated images by prompt, the open-document title, and
text labels — as a small tool result (`{ ok, canvas }`, or `{ ok, empty }` on a
blank board), prefixed with the user's LIVE FOCUS — what they have selected
and how much of the board is on screen — so "this one" resolves to the
selection, and "this stuff" to what is in view (LL-010). This is the model's
cheap mid-session answer to "what's on the
board?": text only, bounded (≤40 labels, 60 chars each), so it carries none of
the data-channel size risk that killed auto-screenshots
([ADR-0011](decisions/ADR-0011-visual-grounding-on-resume.md)). Structure comes
from `read_canvas`; pixels still come from `capture_canvas`.

Both `read_canvas` and the grounding render their text from the **board
inventory** (`src/canvas/inventory/`, [ADR-0012](decisions/ADR-0012-canvas-agnostic-inventory.md)):
a canvas-agnostic model of the board — nodes and first-class links with stable
ids, bounds, and open provenance-namespaced tags (`source.*` / `ai.*` /
`user.*`, persisted on elements via `customData.lumenTags`; `source.*` is
derived-only and cannot be spoofed by stored data). The schema
(`schema.ts`) imports nothing from Excalidraw; `excalidrawAdapter.ts` is the
only file allowed to. Future per-asset vision, board navigation, and
annotation tools address the board through this layer.

### Buffered vision — pre-read at placement (LL-012)

When `screenshot_website` or `generate_image` places an image, the client
fires a background `/api/image/describe` call (Gemini vision, server-side,
HTTP — zero data-channel traffic): a literal transcription-first note of what
the image contains, stored on the element as an `ai.description` tag (so it
persists with the scene and is computed once, ever). `read_canvas` surfaces
the notes ("Image contents (pre-read, literal): …", bounded), making most
"what does it say?" questions instant text answers. `look_at_item` remains the
deep read when the note isn't enough.

### `look_at_item` (delegated per-item vision, LL-013)

`{ target, question }`. The close-up rung of the perception ladder — with NO
pixels on the data channel. The resolved item's ORIGINAL bytes (full
resolution; the canvas displays only a scaled copy) plus the model's question
go to `/api/image/describe` over HTTP; a fast vision model (Gemini,
server-side, direct — not through Inworld) answers strictly from the image,
and only that short text answer enters the session. Targets resolve via
`inventory/resolveTarget.ts`: `"selected"` → the live selection, then exact
label, label/host substring, then a unique kind word; ambiguity returns
candidates instead of guessing. Non-image elements are exported crisply and
sent down the same HTTP path. Doctrine: conversation rides the voice pipe,
pixels ride HTTP — always.

### `clear_canvas` (full wipe, confirmed)

`{ confirmed?, restore? }`. Removes **everything** — the diagram, sticky notes,
generated images, website screenshots, and the briefing document (memory +
`lumen-doc-v1`) — unlike a redraw, which only replaces the tool-drawn diagram.
Because the scene persists and there is no cross-wipe undo in Excalidraw, the
tool enforces safety itself rather than trusting the model to ask:

- **Two-step confirm:** a call without `confirmed: true` clears nothing and
  returns `needs_confirmation` plus an `about_to_clear` inventory; the model
  must get an explicit yes from the user, then call again with
  `confirmed: true`.
- **Undo snapshot:** just before wiping, the full board is stashed to
  `lumen-scene-undo-v1` / `lumen-doc-undo-v1` (`src/canvas/clearScene.ts`, one
  slot, overwritten per clear). `clear_canvas` with `restore: true` brings it
  back, including the doc window content.

### `generate_image`

`{ prompt, aspect?, x?, y? }`. Generates an image via Google Gemini ("Nano
Banana") server-side and places it on the canvas. Persists across draws.

### `screenshot_website`

`{ url, x?, y? }`. Captures a live public web page via thum.io server-side and
places it on the canvas as an image. Bare domains are normalized to `https://`.
Persists across draws.

### `web_search`

`{ query }`. Searches the live web (Tavily preferred, Brave fallback) and returns
a synthesized answer plus source results (`title, url, snippet`).

### Document briefing tools

- `open_document` — `{ markdown, title? }`. Opens a Markdown document in a window
  on the canvas; returns a section outline (each with an id).
- `read_document` — no args. Returns the window's current Markdown + outline,
  including anything the user pasted/edited into it.
- `highlight_passage` — `{ section?, text?, clear? }`. Highlights a passage in the
  window and scrolls it into view; call repeatedly while briefing.
- `brief_from_canvas` — `{ title? }`. Lifts text the user pasted/selected on the
  canvas into the briefing window. Prefers the selection; else the largest text
  block.

### Session re-grounding (cross-session continuity)

On every session connect, the client injects a compact **grounding** as the first
conversation item, framed as automated context (no `response.create`, and the
model must not thank the user for it), so a resumed session knows both the board
and the dialogue it is continuing:

- **Canvas summary** — `src/canvas/summarizeScene.ts` describes the live scene:
  shapes/connectors, text labels, the open-document title, and images identified
  by what they are (website screenshots by host, generated images by prompt — via
  `customData.lumenImage` set in `addImage.ts`). *Derived* from the scene each
  time, so it cannot drift from what the user sees.
  ([ADR-0009](decisions/ADR-0009-session-regrounding-from-canvas.md))
- **Conversation recap** — `src/assistant/transcriptStore.ts` replays the last
  ~12 turns of the persisted transcript (`lumen-transcript-v1`).
  ([ADR-0010](decisions/ADR-0010-persist-conversation-transcript.md))
When the board has images, the grounding text also tells the model that image
*content* can't be read from text and to call `capture_canvas` (the on-demand
vision path) before answering about an image. Auto-injecting a screenshot at
connect was tried and reverted — it broke the voice session
([ADR-0011](decisions/ADR-0011-visual-grounding-on-resume.md)).

The text parts are concatenated and injected via `RealtimeClient`'s
`getSessionGrounding` callback (after `session.updated`, never blocking connect).
Either part may be empty (e.g. a blank canvas or a first-ever session).

### Session export (leave-with artifact)

The panel's **Export** action downloads a browser-local Markdown artifact for
the current session. It combines the live board inventory, text labels, source
provenance (`source.url` screenshots, `source.prompt` generated images, and the
briefing document title/word count), plus a bounded transcript recap. The export
does not call a server, add auth, or sync across devices.

### Behavioral rules

- Invalid enum values / malformed elements are dropped during normalization.
- Connectors referencing unknown ids are skipped.
- Drawing replaces the previous tool-drawn shapes; user-drawn shapes, generated
  images, website screenshots, and the document window are left untouched.
- The `capture_canvas` screenshot is injected as a `user`-role message but
  labelled as an automated capture; the agent must not thank the user for it.

## Testing Strategy

See [`TESTING.md`](TESTING.md). Today: `npm run typecheck` + `npm run build` +
`npm test` (vitest) as gates, plus manual/automated browser verification. The
board inventory adapter and scene summarizer are unit-tested; `normalizeFlow`
and `normalizeCanvasElements` are the next priority targets.

## Boundaries

- **Always:** keep every API key server-side; validate tool args before drawing;
  run `npm run typecheck` before commit; mirror Excalidraw values from the package.
- **Ask first:** adding dependencies; changing the tool contract; changing the
  canvas-as-projection model; adding a new server-side provider/key.
- **Never:** commit `.env.local` or secrets; let the browser hold an API key;
  treat the Excalidraw scene JSON as the durable source of truth.

## Success Criteria

- Voice and text produce identical tool calls / canvas behavior.
- The agent draws varied structures (not only flowcharts) for open-ended prompts.
- A malformed tool call never crashes the canvas (validated away).
- `npm run build` and `npm run typecheck` pass clean.
- No API key ever appears in the client bundle or git history.

## Open Questions

- Persistence beyond localStorage — what (if anything) the user leaves a session
  with across devices.
- File/PDF upload + OCR as briefing sources (the paste/Markdown path is live).
- How strict the trust/review model should be on a live creative canvas.
