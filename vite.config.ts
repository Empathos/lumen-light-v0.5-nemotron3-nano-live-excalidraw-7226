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
        geminiApiKey: env.GEMINI_API_KEY,
        liveModel: env.GEMINI_LIVE_MODEL,
        liveVoice: env.GEMINI_LIVE_VOICE,
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
    server: {
      port: 5180,
      host: true,
      proxy: {
        // Dev-only relay for the Gemini Live WebSocket: the browser connects to
        // this origin and the dev server forwards to Google. Host-side VPNs /
        // filters (e.g. NordVPN) can black-hole a direct browser connection to
        // googleapis.com while the dev server's egress is unaffected. The
        // production build always connects directly (see RealtimeClient).
        '/live-ws': {
          target: 'https://generativelanguage.googleapis.com',
          changeOrigin: true,
          ws: true,
          rewrite: (p) => p.replace(/^\/live-ws/, ''),
        },
      },
    },
  }
})
