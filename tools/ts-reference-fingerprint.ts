// Отпечаток поведения эталона TS: полный Simulation.stateHash после нескольких игровых суток (флора работает)
// для Genesis и Wildlands мира S. Нужен, чтобы доказать, что изменение эталонного снимка (например, добавление
// export к функции) не меняет поведение: отпечаток до и после правки должен совпасть.
// Использование: npx tsx tools/ts-reference-fingerprint.ts [--days 6]

import { Simulation } from '../src/sim/core/simulation';
import { DEFAULT_CONFIG } from '../src/shared/worldConfig';
import { TICKS_PER_DAY } from '../src/shared/time';

const i = process.argv.indexOf('--days');
const DAYS = i >= 0 ? Number(process.argv[i + 1]) : 6;
for (const scenario of ['genesis', 'wild'] as const) {
  for (const seed of [42, 7]) {
    const sim = new Simulation({ config: { ...DEFAULT_CONFIG, seed, size: 'S', scenario }, testAgents: 0 });
    const h0 = sim.stateHash();
    for (let t = 0; t < DAYS * TICKS_PER_DAY; t++) sim.step();
    console.log(`${scenario} S/${seed}: такт 0 ${h0}; после ${DAYS} сут. ${sim.stateHash()}; древесных ${sim.world.flora.woody.count}`);
  }
}
