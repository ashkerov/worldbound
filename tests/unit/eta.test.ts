import { describe, expect, it } from 'vitest';
import { YearlyCostEta } from '../../src/shared/eta';

/** Прогон с ценой года cost(k), отметки каждые 0,1 года; возвращает пары (доля, фактический и оценённый остаток). */
function simulate(years: number, cost: (k: number) => number): { f: number; actual: number; est: number | undefined }[] {
  const eta = new YearlyCostEta(years);
  const total = Array.from({ length: years }, (_, k) => cost(k)).reduce((a, b) => a + b, 0);
  const out: { f: number; actual: number; est: number | undefined }[] = [];
  let t = 0;
  for (let step = 1; step <= years * 10; step++) {
    t += cost(Math.floor((step - 1) / 10)) / 10;
    const f = step / (years * 10);
    eta.add(f, t);
    out.push({ f, actual: total - t, est: eta.remaining() });
  }
  return out;
}

describe('Оценка оставшегося времени подготовки', () => {
  it('постоянная цена года — оценка точная', () => {
    for (const r of simulate(20, () => 30)) if (r.f >= 0.1 && r.f < 1) expect(r.est!).toBeCloseTo(r.actual, 6);
  });

  it('растущая цена (как у мира M: быстрый рост, затем медленный) — ошибка во второй половине ≤ 10 %, линейная — больше', () => {
    const cost = (k: number) => (k === 0 ? 15 : Math.min(41, 26 + 5 * k) + 0.4 * k);
    let worstNew = 0;
    let worstLinear = 0;
    for (const r of simulate(20, cost)) {
      const t = Array.from({ length: 20 }, (_, k) => cost(k)).reduce((a, b) => a + b, 0) - r.actual;
      if (r.f < 0.5 || r.f >= 0.95) continue;
      worstNew = Math.max(worstNew, Math.abs(r.est! - r.actual) / r.actual);
      worstLinear = Math.max(worstLinear, Math.abs((t / r.f) * (1 - r.f) - r.actual) / r.actual);
    }
    expect(worstNew).toBeLessThan(0.1);
    expect(worstLinear).toBeGreaterThan(worstNew);
  });

  it('до 2 % прогресса оценки нет; в конце — ноль', () => {
    const eta = new YearlyCostEta(20);
    eta.add(0.01, 1);
    expect(eta.remaining()).toBeUndefined();
    eta.add(1, 100);
    expect(eta.remaining()).toBe(0);
  });
});
