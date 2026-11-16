// Прототип 1D: нагрузка симуляции. Чистый TypeScript — запускается и в Node, и в воркере браузера.
// Три замера:
//   1) такт агентов с восприятием, выбором поведения по полезности и рулевым движением;
//   2) суточный проход по полям среды и травяному ярусу (512² ячеек, 4 слота видов);
//   3) единая пространственная модель «трава–кролики–лисы» (из прототипа 1C) в масштабе мира M.

import { hash4 } from '../../src/shared/rng';
import { FOX, LodWorld, RABBIT } from '../lod/model';

export type Now = () => number;

export interface AgentBench {
  agents: number;
  ticks: number;
  msAvg: number;
  msP95: number;
  msMax: number;
}

/** Такт агентов: сетка соседства перестраивается каждый такт, восприятие — каждый такт (худший случай). */
export function benchAgents(n: number, ticks: number, now: Now): AgentBench {
  const WORLD = 1024;
  const CELL = 16;
  const G = WORLD / CELL;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const heading = new Float32Array(n);
  const target = new Float32Array(n);
  const hunger = new Float32Array(n);
  const thirst = new Float32Array(n);
  const energy = new Float32Array(n);
  const kind = new Uint8Array(n);
  const head = new Int32Array(G * G);
  const next = new Int32Array(n);
  const inv = 1 / 4294967296;
  for (let i = 0; i < n; i++) {
    x[i] = hash4(1, 1, i, 0) * inv * WORLD;
    z[i] = hash4(1, 2, i, 0) * inv * WORLD;
    heading[i] = hash4(1, 3, i, 0) * inv * 6.283;
    target[i] = heading[i]!;
    hunger[i] = hash4(1, 4, i, 0) * inv;
    thirst[i] = hash4(1, 5, i, 0) * inv;
    energy[i] = hash4(1, 6, i, 0) * inv;
    kind[i] = hash4(1, 7, i, 0) * inv < 0.05 ? 1 : 0;
  }
  const times = new Float64Array(ticks);
  for (let tick = 0; tick < ticks; tick++) {
    const start = now();
    head.fill(-1);
    for (let i = 0; i < n; i++) {
      const c = Math.floor(z[i]! / CELL) * G + Math.floor(x[i]! / CELL);
      next[i] = head[c]!;
      head[c] = i;
    }
    for (let i = 0; i < n; i++) {
      const xi = x[i]!;
      const zi = z[i]!;
      hunger[i]! += 0.0004;
      thirst[i]! += 0.0006;
      energy[i]! -= 0.0002;
      // Восприятие: ближайший сосед и ближайшая угроза в окне 3×3 ячейки (48 м).
      const cx = Math.floor(xi / CELL);
      const cz = Math.floor(zi / CELL);
      let nearest = -1;
      let nearestD = 1e9;
      let threat = -1;
      let threatD = 1e9;
      let neighbours = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = cz + dz;
        if (zz < 0 || zz >= G) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= G) continue;
          for (let j = head[zz * G + xx]!; j >= 0; j = next[j]!) {
            if (j === i) continue;
            const ddx = x[j]! - xi;
            const ddz = z[j]! - zi;
            const d = ddx * ddx + ddz * ddz;
            neighbours++;
            if (d < nearestD) {
              nearestD = d;
              nearest = j;
            }
            if (kind[j] === 1 && kind[i] === 0 && d < threatD) {
              threatD = d;
              threat = j;
            }
          }
        }
      }
      // Выбор поведения по полезности — раз в 10 тактов, со сдвигом по индексу.
      if ((tick + i) % 10 === 0) {
        const uFlee = threat >= 0 && threatD < 576 ? 2 : 0;
        const uEat = hunger[i]! * 1.2;
        const uDrink = thirst[i]!;
        const uRest = 1 - energy[i]!;
        const uSocial = neighbours < 2 ? 0.35 : 0;
        let best = 0.2;
        let goal = 5;
        const utilities = [uFlee, uEat, uDrink, uRest, uSocial];
        for (let g = 0; g < utilities.length; g++) {
          if (utilities[g]! > best) {
            best = utilities[g]!;
            goal = g;
          }
        }
        if (goal === 0) target[i] = Math.atan2(zi - z[threat]!, xi - x[threat]!);
        else if (goal === 4 && nearest >= 0) target[i] = Math.atan2(z[nearest]! - zi, x[nearest]! - xi);
        else target[i] = hash4(2, goal, i, tick) * inv * 6.283;
        if (goal === 1) hunger[i] = 0;
        else if (goal === 2) thirst[i] = 0;
        else if (goal === 3) energy[i] = 1;
      }
      // Рулевое движение: отталкивание от слишком близкого соседа + поворот к цели.
      let h = heading[i]!;
      let want = target[i]!;
      if (nearest >= 0 && nearestD < 4) want = Math.atan2(zi - z[nearest]!, xi - x[nearest]!);
      let delta = want - h;
      delta -= Math.round(delta / 6.2831853) * 6.2831853;
      h += delta > 0.16 ? 0.16 : delta < -0.16 ? -0.16 : delta;
      heading[i] = h;
      let nx = xi + Math.cos(h) * 0.15;
      let nz = zi + Math.sin(h) * 0.15;
      if (nx < 0) nx += WORLD;
      else if (nx >= WORLD) nx -= WORLD;
      if (nz < 0) nz += WORLD;
      else if (nz >= WORLD) nz -= WORLD;
      x[i] = nx;
      z[i] = nz;
    }
    times[tick] = now() - start;
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  return {
    agents: n,
    ticks,
    msAvg: sorted.reduce((a, b) => a + b, 0) / ticks,
    msP95: sorted[Math.floor(ticks * 0.95)]!,
    msMax: sorted[ticks - 1]!,
  };
}

export interface FieldBench {
  cells: number;
  passes: number;
  msPerDailyPass: number;
}

/** Суточный проход: рост и конкуренция 4 слотов видов, опад, разложение, влага, засев соседей. */
export function benchFields(size: number, passes: number, now: Now): FieldBench {
  const cells = size * size;
  const SLOTS = 4;
  const SPECIES = 16;
  const moisture = new Float32Array(cells).fill(0.5);
  const nutrients = new Float32Array(cells).fill(0.5);
  const litter = new Float32Array(cells).fill(0.1);
  const canopy = new Float32Array(cells);
  const slotSpecies = new Uint8Array(cells * SLOTS);
  const slotBiomass = new Float32Array(cells * SLOTS);
  const optMoist = new Float32Array(SPECIES);
  const growth = new Float32Array(SPECIES);
  const waterUse = new Float32Array(SPECIES);
  const inv = 1 / 4294967296;
  for (let s = 0; s < SPECIES; s++) {
    optMoist[s] = 0.2 + (s / SPECIES) * 0.6;
    growth[s] = 0.1 + (hash4(3, 1, s, 0) * inv) * 0.2;
    waterUse[s] = 0.01 + (hash4(3, 2, s, 0) * inv) * 0.02;
  }
  for (let c = 0; c < cells; c++) {
    canopy[c] = hash4(3, 3, c, 0) * inv * 0.6;
    for (let k = 0; k < SLOTS; k++) {
      slotSpecies[c * SLOTS + k] = hash4(3, 4, c, k) % SPECIES;
      slotBiomass[c * SLOTS + k] = hash4(3, 5, c, k) * inv * 0.2;
    }
  }
  const start = now();
  for (let day = 0; day < passes; day++) {
    for (let c = 0; c < cells; c++) {
      const m = moisture[c]!;
      const nut = nutrients[c]!;
      const light = 1 - canopy[c]!;
      const base = c * SLOTS;
      const total = slotBiomass[base]! + slotBiomass[base + 1]! + slotBiomass[base + 2]! + slotBiomass[base + 3]!;
      const room = 1 - total;
      let dead = 0;
      let water = 0;
      let uptake = 0;
      let weakest = 0;
      let weakestB = 1e9;
      let strongest = 0;
      let strongestB = -1;
      for (let k = 0; k < SLOTS; k++) {
        const sp = slotSpecies[base + k]!;
        let b = slotBiomass[base + k]!;
        const dm = m - optMoist[sp]!;
        const fm = 1 - dm * dm * 6;
        let limit = fm < nut ? fm : nut;
        if (light < limit) limit = light;
        if (limit < 0) limit = 0;
        const grow = growth[sp]! * b * room * limit;
        const die = b * 0.02;
        b += grow - die;
        if (b < 0.001) b = 0.001;
        slotBiomass[base + k] = b;
        dead += die;
        water += b * waterUse[sp]!;
        uptake += grow * 0.3;
        if (b < weakestB) {
          weakestB = b;
          weakest = k;
        }
        if (b > strongestB) {
          strongestB = b;
          strongest = k;
        }
      }
      const decomposed = litter[c]! * 0.05 * m;
      litter[c] = litter[c]! + dead - decomposed;
      const n2 = nut + decomposed - uptake;
      nutrients[c] = n2 < 0 ? 0 : n2 > 1 ? 1 : n2;
      const m2 = m + 0.012 - water - m * 0.01;
      moisture[c] = m2 < 0 ? 0 : m2 > 1 ? 1 : m2;
      // Засев: сильнейший вид ячейки вытесняет слабейший слот случайного соседа.
      if (strongestB > 0.25 && (hash4(4, day, c, 0) & 63) === 0) {
        const dir = hash4(4, day, c, 1) & 3;
        const target = c + (dir === 0 ? 1 : dir === 1 ? -1 : dir === 2 ? size : -size);
        if (target >= 0 && target < cells) {
          slotSpecies[target * SLOTS + weakest] = slotSpecies[base + strongest]!;
          slotBiomass[target * SLOTS + weakest] = 0.02;
        }
      }
    }
  }
  return { cells, passes, msPerDailyPass: (now() - start) / passes };
}

export interface UnifiedBench {
  chunks: number;
  days: number;
  rabbitsAvg: number;
  foxesAvg: number;
  msPerGameDay: number;
  /** Обработано «особь × час» в секунду. */
  individualHoursPerSecond: number;
}

/** Единая почасовая модель на весь мир: сколько стоят игровые сутки. */
export function benchUnified(chunksPerSide: number, days: number, rabbitsPerChunk: number, now: Now): UnifiedBench {
  const world = new LodWorld(7, chunksPerSide, chunksPerSide, 'unified', null, { rabbitsPerChunk, foxesPerChunk: rabbitsPerChunk / 12 });
  const warmup = Math.min(40, Math.floor(days / 3));
  for (let day = 0; day < warmup; day++) world.stepDay();
  let rabbits = 0;
  let foxes = 0;
  const start = now();
  for (let day = warmup; day < days; day++) {
    world.stepDay();
    rabbits += world.embodied(RABBIT);
    foxes += world.embodied(FOX);
  }
  const elapsed = now() - start;
  const measured = days - warmup;
  return {
    chunks: chunksPerSide * chunksPerSide,
    days: measured,
    rabbitsAvg: rabbits / measured,
    foxesAvg: foxes / measured,
    msPerGameDay: elapsed / measured,
    individualHoursPerSecond: (((rabbits + foxes) * 24) / elapsed) * 1000,
  };
}

export interface SimBenchReport {
  environment: string;
  agents: AgentBench[];
  fields: FieldBench;
  unified: UnifiedBench[];
}

export function runSimBench(environment: string, now: Now, quick = false): SimBenchReport {
  return {
    environment,
    agents: [2000, 5000, 10000, 20000].map((n) => benchAgents(n, quick ? 100 : 300, now)),
    fields: benchFields(512, quick ? 3 : 10, now),
    unified: [
      benchUnified(32, quick ? 50 : 100, 8, now),
      benchUnified(32, quick ? 50 : 100, 24, now),
    ],
  };
}
