// Эксперименты с расширенной пищевой сетью. Запуск: npx tsx prototypes/web/experiments.ts [--quick]
// Результат: docs/measurements/phase1-foodweb.json и сводка в консоли.
//   Базовый прогон — устойчивость, сезонность размножения, причины смертности, миграция.
//   Каскады — мир без волков и мир без лис против базового (те же seed).

import { mkdirSync, writeFileSync } from 'node:fs';
import { CAUSES, DAYS_PER_YEAR, DEER, FOX, RABBIT, SEASONS, SPECIES_NAMES, SPECS, WOLF, WebWorld, type WebOptions } from './model';

const QUICK = process.argv.includes('--quick');
const NX = 8;
const NY = 24;
const SEEDS = Array.from({ length: QUICK ? 4 : 16 }, (_, i) => 2000 + i);
const DAYS = QUICK ? 400 : 1000;
const WARMUP = 200;
const CASCADE_SEEDS = SEEDS.slice(0, QUICK ? 3 : 8);
const CASCADE_DAYS = QUICK ? 400 : 600;

interface Run {
  alive: boolean[];
  mean: number[];
  grass: number;
  shrub: number;
  nutrient: number;
  /** Среднее положение по оси север — юг в середине лета и в середине зимы, доля длины мира. */
  summerZ: number[];
  winterZ: number[];
  births: number[][];
  deaths: number[][][];
  minParentAge: number[];
  minParentEnergy: number[];
  minOldAgeFraction: number[];
  msPerDay: number;
  individuals: number;
}

function run(seed: number, days: number, options: WebOptions = {}): Run {
  const world = new WebWorld(seed, NX, NY, options);
  const mean = [0, 0, 0, 0];
  const summerZ = [0, 0, 0, 0];
  const winterZ = [0, 0, 0, 0];
  const summerN = [0, 0, 0, 0];
  const winterN = [0, 0, 0, 0];
  let grass = 0;
  let shrub = 0;
  let nutrient = 0;
  let samples = 0;
  let individuals = 0;
  const length = NY * 128;
  const start = performance.now();
  for (let day = 0; day < days; day++) {
    world.stepDay();
    if (day < WARMUP) continue;
    samples++;
    grass += world.fieldMean(world.grass);
    shrub += world.fieldMean(world.shrub);
    nutrient += world.fieldMean(world.nutrient);
    const dayOfYear = day % DAYS_PER_YEAR;
    for (let s = 0; s < 4; s++) {
      const count = world.count(s);
      mean[s]! += count;
      individuals += count;
      if (count === 0) continue;
      // Конец лета (сутки 8–9) и конец зимы (сутки 18–19): к этому времени кочёвка успевает проявиться.
      if (dayOfYear === 8 || dayOfYear === 9) {
        summerZ[s]! += world.meanZ(s) / length;
        summerN[s]!++;
      } else if (dayOfYear === 18 || dayOfYear === 19) {
        winterZ[s]! += world.meanZ(s) / length;
        winterN[s]!++;
      }
    }
  }
  const elapsed = performance.now() - start;
  return {
    alive: [0, 1, 2, 3].map((s) => world.count(s) > 0),
    mean: mean.map((m) => m / samples),
    grass: grass / samples,
    shrub: shrub / samples,
    nutrient: nutrient / samples,
    summerZ: summerZ.map((z, s) => z / Math.max(1, summerN[s]!)),
    winterZ: winterZ.map((z, s) => z / Math.max(1, winterN[s]!)),
    births: world.births.map((b) => b.slice()),
    deaths: world.deaths.map((d) => d.map((c) => c.slice())),
    minParentAge: world.minParentAge.slice(),
    minParentEnergy: world.minParentEnergy.slice(),
    minOldAgeFraction: world.minOldAgeFraction.slice(),
    msPerDay: elapsed / days,
    individuals: individuals / samples,
  };
}

const avg = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const se = (values: number[]) => {
  const m = avg(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1) / values.length);
};
const sumSeasons = (runs: Run[], pick: (r: Run) => number[]) => [0, 1, 2, 3].map((season) => runs.reduce((a, r) => a + pick(r)[season]!, 0));

console.log(`Мир ${NX}×${NY} чанков (${NX * 128}×${NY * 128} м), ${DAYS} суток (${DAYS / DAYS_PER_YEAR} лет), seed-ов: ${SEEDS.length}`);
const base = SEEDS.map((seed) => run(seed, DAYS));

const species = [0, 1, 2, 3].map((s) => {
  const births = sumSeasons(base, (r) => r.births[s]!);
  const deathsByCause = CAUSES.map((_c, cause) => sumSeasons(base, (r) => r.deaths[s]![cause]!));
  const totalDeaths = deathsByCause.reduce((a, c) => a + c.reduce((x, y) => x + y, 0), 0) || 1;
  const totalBirths = births.reduce((a, b) => a + b, 0) || 1;
  return {
    name: SPECIES_NAMES[s],
    survived: base.filter((r) => r.alive[s]).length,
    of: base.length,
    mean: avg(base.map((r) => r.mean[s]!)),
    se: se(base.map((r) => r.mean[s]!)),
    birthsBySeason: Object.fromEntries(SEASONS.map((name, i) => [name, births[i]! / totalBirths])),
    deathsByCause: Object.fromEntries(CAUSES.map((name, i) => [name, deathsByCause[i]!.reduce((a, b) => a + b, 0) / totalDeaths])),
    starvationBySeason: Object.fromEntries(SEASONS.map((name, i) => [name, deathsByCause[0]![i]!])),
    minParentAge: Math.min(...base.map((r) => r.minParentAge[s]!)),
    matureDays: SPECS[s]!.matureDays,
    minParentEnergy: Math.min(...base.map((r) => r.minParentEnergy[s]!)),
    reproThreshold: SPECS[s]!.reproThreshold,
    minOldAgeFraction: Math.min(...base.map((r) => r.minOldAgeFraction[s]!)),
    summerZ: avg(base.map((r) => r.summerZ[s]!)),
    winterZ: avg(base.map((r) => r.winterZ[s]!)),
    migrationShiftM: (avg(base.map((r) => r.winterZ[s]!)) - avg(base.map((r) => r.summerZ[s]!))) * NY * 128,
    migrationSeedsSouthInWinter: base.filter((r) => r.winterZ[s]! > r.summerZ[s]!).length,
  };
});

for (const s of species) {
  console.log(
    `${String(s.name).padEnd(7)} выжил ${s.survived}/${s.of}  в среднем ${s.mean.toFixed(0).padStart(5)} ±${s.se.toFixed(0)}  рождения: ${SEASONS.map((n) => `${n} ${(s.birthsBySeason[n]! * 100).toFixed(0)}%`).join(', ')}  смерти: ${CAUSES.map((n) => `${n} ${(s.deathsByCause[n]! * 100).toFixed(0)}%`).join(', ')}`,
  );
  console.log(`        мин. возраст родителя ${s.minParentAge} (зрелость ${s.matureDays}), мин. энергия ${s.minParentEnergy.toFixed(1)} (порог ${s.reproThreshold}), старость не раньше ${(s.minOldAgeFraction * 100).toFixed(0)}% срока; зимой южнее лета на ${s.migrationShiftM.toFixed(0)} м (в ${s.migrationSeedsSouthInWinter}/${s.of} прогонов)`);
}
const perf = { msPerDay: avg(base.map((r) => r.msPerDay)), individuals: avg(base.map((r) => r.individuals)) };
console.log(`Стоимость: ${perf.msPerDay.toFixed(1)} мс на игровые сутки при ${perf.individuals.toFixed(0)} особях; плодородие почвы в среднем ${avg(base.map((r) => r.nutrient)).toFixed(3)}`);

console.log(`\nКаскады: ${CASCADE_SEEDS.length} seed-ов × ${CASCADE_DAYS} суток`);
const control = CASCADE_SEEDS.map((seed) => run(seed, CASCADE_DAYS));
const noWolves = CASCADE_SEEDS.map((seed) => run(seed, CASCADE_DAYS, { absent: [WOLF] }));
const noFoxes = CASCADE_SEEDS.map((seed) => run(seed, CASCADE_DAYS, { absent: [FOX] }));
const effect = (variant: Run[], pick: (r: Run) => number) => {
  const a = variant.map(pick);
  const b = control.map(pick);
  const diff = a.map((v, i) => v - b[i]!);
  return { control: avg(b), variant: avg(a), changePct: ((avg(a) - avg(b)) / avg(b)) * 100, seedsSameDirection: diff.filter((d) => Math.sign(d) === Math.sign(avg(diff))).length, of: diff.length };
};
const cascades = {
  withoutWolves: { deer: effect(noWolves, (r) => r.mean[DEER]!), shrub: effect(noWolves, (r) => r.shrub), rabbits: effect(noWolves, (r) => r.mean[RABBIT]!), grass: effect(noWolves, (r) => r.grass) },
  withoutFoxes: { rabbits: effect(noFoxes, (r) => r.mean[RABBIT]!), grass: effect(noFoxes, (r) => r.grass), deer: effect(noFoxes, (r) => r.mean[DEER]!), shrub: effect(noFoxes, (r) => r.shrub) },
};
const line = (label: string, e: ReturnType<typeof effect>) => `  ${label.padEnd(10)} ${e.control.toFixed(2)} → ${e.variant.toFixed(2)} (${e.changePct >= 0 ? '+' : ''}${e.changePct.toFixed(0)}%, в ${e.seedsSameDirection}/${e.of} прогонов)`;
console.log('Без волков:');
for (const [k, v] of Object.entries(cascades.withoutWolves)) console.log(line(k, v));
console.log('Без лис:');
for (const [k, v] of Object.entries(cascades.withoutFoxes)) console.log(line(k, v));

mkdirSync('docs/measurements', { recursive: true });
writeFileSync(`docs/measurements/phase1-foodweb${QUICK ? '-quick' : ''}.json`, JSON.stringify({ setup: { nx: NX, ny: NY, days: DAYS, warmup: WARMUP, seeds: SEEDS.length, cascadeSeeds: CASCADE_SEEDS.length, cascadeDays: CASCADE_DAYS }, species, perf, cascades }, null, 2));
