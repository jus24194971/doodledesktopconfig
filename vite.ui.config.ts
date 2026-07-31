/**
 * Browser-only dev server for the renderer, used with `npm run dev:ui`.
 *
 * The interface runs against the demo dataset in `src/renderer/src/mockApi.ts`, so layout and
 * styling can be iterated on without Electron or any radios on the bench. The packaged app is
 * always built with electron.vite.config.ts instead.
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [
    react(),
    {
      // The production CSP forbids inline scripts, which React Fast Refresh needs. Strip it for
      // the dev server only — the Electron build keeps the strict policy.
      name: 'strip-csp-for-dev',
      transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
    }
  ],
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: { port: 5199, strictPort: true }
})
