import { defineConfig } from '@playwright/test';

// Тесты идут в установленном системном браузере (по умолчанию Edge), а не в
// скачиваемой сборке Chromium: так проверяется настоящий графический стек машины.
// WB_BROWSER_CHANNEL=chrome — переключить на Chrome. WB_HEADED=1 — показать окно.
const channel = process.env.WB_BROWSER_CHANNEL ?? 'msedge';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel,
    headless: !process.env.WB_HEADED,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
    },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
