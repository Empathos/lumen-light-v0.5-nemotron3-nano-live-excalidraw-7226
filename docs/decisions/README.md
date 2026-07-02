# Architecture Decision Records

ADRs capture the *why* behind significant technical decisions — the context,
the choice, the alternatives rejected, and the consequences. They are not
deleted; when a decision changes, a new ADR supersedes the old one.

| # | Decision | Status |
|---|----------|--------|
| [0001](ADR-0001-canvas-first-thinking-surface.md) | Canvas-first thinking surface (not a chat window) | Accepted |
| [0002](ADR-0002-openai-realtime-webrtc.md) | OpenAI Realtime over WebRTC with ephemeral tokens | Accepted |
| [0003](ADR-0003-canvas-as-projection.md) | The canvas is a projection of tool calls, not the source of truth | Accepted |
| [0004](ADR-0004-full-tldraw-vocabulary.md) | Expose the full TLDraw vocabulary via `draw_canvas` | Superseded by [0008](ADR-0008-excalidraw-canvas.md) |
| [0005](ADR-0005-screenshot-feedback-loop.md) | Screenshot vision feedback loop (`capture_canvas`) | Accepted |
| [0007](ADR-0007-inworld-realtime-provider.md) | Inworld Realtime provider (proxied signaling + router) | Accepted (branch `v0.5-inworld-62426`) |
| [0008](ADR-0008-excalidraw-canvas.md) | Excalidraw as the canvas engine (supersedes 0004) | Accepted (branch `v0.5-inworld-62426-excalidraw`) |
| [0009](ADR-0009-session-regrounding-from-canvas.md) | Re-ground the model from the canvas on session start | Accepted (branch `v0.5-inworld-62426-excalidraw`) |
| [0010](ADR-0010-persist-conversation-transcript.md) | Persist + recap the conversation transcript (complements 0009) | Accepted (branch `v0.5-inworld-62426-excalidraw`) |
| [0011](ADR-0011-visual-grounding-on-resume.md) | Canvas screenshot in re-grounding when the board has images | Reverted (broke voice; model uses capture_canvas on demand) |
| [0012](ADR-0012-canvas-agnostic-inventory.md) | Canvas-agnostic board inventory with extensible tagging | Accepted (branch `v0.5-inworld-62426-excalidraw`) |
| [0013](ADR-0013-gemini-live-provider.md) | Gemini Live realtime provider — ephemeral tokens over WebSocket (supersedes 0007 here) | Accepted (branch `v0.5-gemini-live-7226`) |
| [0014](ADR-0014-nemotron-openrouter-chat-brain.md) | Nemotron 3 Nano chat brain via OpenRouter, cascade voice (supersedes 0013 here) | Accepted (branch `v0.5-nemotron3-nano-live-7226`) |

## Status values

`Proposed → Accepted → (Superseded by ADR-XXXX \| Deprecated)`
