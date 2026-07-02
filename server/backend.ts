/**
 * Framework-agnostic backend logic for Lumen's server-side proxies.
 *
 * Both the Vite dev-server plugin (local `npm run dev`) and the Netlify
 * Functions (production) import from here, so the realtime session config, tool
 * schemas, image generation, and web search all live in exactly one place.
 *
 * Nothing here touches Vite/Connect/Netlify types — it only deals in plain
 * inputs/outputs, so it can run in any Node 18+ runtime.
 */

export interface RealtimeEnv {
  apiKey?: string
  /** Inworld router id (preferred) or concrete model id for session.model. */
  model?: string
  /** Inworld voice name for TTS output. */
  voice?: string
  /** STT model id; defaults to inworld/inworld-stt-1. */
  sttModel?: string
  /** TTS model id; defaults to inworld-tts-2. */
  ttsModel?: string
  /** Google Gemini API key for the generate_image tool. Used server-side only. */
  geminiApiKey?: string
  /** Gemini image model ("Nano Banana"); defaults to gemini-2.5-flash-image. */
  imageModel?: string
  /** Tavily API key for the web_search tool (preferred). Server-side only. */
  tavilyApiKey?: string
  /** Brave Search API key — fallback web_search provider. Server-side only. */
  braveApiKey?: string
  /** thum.io API key for the screenshot_website tool. Server-side only. */
  thumApiKey?: string
}

/** Read the backend config from process.env (used by Netlify Functions). */
export function readEnv(): RealtimeEnv {
  const e = process.env
  return {
    apiKey: e.INWORLD_API_KEY,
    model: e.INWORLD_REALTIME_MODEL,
    voice: e.INWORLD_REALTIME_VOICE,
    sttModel: e.INWORLD_STT_MODEL,
    ttsModel: e.INWORLD_TTS_MODEL,
    geminiApiKey: e.GEMINI_API_KEY,
    imageModel: e.GEMINI_IMAGE_MODEL,
    tavilyApiKey: e.TAVILY_API_KEY,
    braveApiKey: e.BRAVE_API_KEY,
    thumApiKey: e.THUM_IO_KEY,
  }
}

const INWORLD_BASE = 'https://api.inworld.ai/v1/realtime'

const INSTRUCTIONS = `You are Lumen, a thinking-canvas collaborator.

The user thinks out loud — by voice or text — and a shared whiteboard sits
between you. Your job is to visualize their ideas on that canvas as the
conversation unfolds, so it becomes coherent and memorable.

You have the full visual vocabulary of a whiteboard. Use draw_canvas as your
primary tool. Don't limit yourself to flowcharts — choose whatever representation
fits the idea:
- mind maps and concept maps (a central shape with branches)
- sticky notes ("note") for brainstormed ideas, pros/cons, questions
- labelled shapes for entities, systems, people, options
- comparisons and quadrants, timelines, groupings, hierarchies
- free text labels ("text") for headings and annotations
- connectors (type "connector" with from/to element ids) to show relationships

Use color and fill meaningfully (e.g. green for positive, red for risk, yellow
sticky notes for raw ideas). The shape vocabulary is rectangle, ellipse, and
diamond — use ellipse for entities/people, diamond for decisions, rectangle for
everything else, and lean on color, fill, notes, and labels to carry meaning.
Give every element a unique "id" so connectors can reference them. You may set
x/y (canvas pixels, ~250px apart) to control layout, or omit them to
auto-arrange.

draw_flow is a shortcut for simple linear step-by-step processes only; prefer
draw_canvas for everything richer.

generate_image creates an actual picture (illustration, icon, mascot, reference
image) and drops it on the canvas. Reach for it when the idea is genuinely
visual and shapes/text can't capture it — not for things you can diagram. It
takes a few seconds, so say something brief first ("let me sketch that"). These
images stay put; draw_canvas/draw_flow won't erase them.

DOCUMENT BRIEFING — when the user shares a document or asks you to walk/brief
them through something, act like a warm live presenter, not a summarizer:
- call open_document with the full content as Markdown to put it in a window on
  the canvas; it returns a section outline with ids
- then go section by section, TALKING it through, and call highlight_passage to
  spotlight the exact passage you're discussing as you discuss it (by section id
  and/or by quoting the words) — keep the user's eyes where your voice is
- draw the connections between ideas on the canvas with draw_canvas as they come
  up, so the structure builds alongside the reading
- move at the user's pace; let them interrupt, ask, and redirect. Guide
  attention, don't dump a wall of text. The document window persists.
The window is editable: the user can paste or type their own text into it. If
they say they've pasted/added something, call read_document to see the current
contents before you brief or highlight.
If the user pastes a block of text directly onto the CANVAS (as a text object)
and asks you to brief them on it, call brief_from_canvas — it lifts that pasted
text into the document window so you can then highlight_passage through it.

web_search looks things up on the live internet. Use it whenever the user asks
about something current, factual, or outside what you reliably know (recent
events, prices, stats, docs, specific people/products) instead of guessing. Say
a brief filler first ("let me check"), then give a short spoken answer and
mention the source; you can also diagram the findings or open_document them.

Always pass the COMPLETE set of elements you want visible — each call replaces
what the previous call drew. Speak briefly and naturally while you draw; the
canvas is the main output, not your words. Don't read the diagram aloud
element-by-element.

You cannot see the canvas unless you look. You have two ways to look:
read_canvas returns an instant text inventory of what is on the board (shapes,
connectors, screenshots, images, document, labels) — use it whenever the user
asks what's on the canvas or you're about to build on existing content and
aren't sure what's there. capture_canvas returns an actual screenshot — use it
when layout or image content matters.

read_canvas also reports the user's LIVE FOCUS: what they have selected and
how much of the board is on their screen. When the user says "this", "this
one", or "here", call read_canvas and resolve it: their selection if they have
one, otherwise what is currently in view — never something off-screen.

Images are PRE-READ when they land on the board: read_canvas includes a short
literal note of what each image contains (its main text/headline). Answer
quick "what does it say/show?" questions straight from that note — instantly,
no tool pause. When the user needs MORE than the note covers (a specific
corner, a small date, details the note doesn't mention), call look_at_item.

When you need to READ what is inside one image beyond its pre-read note — do
NOT squint at capture_canvas: call
look_at_item with that item as the target. It returns the original
full-resolution pixels of just that item. capture_canvas is for overall
layout; look_at_item is for reading one thing closely.

NEVER describe what a screenshot or image contains from memory or from your
general knowledge of what that website usually shows. Only state what you can
actually read in an image returned by look_at_item or capture_canvas IN THIS
conversation. If you have not looked yet, look first. If the text is still
too small or unclear after looking, SAY SO plainly — "I can't read that part"
is always the right answer over a guess. Guessed content destroys the user's
trust in everything else you say.

After drawing something non-trivial,
call capture_canvas to get a screenshot of how it actually rendered. Inspect it
for overlapping shapes, bad spacing, off-screen or cut-off elements, and
connectors going to the wrong place — then call draw_canvas again with corrected
x/y/w/h to clean it up. Use this look-then-fix loop especially when you place
elements by coordinates. Don't over-do it: a quick check and one realignment
pass is usually enough.

When the user asks to clear/wipe the whole board or start fresh, use
clear_canvas — it removes EVERYTHING, including images and the document, unlike
a redraw. It is two-step by design: your first call returns needs_confirmation
and clears nothing; ask the user out loud ("clear the whole board — you're
sure?") and call again with confirmed: true only after an explicit yes. Never
skip straight to confirmed. If they change their mind afterwards, clear_canvas
with restore: true brings the board back.

IMPORTANT: the screenshot returned after capture_canvas is generated
automatically by the app — it is NOT provided by the user. Never thank the user
for screenshots, never say "thanks for the screenshot", and don't talk about
images being shared with you. Just look and silently adjust the canvas.

HOW YOU SPEAK
You are on a live voice call. Speak the way a person speaks, not the way a
chatbot writes. The canvas is the main output — your voice is the warm,
human thread around it.

TURN LENGTH: short by default — usually 5 to 12 words. A quick acknowledgement
("yeah", "mm-hm", "right", "oh nice") is often the whole turn. Go longer only
when the user asks you to explain or walk through something. Never read the
diagram aloud element-by-element.

NON-VERBALS — six bracketed sounds the voice can actually produce: [laugh],
[breathe], [sigh], [cough], [clear throat], [yawn]. Use only where a person
would really make that sound. At most one per turn, usually none.

STEERING TAGS — at most ONE [speak ...] tag per turn, and if used it MUST be the
very first thing in the turn. Use it only when the emotional register shifts:
- user excited / good news → [speak with bright energy, faster, warmer]
- user frustrated → [speak evenly, slower, lower volume, no defensiveness]
- user vulnerable or paused on something hard → [speak softly, slower, with warmth]
Default is no tag; let tone carry through word choice and rhythm. Once you shift
manner, keep it across turns without re-tagging.

SMALL DISFLUENCIES — sprinkle lightly, often none: fillers ("um", "uh", "hmm"),
soft openers ("oh", "well", "so", "okay"), hedges ("kind of", "maybe"),
self-repairs ("I, I think"). Zero to two per turn.

LANGUAGE: always speak English. Speech-to-text sometimes inserts stray
non-English characters (often Chinese/CJK) during silence or noise — treat any
such fragment as a transcription glitch, ignore it, and keep replying in English.
Switch languages ONLY if the user clearly and explicitly asks you to (e.g. "let's
speak Spanish"); never switch because of a single odd word or symbol. Steering
tags, non-verbals, and stage directions are always in English regardless.`

const DRAW_FLOW_TOOL = {
  type: 'function',
  name: 'draw_flow',
  description:
    'Create or replace the flow diagram on the shared canvas to represent the structure of what the user is discussing. Always pass the COMPLETE diagram; it replaces whatever was there before.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['nodes', 'edges'],
    properties: {
      title: {
        type: 'string',
        description: 'Optional short title for the diagram.',
      },
      nodes: {
        type: 'array',
        description: 'The diagram nodes.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'label', 'kind'],
          properties: {
            id: { type: 'string', description: 'Unique id used to reference this node in edges.' },
            label: { type: 'string', description: 'Short node label (max ~6 words).' },
            kind: {
              type: 'string',
              enum: ['start', 'process', 'decision', 'end'],
            },
          },
        },
      },
      edges: {
        type: 'array',
        description: 'Directed connections between nodes.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: {
            from: { type: 'string', description: 'Source node id.' },
            to: { type: 'string', description: 'Target node id.' },
            label: { type: 'string', description: 'Optional edge label.' },
          },
        },
      },
    },
  },
}

// Excalidraw's three generic closed shapes. (Excalidraw has no native
// triangle/star/cloud/etc.; richer geo would silently fall back to rectangle.)
const GEO_SHAPES = ['rectangle', 'ellipse', 'diamond']
const CANVAS_COLORS = [
  'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
  'orange', 'green', 'light-green', 'light-red', 'red', 'white',
]
const CANVAS_FILLS = ['none', 'semi', 'solid', 'pattern', 'fill']
const CANVAS_SIZES = ['s', 'm', 'l', 'xl']

const DRAW_CANVAS_TOOL = {
  type: 'function',
  name: 'draw_canvas',
  description:
    'Draw or replace the contents of the shared whiteboard using the full visual vocabulary: any shape, sticky notes, text labels, and connectors. Use this for mind maps, concept maps, comparisons, hierarchies, brainstorms — anything, not just flowcharts. Always pass the COMPLETE set of elements; it replaces whatever was there before.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['elements'],
    properties: {
      title: { type: 'string', description: 'Optional short title for the board.' },
      elements: {
        type: 'array',
        description: 'Every element that should be visible on the canvas.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'type'],
          properties: {
            id: { type: 'string', description: 'Unique id; referenced by connectors.' },
            type: {
              type: 'string',
              enum: ['shape', 'text', 'note', 'connector'],
              description:
                '"shape" = a geometric shape; "note" = sticky note; "text" = free text label; "connector" = an arrow between two elements.',
            },
            geo: {
              type: 'string',
              enum: GEO_SHAPES,
              description: 'For type "shape": which geometric shape to draw.',
            },
            text: { type: 'string', description: 'Label/content text (or connector label).' },
            x: { type: 'number', description: 'Optional canvas x in pixels.' },
            y: { type: 'number', description: 'Optional canvas y in pixels.' },
            w: { type: 'number', description: 'Optional width for shapes.' },
            h: { type: 'number', description: 'Optional height for shapes.' },
            color: { type: 'string', enum: CANVAS_COLORS, description: 'Optional color.' },
            fill: { type: 'string', enum: CANVAS_FILLS, description: 'Optional fill style for shapes.' },
            size: { type: 'string', enum: CANVAS_SIZES, description: 'Optional size (text/stroke scale).' },
            from: { type: 'string', description: 'For type "connector": source element id.' },
            to: { type: 'string', description: 'For type "connector": target element id.' },
          },
        },
      },
    },
  },
}

const CAPTURE_CANVAS_TOOL = {
  type: 'function',
  name: 'capture_canvas',
  description:
    'Take a screenshot of the current canvas so you can see how it actually rendered. Returns the image to you. Use it after drawing to verify layout (overlaps, spacing, off-screen or cut-off elements, misrouted connectors), then call draw_canvas again to realign if needed.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
}

const READ_CANVAS_TOOL = {
  type: 'function',
  name: 'read_canvas',
  description:
    'Get a fresh text inventory of what is currently on the canvas: counts of shapes and connectors, website screenshots (by site), generated images (by prompt), the open briefing document, and the text labels present — plus the user\'s LIVE FOCUS (what they have selected, and what is on their screen). Instant and cheap — call it whenever you need to know what is on the board, or whenever the user says "this" / "this one" / "here" so you resolve what they mean (selection first, then what is in view). It does NOT show layout or what images look like — call capture_canvas for those.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
}

const LOOK_AT_ITEM_TOOL = {
  type: 'function',
  name: 'look_at_item',
  description:
    'Look closely at ONE item on the canvas at full sharpness — returns that single item as an image (for screenshots and pictures: the original full-resolution pixels, not a blurry re-capture). Use this whenever text or details inside an image are too small to read in capture_canvas, or the user asks what a specific item says or shows. Reading the image takes several seconds — ALWAYS say a brief filler first ("let me take a close look — one moment") so the user never sits in silence. target examples: "selected" (what the user has selected), "the wikipedia screenshot", "the mini cooper", a label like "Budget Review", or just "screenshot" when there is only one.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['target'],
    properties: {
      target: {
        type: 'string',
        description:
          'Which item to look at: "selected", a quoted label, a site name, or a kind word like "screenshot"/"image"/"document".',
      },
    },
  },
}

const CLEAR_CANVAS_TOOL = {
  type: 'function',
  name: 'clear_canvas',
  description:
    'Clear the ENTIRE canvas — diagram, sticky notes, generated images, website screenshots, and the briefing document. Destructive and irreversible except for one saved snapshot. Two-step: first call it WITHOUT confirmed — you get needs_confirmation back and nothing is cleared; ask the user out loud if they really want the whole board wiped, and only after an explicit yes call it again with confirmed: true. If the user regrets a clear, call it with restore: true to bring back the board saved by the most recent clear. Use only when the user asks to clear/wipe/empty the whole board or start fresh — to replace just the diagram, call draw_canvas/draw_flow as usual.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      confirmed: {
        type: 'boolean',
        description:
          'Pass true ONLY after the user has explicitly confirmed, in this conversation, that the whole board should be wiped.',
      },
      restore: {
        type: 'boolean',
        description:
          'Pass true to undo the most recent clear: restores the snapshot taken just before that board was wiped.',
      },
    },
  },
}

const GENERATE_IMAGE_TOOL = {
  type: 'function',
  name: 'generate_image',
  description:
    'Generate an image from a text prompt and place it on the canvas as a real picture (e.g. an illustration, icon, logo sketch, mascot, diagram asset, photo-style reference). Use this when the user asks to "draw/show/picture/imagine" something visual that line shapes cannot express. Takes a few seconds — say something brief first. Generated images persist on the canvas and are NOT cleared by draw_canvas/draw_flow.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        description:
          'A vivid, self-contained description of the image to generate. Include subject, style, and mood. For a clean asset on the whiteboard, ask for a plain white (or simple) background in the prompt.',
      },
      aspect: {
        type: 'string',
        enum: ['square', 'portrait', 'landscape'],
        description: 'Optional aspect ratio. Defaults to square.',
      },
      x: { type: 'number', description: 'Optional canvas x in pixels. Omit to auto-place beside existing content.' },
      y: { type: 'number', description: 'Optional canvas y in pixels.' },
    },
  },
}

const OPEN_DOCUMENT_TOOL = {
  type: 'function',
  name: 'open_document',
  description:
    'Open a document in a window on the canvas so you can brief the user through it. Provide the full document as Markdown. Returns a section outline (each with an id) so you can then highlight passages with highlight_passage as you talk. Use this when the user shares a document or asks to be walked/briefed through content. The window persists; draw_canvas/draw_flow will not erase it.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['markdown'],
    properties: {
      title: { type: 'string', description: 'Optional short title shown atop the window.' },
      markdown: {
        type: 'string',
        description:
          'The document content as Markdown (headings, paragraphs, lists, blockquotes, code). Pass the COMPLETE document you want to brief from; calling again replaces it.',
      },
    },
  },
}

const HIGHLIGHT_PASSAGE_TOOL = {
  type: 'function',
  name: 'highlight_passage',
  description:
    'Highlight a passage in the open document window and scroll it into view, to direct the user\'s attention to what you are currently discussing. Call it repeatedly as you walk through the document, section by section. Address the passage by section id (from open_document) and/or by quoting the exact words to highlight.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      section: {
        type: 'string',
        description: 'A section id or slug from the open_document outline (e.g. "b3" or "risks").',
      },
      text: {
        type: 'string',
        description:
          'Exact words from the document to highlight. If omitted, the whole referenced section is highlighted.',
      },
      clear: { type: 'boolean', description: 'Set true to remove all current highlights.' },
    },
  },
}

const BRIEF_FROM_CANVAS_TOOL = {
  type: 'function',
  name: 'brief_from_canvas',
  description:
    "Take a block of text the user has pasted (or typed/selected) on the canvas and open it in the briefing document window, so you can walk through and highlight it. Use this when the user pastes text onto the canvas and asks to be briefed on 'this' / 'what I pasted'. Prefers the user's current selection; otherwise uses the largest text block on the canvas. After it opens, use highlight_passage as you talk.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', description: 'Optional short title shown atop the window.' },
    },
  },
}

const READ_DOCUMENT_TOOL = {
  type: 'function',
  name: 'read_document',
  description:
    'Read the current contents of the open document window, including any text the user has pasted or edited in it. Returns the Markdown and the section outline. Call this when the user says they pasted/added something to the window, or before briefing so you know exactly what it contains.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
}

const WEB_SEARCH_TOOL = {
  type: 'function',
  name: 'web_search',
  description:
    'Search the live web for current, factual, or external information you do not already know — recent news/events, prices, statistics, documentation, people, products, anything time-sensitive or beyond your training data. Returns a short synthesized answer plus source results (title, url, snippet). Takes a couple of seconds, so say something brief first ("let me look that up"). Keep the spoken reply concise, mention where it came from, and feel free to diagram or open_document the findings.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'The search query, phrased the way you would type it into a search engine.',
      },
    },
  },
}

const SCREENSHOT_WEBSITE_TOOL = {
  type: 'function',
  name: 'screenshot_website',
  description:
    'Capture a live screenshot of a public web page and place it on the canvas as an image. Use this when the user asks to "show/pull up/grab/screenshot" a website, article, or page, or wants to look at one together on the board. Pair it with web_search when you have a topic but not a URL: search first, then screenshot the best result. Takes a few seconds — say something brief first. The screenshot persists on the canvas and is NOT cleared by draw_canvas/draw_flow.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description:
          'The full URL of the page to capture, including the scheme (e.g. "https://example.com/article"). If the user gives a bare domain, prepend "https://".',
      },
      x: { type: 'number', description: 'Optional canvas x in pixels. Omit to auto-place beside existing content.' },
      y: { type: 'number', description: 'Optional canvas y in pixels.' },
    },
  },
}

/** The session config attached to every Inworld call (model, voice, tools). */
export function buildSession(env: RealtimeEnv) {
  return {
    type: 'realtime',
    model: env.model || 'inworld/lumen-router',
    instructions: INSTRUCTIONS,
    output_modalities: ['audio', 'text'],
    // Gemini "flash"/"pro" tiers are reasoning models: left to think, they burn
    // their token budget silently and reply tersely or not at all (= "no audio
    // reply" in voice) and add latency. For realtime we want direct answers, so
    // disable chain-of-thought. Raise this (LOW/MEDIUM) for deeper, slower turns.
    text_generation_config: { reasoning: { effort: 'NONE' } },
    // A little sampling variety makes phrasing feel less templated.
    temperature: 0.8,
    audio: {
      input: {
        transcription: { model: env.sttModel || 'inworld/inworld-stt-1' },
        // eagerness 'low' tolerates natural pauses instead of cutting the user
        // off and superseding the reply mid-sentence.
        turn_detection: { type: 'semantic_vad', eagerness: 'low' },
      },
      output: {
        model: env.ttsModel || 'inworld-tts-2',
        voice: env.voice || 'Sarah',
        speed: 1.0,
      },
    },
    // This is the demo's "naturalness" recipe (inworld.ai realtime demo):
    // CREATIVE delivery is the expressive TTS-2 preset (STABLE/BALANCED flatten
    // prosody); full_turn buffers the whole turn for best intonation; emit_once
    // is the recommended steering handling for TTS-2; responsiveness fillers
    // cover LLM warmup and play on the normal audio track. backchannel emits
    // "mm-hm"/"right" while the user is still speaking — its audio arrives as
    // base64 PCM on the data channel and is played client-side (RealtimeClient).
    providerData: {
      tts: {
        delivery_mode: 'CREATIVE',
        segmenter_strategy: 'full_turn',
        steering_handling: 'emit_once',
      },
      responsiveness: { enabled: true },
      backchannel: { enabled: true },
    },
    tools: [
      DRAW_CANVAS_TOOL,
      DRAW_FLOW_TOOL,
      CAPTURE_CANVAS_TOOL,
      READ_CANVAS_TOOL,
      LOOK_AT_ITEM_TOOL,
      CLEAR_CANVAS_TOOL,
      GENERATE_IMAGE_TOOL,
      OPEN_DOCUMENT_TOOL,
      HIGHLIGHT_PASSAGE_TOOL,
      READ_DOCUMENT_TOOL,
      BRIEF_FROM_CANVAS_TOOL,
      WEB_SEARCH_TOOL,
      SCREENSHOT_WEBSITE_TOOL,
    ],
    tool_choice: 'auto',
  }
}

/** GET Inworld ICE/STUN/TURN config. Returns the raw passthrough response. */
export async function getIceServers(env: RealtimeEnv): Promise<{ status: number; text: string }> {
  if (!env.apiKey) {
    return { status: 500, text: JSON.stringify({ error: 'INWORLD_API_KEY is not set.' }) }
  }
  const r = await fetch(`${INWORLD_BASE}/ice-servers`, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  })
  return { status: r.status, text: await r.text() }
}

/** POST an SDP offer to Inworld with the session config; return the SDP answer. */
export async function createCall(
  env: RealtimeEnv,
  sdp: string,
): Promise<{ status: number; text: string }> {
  if (!env.apiKey) {
    return { status: 500, text: JSON.stringify({ error: 'INWORLD_API_KEY is not set.' }) }
  }
  const r = await fetch(`${INWORLD_BASE}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sdp, session: buildSession(env) }),
  })
  return { status: r.status, text: await r.text() }
}

/** generate_image backend: prompt -> Google Gemini ("Nano Banana") -> data URL. */
/**
 * Pre-read an image (IDEA-010 → LL-012): literal 2-3 sentence description plus
 * a transcription of the most prominent readable text. Runs server-side over
 * HTTP at placement time, so answers about image contents become instant text
 * — no image ever crosses the data channel at question time.
 */
export async function describeImage(
  env: RealtimeEnv,
  dataURL: string,
): Promise<{ status: number; body: { description?: string; error?: string } }> {
  if (!env.geminiApiKey) return { status: 500, body: { error: 'GEMINI_API_KEY is not set.' } }
  const m = dataURL.match(/^data:(image\/[\w+.-]+);base64,(.+)$/)
  if (!m) return { status: 400, body: { error: 'expected a base64 image data URL' } }
  const model = 'gemini-2.5-flash'
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': env.geminiApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: m[1], data: m[2] } },
              {
                text:
                  'TRANSCRIBE FIRST: quote the main headline/title and the 2-3 most prominent readable text items exactly as written (section names, visible dates). THEN one short literal sentence on what the image shows. If some text is unreadable, say which. No speculation, no generic layout talk. Max 90 words.',
              },
            ],
          },
        ],
      }),
    },
  )
  const data = (await r.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    error?: { message?: string }
  }
  if (!r.ok) return { status: r.status, body: { error: data?.error?.message || 'describe failed' } }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join(' ').trim()
  if (!text) return { status: 502, body: { error: 'no description returned' } }
  return { status: 200, body: { description: text } }
}

export async function generateImage(
  env: RealtimeEnv,
  prompt: string,
  aspect?: string,
): Promise<{ status: number; body: { dataURL?: string; error?: string } }> {
  if (!env.geminiApiKey) {
    return { status: 500, body: { error: 'GEMINI_API_KEY is not set.' } }
  }
  const aspectRatio = aspect === 'portrait' ? '3:4' : aspect === 'landscape' ? '4:3' : '1:1'
  const model = env.imageModel || 'gemini-2.5-flash-image'
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': env.geminiApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          // Both modalities are required: omitting TEXT makes Gemini return an
          // empty parts array with no error.
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio },
        },
      }),
    },
  )
  const data = (await r.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[]
    error?: { message?: string }
  }
  if (!r.ok) {
    return { status: r.status, body: { error: data?.error?.message || 'image generation failed' } }
  }
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  const inline = part?.inlineData
  if (!inline?.data) {
    return { status: 502, body: { error: 'No image returned by Gemini.' } }
  }
  return { status: 200, body: { dataURL: `data:${inline.mimeType || 'image/png'};base64,${inline.data}` } }
}

/**
 * screenshot_website backend: url -> thum.io renders the page server-side -> we
 * fetch the image bytes and return a data URL (so the client reuses the exact
 * same addImageToCanvas path as generate_image). The key never leaves the server.
 */
export async function screenshotWebsite(
  env: RealtimeEnv,
  rawUrl: string,
): Promise<{ status: number; body: { dataURL?: string; url?: string; error?: string } }> {
  if (!env.thumApiKey) {
    return { status: 500, body: { error: 'THUM_IO_KEY is not set.' } }
  }
  // Normalize: accept bare domains, require http(s), reject anything else.
  let target = rawUrl.trim()
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return { status: 400, body: { error: `Invalid URL: ${rawUrl}` } }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { status: 400, body: { error: 'Only http(s) URLs can be screenshotted.' } }
  }
  // thum.io path-style API: options are path segments, the target URL is
  // appended literally (NOT percent-encoded). auth/<key> authenticates; width
  // sizes the output; wait gives JS-heavy pages a moment to paint.
  const endpoint = `https://image.thum.io/get/auth/${env.thumApiKey}/wait/3/width/1280/${target}`
  let r: Response
  try {
    r = await fetch(endpoint)
  } catch (err) {
    return { status: 502, body: { error: err instanceof Error ? err.message : 'screenshot fetch failed' } }
  }
  if (!r.ok) {
    return { status: r.status, body: { error: `thum.io error ${r.status}` } }
  }
  const contentType = r.headers.get('content-type') || 'image/png'
  if (!contentType.startsWith('image/')) {
    // thum.io returns text/plain with an error message on auth/quota problems.
    const detail = (await r.text().catch(() => '')).slice(0, 200)
    return { status: 502, body: { error: `thum.io did not return an image: ${detail || contentType}` } }
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length === 0) {
    return { status: 502, body: { error: 'thum.io returned an empty image.' } }
  }
  const dataURL = `data:${contentType};base64,${buf.toString('base64')}`
  return { status: 200, body: { dataURL, url: parsed.toString() } }
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

// Brave highlights matched terms with <strong> tags; strip markup/entities so
// the model (and any display) gets clean prose.
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .trim()
}

/**
 * Run a web search via whichever provider is configured. Tavily is preferred
 * (it returns an LLM-ready synthesized answer plus sources); Brave is the
 * fallback (web results only). Returns a compact, model-friendly payload.
 */
export async function runWebSearch(
  env: RealtimeEnv,
  query: string,
): Promise<{ answer?: string; results: SearchResult[] }> {
  if (env.tavilyApiKey) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.tavilyApiKey,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: 5,
      }),
    })
    const data = (await r.json()) as {
      answer?: string
      results?: { title?: string; url?: string; content?: string }[]
      error?: string
    }
    if (!r.ok) throw new Error(data?.error || `Tavily error ${r.status}`)
    return {
      answer: data.answer,
      results: (data.results ?? []).slice(0, 5).map((x) => ({
        title: stripHtml(x.title ?? ''),
        url: x.url ?? '',
        snippet: stripHtml(x.content ?? '').slice(0, 500),
      })),
    }
  }

  if (env.braveApiKey) {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': env.braveApiKey } },
    )
    const data = (await r.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string }[] }
      error?: { detail?: string }
    }
    if (!r.ok) throw new Error(data?.error?.detail || `Brave error ${r.status}`)
    return {
      results: (data.web?.results ?? []).slice(0, 5).map((x) => ({
        title: stripHtml(x.title ?? ''),
        url: x.url ?? '',
        snippet: stripHtml(x.description ?? '').slice(0, 500),
      })),
    }
  }

  throw new Error(
    'No web search provider configured. Set TAVILY_API_KEY (preferred) or BRAVE_API_KEY.',
  )
}
