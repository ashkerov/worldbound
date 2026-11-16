// Тестовый рельеф фазы 0: пологие холмы из значащего шума.
// Только целочисленный хеш и арифметика + − × — никакой тригонометрии,
// поэтому результат побитно одинаков в любом движке JS.

import { hash4 } from '../../shared/rng';
import type { Terrain } from '../core/world';

const INV_2_32 = 1 / 4294967296;

function lattice(seed: number, octave: number, ix: number, iz: number): number {
  return hash4(seed, octave, ix, iz) * INV_2_32;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(seed: number, octave: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = smooth(x - ix);
  const tz = smooth(z - iz);
  const a = lattice(seed, octave, ix, iz);
  const b = lattice(seed, octave, ix + 1, iz);
  const c = lattice(seed, octave, ix, iz + 1);
  const d = lattice(seed, octave, ix + 1, iz + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function generateTestTerrain(seed: number, worldSize: number, spacing: number): Terrain {
  const samples = Math.round(worldSize / spacing) + 1;
  const heights = new Float32Array(samples * samples);
  for (let iz = 0; iz < samples; iz++) {
    for (let ix = 0; ix < samples; ix++) {
      const x = ix * spacing;
      const z = iz * spacing;
      let h = 0;
      let amplitude = 14;
      let frequency = 1 / 160;
      for (let octave = 0; octave < 4; octave++) {
        h += (valueNoise(seed, octave, x * frequency, z * frequency) - 0.5) * amplitude;
        amplitude *= 0.5;
        frequency *= 2;
      }
      heights[iz * samples + ix] = h;
    }
  }
  return { samples, spacing, heights };
}
