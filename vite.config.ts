import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Страницы прототипов фазы 1 собираются вместе с игрой, чтобы стенды шли на производственной сборке.
      // После фазы 1 будут убраны из сборки.
      input: {
        main: 'index.html',
        benchSim: 'prototypes/bench/sim.html',
        benchRender: 'prototypes/bench/render.html',
        diorama: 'prototypes/diorama/index.html',
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/sim/**/*.test.ts'],
    environment: 'node',
  },
});
