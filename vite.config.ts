import { setDefaultResultOrder } from 'node:dns'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { lumenRealtimePlugin } from './server/realtimePlugin'

// WSL/VPN hosts often advertise IPv6 routes that don't actually carry traffic;
// prefer IPv4 for the dev server's own egress (token mint, image gen, search)
// so a dead v6 route can't intermittently fail those fetches.
setDefaultResultOrder('ipv4first')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      lumenRealtimePlugin({
        openrouterApiKey: env.OPENROUTER_API_KEY,
        chatModel: env.NEMOTRON_MODEL,
        geminiApiKey: env.GEMINI_API_KEY,
        imageModel: env.GEMINI_IMAGE_MODEL,
        tavilyApiKey: env.TAVILY_API_KEY,
        braveApiKey: env.BRAVE_API_KEY,
        thumApiKey: env.THUM_IO_KEY,
      }),
    ],
    // Excalidraw reads process.env.IS_PREACT at runtime; in a browser/Vite build
    // `process` is undefined, so we statically replace it to avoid a crash.
    define: {
      'process.env.IS_PREACT': JSON.stringify('false'),
    },
    // No websocket proxy here: the Nemotron brain talks HTTP to our own /api
    // endpoints, so the browser never needs a direct third-party connection
    // (ADR-0014) — VPN-filtered hosts are unaffected by construction.
    server: {
      port: 5180,
      host: true,
    },
  }
})
