import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const PORT = Number(process.env.SCRAPPER_PORT ?? 4478)

// 렌더러(React) 빌드 → dist/. Bun 서버(src/server.ts)가 dist 를 서빙한다.
// 개발 시 `vite`(dev:ui) 는 /api·/ws 를 Bun 서버로 프록시해 HMR 을 제공.
export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve('./src'),
    },
  },
  build: {
    outDir: resolve('./dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': `http://localhost:${PORT}`,
      '/ws': { target: `ws://localhost:${PORT}`, ws: true },
    },
  },
})
