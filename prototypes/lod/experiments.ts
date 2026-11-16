// Эксперименты прототипа 1C. Запуск: npx tsx prototypes/lod/experiments.ts [--quick]
// Результат: docs/measurements/phase1c-lod.json и сводка в консоли.
//
// E2 «динамика»: весь мир считается одним способом (S0 / meanfield / cohort) — насколько дальний
//    уровень воспроизводит пространственную модель.
// E3 «наблюдатель»: дальний уровень + зона S0 разной формы — меняет ли присутствие наблюдателя
//    судьбу мира и самой наблюдаемой области.

import { mkdirSync, writeFileSync } from 'node:fs';
import { calibrate, describeParams } from './calibrate';
import { CAUSES, FOX, LodWorld, RABBIT, type FarMode, type FarParams } from './model';

const QUICK = process.argv.includes('--quick');
const SIZE = 12;
const DAYS = QUICK ? 400 : 1000;
const WARMUP = QUICK ? 100 : 200;
const SEEDS = Array.from({ length: QUICK ? 6 : 16 }, (_, i) => 1000 + i);

type Focus = (chunk: number, day: number) => boolean;

const centre = (radius: number): Focus => (c) => {
  const cx = c % SIZE;
  const cz = Math.floor(c / SIZE);
  const mid = Math.floor(SIZE / 2);
  return Math.abs(cx - mid) <= radius && Math.abs(cz - mid) <= radius;
};
/** Зона 3×3, обходящая мир: сдвиг раз в двое суток. */
const roaming: Focus = (c, day) => {
  const step = Math.floor(day / 2);
  const fx = 1 + (step % (SIZE - 2));
  const fz = 1 + (Math.floor(step / (SIZE - 2)) % (SIZE - 2));
  return Math.abs((c % SIZE) - fx) <= 1 && Math.abs(Math.floor(c / SIZE) - fz) <= 1;
};
const none: Focus = () => false;
const all: Focus = () => true;
const inCentre = centre(1);

interface RunResult {
  rabbits: number;
  foxes: number;
  grass: number;
  /** Средняя численность в центральной области 3×3 чанка. */
  centreRabbits: number;
  centreFoxes: number;
  foxExtinct: boolean;
  rabbitExtinct: boolean;
  causeShare: number[];
  ms: number;
}

function run(seed: number, far: FarMode, fp: FarParams | null, focus: Focus): RunResult {
  const world = new LodWorld(seed, SIZE, SIZE, far, fp);
  let rabbits = 0;
  let foxes = 0;
  let grass = 0;
  let centreRabbits = 0;
  let centreFoxes = 0;
  let samples = 0;
  const start = performance.now();
  for (let day = 0; day < DAYS; day++) {
    world.setFocus((c) => focus(c, day));
    world.stepDay();
    if (day >= WARMUP) {
      rabbits += world.count(RABBIT);
      foxes += world.count(FOX);
      grass += world.grassMean();
      const r = world.countByChunk(RABBIT);
      const f = world.countByChunk(FOX);
      for (let c = 0; c < world.nChunks; c++) {
        if (inCentre(c, 0)) {
          centreRabbits += r[c]!;
          centreFoxes += f[c]!;
        }
      }
      samples++;
    }
  }
  const deaths = world.deaths[RABBIT];
  const total = deaths.reduce((a, b) => a + b, 0) || 1;
  return {
    rabbits: rabbits / samples,
    foxes: foxes / samples,
    grass: grass / samples,
    centreRabbits: centreRabbits / samples,
    centreFoxes: centreFoxes / samples,
    foxExtinct: world.count(FOX) === 0,
    rabbitExtinct: world.count(RABBIT) === 0,
    causeShare: deaths.map((d) => d / total),
    ms: performance.now() - start,
  };
}

interface Summary {
  name: string;
  n: number;
  mean: Record<string, number>;
  se: Record<string, number>;
  foxExtinct: number;
  rabbitExtinct: number;
  rabbitDeathCauses: Record<string, number>;
  msPerRun: number;
}

const METRICS = ['rabbits', 'foxes', 'grass', 'centreRabbits', 'centreFoxes'] as const;

function summarise(name: string, runs: RunResult[]): Summary {
  const mean: Record<string, number> = {};
  const se: Record<string, number> = {};
  for (const m of METRICS) {
    const values = runs.map((r) => r[m]);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / Math.max(1, values.length - 1);
    mean[m] = avg;
    se[m] = Math.sqrt(variance / values.length);
  }
  const causes: Record<string, number> = {};
  CAUSES.forEach((cause, i) => (causes[cause] = runs.reduce((a, r) => a + r.causeShare[i]!, 0) / runs.length));
  return {
    name,
    n: runs.length,
    mean,
    se,
    foxExtinct: runs.filter((r) => r.foxExtinct).length,
    rabbitExtinct: runs.filter((r) => r.rabbitExtinct).length,
    rabbitDeathCauses: causes,
    msPerRun: runs.reduce((a, r) => a + r.ms, 0) / runs.length,
  };
}

/** Отличие от эталона: в процентах и в стандартных ошибках разности. */
function compare(a: Summary, reference: Summary): Record<string, { deltaPct: number; z: number }> {
  const out: Record<string, { deltaPct: number; z: number }> = {};
  for (const m of METRICS) {
    const delta = a.mean[m]! - reference.mean[m]!;
    const se = Math.sqrt(a.se[m]! ** 2 + reference.se[m]! ** 2);
    out[m] = { deltaPct: reference.mean[m]! !== 0 ? (delta / reference.mean[m]!) * 100 : 0, z: se > 0 ? delta / se : 0 };
  }
  return out;
}

const fmt = (s: Summary) =>
  `${s.name.padEnd(34)} кролики ${s.mean.rabbits!.toFixed(0).padStart(5)} ±${s.se.rabbits!.toFixed(0).padStart(3)}  лисы ${s.mean.foxes!.toFixed(1).padStart(6)} ±${s.se.foxes!.toFixed(1).padStart(4)}  трава ${s.mean.grass!.toFixed(3)}  центр: кр ${s.mean.centreRabbits!.toFixed(1).padStart(5)} лис ${s.mean.centreFoxes!.toFixed(2).padStart(5)}  вымерли лисы ${s.foxExtinct}/${s.n}  ${s.msPerRun.toFixed(0)} мс`;

console.log(`Мир ${SIZE}×${SIZE} чанков, ${DAYS} суток (${DAYS / 20} игровых лет), прогрев ${WARMUP}, seed-ов: ${SEEDS.length}`);
console.log('Калибровка дальнего уровня по S0…');
const fp = calibrate({ seeds: [501, 502, 503, 504], nx: SIZE, ny: SIZE, days: QUICK ? 400 : 800, warmup: 100 });

console.log('\nE2. Весь мир одним способом');
const truth = summarise('S0 (эталон)', SEEDS.map((seed) => run(seed, 'meanfield', null, all)));
console.log(fmt(truth));
// Второй независимый набор seed-ов на том же S0 — уровень шума, с которым сравниваются отличия.
const truth2 = summarise('S0, другой набор seed-ов', SEEDS.map((seed) => run(seed + 5000, 'meanfield', null, all)));
console.log(fmt(truth2));
const mfAll = summarise('meanfield, весь мир', SEEDS.map((seed) => run(seed, 'meanfield', fp, none)));
console.log(fmt(mfAll));
const cohortAll = summarise('cohort, весь мир', SEEDS.map((seed) => run(seed, 'cohort', fp, none)));
console.log(fmt(cohortAll));
const coarseAll = summarise('coarse, весь мир', SEEDS.map((seed) => run(seed, 'coarse', fp, none)));
console.log(fmt(coarseAll));

console.log('\nE3. Дальний уровень + зона наблюдателя');
const observer: Record<string, Summary[]> = {};
for (const far of ['coarse', 'meanfield', 'cohort'] as const) {
  observer[far] = [
    summarise(`${far}: без наблюдателя`, SEEDS.map((seed) => run(seed, far, fp, none))),
    summarise(`${far}: зона 3×3 в центре`, SEEDS.map((seed) => run(seed, far, fp, centre(1)))),
    summarise(`${far}: зона 5×5 в центре`, SEEDS.map((seed) => run(seed, far, fp, centre(2)))),
    summarise(`${far}: зона 3×3 обходит мир`, SEEDS.map((seed) => run(seed, far, fp, roaming))),
  ];
  for (const s of observer[far]!) console.log(fmt(s));
}

const result = {
  setup: { chunks: SIZE, days: DAYS, warmup: WARMUP, seeds: SEEDS.length, quick: QUICK },
  calibration: describeParams(fp),
  e2: {
    truth,
    noise: compare(truth2, truth),
    meanfield: { summary: mfAll, vsTruth: compare(mfAll, truth) },
    cohort: { summary: cohortAll, vsTruth: compare(cohortAll, truth) },
    coarse: { summary: coarseAll, vsTruth: compare(coarseAll, truth) },
  },
  e3: Object.fromEntries(
    Object.entries(observer).map(([far, list]) => [
      far,
      list.map((s, i) => ({ summary: s, vsNoObserver: i === 0 ? null : compare(s, list[0]!), vsTruth: compare(s, truth) })),
    ]),
  ),
};
mkdirSync('docs/measurements', { recursive: true });
writeFileSync(`docs/measurements/phase1c-lod${QUICK ? '-quick' : ''}.json`, JSON.stringify(result, null, 2));

const pct = (c: Record<string, { deltaPct: number; z: number }>, m: string) => `${c[m]!.deltaPct >= 0 ? '+' : ''}${c[m]!.deltaPct.toFixed(0)}% (${c[m]!.z.toFixed(1)}σ)`;
console.log('\nОтличие от эталона S0 (кролики / лисы / трава):');
console.log(`  шум между наборами seed-ов: ${pct(result.e2.noise, 'rabbits')} / ${pct(result.e2.noise, 'foxes')} / ${pct(result.e2.noise, 'grass')}`);
console.log(`  meanfield:                  ${pct(result.e2.meanfield.vsTruth, 'rabbits')} / ${pct(result.e2.meanfield.vsTruth, 'foxes')} / ${pct(result.e2.meanfield.vsTruth, 'grass')}`);
console.log(`  coarse:                     ${pct(result.e2.coarse.vsTruth, 'rabbits')} / ${pct(result.e2.coarse.vsTruth, 'foxes')} / ${pct(result.e2.coarse.vsTruth, 'grass')}`);
console.log(`  cohort:                     ${pct(result.e2.cohort.vsTruth, 'rabbits')} / ${pct(result.e2.cohort.vsTruth, 'foxes')} / ${pct(result.e2.cohort.vsTruth, 'grass')}`);
console.log('\nВлияние наблюдателя (относительно «без наблюдателя»), мир: кролики / лисы; центр: кролики / лисы');
for (const [far, list] of Object.entries(result.e3)) {
  for (const entry of list.slice(1)) {
    const c = entry.vsNoObserver!;
    console.log(`  ${entry.summary.name.padEnd(30)} ${pct(c, 'rabbits')} / ${pct(c, 'foxes')};  ${pct(c, 'centreRabbits')} / ${pct(c, 'centreFoxes')}`);
  }
  void far;
}
