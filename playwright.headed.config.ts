import { defineConfig } from '@playwright/test';

// Проверки в обычном видимом окне браузера с настройками по умолчанию:
// вертикальная синхронизация включена, никаких флагов графики. Запуск: npm run test:headed
const channel = process.env.WB_BROWSER_CHANNEL ?? 'msedge';

export default defineConfig({
  testDir: 'tests/headed',
  timeout: 900_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel,
    headless: false,
    viewport: { width: 1600, height: 900 },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
