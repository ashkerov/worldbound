// Графики этапа 5 фазы 3 по протоколам стенда рендера растительности (tests/bench/flora.spec.ts):
// кадры в секунду, треугольники и экземпляры растений по сценариям, WebGPU и WebGL 2.
// Использование: npx tsx tools/flora-render-charts.ts → docs/charts/phase3-stage5/*.svg

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const OUT = 'docs/charts/phase3-stage5';
mkdirSync(OUT, { recursive: true });

interface Summary {
  fpsMean: number;
  fpsP5: number;
  frameMsMax: number;
  trianglesMax: number;
  drawCallsMax: number;
  lod0Max: number;
  lod1Max: number;
  impostorsMax: number;
  grassMax: number;
}

const SCENARIOS = [
  ['strategic', 'Обзор мира'],
  ['overForest', 'Над лесом, 420 м'],
  ['inForest', 'В лесу'],
  ['flight', 'Облёт'],
] as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Сгруппированная столбчатая диаграмма: группы по оси x, серии — цветом; пунктир — целевая линия. */
function barChart(title: string, unit: string, groups: string[], series: { name: string; color: string; values: number[] }[], target?: { value: number; label: string }): string {
  const W = 760;
  const H = 360;
  const L = 64;
  const R = 200;
  const T = 44;
  const B = 56;
  const max = Math.max(target?.value ?? 0, ...series.flatMap((s) => s.values)) * 1.12 || 1;
  const step = Math.pow(10, Math.floor(Math.log10(max / 5)));
  const nice = [1, 2, 5, 10].map((k) => k * step).find((s) => max / s <= 6) ?? step * 10;
  const yMax = Math.ceil(max / nice) * nice;
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  const gw = (W - L - R) / groups.length;
  const bw = (gw * 0.75) / series.length;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, sans-serif" font-size="12">`;
  s += `<rect width="${W}" height="${H}" fill="#fff"/><text x="${L}" y="24" font-size="15" font-weight="600">${esc(title)}</text>`;
  for (let v = 0; v <= yMax + 1e-9; v += nice) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e3e3"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" fill="#555">${+v.toFixed(2)}</text>`;
  }
  s += `<text x="16" y="${T + (H - T - B) / 2}" transform="rotate(-90 16 ${T + (H - T - B) / 2})" text-anchor="middle" fill="#555">${esc(unit)}</text>`;
  groups.forEach((g, gi) => {
    series.forEach((se, si) => {
      const v = se.values[gi] ?? 0;
      const x = L + gi * gw + gw * 0.125 + si * bw;
      s += `<rect x="${x}" y="${y(v)}" width="${bw - 2}" height="${y(0) - y(v)}" fill="${se.color}"/><text x="${x + bw / 2 - 1}" y="${y(v) - 4}" text-anchor="middle" font-size="10" fill="#333">${v >= 100 ? Math.round(v) : +v.toFixed(1)}</text>`;
    });
    s += `<text x="${L + gi * gw + gw / 2}" y="${H - B + 18}" text-anchor="middle" fill="#333">${esc(g)}</text>`;
  });
  if (target) s += `<line x1="${L}" x2="${W - R}" y1="${y(target.value)}" y2="${y(target.value)}" stroke="#c0392b" stroke-dasharray="6 4"/><text x="${W - R + 6}" y="${y(target.value) + 4}" fill="#c0392b">${esc(target.label)}</text>`;
  series.forEach((se, si) => {
    s += `<rect x="${W - R + 10}" y="${T + si * 20}" width="12" height="12" fill="${se.color}"/><text x="${W - R + 28}" y="${T + si * 20 + 10}">${esc(se.name)}</text>`;
  });
  return s + '</svg>\n';
}

const worlds = [
  ['wildlands', 'Wildlands M'],
  ['trees300k', '300 тыс. деревьев'],
] as const;
const colors = ['#2f7d4a', '#8fc06a', '#3a6fb0', '#9cc0e8'];
const runs: { name: string; color: string; data: Record<string, Summary> }[] = [];
for (const [kind, label] of worlds) {
  const file = `docs/measurements/phase3-stage5-flora-${kind}-M.json`;
  if (!existsSync(file)) continue;
  const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Summary>>;
  runs.push({ name: `${label}, WebGPU`, color: colors[runs.length]!, data: j.webgpu! });
  runs.push({ name: `${label}, WebGL 2`, color: colors[runs.length]!, data: j.webgl2! });
}
const groups = SCENARIOS.map(([, l]) => l);
const pick = (k: keyof Summary) => runs.map((r) => ({ name: r.name, color: r.color, values: SCENARIOS.map(([s]) => r.data[s]?.[k] ?? 0) }));
writeFileSync(`${OUT}/fps.svg`, barChart('Кадры в секунду (среднее), средний пресет, Iris Xe', 'к/с', groups, pick('fpsMean'), { value: 35, label: 'минимум 35 к/с' }));
writeFileSync(`${OUT}/fps-p5.svg`, barChart('Кадры в секунду: 5-й перцентиль окон 0,5 с', 'к/с', groups, pick('fpsP5'), { value: 35, label: 'минимум 35 к/с' }));
writeFileSync(`${OUT}/frame-max.svg`, barChart('Самый длинный кадр', 'мс', groups, pick('frameMsMax'), { value: 100, label: 'предел 100 мс' }));
writeFileSync(`${OUT}/triangles.svg`, barChart('Треугольники в кадре (наибольшее), тыс.', 'тыс.', groups, pick('trianglesMax').map((s) => ({ ...s, values: s.values.map((v) => v / 1000) })), { value: 1000, label: 'предел 1 млн' }));
writeFileSync(`${OUT}/draw-calls.svg`, barChart('Вызовы отрисовки (наибольшее)', 'вызовов', groups, pick('drawCallsMax')));
const inst = runs.filter((r) => r.name.includes('WebGPU'));
const tiers: [keyof Summary, string, string][] = [
  ['lod0Max', 'LOD0', '#1f5a34'],
  ['lod1Max', 'LOD1', '#4f9a5c'],
  ['impostorsMax', 'Импосторы', '#a9cf7a'],
  ['grassMax', 'Пучки трав', '#d9c35a'],
];
for (const r of inst) {
  writeFileSync(
    `${OUT}/instances-${r.name.startsWith('Wildlands') ? 'wildlands' : 'trees300k'}.svg`,
    barChart(`Экземпляры по уровням — ${r.name.replace(', WebGPU', '')}`, 'экземпляров', groups, tiers.map(([k, n, c]) => ({ name: n, color: c, values: SCENARIOS.map(([s]) => r.data[s]?.[k] ?? 0) }))),
  );
}
console.log(`Графики — ${OUT}/ (${runs.length} рядов)`);
