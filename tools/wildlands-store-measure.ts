// Заполнение хранилища древесных в настоящем Wildlands (Stage 2.5, вопрос заказчика): мир готовится 20 лет той же
// симуляцией, затем живёт дальше; в конце каждого года — число древесных, HighWater, свободные индексы, доля ёмкости,
// множитель приживания у предела хранилища (storeRoom), состав видов и стадий, рождения и гибели за год по видам.
// Это замер модели TS (снимок 7b2fbabbc1); C# совпадает с ней побитно (G3 D–F проверяет 20 лет подготовки и год после).
// Использование: npx tsx tools/wildlands-store-measure.ts [--out docs/unity-stage2-5/wildlands-store-ts.json]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG, type WorldConfig } from '../src/shared/worldConfig';
import { TICKS_PER_DAY } from '../src/shared/time';
import { PLANTS, SPECIES } from '../src/sim/flora/species';

const i = process.argv.indexOf('--out');
const OUT = i >= 0 ? process.argv[i + 1]! : 'docs/unity-stage2-5/wildlands-store-ts.json';
const YEAR_TICKS = 20 * TICKS_PER_DAY;

function measure(size: 'S' | 'M', seed: number, climate: WorldConfig['climate'], years: number): void {
  const config: WorldConfig = { ...DEFAULT_CONFIG, size, seed, climate, scenario: 'wild', isolated: false };
  const sim = new Simulation({ config, testAgents: 0 });
  const w = sim.world.flora.woody;
  const start = sim.world.tick;
  const alive = w.alive.slice();
  const gen = w.generation.slice();
  const spc = w.species.slice();
  const rows: unknown[] = [];
  const t0 = performance.now();
  for (let y = 1; y <= years; y++) {
    const births = new Array<number>(SPECIES.count).fill(0);
    const deaths = new Array<number>(SPECIES.count).fill(0);
    for (let d = 0; d < 20; d++) {
      const end = start + ((y - 1) * 20 + d + 1) * TICKS_PER_DAY;
      while (sim.world.tick < end) sim.step();
      for (let k = 0; k < w.highWater; k++) {
        const was = alive[k] === 1;
        const is = w.alive[k] === 1;
        const same = gen[k] === w.generation[k];
        if (was && !(is && same)) deaths[spc[k]!]!++;
        if (is && !(was && same)) births[w.species[k]!]!++;
      }
      alive.set(w.alive);
      gen.set(w.generation);
      spc.set(w.species);
    }
    const bySpecies = new Array<number>(SPECIES.count).fill(0);
    const stages = [0, 0, 0, 0];
    for (let k = 0; k < w.highWater; k++) {
      if (w.alive[k] !== 1) continue;
      bySpecies[w.species[k]!]!++;
      stages[w.stage[k]!]!++;
    }
    const fill = w.count / w.capacity;
    rows.push({
      year: y,
      preparing: sim.preparation !== null,
      tick: sim.world.tick,
      count: w.count,
      highWater: w.highWater,
      free: w.freeSlots().length,
      capacity: w.capacity,
      fill,
      storeRoom: fill < 0.9 ? 1 : Math.max(0, (1 - fill) * 10),
      bySpecies,
      stages,
      births,
      deaths,
      seconds: (performance.now() - t0) / 1000,
    });
    console.log(`${size}/${seed}/${climate} год ${y}: ${w.count} (${(fill * 100).toFixed(1)} %), ${((performance.now() - t0) / 1000).toFixed(0)} с`);
    // Файл переписывается после каждого года: прерванный замер оставляет все прожитые годы.
    save({ size, seed, climate, years, preparedYears: 20, complete: y === years, stateHash: y === years ? sim.stateHash() : null, rows });
  }
}

const done: unknown[] = [];
function save(current: unknown): void {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ tool: 'wildlands-store-measure', node: process.version, reference: '7b2fbabbc1', species: PLANTS.map((p) => p.id), yearTicks: YEAR_TICKS, runs: [...done, current] }, null, 1));
}
for (const [size, years] of [
  ['M', 32],
  ['S', 50],
] as const) {
  const before = done.length;
  measure(size, 42, 'temperate', years);
  // Последняя запись прогона — его итог; следующий прогон дописывается после него.
  if (done.length === before) done.push(JSON.parse(readFileSync(OUT, 'utf-8')).runs.at(-1));
}
console.log(`→ ${OUT}`);
