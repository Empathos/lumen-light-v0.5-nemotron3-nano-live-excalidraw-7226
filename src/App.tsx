import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { exportToBlob } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { LumenCanvas } from './canvas/LumenCanvas'
import { drawFlowDiagram } from './canvas/drawFlow'
import { normalizeFlowDiagram } from './canvas/normalizeFlow'
import { drawCanvasElements, normalizeCanvasElements } from './canvas/drawCanvas'
import { addImageToCanvas } from './canvas/addImage'
import { describeScene, sceneInventory, summarizeScene } from './canvas/summarizeScene'
import { loadTranscript, saveTranscript, summarizeTranscript } from './assistant/transcriptStore'
import { buildSessionExport, downloadMarkdownExport } from './sessionExport'
import {
  openDocument,
  highlightPassage,
  getDocument,
  briefFromCanvas,
  initDocWindow,
  clearDocument,
  rehydrateDocument,
} from './canvas/docWindow'
import { snapshotBeforeClear, wipeBoard, restoreLastClear } from './canvas/clearScene'
import { lookAtItem } from './canvas/zoomItem'
import { preReadImage } from './canvas/annotateImage'
import { fitChannelBudget } from './lib/imageBudget'
import { ConversationPanel } from './ui/ConversationPanel'
import { MockAssistantProvider } from './assistant/mockProvider'
import { RealtimeClient, type RealtimeStatus } from './realtime/RealtimeClient'
import type { ConversationEntry } from './assistant/types'

const PANEL_MIN = 280
const PANEL_MAX = 900
const PANEL_DEFAULT = 360
const PANEL_KEY = 'lumen-panel-w'
const PANEL_HIDDEN_KEY = 'lumen-panel-hidden'

export function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const mockRef = useRef(new MockAssistantProvider())
  const clientRef = useRef<RealtimeClient | null>(null)

  // Restore the prior transcript so a returning user sees the conversation, and
  // the model can be re-grounded in what was said (BUG-001, gap #2).
  const [messages, setMessages] = useState<ConversationEntry[]>(() => loadTranscript())
  const [status, setStatus] = useState<RealtimeStatus>('idle')
  const [micOn, setMicOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null)

  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_KEY))
    return Number.isFinite(saved) && saved >= PANEL_MIN ? Math.min(saved, PANEL_MAX) : PANEL_DEFAULT
  })
  const [panelHidden, setPanelHidden] = useState(
    () => localStorage.getItem(PANEL_HIDDEN_KEY) === '1',
  )
  const resizingRef = useRef(false)

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, String(panelWidth))
  }, [panelWidth])

  useEffect(() => {
    localStorage.setItem(PANEL_HIDDEN_KEY, panelHidden ? '1' : '0')
  }, [panelHidden])

  const onResizeStart = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    resizingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.classList.add('dragging')
    document.body.classList.add('resizing-x')
  }, [])

  const onResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return
    const next = window.innerWidth - e.clientX
    const max = Math.min(PANEL_MAX, window.innerWidth - 320)
    setPanelWidth(Math.round(Math.min(Math.max(next, PANEL_MIN), max)))
  }, [])

  const onResizeEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return
    resizingRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    e.currentTarget.classList.remove('dragging')
    document.body.classList.remove('resizing-x')
  }, [])

  const addMessage = useCallback((entry: ConversationEntry) => {
    setMessages((prev) => [...prev, entry])
  }, [])

  // Persist the transcript so it survives refresh / a new session.
  useEffect(() => {
    saveTranscript(messages)
  }, [messages])

  const handleReady = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
    // Re-bind/repopulate a persisted briefing window after reload or back-nav.
    initDocWindow(api)
  }, [])

  const handlePersistenceChange = useCallback((result: { ok: boolean; slimmed: boolean }) => {
    if (!result.ok) {
      setPersistenceWarning('Board changes are not saving. Export before closing this session.')
    } else if (result.slimmed) {
      setPersistenceWarning('Storage is nearly full. Text and layout saved; image files may need export.')
    } else {
      setPersistenceWarning(null)
    }
  }, [])

  const drawFlowFromArgs = useCallback((args: unknown) => {
    if (!apiRef.current) return { ok: false, error: 'canvas not ready' }
    const diagram = normalizeFlowDiagram(args)
    if (diagram.nodes.length === 0) return { ok: false, error: 'no nodes' }
    drawFlowDiagram(apiRef.current, diagram)
    return { ok: true, nodes: diagram.nodes.length, edges: diagram.edges.length }
  }, [])

  const drawCanvasFromArgs = useCallback((args: unknown) => {
    if (!apiRef.current) return { ok: false, error: 'canvas not ready' }
    const elements = normalizeCanvasElements(args)
    if (elements.length === 0) return { ok: false, error: 'no elements' }
    drawCanvasElements(apiRef.current, elements)
    return { ok: true, elements: elements.length }
  }, [])

  const generateImageFromArgs = useCallback(async (args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
    if (!prompt) return { ok: false, error: 'missing prompt' }
    const aspect = typeof a.aspect === 'string' ? a.aspect : undefined
    try {
      const resp = await fetch('/api/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspect }),
      })
      const data = (await resp.json()) as { dataURL?: string; error?: string }
      if (!resp.ok || !data.dataURL) {
        return { ok: false, error: data.error || 'image generation failed' }
      }
      const dims = await addImageToCanvas(api, data.dataURL, {
        x: typeof a.x === 'number' ? a.x : undefined,
        y: typeof a.y === 'number' ? a.y : undefined,
        meta: { kind: 'generated', label: prompt },
      })
      void preReadImage(api, dims.id, data.dataURL) // buffered vision (LL-012)
      return { ok: true, placed: true, ...dims }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const openDocumentFromArgs = useCallback((args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    const markdown =
      typeof a.markdown === 'string'
        ? a.markdown
        : typeof a.content === 'string'
          ? a.content
          : ''
    if (!markdown.trim()) return { ok: false, error: 'missing markdown' }
    const title = typeof a.title === 'string' ? a.title : undefined
    return openDocument(api, { title, markdown })
  }, [])

  const highlightFromArgs = useCallback((args: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>
    return highlightPassage({
      section: typeof a.section === 'string' ? a.section : undefined,
      text: typeof a.text === 'string' ? a.text : undefined,
      clear: a.clear === true,
    })
  }, [])

  const readDocument = useCallback(() => getDocument(), [])

  const webSearchFromArgs = useCallback(async (args: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>
    const query = typeof a.query === 'string' ? a.query.trim() : ''
    if (!query) return { ok: false, error: 'missing query' }
    try {
      const resp = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const data = (await resp.json()) as {
        query?: string
        answer?: string
        results?: { title: string; url: string; snippet: string }[]
        error?: string
      }
      if (!resp.ok) return { ok: false, error: data.error || 'search failed' }
      return { ok: true, query: data.query, answer: data.answer, results: data.results ?? [] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const screenshotWebsiteFromArgs = useCallback(async (args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    const url = typeof a.url === 'string' ? a.url.trim() : ''
    if (!url) return { ok: false, error: 'missing url' }
    try {
      const resp = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = (await resp.json()) as { dataURL?: string; url?: string; error?: string }
      if (!resp.ok || !data.dataURL) {
        return { ok: false, error: data.error || 'screenshot failed' }
      }
      const dims = await addImageToCanvas(api, data.dataURL, {
        x: typeof a.x === 'number' ? a.x : undefined,
        y: typeof a.y === 'number' ? a.y : undefined,
        meta: { kind: 'screenshot', label: data.url ?? url },
      })
      void preReadImage(api, dims.id, data.dataURL) // buffered vision (LL-012)
      return { ok: true, placed: true, url: data.url ?? url, ...dims }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const briefFromCanvasFromArgs = useCallback((args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    return briefFromCanvas(api, { title: typeof a.title === 'string' ? a.title : undefined })
  }, [])

  const captureCanvas = useCallback(async () => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const elements = api.getSceneElements()
    if (elements.length === 0) return { ok: true, empty: true, note: 'canvas is empty' }
    try {
      const blob = await exportToBlob({
        elements,
        appState: {
          ...api.getAppState(),
          // Force a light render for the AI screenshot regardless of the live UI
          // theme, so the self-correction loop sees clean, legible colors.
          theme: 'light',
          exportBackground: true,
          viewBackgroundColor: '#ffffff',
        },
        files: api.getFiles(),
        mimeType: 'image/png',
        exportPadding: 32,
      })
      // Whole-board captures grow with content; shrink to the channel budget
      // so a busy board can always photograph itself (layout needs no full res).
      const image = await fitChannelBudget(await blobToDataUrl(blob))
      return { ok: true, image }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  const readCanvas = useCallback(() => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const canvas = describeScene(api)
    if (!canvas) return { ok: true, empty: true, note: 'canvas is empty' }
    return { ok: true, canvas }
  }, [])

  const exportSession = useCallback(() => {
    const api = apiRef.current
    const inventory = api ? sceneInventory(api) : { version: 1 as const, nodes: [], links: [], tags: {} }
    downloadMarkdownExport(buildSessionExport({ inventory, transcript: messages }))
  }, [messages])

  const lookAtItemFromArgs = useCallback(async (args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    const target = typeof a.target === 'string' ? a.target : ''
    const question = typeof a.question === 'string' && a.question.trim() ? a.question.trim() : 'Transcribe the most prominent readable text and describe the image literally.'
    if (!target.trim()) return { ok: false, error: 'missing target' }
    return lookAtItem(api, target, question)
  }, [])

  const clearCanvas = useCallback((args: unknown) => {
    const api = apiRef.current
    if (!api) return { ok: false, error: 'canvas not ready' }
    const a = (args ?? {}) as Record<string, unknown>
    if (a.restore === true) {
      const result = restoreLastClear(api)
      if (result.ok) rehydrateDocument(api)
      return result
    }
    const count = api.getSceneElements().filter((e) => !e.isDeleted).length
    if (count === 0 && !getDocument().ok) {
      return { ok: true, empty: true, note: 'canvas is already empty' }
    }
    if (a.confirmed !== true) {
      return {
        ok: true,
        needs_confirmation: true,
        about_to_clear: describeScene(api) ?? `${count} element${count === 1 ? '' : 's'}`,
        note: 'Nothing was cleared. Ask the user out loud whether the WHOLE board should be wiped, and only after an explicit yes call clear_canvas again with confirmed: true.',
      }
    }
    const snapshotSaved = snapshotBeforeClear(api)
    const cleared = wipeBoard(api)
    clearDocument()
    return {
      ok: true,
      cleared,
      note: snapshotSaved
        ? 'Board wiped. A snapshot was saved — clear_canvas with restore: true brings it back if the user changes their mind.'
        : 'Board wiped. The undo snapshot could not be saved, so this clear cannot be restored.',
    }
  }, [])

  // Dev-only hook so the rich canvas tool can be exercised without a live
  // (paid, mic-gated) realtime session. Mirrors what the model's draw_canvas
  // tool call does. Available as window.__lumenDrawCanvas(elements) in dev.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as Record<string, unknown>
    w.__lumenDrawCanvas = (elements: unknown) => drawCanvasFromArgs({ elements })
    w.__lumenCapture = () => captureCanvas()
    w.__lumenReadCanvas = () => readCanvas()
    w.__lumenClearCanvas = (opts?: { confirmed?: boolean; restore?: boolean }) =>
      clearCanvas(opts ?? {})
    // GAP-001 spike: does Inworld accept a REMOTE image_url? Needs a live session.
    w.__lumenInjectImage = (url: string, text?: string) =>
      clientRef.current?.injectImage(url, text) ?? false
    w.__lumenLookAt = (target: string, question?: string) => lookAtItemFromArgs({ target, question })
    w.__lumenTelemetry = () => clientRef.current?.telemetryDump()
    // IDEA-007: select an element programmatically (live focus testing).
    w.__lumenSelect = (id: string) =>
      apiRef.current?.updateScene({ appState: { selectedElementIds: { [id]: true } } })
    w.__lumenGenerateImage = (prompt: string, aspect?: string) =>
      generateImageFromArgs({ prompt, aspect })
    // Place a local data URL directly (no API call) for testing image rendering.
    w.__lumenAddImage = (dataURL: string) =>
      apiRef.current ? addImageToCanvas(apiRef.current, dataURL) : undefined
    w.__lumenOpenDoc = (markdown: string, title?: string) =>
      openDocumentFromArgs({ markdown, title })
    w.__lumenHighlight = (section?: string, text?: string) =>
      highlightFromArgs({ section, text })
    w.__lumenReadDoc = () => readDocument()
    w.__lumenBriefFromCanvas = (title?: string) => briefFromCanvasFromArgs({ title })
    w.__lumenSceneInfo = () =>
      (apiRef.current?.getSceneElements() ?? [])
        .filter((e) => !e.isDeleted)
        .map((e) => ({ type: e.type, id: e.id }))
    w.__lumenWebSearch = (query: string) => webSearchFromArgs({ query })
  }, [
    drawCanvasFromArgs,
    captureCanvas,
    readCanvas,
    lookAtItemFromArgs,
    clearCanvas,
    generateImageFromArgs,
    openDocumentFromArgs,
    highlightFromArgs,
    readDocument,
    briefFromCanvasFromArgs,
    webSearchFromArgs,
  ])

  const connect = useCallback(() => {
    if (clientRef.current) return
    const client = new RealtimeClient({
      onStatus: (s) => setStatus(s),
      onMic: (enabled) => setMicOn(enabled),
      getSessionGrounding: () => {
        // Re-ground a resumed session in both the board and the dialogue. Both
        // are read fresh at connect time (canvas from the live scene, transcript
        // from storage), so neither can drift from the current state.
        const canvas = summarizeScene(apiRef.current)
        const conversation = summarizeTranscript(loadTranscript())
        return [canvas, conversation].filter(Boolean).join('\n\n') || null
      },
      onUserTranscript: (text) => addMessage({ role: 'user', text }),
      onAssistantTranscript: (text) => addMessage({ role: 'assistant', text }),
      onError: (message) => addMessage({ role: 'assistant', text: `[error] ${message}` }),
      onToolCall: (name, args) => {
        if (name === 'draw_canvas') return drawCanvasFromArgs(args)
        if (name === 'draw_flow') return drawFlowFromArgs(args)
        if (name === 'capture_canvas') return captureCanvas()
        if (name === 'read_canvas') return readCanvas()
        if (name === 'look_at_item') return lookAtItemFromArgs(args)
        if (name === 'clear_canvas') return clearCanvas(args)
        if (name === 'generate_image') return generateImageFromArgs(args)
        if (name === 'open_document') return openDocumentFromArgs(args)
        if (name === 'highlight_passage') return highlightFromArgs(args)
        if (name === 'read_document') return readDocument()
        if (name === 'brief_from_canvas') return briefFromCanvasFromArgs(args)
        if (name === 'web_search') return webSearchFromArgs(args)
        if (name === 'screenshot_website') return screenshotWebsiteFromArgs(args)
        return { ok: false, error: `unknown tool: ${name}` }
      },
    })
    clientRef.current = client
    void client.connect()
  }, [
    addMessage,
    captureCanvas,
    readCanvas,
    lookAtItemFromArgs,
    clearCanvas,
    drawCanvasFromArgs,
    drawFlowFromArgs,
    generateImageFromArgs,
    openDocumentFromArgs,
    highlightFromArgs,
    readDocument,
    briefFromCanvasFromArgs,
    webSearchFromArgs,
  ])

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect()
    clientRef.current = null
    setMicOn(false)
    setStatus('closed')
  }, [])

  const toggleSession = useCallback(() => {
    if (clientRef.current) disconnect()
    else connect()
  }, [connect, disconnect])

  // Text input routes through the live session when connected. Outside a
  // session, the local mock only exercises the canvas loop during development.
  const handleSend = useCallback(
    async (text: string) => {
      addMessage({ role: 'user', text })

      const client = clientRef.current
      if (client && client.state === 'connected') {
        client.sendText(text)
        return
      }

      setBusy(true)
      try {
        const actions = await mockRef.current.respond({ userText: text, history: messages })
        for (const action of actions) {
          if (action.type === 'message') {
            addMessage({ role: 'assistant', text: action.text })
          } else if (action.type === 'draw_flow') {
            drawFlowFromArgs(action.diagram)
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [addMessage, drawFlowFromArgs, messages],
  )

  return (
    <div
      className={`app${panelHidden ? ' app--panel-hidden' : ''}`}
      style={{ ['--panel-w']: `${panelWidth}px` } as CSSProperties}
    >
      <main className="canvas-wrap">
        {persistenceWarning ? (
          <div className="persistence-warning" role="status">
            {persistenceWarning}
          </div>
        ) : null}
        <LumenCanvas onReady={handleReady} onPersistenceChange={handlePersistenceChange} />
      </main>
      <div
        className="app__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel (double-click to reset)"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
      />
      <ConversationPanel
        messages={messages}
        busy={busy}
        status={status}
        micOn={micOn}
        onToggleSession={toggleSession}
        onExport={exportSession}
        onSend={handleSend}
        onHide={() => setPanelHidden(true)}
      />
      <button
        type="button"
        className="panel-reveal"
        onClick={() => setPanelHidden(false)}
        aria-label="Show chat panel"
        title="Show chat"
      >
        <span className="panel-reveal__chevron">‹</span>
        <span className="panel-reveal__label">Chat</span>
      </button>
    </div>
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })
}
