import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { lumenRealtimePlugin } from './server/realtimePlugin'

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
    },
  }
})
