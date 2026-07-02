# Known Issues

Tracked bugs and their status. Resolved entries are kept (struck through in the
index) as a record. Fixes should reference the bug id in the commit message.

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| [BUG-001](#bug-001) | Assistant loses awareness of the canvas + conversation across sessions | High | ✅ Resolved |
| [BUG-002](#bug-002) | Assistant can't check what's on the canvas mid-session (stale picture) | High | ✅ Resolved |
| [BUG-003](#bug-003) | Assistant can't clear the canvas ("clear everything" does nothing) | High | ✅ Resolved |
| [BUG-004](#bug-004) | Assistant calls a visibly populated board "blank" after app restart | High | ✅ Resolved |
| [BUG-005](#bug-005) | Silences around look_at_item; session may stall after | Medium | 🔍 Investigating (mitigated) |

---

## BUG-001

**Assistant loses awareness of the canvas (and prior conversation) across sessions**

- **Severity:** High (breaks continuity — the core "come back to your thinking" promise)
- **Status:** ✅ Resolved — 2026-06-28. Gap #1 (canvas re-grounding) and gap #2
  (conversation persistence + recap) both shipped.
- **Reported:** 2026-06-28

### Steps to reproduce
1. Start a voice/text session and put some content on the canvas (have the agent
   draw shapes, generate an image, or paste/brief a document).
2. Stop the session.
3. Start a new session (or refresh and start one) and ask the assistant about what
   is on the canvas (e.g. "what did we put up here?", "add to the diagram").

### Expected
The assistant is re-grounded in the existing board: it knows what is already on
the canvas and can reference/extend it, and ideally remembers the prior
conversation — so returning to a canvas feels continuous.

### Actual
The assistant behaves as if the canvas is blank. It has no knowledge of existing
shapes/images/notes until it happens to call `capture_canvas`, and the prior
conversation is gone entirely.

### Root cause (verified in code)
Two distinct gaps:

1. **No canvas re-grounding at session start.** `buildSession` attaches only the
   static `INSTRUCTIONS` (`server/backend.ts`). Nothing injects a snapshot of the
   current scene (or a `capture_canvas` image) when a session connects, so the
   model has zero context about what is already on the board.
2. **Conversation is not persisted.** `src/canvas/persistence.ts` saves only the
   *scene* (`lumen-scene-v1` → elements/appState/files). The transcript lives in
   in-memory React state (`messages` in `src/App.tsx`) and is lost on reload / new
   session. The visual canvas survives; the dialogue and the model's awareness of
   it do not.

### Proposed direction
Lightweight session continuity until real auth/accounts exist (per the product
note that auth + a platform come later):

- **Re-ground the model on session start.** When a session connects and the
  canvas is non-empty, prime it with the current state — either a textual summary
  of the scene or an automatic `capture_canvas` image injected as the first
  `conversation.item` — so it can see/reference existing content immediately.
- **Persist the conversation locally.** Save the transcript (and a short rolling
  summary) alongside the scene — a cookie or a `localStorage` key (e.g.
  `lumen-session-v1`) — and replay/summarize it into the new session so the agent
  picks up where it left off.
- Keep it **device-local and keyless** for now; full cross-device persistence and
  identity land with authentication + the platform.

### Resolution
On every session connect, `RealtimeClient` injects a silent grounding context
item the moment the data channel opens, combining:

- **Gap #1 — canvas** ([ADR-0009](decisions/ADR-0009-session-regrounding-from-canvas.md)):
  `src/canvas/summarizeScene.ts` describes the live scene (shape/connector/image
  counts, labels, open-document title). Derived, not stored — can't drift.
- **Gap #2 — conversation** ([ADR-0010](decisions/ADR-0010-persist-conversation-transcript.md)):
  `src/assistant/transcriptStore.ts` persists the transcript to `localStorage`
  (`lumen-transcript-v1`), restores it on load, and recaps the last ~12 turns.

**Image-identity follow-up (2026-06-28):** the grounding initially summarized
images only as a count, so a resumed model knew images existed but couldn't say
*what* they were (e.g. it missed two website screenshots on the board). Fixed by
tagging each placed image with `customData.lumenImage` (`addImage.ts`) — a
screenshot's URL or a generated image's prompt — which `summarizeScene` now
surfaces ("2 website screenshots (google.com, cnn.com)"). Images placed before
this change have no tag and still show as a generic count.

**Visual-grounding attempt + revert (2026-06-28):** text can't convey image
*content* (the model saw "two images" and assumed generated, not website
snapshots). We tried auto-injecting a full-canvas screenshot as an `input_image`
on resume — but it **regressed the voice session to silence** (a full-canvas PNG
is too large to push over the WebRTC data channel at session start). **Reverted**
([ADR-0011](decisions/ADR-0011-visual-grounding-on-resume.md)). The grounding text
now instructs the model to call `capture_canvas` on demand when asked about an
image — the proven mid-session vision path — instead of pushing a screenshot up
front. Newly placed screenshots are still named by host in the text summary.

**Timing follow-up (2026-06-28):** the first cut injected the grounding
synchronously in the data-channel `open` handler, *before* `session.updated`. That
caused two live regressions — the model still saw a blank canvas (the item landed
in the default persona's context and was discarded on reconfigure), and a summary
error could block `setStatus('connected')` and freeze the UI. Fixed by marking the
session connected first, guarding the summary in try/catch, and **deferring the
injection until `session.updated`** (with a 1.5s fallback and a one-shot guard).

### Remaining (deferred — separate from this bug)
- **Cross-device / server-side** session storage and identity — land with
  authentication + the platform. The current persistence is device-local
  (`localStorage`).

---

## BUG-002

**Assistant can't check what's on the canvas mid-session (works from a stale picture)**

- **Severity:** High (the assistant reported the canvas wrong / couldn't answer
  "what do we have here?" in live use — 2026-06-29)
- **Status:** ✅ Resolved — 2026-07-01 via the `read_canvas` tool.
- **Reported:** 2026-06-29

### Steps to reproduce
1. Start a session and add content over time (draw, screenshot a website,
   generate an image).
2. Later in the same session, ask the assistant what is on the canvas.

### Expected
The assistant knows the current board state and describes it accurately.

### Actual
The assistant answers from its connect-time grounding (BUG-001), which is a
one-shot snapshot: anything added *after* connect, or beyond the summary's
caps, isn't in it. Its only refresh path was `capture_canvas` — a heavyweight
screenshot it rarely chose to call for a simple "what's here?" question — so it
guessed, or reported the canvas as emptier than it was.

### Root cause (verified in code)
The scene description (`summarizeScene`) was wired only into session-start
grounding (`getSessionGrounding` in `src/App.tsx`); the model had no tool to
request it on demand. Perception was connect-time-only text or on-demand pixels,
with nothing in between.

### Resolution
New `read_canvas` tool (no args): returns the live scene inventory —
`describeScene()` in `src/canvas/summarizeScene.ts`, the same derived
description used for grounding, minus the resume framing — as a small text tool
result. Bounded by design (≤40 labels, 60 chars each), so it carries none of
the data-channel size risk that reverted ADR-0011. Session instructions now
route the model: `read_canvas` for state, `capture_canvas` for layout/image
content.

### Remaining (deferred — separate from this bug)
- Reading image *content* without downscaling — URL-by-reference vision
  (Tier 2), gated on verifying Inworld accepts a remote `image_url`.
- Structured inventory with stable element ids (Tier 3 canvas-state work).

---

## BUG-003

**Assistant can't clear the canvas ("clear everything off the canvas" does nothing)**

- **Severity:** High (a capability the user relied on visibly stopped working —
  reported live 2026-06-29 alongside BUG-002)
- **Status:** ✅ Resolved — 2026-07-01 via the `clear_canvas` tool.
- **Reported:** 2026-06-29

### Steps to reproduce
1. Put durable content on the board (a website screenshot, a generated image,
   or the briefing document) plus a diagram.
2. Ask the assistant to "clear everything off of the canvas."

### Expected
The whole board is wiped (ideally after a confirmation), leaving a blank canvas.

### Actual
Nothing is removed, or only the diagram changes. The assistant has no way to
comply and may claim it cleared the board when it didn't.

### Root cause (verified in code)
There was never a clear-canvas capability. No tool deletes elements; the only
"clearing" that ever existed was a side effect of drawing — `commitSkeleton`
replaces the previous *diagram* on each draw call, and it early-returns on an
empty element list, so the model can't even clear by drawing nothing. The
illusion of a working "clear" held only while the board contained nothing but
the diagram; once durable assets existed (screenshots, generated images, the
doc window — all deliberately redraw-proof), it visibly broke.

### Resolution
New `clear_canvas` tool (`{ confirmed?, restore? }`): wipes the entire board —
diagram, images, screenshots, and the briefing document. Safety is enforced by
the tool, not model memory: a call without `confirmed: true` clears nothing and
returns `needs_confirmation` (plus an inventory of what would be lost), so the
model must get an explicit yes first. Before wiping, the full board is stashed
to `lumen-scene-undo-v1` / `lumen-doc-undo-v1` (`src/canvas/clearScene.ts`),
and `restore: true` brings it back — an accidental clear is no longer
permanent. Small text over the data channel; no size risk.

### Remaining (deferred — separate from this bug)
- Save-before-clear into the user's **Excalidraw Library** (visible, re-insertable
  stash) — Tier 3, pending verification that binary image files and the
  embeddable round-trip through library items.
- Partial clears ("just the images", "keep the diagram") — scope by kind.

---

## BUG-004

**Assistant calls a visibly populated board "blank" after force-closing and reopening the app**

- **Severity:** High (continuity promise broken in the user's hands, again)
- **Status:** ✅ Resolved — 2026-07-02. Fix verified end-to-end in a live
  session driven by browser automation: a board seeded with only freedraw
  strokes + a line, fresh app load, real Inworld session, question typed into
  the panel — the assistant answered "Yeah, I see those three hand-drawn lines
  on the board." (Pre-fix, `read_canvas` returned `empty` for the same board.)
- **Reported:** 2026-07-02 (PWA, deployed site; the build running at the time predates the inventory refactor)

### Steps to reproduce (as reported)
1. Have content on the board; force-close the installed PWA.
2. Reopen; the content is visible on the canvas (persistence worked).
3. Start a session and ask "can you see what's on the canvas?" → "actually
   it's a blank canvas."

### Leading hypothesis (fix shipped)
The scene summary only counted Lumen's own drawing vocabulary (closed shapes,
arrows, text, tagged images, the doc window). **Anything the user draws by
hand — freedraw pencil strokes, plain lines — was invisible to it**, so on a
board of hand-drawn content `describeScene` returned `null`: the session
grounding stayed silent about the canvas AND `read_canvas`/`capture_canvas`'s
empty-path told the model "canvas is empty". The model honestly relayed what
its tools said. (Flagged presciently by the ADR-0012 review; the inventory
made such elements addressable as `unknown` nodes but the text renderer still
skipped them.)

**Fix:** `describeScene` now renders unknown-kind nodes as "N other elements
(e.g. hand-drawn strokes or lines added by the user)" — a non-empty board can
never again summarize to "empty". Locked by a test.

### Alternative hypotheses (open until confirmed)
- The PWA's service worker served a stale build (bundle observed on the
  deployed site differed from the latest push at report time) — older builds
  still had grounding, so this alone doesn't explain the symptom.
- A grounding-delivery race after restart (session.updated timing) — would
  need session logs to confirm; the 1.5s fallback should cover it.

### To confirm
On the deployed site (same browser profile as the PWA), run in the console:
`JSON.parse(localStorage.getItem('lumen-scene-v1')).elements.map(e => e.type)`
— if the types are mostly `freedraw`/`line`, the hypothesis is confirmed.

---

## BUG-005

**Long silences around look_at_item; session may stop responding after**

- **Severity:** Medium (capability works — she read the real date — but dead
  air makes it feel broken, and one session went quiet afterwards)
- **Status:** 🔍 Investigating — mitigations shipped 2026-07-02 (filler-first
  instruction; image budget 250K→180K chars for channel headroom)
- **Reported:** 2026-07-02 (live session; user asked twice during the silence)

### Hypotheses
1. Vision generation latency: the Google-backed router takes many seconds on a
   1400px image; nothing tells the user to wait. (Mitigated: instruction now
   requires a spoken filler before looking.)
2. Channel strain from ~225K-char messages degrading the session afterwards
   (RISK-001 family). (Mitigated: budget lowered to 180K; oversized guard
   already drops rather than kills.)
3. Inworld-side turn management after image items — needs more live sessions
   to characterize.
