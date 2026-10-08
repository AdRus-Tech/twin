// Сквозные проверки в браузере против запущенного сервера (Django отдаёт собранный фронтенд).
// Локально: cd backend && python manage.py runserver; cd frontend && npm run build && npm run e2e
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_URL || 'http://127.0.0.1:8000',
    viewport: { width: 1600, height: 900 },
    screenshot: 'only-on-failure',
    launchOptions: {
      // 3D через программный WebGL — работает и на машинах без видеокарты.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    },
  },
})
