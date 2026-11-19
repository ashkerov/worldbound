// Эталон для Prototype C (оценка Unity): входы и выходы настоящего часового шага воды TypeScript-ядра.
// Перехватывает waterSystem.run в обычной симуляции, перед вызовом вычисляет те же входы ячейки (осадки,
// облачность, температура — теми же функциями climate.ts), после — снимает выходы. C#-порт получает только
// входы и должен воспроизвести выходы. Плюс векторы хеша counterRandom/hash4.
// Использование: npx tsx tools/unity-golden.ts [--hours 24] [--warm 600] [--out unity/WorldboundProto/Assets/StreamingAssets/golden]

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Simulation } from '../src/sim/core/simulation';
import { cellTemperature, chunkSampler, sampleChunks, timeContext, type TimeContext } from '../src/sim/env/climate';
import { waterSystem } from '../src/sim/env/water';
import { hash4 } from '../src/shared/rng';
import { smoothstep } from '../src/shared/dmath';
import { TICKS_PER_HOUR, hoursPerYear } from '../src/shared/time';
import { WaterKind } from '../src/sim/worldgen/geo';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const HOURS = Number(opt('hours', '24'));
const WARM = Number(opt('warm', '600'));
const OUT = opt('out', 'unity/WorldboundProto/Assets/StreamingAssets/golden');
mkdirSync(OUT, { recursive: true });

const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
/** FNV-1a по байтам массива — побитное сравнение с C# без хранения всех часов. */
function fnv(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const sim = new Simulation({ config: { seed: 42, size: 'S', scenario: 'wild' }, testAgents: 0, prepareYears: 0 }, () => performance.now());
const w = sim.world;
const geo = w.geo;
const n = geo.n;
const count = n * n;
// Разогрев: несколько игровых суток, чтобы появились снег, сток и осадки разных типов.
for (let t = 0; t < WARM * TICKS_PER_HOUR && t < 40 * 7200; t++) sim.step();

const ctx: TimeContext = { seasonal: 0, diurnal: 0, anomaly: 0, sun: { x: 0, y: 1, z: 0 } };
const original = waterSystem.run.bind(waterSystem);
const hours: unknown[] = [];
const precip = new Float64Array(HOURS * count);
const cloud = new Float64Array(HOURS * count);
const temp = new Float64Array(HOURS * count);
const greenness = new Float32Array(HOURS * count);
// Накопители флоры перед каждым часом: между часами их читает и обнуляет суточный шаг флоры (другая система).
const accPre = new Float32Array(HOURS * count * 4);
let recorded = 0;
let startMoisture: Float32Array | null = null;
let startSnow: Float32Array | null = null;
let startAcc: Float32Array[] | null = null;
const tsMs: number[] = [];
const compression = 8760 / hoursPerYear(w.config.daysPerSeason);

waterSystem.run = (world, tick) => {
  if (recorded >= HOURS) return original(world, tick);
  const env = world.env;
  const weather = env.weather;
  timeContext(world.seed, tick, world.config.daysPerSeason, ctx);
  const sampler = chunkSampler(weather, geo);
  const o = recorded * count;
  for (let i = 0; i < count; i++) {
    const kind = geo.waterKind[i]!;
    if (kind === WaterKind.Sea) continue;
    const c = sampleChunks(sampler, weather.chunkCloud, i);
    cloud[o + i] = c;
    precip[o + i] = sampleChunks(sampler, weather.chunkAccum, i) * world.derived.pFactor[i]!;
    temp[o + i] = kind === WaterKind.None ? cellTemperature(geo, i, ctx, c) : 0;
  }
  greenness.set(env.greenness, o);
  {
    const f = world.flora;
    const a = recorded * count * 4;
    accPre.set(f.accT, a);
    accPre.set(f.accW, a + count);
    accPre.set(f.accRunoff, a + 2 * count);
    accPre.set(f.accMinT, a + 3 * count);
  }
  if (recorded === 0) {
    startMoisture = env.moisture.slice();
    startSnow = env.snow.slice();
    const f = world.flora;
    startAcc = [f.accT.slice(), f.accW.slice(), f.accRunoff.slice(), f.accMinT.slice()];
  }
  const totals0 = Array.from(env.waterTotals);
  const cap0 = world.flora.capillary[0]!;
  const sunFactor = 0.35 + 0.65 * smoothstep(-0.05, 0.5, ctx.sun.y);
  const t0 = performance.now();
  original(world, tick);
  tsMs.push(performance.now() - t0);
  const f = world.flora;
  hours.push({
    tick,
    sunFactor,
    totals: Array.from(env.waterTotals).map((v, k) => v - totals0[k]!),
    capillary: f.capillary[0]! - cap0,
    hash: { moisture: fnv(env.moisture), snow: fnv(env.snow), runoff: fnv(env.runoff), discharge: fnv(env.discharge), accT: fnv(f.accT), accW: fnv(f.accW), accRunoff: fnv(f.accRunoff), accMinT: fnv(f.accMinT) },
  });
  recorded++;
};
while (recorded < HOURS) sim.step();

const d = w.derived;
writeFileSync(`${OUT}/static.bin`, Buffer.concat([bytes(geo.waterKind), bytes(d.capacity), bytes(d.drainHour), bytes(geo.waterDist), bytes(geo.receiver), bytes(geo.upstreamOrder)]));
writeFileSync(`${OUT}/start.bin`, Buffer.concat([bytes(startMoisture!), bytes(startSnow!), ...startAcc!.map(bytes)]));
writeFileSync(`${OUT}/inputs.bin`, Buffer.concat([bytes(precip), bytes(cloud), bytes(temp), bytes(greenness)]));
writeFileSync(`${OUT}/accpre.bin`, bytes(accPre));
writeFileSync(`${OUT}/final.bin`, Buffer.concat([bytes(w.env.moisture), bytes(w.env.snow), bytes(w.env.runoff), bytes(w.env.discharge)]));
// Векторы хеша.
const vec: number[][] = [];
for (let k = 0; k < 2000; k++) {
  const a = (k * 2654435761) | 0;
  const b = (k * 40503) ^ 0x5bd1e995;
  const c = k - 1000;
  const e = (k * k) | 0;
  vec.push([a, b, c, e, hash4(a, b, c, e)]);
}
const sortedMs = tsMs.slice().sort((a, b) => a - b);
// Простой текстовый формат для C# (без JSON-разбора): числа — с полной точностью (17 значащих цифр).
const lines = [`world ${n} ${geo.cellSize} ${count}`, `compression ${compression.toPrecision(17)}`, `melt ${((3.2 / 24) * compression).toPrecision(17)}`, `tsms ${sortedMs[Math.floor(sortedMs.length / 2)]}`];
for (const h of hours as { sunFactor: number; totals: number[]; capillary: number; hash: Record<string, string> }[]) {
  const hs = h.hash;
  lines.push(`hour ${h.sunFactor.toPrecision(17)} ${h.totals.map((v) => v.toPrecision(17)).join(' ')} ${h.capillary.toPrecision(17)} ${hs.moisture} ${hs.snow} ${hs.runoff} ${hs.discharge} ${hs.accT} ${hs.accW} ${hs.accRunoff} ${hs.accMinT}`);
}
for (const v of vec) lines.push(`vec ${v.join(' ')}`);

// Ядро TS с готовыми входами (как в C#) — для честного сравнения скорости: та же работа, что у C#-порта.
// Перед замером результат сверяется с хешами настоящей системы (иначе сравнение не имело бы смысла).
{
  const kind = geo.waterKind;
  const cap = d.capacity;
  const drainH = d.drainHour;
  const wdist = geo.waterDist;
  const recv = geo.receiver;
  const order = geo.upstreamOrder;
  const toM3s = (geo.cellSize * geo.cellSize) / 1000 / 3600;
  const meltPer = (3.2 / 24) * compression;
  const st = () => ({ m: startMoisture!.slice(), s: startSnow!.slice(), r: new Float32Array(count), q: new Float32Array(count), aT: startAcc![0]!.slice(), aW: startAcc![1]!.slice(), aR: startAcc![2]!.slice(), aM: startAcc![3]!.slice() });
  const step = (x: ReturnType<typeof st>, h: number) => {
    const o = h * count;
    const sun = (hours[h] as { sunFactor: number }).sunFactor;
    for (let i = 0; i < count; i++) {
      const k = kind[i]!;
      if (k === WaterKind.Sea) { x.r[i] = 0; continue; }
      const c = cloud[o + i]!;
      const pr = precip[o + i]!;
      if (k !== WaterKind.None) { x.r[i] = pr; continue; }
      const t = temp[o + i]!;
      let sn = x.s[i]!;
      let input = 0;
      if (t < 0.5) sn += pr; else input += pr;
      if (t > 0 && sn > 0) { const melt = Math.min(sn, meltPer * t); sn -= melt; input += melt; }
      const cp = cap[i]!;
      let m = x.m[i]! + input;
      let out = 0;
      if (m > cp) { out = m - cp; m = cp; }
      const wd = wdist[i]!;
      if (wd < 40 && m < cp) m += Math.min(cp - m, cp * 0.03 * (1 - wd / 40));
      const cover = greenness[o + i]!;
      const pet = t > -4 ? (t + 4) * 0.0084 * compression * sun * (1 - 0.5 * c) * (0.5 + 0.5 * (cover > 1 ? 1 : cover)) : 0;
      const et = Math.min(m, pet * (m / cp) * (sn > 5 ? 0.2 : 1));
      m -= et;
      const drain = drainH[i]! * m * (m / cp);
      m -= drain;
      out += drain;
      x.m[i] = m; x.s[i] = sn; x.r[i] = out;
      x.aT[i] = x.aT[i]! + t; x.aW[i] = x.aW[i]! + m / cp; x.aR[i] = x.aR[i]! + out;
      if (t < x.aM[i]!) x.aM[i] = t;
    }
    x.q.fill(0);
    for (let kk = 0; kk < count; kk++) {
      const i = order[kk]!;
      if (kind[i] === WaterKind.Sea) continue;
      const q = x.q[i]! + x.r[i]! * toM3s;
      x.q[i] = q;
      const r = recv[i]!;
      if (!(r < 0 || kind[r] === WaterKind.Sea)) x.q[r] = x.q[r]! + q;
    }
  };
  const check = st();
  let equal = 0;
  for (let h = 0; h < HOURS; h++) {
    step(check, h);
    const hs = (hours[h] as { hash: Record<string, string> }).hash;
    if (fnv(check.m) === hs.moisture && fnv(check.s) === hs.snow && fnv(check.r) === hs.runoff && fnv(check.q) === hs.discharge) equal++;
  }
  const times: number[] = [];
  const x = st();
  for (let loop = 0; loop < 6; loop++) for (let h = 0; h < HOURS; h++) { const t0 = performance.now(); step(x, h); times.push(performance.now() - t0); }
  times.sort((p, q) => p - q);
  lines.push(`tskernel ${equal} ${times[Math.floor(times.length / 2)]} ${times[0]} ${times[Math.floor(times.length * 0.95)]}`);
  console.log(`TS-ядро с готовыми входами: совпало часов ${equal}/${HOURS}, медиана ${times[Math.floor(times.length / 2)]!.toFixed(3)} мс`);
}
writeFileSync(`${OUT}/golden.txt`, lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
writeFileSync(
  `${OUT}/golden.json`,
  JSON.stringify(
    {
      source: 'src/sim/env/water.ts (waterSystem) — перехват настоящего вызова',
      world: { seed: 42, size: 'S', n, cellSize: geo.cellSize, count, daysPerSeason: w.config.daysPerSeason },
      compression,
      meltPerDegree: (3.2 / 24) * compression,
      hours: HOURS,
      tsMsPerHour: { median: sortedMs[Math.floor(sortedMs.length / 2)], min: sortedMs[0], all: tsMs.map((x) => +x.toFixed(3)) },
      node: process.version,
      hourly: hours,
      hashVectors: vec,
    },
    null,
    1,
  ),
);
console.log(`эталон: ${HOURS} ч, ${count} ячеек; TS шаг воды медиана ${sortedMs[Math.floor(sortedMs.length / 2)]!.toFixed(2)} мс → ${OUT}`);
