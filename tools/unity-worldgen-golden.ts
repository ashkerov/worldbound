// Эталон генератора мира для C#-порта (Unity Migration Stage 1): для каждого набора seed/размер/климат —
// geoHash, FNV-1a каждого массива Geo, озёра, провинции, ветер, время генерации TS.
// Только хеши и сводки (килобайты), без больших бинарных файлов.
// Использование: npx tsx tools/unity-worldgen-golden.ts [--out unity/WorldboundProto/Golden/worldgen.json] [--cases 42:S,7:S,1234:S,42:M]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { generateWorld } from '../src/sim/worldgen/generate';
import { DEFAULT_CONFIG, type ClimateName, type WorldSizeName } from '../src/shared/worldConfig';

function opt(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const OUT = opt('out', 'unity/WorldboundProto/Golden/worldgen.json');
const CASES = opt('cases', '42:S:temperate,7:S:cold,1234:S:warm,99:S:temperate,42:M:temperate,2024:M:warm');

export function fnv(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Точные биты double (hex IEEE-754, big-endian): сравнение не зависит от разбора десятичной записи. */
function bits(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString('hex');
}

const cases = CASES.split(',').map((c) => {
  const [seed, size, climate] = c.split(':');
  return { seed: Number(seed), size: size as WorldSizeName, climate: (climate ?? 'temperate') as ClimateName };
});
const out: unknown[] = [];
for (const c of cases) {
  const t0 = performance.now();
  const { geo, hash } = generateWorld({ ...DEFAULT_CONFIG, seed: c.seed, size: c.size, climate: c.climate });
  const ms = performance.now() - t0;
  const arrays: Record<string, string> = {
    height: fnv(geo.height),
    slope: fnv(geo.slope),
    waterKind: fnv(geo.waterKind),
    waterLevel: fnv(geo.waterLevel),
    waterDist: fnv(geo.waterDist),
    seaDist: fnv(geo.seaDist),
    receiver: fnv(geo.receiver),
    upstreamOrder: fnv(geo.upstreamOrder),
    meanDischarge: fnv(geo.meanDischarge),
    lakeId: fnv(geo.lakeId),
    tMean: fnv(geo.tMean),
    tAmp: fnv(geo.tAmp),
    precip: fnv(geo.precip),
    soil: fnv(geo.soil),
    fertility: fnv(geo.fertility),
    deposit: fnv(geo.deposit),
    depositRichness: fnv(geo.depositRichness),
    province: fnv(geo.province),
    terrain: fnv(geo.terrain.heights),
    horizon: fnv(geo.horizon.heights),
  };
  out.push({
    seed: c.seed,
    size: c.size,
    climate: c.climate,
    geoHash: hash,
    n: geo.n,
    edges: [...geo.edges],
    windX: bits(geo.windX),
    windZ: bits(geo.windZ),
    arrays,
    lakes: geo.lakes.map((l) => [bits(l.level), l.cells, l.outlet]),
    provinces: geo.provinces.map((p) => ({ name: p.name, kind: p.kind, cells: p.cells, x: bits(p.x), z: bits(p.z), meanHeight: bits(p.meanHeight), meanTemp: bits(p.meanTemp), meanPrecip: bits(p.meanPrecip) })),
    tsMs: Math.round(ms),
  });
  console.log(`${c.seed}:${c.size}:${c.climate} → ${hash} (${Math.round(ms)} мс)`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ tool: 'unity-worldgen-golden', node: process.version, cases: out }, null, 1));
console.log(`→ ${OUT}`);
