import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // apps/sync (wrangler dev, localhost:8787) への開発プロキシ。
      // バックエンドが起動していない場合は 502 系のレスポンスになるが、
      // アプリ側 (App.tsx) はそれを「未接続」として静かに扱う。
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
