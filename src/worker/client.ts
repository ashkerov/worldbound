// Клиент воркера симуляции на главном потоке. Знает только протокол из shared.

import type { Command, FromWorker, SimRequest, SimResponse } from '../shared/protocol';

type Pushed = Exclude<FromWorker, { type: 'response' }>;
export type PushHandler = (message: Pushed) => void;

export class SimClient {
  private readonly worker: Worker;
  private nextRequestId = 1;
  private readonly pending = new Map<number, (response: SimResponse) => void>();

  constructor(private readonly onMessage: PushHandler) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module', name: 'worldbound-sim' });
    this.worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.type === 'response') {
        const resolve = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        resolve?.(message.response);
      } else {
        this.onMessage(message);
      }
    };
    this.worker.onerror = (event) => this.onMessage({ type: 'error', message: event.message });
  }

  send(command: Command): void {
    this.worker.postMessage({ type: 'command', command });
  }

  /** Возвращает буфер снимка воркеру для повторного использования. */
  recycle(buffer: ArrayBuffer): void {
    if (buffer.byteLength > 0) this.worker.postMessage({ type: 'recycle', buffer }, [buffer]);
  }

  /** Запрос с ответом; ответ «failed» превращается в исключение. */
  request<K extends SimRequest['kind']>(request: Extract<SimRequest, { kind: K }>): Promise<Extract<SimResponse, { kind: K }>> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, (response) => {
        if (response.kind === 'failed') reject(new Error(response.message));
        else resolve(response as Extract<SimResponse, { kind: K }>);
      });
      this.worker.postMessage({ type: 'request', requestId, request });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
