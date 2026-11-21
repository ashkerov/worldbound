// Эталон среды для C#-порта (Unity Migration Stage 1): настоящие системы TS weatherSystem и waterSystem
// (src/sim/env) на настоящем мире из генератора — без флоры, агентов и подготовки Wildlands.
// Флора ещё не перенесена, поэтому покров (greenness) остаётся начальным (0.25 на суше), а накопители условий
// для растений (accT, accW, …) только копятся — их никто не обнуляет. Это та же модель среды, что в игре,
// за вычетом обратной связи с растительностью; C# должен воспроизвести её побитно.
// Хеш состояния среды — по тем же полям и в том же порядке, что Simulation.stateHash (без агентов и флоры).
// Использование: npx tsx tools/unity-env-golden.ts [--out unity/WorldboundProto/Golden/env.json] [--cases 42:S:temperate:960,...]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateWorld } from '../src/sim/worldgen/generate';
import { DEFAULT_CONFIG, type ClimateName, type WorldConfig, type WorldSizeName } from '../src/shared/worldConfig';
import { TICKS_PER_HOUR } from '../src/shared/time';
import { createEnv, precipFactor } from '../src/sim/env/envState';
import { SOILS } from '../src/sim/env/soils';
import { weatherSystem, WEATHER_PERIOD } from '../src/sim/env/weather';
import { waterSystem } from '../src/sim/env/water';
import { createFlora } from '../src/sim/flora/state';
import { startTick } from '../src/sim/core/simulation';
import { StateHasher } from '../src/sim/core/hash';
import type { World } from '../src/sim/core/world';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/env.json');
// seed:размер:климат:часы[:дней в сезоне]
const CASES = opt('cases', '42:S:temperate:960,7:S:cold:960,1234:S:warm:480:8,42:M:temperate:480');

function fnv(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Точные биты double (hex IEEE-754, big-endian). */
function bits(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
}

function envHash(w: World): string {
  const e = w.env;
  const f = w.flora;
  const h = new StateHasher().addInt(w.seed).addInt(w.config.daysPerSeason).addInt(w.config.size === 'M' ? 2 : 1).addInt(w.config.scenario === 'genesis' ? 1 : 0).addInt(w.config.isolated ? 1 : 0);
  for (let i = 0; i < w.config.climate.length; i++) h.addInt(w.config.climate.charCodeAt(i));
  for (let i = 0; i < w.geoHash.length; i++) h.addInt(w.geoHash.charCodeAt(i));
  h.addInt(w.tick % 0x40000000)
    .addInt(Math.floor(w.tick / 0x40000000))
    .addInt(w.speed)
    .addArray(e.moisture)
    .addArray(e.snow)
    .addArray(e.greenness)
    .addArray(e.discharge)
    .addArray(e.runoff)
    .addArray(e.waterTotals)
    .addArray(e.weather.cells)
    .addArray(e.weather.chunkRate)
    .addArray(e.weather.chunkCloud)
    .addArray(e.weather.chunkAccum)
    .addArray(e.weather.balance)
    .addInt(e.lastHourStep)
    .addArray(f.accT)
    .addArray(f.accW)
    .addArray(f.accRunoff)
    .addArray(f.accMinT)
    .addArray(f.accHours)
    .addArray(f.capillary);
  return h.digest();
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const cases = CASES.split(',').map((c) => {
  const [seed, size, climate, hours, dps] = c.split(':');
  return { seed: Number(seed), size: size as WorldSizeName, climate: climate as ClimateName, hours: Number(hours), dps: Number(dps ?? 5) };
});
const out: unknown[] = [];
for (const c of cases) {
  const config: WorldConfig = { ...DEFAULT_CONFIG, seed: c.seed, size: c.size, climate: c.climate, daysPerSeason: c.dps };
  const gen = generateWorld(config);
  const geo = gen.geo;
  const worldSize = geo.n * geo.cellSize;
  const { factor, landMean, landCells } = precipFactor(geo);
  const count = geo.n * geo.n;
  const capacity = new Float32Array(count);
  const drainHour = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const soil = SOILS[geo.soil[i]!]!;
    capacity[i] = soil.fieldCapacityMm;
    drainHour[i] = soil.drainagePerDay / 24;
  }
  const world = {
    seed: config.seed,
    config,
    worldSize,
    tick: startTick(config.daysPerSeason),
    speed: 1,
    terrain: geo.terrain,
    geo,
    geoHash: gen.hash,
    env: createEnv(geo, worldSize),
    derived: { pFactor: factor, landMeanPrecip: landMean, landCells, capacity, drainHour },
    flora: createFlora(geo),
  } as unknown as World;
  // Команды: смена скорости в заданные такты (скорость входит в хеш состояния; на шаг ядра не влияет).
  const t0 = world.tick;
  const commands = [
    { tick: t0 + 1000, speed: 4 },
    { tick: t0 + 40000, speed: 2 },
    { tick: t0 + 90000, speed: 8 },
  ];
  const hours: unknown[] = [];
  const hourMs: number[] = [];
  const waterMs: number[] = [];
  const initial = envHash(world);
  for (let h = 0; h < c.hours; h++) {
    const s0 = performance.now();
    for (let k = 0; k < TICKS_PER_HOUR; k++) {
      for (const cmd of commands) if (cmd.tick === world.tick) world.speed = cmd.speed as World['speed'];
      const tick = world.tick;
      if (tick % WEATHER_PERIOD === 0) weatherSystem.run(world, tick);
      if (tick % TICKS_PER_HOUR === 0) {
        const w0 = performance.now();
        waterSystem.run(world, tick);
        waterMs.push(performance.now() - w0);
      }
      world.tick++;
    }
    hourMs.push(performance.now() - s0);
    const e = world.env;
    const rec: Record<string, unknown> = { h, tick: world.tick, hash: envHash(world) };
    if (h < 48 || h % 24 === 23) {
      rec.arrays = {
        moisture: fnv(e.moisture),
        snow: fnv(e.snow),
        discharge: fnv(e.discharge),
        runoff: fnv(e.runoff),
        cells: fnv(e.weather.cells),
        chunkRate: fnv(e.weather.chunkRate),
        chunkCloud: fnv(e.weather.chunkCloud),
        accT: fnv(world.flora.accT),
        accW: fnv(world.flora.accW),
        accMinT: fnv(world.flora.accMinT),
      };
      rec.totals = [...e.waterTotals].map(bits);
      rec.balance = [...e.weather.balance].map(bits);
      rec.capillary = bits(world.flora.capillary[0]!);
    }
    hours.push(rec);
  }
  const dayMs: number[] = [];
  for (let d = 0; d + 24 <= hourMs.length; d += 24) dayMs.push(hourMs.slice(d, d + 24).reduce((a, v) => a + v, 0));
  const ds = [...dayMs].sort((a, b) => a - b);
  const hs = [...hourMs].sort((a, b) => a - b);
  const ws = [...waterMs].sort((a, b) => a - b);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  out.push({
    seed: c.seed,
    size: c.size,
    climate: c.climate,
    daysPerSeason: c.dps,
    hours: c.hours,
    geoHash: gen.hash,
    startTick: t0,
    commands,
    initialHash: initial,
    records: hours,
    tsTiming: {
      hourMean: mean(hourMs),
      hourP95: pct(hs, 0.95),
      hourP99: pct(hs, 0.99),
      waterMean: mean(waterMs),
      waterP95: pct(ws, 0.95),
      waterP99: pct(ws, 0.99),
      days: dayMs.length,
      dayMean: mean(dayMs),
      dayP95: pct(ds, 0.95),
      dayP99: pct(ds, 0.99),
    },
  });
  console.log(`${c.seed}:${c.size}:${c.climate}:${c.hours}h dps ${c.dps} → ${(hours[hours.length - 1] as { hash: string }).hash}; час ${mean(hourMs).toFixed(2)} мс (p99 ${pct(hs, 0.99).toFixed(2)}), вода ${mean(waterMs).toFixed(2)} мс`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ tool: 'unity-env-golden', node: process.version, cases: out }));
console.log(`→ ${OUT}`);
