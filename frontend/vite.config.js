import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// В разработке запросы /api проксируются на Django (manage.py runserver 8000).
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: { chunkSizeWarningLimit: 900 },
  // Юнит-тесты (vitest); сквозные проверки в браузере — e2e/, запускаются Playwright.
  test: { include: ['src/**/*.test.js'] },
})
