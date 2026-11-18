// Графики опытов этапа 3 из сохранённых рядов: npm run flora:charts (читает docs/measurements/phase3-stage3-experiments.json).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { YearSample } from '../tests/support/experiments';
import { PLANTS } from '../src/sim/flora/species';
import { lineChart, type Series } from './lib/svgChart';

export interface ExperimentData {
  succession: Record<'wet' | 'dry', { seed: number; field: YearSample[]; near: YearSample[] }[]>;
  shade: { year: number; open: Record<string, number>; shaded: Record<string, number> }[];
  growth: { id: string; name: string; heights: [number, number][] }[];
}

const OUT = 'docs/charts/phase3-stage3';
const C = ['#3b7d3a', '#c0762b', '#3d6fa8', '#9a4fa0', '#b23b3b', '#5c8f8f', '#8a8a3a', '#555555'];
const pts = (xs: YearSample[], f: (s: YearSample) => number): [number, number][] => xs.map((s) => [s.year, f(s)]);

export function writeCharts(d: ExperimentData): void {
  mkdirSync(OUT, { recursive: true });
  const opts = { width: 820 };
  for (const k of ['wet', 'dry'] as const) {
    const title = k === 'wet' ? 'Опыт A — влажный плодородный участок' : 'Опыт B — сухой бедный участок';
    const runs = d.succession[k];
    const seeds = runs.map((r) => r.seed).join(', ');
    const cover: Series[] = runs.flatMap((r, i) => [
      { name: i === 0 ? 'травы (биомасса ÷ 400)' : '', color: C[0]!, dashed: i > 0, points: pts(r.field, (s) => s.herbs / 400) },
      { name: i === 0 ? 'кустарники, покрытие' : '', color: C[1]!, dashed: i > 0, points: pts(r.field, (s) => s.shrubCover) },
      { name: i === 0 ? 'деревья у опушки' : '', color: C[2]!, dashed: i > 0, points: pts(r.near, (s) => s.treeCover) },
      { name: i === 0 ? 'деревья, всё поле' : '', color: C[3]!, dashed: i > 0, points: pts(r.field, (s) => s.treeCover) },
    ]);
    writeFileSync(`${OUT}/${k}-cover.svg`, lineChart(cover, { ...opts, title: `${title}: покров (seed ${seeds}; пунктир — другие seed)`, xLabel: 'игровые годы', yLabel: 'доля', yMax: 1 }));
    const counts: Series[] = runs.flatMap((r, i) => [
      { name: i === 0 ? 'кустарники' : '', color: C[1]!, dashed: i > 0, points: pts(r.field, (s) => s.shrubs) },
      { name: i === 0 ? 'деревья' : '', color: C[2]!, dashed: i > 0, points: pts(r.field, (s) => s.trees) },
    ]);
    writeFileSync(`${OUT}/${k}-counts.svg`, lineChart(counts, { ...opts, title: `${title}: число растений в поле (seed ${seeds})`, xLabel: 'игровые годы', yLabel: 'особей' }));
    const first = runs[0]!;
    const ids = [...new Set(first.field.flatMap((s) => Object.keys(s.herbBySpecies)))].filter((id) => first.field.some((s) => (s.herbBySpecies[id] ?? 0) > 2));
    writeFileSync(`${OUT}/${k}-herbs.svg`, lineChart(ids.map((id, i) => ({ name: PLANTS.find((p) => p.id === id)!.name, color: C[i % C.length]!, points: pts(first.field, (s) => s.herbBySpecies[id] ?? 0) })), { ...opts, title: `${title}: травы по видам (seed ${first.seed})`, xLabel: 'игровые годы', yLabel: 'г/м²' }));
    writeFileSync(`${OUT}/${k}-stages.svg`, lineChart(['всходы', 'подрост', 'взрослые', 'старые'].map((name, st) => ({ name, color: C[st]!, points: pts(first.field, (s) => s.treeStages[st]!) })), { ...opts, title: `${title}: деревья по стадиям (seed ${first.seed})`, xLabel: 'игровые годы', yLabel: 'особей' }));
  }
  const sh = (key: 'open' | 'shaded', dashed: boolean): Series[] => [
    { name: `мятлик — ${key === 'open' ? 'открыто' : 'под пологом'}`, color: C[0]!, dashed, points: d.shade.map((s) => [s.year, s[key]['meadow-grass'] ?? 0]) },
    { name: `черника + мох — ${key === 'open' ? 'открыто' : 'под пологом'}`, color: C[3]!, dashed, points: d.shade.map((s) => [s.year, (s[key]['bilberry'] ?? 0) + (s[key]['moss'] ?? 0)]) },
  ];
  writeFileSync(`${OUT}/shade.svg`, lineChart([...sh('open', true), ...sh('shaded', false)], { ...opts, title: 'Опыт C — конкуренция за свет (пунктир — открытый участок)', xLabel: 'игровые годы', yLabel: 'г/м²' }));
  const trees = d.growth.filter((g) => PLANTS.find((p) => p.id === g.id)!.form === 'tree');
  writeFileSync(`${OUT}/tree-height.svg`, lineChart(trees.map((g, i) => ({ name: g.name, color: C[i]!, points: g.heights })), { ...opts, title: 'Высота одиночных деревьев на открытом хорошем участке (среднее по живым)', xLabel: 'возраст, игровые годы', yLabel: 'м' }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeCharts(JSON.parse(readFileSync('docs/measurements/phase3-stage3-experiments.json', 'utf-8')) as ExperimentData);
  console.log(`Графики — ${OUT}/`);
}
