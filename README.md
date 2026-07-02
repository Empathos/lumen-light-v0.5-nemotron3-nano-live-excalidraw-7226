# Lumen Light

A voice-and-text **thinking canvas** where an AI collaborator diagrams your
conversation as it happens — generating pictures, screenshotting websites, and
bringing her own opinions and directions.

You open a large open whiteboard (Excalidraw), talk or type, and the assistant
turns what you say into flow diagrams, shapes, generated images, and structure in
real time — so the ideas become coherent while you're still working through them.
The canvas is the main stage; the assistant draws on it with you, can pull live
information and web pages onto the board, and can brief you through a document.

See [`PRD.md`](./PRD.md) for the product vision and scope.

## Documentation

| Document | What's in it |
|----------|--------------|
| [`PRD.md`](./PRD.md) | Product vision, users, capabilities, scope. |
| [`docs/SPEC.md`](./docs/SPEC.md) | Runtime contract (tools), commands, structure, boundaries, success criteria. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Components and the data/event flow. |
| [`docs/decisions/`](./docs/decisions/) | ADRs — the *why* behind key choices. |
| [`docs/TESTING.md`](./docs/TESTING.md) | How changes are verified. |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | How to work on this project. |

## Status

Branch `v0.5-inworld-62426-excalidraw`. Working today:

- **Excalidraw canvas** as the main surface, in **dark mode by default**, with the
  scene (drawings, images, briefing window) **persisted to localStorage** so it
  survives a refresh or back-navigation.
- **Inworld Realtime voice + text session** over WebRTC, where the model calls
  Lumen's tools to diagram the conversation live. The "brain" is an Inworld
  **router** (advanced model + fallback); the voice is Inworld's `inworld-tts-2`
  with `semantic_vad`.
- **An offline fallback**: with no live session, typed text uses a deterministic
  local parser so the app is useful with no keys/network.
- **Generated images on the canvas (`generate_image`)** — the agent generates a
  picture (Google "Nano Banana") from a prompt and drops it onto the board, for
  anything line shapes can't express.
- **Live web search (`web_search`)** — never frozen at a training cutoff. The
  agent looks things up on the open web mid-conversation, synthesizes an answer
  *with sources*, and can diagram or brief the findings on the spot.
- **Website screenshots on the canvas (`screenshot_website`)** — say "pull up
  that page" and the live web page is captured and dropped onto the board as an
  image: no screen-share, no copy-paste, identical on desktop and mobile. Chain
  it with `web_search` to *find* a source and *show* it in a single move.
- **Document briefing (`open_document` / `read_document` / `highlight_passage` /
  `brief_from_canvas`)** — open or paste a document into a window on the canvas
  and have the agent walk you through it, highlighting passage by passage as it
  speaks — like a presenter taking a room through a document.
- **Board awareness (`read_canvas`)** — the agent can check a live text
  inventory of the canvas at any time (shapes, screenshots by site, generated
  images, document, labels), so it knows what's on the board mid-session
  without taking a screenshot.
- **Clear the board by voice (`clear_canvas`)** — "clear everything off the
  canvas" wipes the whole board (diagram, images, screenshots, document), but
  only after the agent confirms out loud — and a snapshot is kept so "bring it
  back" undoes an accidental clear.
- **Session export** — download a local Markdown leave-with artifact containing
  the board inventory, text labels, source provenance, briefing document note,
  and recent transcript recap.
- **A resizable, hideable conversation panel** (drag to resize; tab to hide it
  off-screen and bring it back), and an **installable PWA** (web-app manifest +
  service worker) so it can be added to a phone home screen.

Both voice and typed text drive the **same** tool calls / canvas actions, so the
input modality is fully decoupled from canvas behavior.

## Setup

Copy the example env file (gitignored) and add your keys:

```bash
cp .env.local.example .env.local
```

```bash
# Required for the live voice/text collaborator:
INWORLD_API_KEY=your-inworld-api-key
INWORLD_REALTIME_MODEL=inworld/lumen-router   # a router id (see below)
INWORLD_REALTIME_VOICE=Sarah

# Optional — each one unlocks a tool; omit to disable that tool:
GEMINI_API_KEY=your-gemini-api-key            # generate_image ("Nano Banana")
TAVILY_API_KEY=your-tavily-api-key            # web_search (preferred)
# BRAVE_API_KEY=your-brave-api-key            # web_search (fallback)
THUM_IO_KEY=your-thum-io-key                  # screenshot_website
```

Create the router the model uses as its brain (one advanced model + a fallback):

```bash
INWORLD_API_KEY=... ./scripts/create-inworld-router.sh
# override defaults if you like:
#   ROUTER_NAME=lumen-router PRIMARY_MODEL=... FALLBACK_MODEL=... \
#   INWORLD_API_KEY=... ./scripts/create-inworld-router.sh
```

Or create it in the Inworld Portal (Routers → new router) and copy its
`inworld/<name>` id into `INWORLD_REALTIME_MODEL`. The Inworld key is required for
the live collaborator; the offline parser works without any keys.

> Security: every key is used **only** by the server side (the Vite dev
> middleware locally, or the Netlify Functions in production), which proxies the
> calls to Inworld / Gemini / the search + screenshot providers. Keys never reach
> the browser. Never commit `.env.local`.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default http://localhost:5180/).

**Voice:** click **Start voice session**, allow microphone access, and think out
loud. The agent speaks back and diagrams what you say on the canvas.

**Text:** type into the panel and press Enter. In a live session this goes to the
realtime model; offline it uses the local parser. For example:

```text
research -> draft -> review -> ship
```

## Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies. |
| `npm run dev` | Start the dev server (http://localhost:5180). |
| `npm run build` | Typecheck + production build (`tsc -b && vite build`). |
| `npm run typecheck` | Types only (`tsc -b --noEmit`). |
| `npm run preview` | Preview the production build. |

## Tools (what the agent can do)

The agent drives everything through these tools. Voice and text resolve to the
**same** calls. Full schemas + behavior are in [`docs/SPEC.md`](./docs/SPEC.md).

| Tool | What it does |
|------|--------------|
| `draw_canvas` | **Primary.** Draw a free-form element list — shapes, sticky notes, text labels, and connectors with color/fill/size/position. Replaces the previous draw call. |
| `draw_flow` | Shortcut for quick linear flowcharts (`start`/`process`/`decision`/`end` → shapes + bound arrows). |
| `capture_canvas` | Screenshot the canvas and feed it back to the model as an image, so it can *see* its own layout and call a draw tool again to realign. |
| `read_canvas` | On-demand text inventory of the board (shapes, connectors, screenshots by site, generated images by prompt, document, labels) — the cheap way for the model to check what's on the canvas mid-session. |
| `look_at_item` | Zoom into a single item — returns its original full-resolution pixels so text inside screenshots is actually readable. |
| `clear_canvas` | Wipe the whole board — diagram, images, screenshots, and document — with a tool-enforced confirmation step and a restorable undo snapshot (`restore: true`). |
| `generate_image` | Generate an image from a prompt (Google "Nano Banana") and place it on the canvas. Persists across draws. |
| `screenshot_website` | Capture a live public web page and place it on the canvas as an image. Persists across draws. |
| `web_search` | Search the live web; returns a synthesized answer plus source results (title, url, snippet). |
| `open_document` | Open a Markdown document in a window on the canvas and return a section outline to brief from. |
| `read_document` | Read back the document window's current contents, including anything the user pasted/edited in it. |
| `highlight_passage` | Highlight a passage in the document window and scroll it into view, as the agent talks through it. |
| `brief_from_canvas` | Lift text the user pasted/selected on the canvas into the briefing window to walk through. |

### Canvas vocabulary (`draw_canvas`)

Each element is one of:

- `shape` — one of Excalidraw's three closed shapes (`rectangle`, `ellipse`,
  `diamond`) with optional `color`, `fill`, `size`, `w`/`h`. (Other geos fall
  back to `rectangle` — see [ADR-0004](./docs/decisions/ADR-0004-full-tldraw-vocabulary.md).)
- `note` — a sticky-style labelled rectangle.
- `text` — a free text label.
- `connector` — an arrow bound between two elements (`from`/`to` ids), routed
  border-to-border.

Mind maps, concept maps, comparisons, hierarchies, brainstorms — not just
flowcharts. Style values are validated before drawing (see `normalizeCanvasElements`
in `src/canvas/drawCanvas.ts`): colors `black, grey, light-violet, violet, blue,
light-blue, yellow, orange, green, light-green, light-red, red, white`; fills
`none, semi, solid, pattern, fill`; sizes `s, m, l, xl`.

Both draw tools replace what the previous draw call drew. Generated images,
website screenshots, and the document window are **not** cleared by a redraw. The
canvas is a view of the latest tool calls, never the durable source of truth.

## Architecture (the important seam)

Input modality is decoupled from canvas behavior. Voice and text both resolve to
the same tool calls, which are projected onto the canvas:

```text
voice (mic) ─┐                                ┌─► draw_canvas / draw_flow ─┐
             ├─► Inworld Realtime session ────┤  generate_image / screenshot │
text (live) ─┘  (router brain + inworld-tts)  ├─► open_document / web_search ├─► canvas
                                              └─► spoken/text reply          ┘  (Excalidraw)

text (offline) ─► MockAssistantProvider ──────► draw_flow ─────────────────────► canvas
```

Inworld speaks the OpenAI Realtime protocol (data channel `oai-events`, same
events), so only the connection + session-config layer is Inworld-specific.

Server logic lives in `server/backend.ts` (framework-agnostic) and is wired two
ways:

- **Dev:** `server/realtimePlugin.ts` — Vite dev-server middleware exposing
  `/api/realtime/{ice,session,call}`, `/api/image/generate`, `/api/search`, and
  `/api/screenshot`. Holds the keys; they never reach the browser. See
  [ADR-0007](./docs/decisions/ADR-0007-inworld-realtime-provider.md).
- **Production:** `netlify/functions/*.mts` — the same `backend.ts` logic exposed
  as Netlify Functions at the identical `/api/...` paths.

Client:

- `src/realtime/RealtimeClient.ts` — fetches ICE servers, opens the WebRTC peer
  connection (mic capture, model audio playback, data channel), does the proxied
  SDP exchange, and handles function calls
  (`response.function_call_arguments.done` → run tool → `function_call_output`
  → `response.create`).
- `src/canvas/drawCanvas.ts` / `drawFlow.ts` — project tool args onto Excalidraw
  elements. `normalizeFlow.ts` / `normalizeCanvasElements` defensively coerce
  tool-call args into valid scenes before touching the canvas.
- `src/canvas/excalidrawScene.ts` — connector routing/binding helpers.
- `src/canvas/addImage.ts` — places generated images / website screenshots on the
  canvas.
- `src/canvas/docWindow.ts` / `markdownDoc.ts` — the on-canvas briefing window and
  its Markdown rendering/highlighting.
- `src/canvas/persistence.ts` — localStorage scene persistence across reloads.
- `src/canvas/LumenCanvas.tsx` — the Excalidraw surface (dark theme default).
- `src/ui/ConversationPanel.tsx` — text input, session controls, transcripts;
  resizable + hideable.
- `src/App.tsx` — wires inputs → tool calls → canvas.

## Roadmap (near-term)

- Richer briefing sources: the canvas-paste/Markdown briefing path is live —
  extend it with file/PDF upload and OCR so longer documents load directly.
- Richer diagram types beyond Excalidraw's three closed shapes.
- Router experiments: A/B model variants and conditional (metadata/CEL) routing.
- Code-split the production bundle (Excalidraw is large).

## Contributing

We work spec-first and record significant decisions as ADRs. Before changing
behavior, skim [`CONTRIBUTING.md`](./CONTRIBUTING.md), update
[`docs/SPEC.md`](./docs/SPEC.md) if the contract changes, and add an ADR under
[`docs/decisions/`](./docs/decisions/) for architectural choices. Run
`npm run typecheck` and `npm run build` before committing, and never commit
`.env.local`.
