import { defineConfig } from '@playwright/test';

// Стенды производительности фазы 1. Отличия от обычных сквозных тестов:
// вертикальная синхронизация и ограничение частоты кадров отключены, чтобы видеть
// реальный запас, а не «60 к/с». Запуск: npm run bench
const channel = process.env.WB_BROWSER_CHANNEL ?? 'msedge';

export default defineConfig({
  testDir: 'tests/bench',
  timeout: 600_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel,
    headless: !process.env.WB_HEADED,
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--use-angle=d3d11',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--enable-precise-memory-info',
      ],
    },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
