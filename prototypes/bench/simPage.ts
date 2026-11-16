import type { SimBenchReport } from './simBench';

declare global {
  interface Window {
    __simBench?: SimBenchReport;
  }
}

const quick = new URLSearchParams(location.search).has('quick');
const worker = new Worker(new URL('./simBench.worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (event: MessageEvent<SimBenchReport>) => {
  window.__simBench = event.data;
  document.getElementById('out')!.textContent = JSON.stringify(event.data, null, 2);
};
worker.postMessage({ quick });
