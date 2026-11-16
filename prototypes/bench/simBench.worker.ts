// Воркер стенда 1D: тот же код замеров, что и в Node, но в воркере браузера.
import { runSimBench } from './simBench';

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ quick: boolean }>) => void) | null };
scope.onmessage = (event) => {
  scope.postMessage(runSimBench(`Воркер браузера: ${navigator.userAgent}`, () => performance.now(), event.data.quick));
};
