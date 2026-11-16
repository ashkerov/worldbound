import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // Страницы прототипов фазы 1 входят только в сборку стендов (npm run build:bench), не в игру.
      input:
        mode === 'bench'
          ? {
              main: 'index.html',
              benchSim: 'prototypes/bench/sim.html',
              benchRender: 'prototypes/bench/render.html',
              diorama: 'prototypes/diorama/index.html',
            }
          : { main: 'index.html' },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/sim/**/*.test.ts'],
    environment: 'node',
    // Генерация мира M и прогоны года среды занимают секунды.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
