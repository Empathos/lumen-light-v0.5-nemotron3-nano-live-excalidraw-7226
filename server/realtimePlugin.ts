import type { Plugin, Connect } from 'vite'
import type { ServerResponse } from 'node:http'
import {
  type RealtimeEnv,
  buildSession,
  getIceServers,
  createCall,
  generateImage,
  describeImage,
  runWebSearch,
  screenshotWebsite,
} from './backend'

/**
 * Dev-server endpoints that proxy Lumen's server-side calls during local
 * `npm run dev`. The actual logic lives in ./backend (shared with the Netlify
 * Functions used in production); this file only wires it to Vite's Connect
 * middleware. The API keys NEVER leave the server.
 *
 *   GET  /api/realtime/ice      -> Inworld ice-servers
 *   GET  /api/realtime/session  -> session config (client applies via session.update)
 *   POST /api/realtime/call     -> Inworld calls (SDP offer -> answer)
 *   POST /api/image/generate    -> Gemini image generation
 *   POST /api/image/describe    -> Gemini vision pre-read (LL-012)
 *   POST /api/search            -> web search (Tavily/Brave)
 *   POST /api/screenshot        -> website screenshot (thum.io)
 */

export type { RealtimeEnv }

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(text)
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function lumenRealtimePlugin(env: RealtimeEnv): Plugin {
  return {
    name: 'lumen-realtime',
    configureServer(server) {
      server.middlewares.use(
        '/api/realtime/ice',
        async (_req: Connect.IncomingMessage, res: ServerResponse) => {
          try {
            const { status, text } = await getIceServers(env)
            sendText(res, status, text)
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )

      // The client applies this via session.update the moment the data channel
      // opens (Inworld starts every call with DEFAULT config). No secret here.
      server.middlewares.use(
        '/api/realtime/session',
        (_req: Connect.IncomingMessage, res: ServerResponse) => {
          sendJson(res, 200, buildSession(env))
        },
      )

      server.middlewares.use(
        '/api/realtime/call',
        async (req: Connect.IncomingMessage, res: ServerResponse) => {
          try {
            const body = await readBody(req)
            const { sdp } = JSON.parse(body || '{}') as { sdp?: string }
            if (!sdp) {
              sendJson(res, 400, { error: 'Missing sdp offer in request body.' })
              return
            }
            const { status, text } = await createCall(env, sdp)
            sendText(res, status, text)
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )

      server.middlewares.use(
        '/api/image/generate',
        async (req: Connect.IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Use POST.' })
            return
          }
          try {
            const body = await readBody(req)
            const { prompt, aspect } = JSON.parse(body || '{}') as {
              prompt?: string
              aspect?: string
            }
            if (!prompt || typeof prompt !== 'string') {
              sendJson(res, 400, { error: 'Missing prompt.' })
              return
            }
            const { status, body: out } = await generateImage(env, prompt, aspect)
            sendJson(res, status, out)
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )

      server.middlewares.use(
        '/api/image/describe',
        async (req: Connect.IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Use POST.' })
            return
          }
          try {
            const body = await readBody(req)
            const { dataURL, question } = JSON.parse(body || '{}') as {
              dataURL?: string
              question?: string
            }
            if (!dataURL || typeof dataURL !== 'string') {
              sendJson(res, 400, { error: 'Missing dataURL.' })
              return
            }
            const { status, body: out } = await describeImage(env, dataURL, question)
            sendJson(res, status, out)
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )

      server.middlewares.use(
        '/api/search',
        async (req: Connect.IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Use POST.' })
            return
          }
          try {
            const body = await readBody(req)
            const { query } = JSON.parse(body || '{}') as { query?: string }
            if (!query || typeof query !== 'string' || !query.trim()) {
              sendJson(res, 400, { error: 'Missing query.' })
              return
            }
            const { answer, results } = await runWebSearch(env, query.trim())
            sendJson(res, 200, { query: query.trim(), answer, results })
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )

      server.middlewares.use(
        '/api/screenshot',
        async (req: Connect.IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Use POST.' })
            return
          }
          try {
            const body = await readBody(req)
            const { url } = JSON.parse(body || '{}') as { url?: string }
            if (!url || typeof url !== 'string' || !url.trim()) {
              sendJson(res, 400, { error: 'Missing url.' })
              return
            }
            const { status, body: out } = await screenshotWebsite(env, url.trim())
            sendJson(res, status, out)
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
          }
        },
      )
    },
  }
}
