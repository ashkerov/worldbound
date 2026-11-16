// Нагрузка симуляцией для совместного прогона с рендером (диорама, параметр ?sim=N).
// Воркер ведёт себя как будущий воркер игры: такты по 100 мс игрового времени на заданной скорости,
// N агентов с восприятием и выбором поведения, плюс раз в 5 секунд — игровые сутки пищевой сети
// целиком (это заведомо тяжелее реального режима, где сутки размазаны по тактам).

import { WebWorld } from '../web/model';
import { makeAgentWorld } from './simBench';

export interface SimLoadStats {
  agents: number;
  speed: number;
  /** Сколько тактов в секунду требуется и сколько получилось. */
  ticksWanted: number;
  ticksPerSecond: number;
  tickMsAvg: number;
  tickMsMax: number;
  /** Длительность последнего расчёта игровых суток пищевой сети и число особей в ней. */
  dayMs: number;
  individuals: number;
  /** Накопленное отставание от реального времени, мс игрового времени. */
  lagMs: number;
  /** Всего тактов и секунд с запуска. */
  totalTicks: number;
  seconds: number;
}

const scope = self as unknown as { postMessage(message: SimLoadStats): void; onmessage: ((event: MessageEvent<{ agents: number; speed: number }>) => void) | null };

scope.onmessage = (event) => {
  const { agents, speed } = event.data;
  const step = makeAgentWorld(agents);
  const web = new WebWorld(5, 8, 24);
  const started = performance.now();
  let last = started;
  let accumulator = 0;
  let tick = 0;
  let windowStart = started;
  let windowTicks = 0;
  let windowMs = 0;
  let windowMax = 0;
  let lastDay = started;
  let dayMs = 0;
  setInterval(() => {
    const now = performance.now();
    accumulator += (now - last) * speed;
    last = now;
    let budget = 24;
    while (accumulator >= 100 && budget-- > 0) {
      const t0 = performance.now();
      step(tick++);
      const took = performance.now() - t0;
      windowMs += took;
      if (took > windowMax) windowMax = took;
      windowTicks++;
      accumulator -= 100;
    }
    if (now - lastDay > 5000) {
      lastDay = now;
      const t0 = performance.now();
      web.stepDay();
      dayMs = performance.now() - t0;
    }
    if (now - windowStart >= 1000) {
      let individuals = 0;
      for (let s = 0; s < 4; s++) individuals += web.count(s);
      scope.postMessage({
        agents,
        speed,
        ticksWanted: speed * 10,
        ticksPerSecond: (windowTicks * 1000) / (now - windowStart),
        tickMsAvg: windowTicks > 0 ? windowMs / windowTicks : 0,
        tickMsMax: windowMax,
        dayMs,
        individuals,
        lagMs: accumulator,
        totalTicks: tick,
        seconds: (now - started) / 1000,
      });
      windowStart = now;
      windowTicks = 0;
      windowMs = 0;
      windowMax = 0;
    }
  }, 5);
};
