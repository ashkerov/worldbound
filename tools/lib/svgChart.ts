// Минимальный построитель линейных графиков в SVG — без зависимостей, для отчётов о прогонах.

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  dashed?: boolean;
}

export interface ChartOptions {
  title: string;
  xLabel: string;
  yLabel: string;
  width?: number;
  height?: number;
  yMax?: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function niceStep(max: number): number {
  const raw = max / 5;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function lineChart(series: Series[], o: ChartOptions): string {
  const W = o.width ?? 720;
  const H = o.height ?? 360;
  const L = 64;
  const R = 220;
  const T = 40;
  const B = 48;
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1]));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMaxRaw = o.yMax ?? Math.max(1e-9, ...ys);
  const step = niceStep(yMaxRaw);
  const yMax = Math.ceil(yMaxRaw / step) * step;
  const px = (x: number) => L + ((x - xMin) / (xMax - xMin || 1)) * (W - L - R);
  const py = (y: number) => H - B - (y / yMax) * (H - T - B);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#fbfaf6"/>`);
  parts.push(`<text x="${L}" y="24" font-size="15" font-weight="600" fill="#2a2a2a">${esc(o.title)}</text>`);
  for (let y = 0; y <= yMax + 1e-9; y += step) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${py(y)}" y2="${py(y)}" stroke="#e3e0d6"/>`);
    parts.push(`<text x="${L - 6}" y="${py(y) + 4}" text-anchor="end" fill="#666">${+y.toFixed(3)}</text>`);
  }
  const xStep = niceStep(xMax - xMin);
  for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
    parts.push(`<text x="${px(x)}" y="${H - B + 16}" text-anchor="middle" fill="#666">${x}</text>`);
  }
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#999"/>`);
  parts.push(`<text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle" fill="#444">${esc(o.xLabel)}</text>`);
  parts.push(`<text x="16" y="${(T + H - B) / 2}" text-anchor="middle" fill="#444" transform="rotate(-90 16 ${(T + H - B) / 2})">${esc(o.yLabel)}</text>`);
  let legend = 0;
  series.forEach((s) => {
    const d = s.points.map((p, k) => `${k ? 'L' : 'M'}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="6 4"' : ''}/>`);
    if (!s.name) return;
    const ly = T + 10 + legend++ * 18;
    parts.push(`<line x1="${W - R + 14}" x2="${W - R + 34}" y1="${ly}" y2="${ly}" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="6 4"' : ''}/>`);
    parts.push(`<text x="${W - R + 40}" y="${ly + 4}" fill="#333">${esc(s.name)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('\n');
}
