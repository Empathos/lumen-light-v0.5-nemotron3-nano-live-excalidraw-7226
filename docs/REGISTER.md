# Product Register — Lumen Light (LL-)

QTrellis register. Rules: `~/.claude/skills/qtrellis/SKILL.md`
Stable = UCXM has no − and no ?. Scores are lazy and must carry reasons.
Backfilled 2026-07-02 from the sessions of 2026-06-27 → 2026-07-02.

## Register

| ID | Item (≤5 words) | From | Status | UCXM | Proof | Note |
|----|-----------------|------|--------|------|-------|------|
| LL-001 | Session re-grounding from canvas | — | built | | [ADR-0009](decisions/ADR-0009-session-regrounding-from-canvas.md) | theme: Continuity; resolved BUG-001 gap 1 |
| LL-002 | Conversation transcript persists locally | LL-001 | built | | [ADR-0010](decisions/ADR-0010-persist-conversation-transcript.md) | resolved BUG-001 gap 2 |
| LL-003 | Read canvas text inventory | LL-001 | built | ++++ | [SPEC](SPEC.md) | U: fixes blindness; C: 30min reuse; X: tiny text; M: no-arg tool |
| LL-004 | Clear canvas, confirmed, undoable | — | supported | ++0+ | [SPEC](SPEC.md) | theme: Control; U: restores lost capability; C: small; M: tool enforces confirm, not memory |
| LL-005 | Board inventory, extensible tagging | — | built | ++0+ | [ADR-0012](decisions/ADR-0012-canvas-agnostic-inventory.md) | theme: Structure; U: unlocks addressing; C: one tested module; M: closed schema |
| LL-006 | Hand-drawn content never invisible | LL-003 | built | | [KNOWN_ISSUES](KNOWN_ISSUES.md) | resolved BUG-004 |
| LL-007 | Model recognizes freehand drawings | LL-006 | built | | [KNOWN_ISSUES](KNOWN_ISSUES.md) | verified live: "house with sun" |
| LL-008 | Markdown session export artifact | LL-002 | built | | [sessionExport](../src/sessionExport.ts) | leave-with artifact from inventory + transcript (commit 71088ff) |
| LL-009 | Offline browser smoke harness | — | built | | [TESTING](TESTING.md) | theme: Quality; npm run smoke:offline gates typed canvas loop (commit 225eb9f) |
| LL-010 | Selection and viewport as focus | IDEA-007 | built | ++++ | [summarizeScene](../src/canvas/summarizeScene.ts) | U: "this one" resolves; C: appState read; X: bytes; M: deterministic — live voice check pending (provider silent 14:00+) |
| LL-011 | Look closely at one item | IDEA-003 | built | ++++ | [zoomItem](../src/canvas/zoomItem.ts) | verified live: read real Wikipedia headline from pixels; X: budget 250K chars after 609K payload silenced channel (RISK-001 confirmed twice) |
| RISK-003 | Some sites block thum.io capture | LL-007 | concept | | [KNOWN_ISSUES](KNOWN_ISSUES.md) | observed live 2026-07-02: MSN retry + Heidelberg tourism refused; Wikipedia fine |
| RISK-001 | Big payloads kill voice channel | — | concept | | [ADR-0011](decisions/ADR-0011-visual-grounding-on-resume.md) | theme: Physics; X player defects ≥ ~256KB per message |
| RISK-002 | Storage quota silently stops persistence | — | concept | | [ADR-0012](decisions/ADR-0012-canvas-agnostic-inventory.md) | theme: Persistence; screenshot images are megabytes; quota ~5MB; saveScene swallows failure |
| GAP-002 | Surface and survive storage-quota failures | RISK-002 | built | ++0+ | [persistence](../src/canvas/persistence.ts), [test](../src/canvas/persistence.test.ts) | warns on failed save; falls back to slim scene without files |
| GAP-001 | Verify Inworld accepts remote image_url | RISK-001 | built | ++-0 | [KNOWN_ISSUES](KNOWN_ISSUES.md) | verified 2026-07-02: Inworld fetches URLs, but Google-backed router rejects http(s) — inline base64 or gs:// only; X resolved to − for current stack |

## Ideas

| ID | Item (≤5 words) | From | Status | UCXM | Proof | Note |
|----|-----------------|------|--------|------|-------|------|
| IDEA-001 | Full-res vision by URL reference | RISK-001 | idea | ++-? | | X: − on current router (GAP-001); revives via IDEA-008 or IDEA-009 |
| IDEA-002 | Cheap fixed-size whole-board overview | RISK-001 | idea | ++0? | | U: Waldo queries; C: export scaling exists; M: legibility at 768px unverified |
| IDEA-003 | Per-asset zoom by node id | IDEA-001 | superseded | +++0 | | graduated to LL-011 |
| IDEA-004 | Take-me-to board navigation | LL-005 | idea | +++0 | | U: conversational navigation; C: one scrollToContent call; X: bytes; M: label matching may miss |
| IDEA-005 | Model annotates items with tags | LL-005 | idea | 0+0? | | C: write path exists; U: unclear until retrieval consumes tags; M: tagging quality unknown |
| IDEA-006 | Save board to Excalidraw library | LL-004 | idea | | | visible stash before clear; binary round-trip unverified |
| IDEA-010 | Pre-read images at placement | LL-011 | idea | | | buffered vision: background describe+OCR when image lands, stored as ai.* tags; answers become instant text |
| IDEA-008 | Host canvas images on GCS | GAP-001 | idea | | | gs:// URIs are the sanctioned Google path |
| IDEA-009 | Non-Google router model for vision | GAP-001 | idea | | | the http(s) refusal is Google-specific per the error |
| IDEA-007 | Selection and viewport as focus | LL-005 | superseded | ++++ | | graduated to LL-010 |
