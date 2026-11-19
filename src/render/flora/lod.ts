// Выбор уровня детализации растения по расстоянию (без three — проверяется модульным тестом).
// Уровни: 0 — LOD0, 1 — LOD1, 2 — импостор. На границах — полоса перехода, в которой растение рисуется
// обоими соседними уровнями с дополняющими друг друга попиксельными растворениями (materials.ts):
// fade > 0 — доля пикселей ближнего уровня, fade < 0 — дальнего (−t). Сумма покрытий всегда 1, кроме
// дальнего края, где импостор плавно исчезает (дальше лес виден цветом полога в материале рельефа).

export interface LodRanges {
  r0: number;
  r1: number;
  rMax: number;
}

/** Доля ширины полосы перехода между уровнями. */
export const LOD_BAND = 0.14;

export interface LodPart {
  tier: 0 | 1 | 2;
  /** Растворение (см. выше). */
  fade: number;
}

/** Части, которыми рисуется растение на расстоянии d (0, 1 или 2 части). */
export function lodParts(d: number, q: LodRanges, out: LodPart[] = []): LodPart[] {
  out.length = 0;
  const b0 = q.r0 * LOD_BAND;
  const b1 = q.r1 * LOD_BAND;
  const bMax = q.rMax * 0.15;
  if (d < q.r0 + b0) {
    const t = clamp01((d - (q.r0 - b0)) / (2 * b0));
    if (t < 1) out.push({ tier: 0, fade: 1 - t });
    if (t > 0) out.push({ tier: 1, fade: -t });
  } else if (d < q.r1 + b1) {
    const t = clamp01((d - (q.r1 - b1)) / (2 * b1));
    if (t < 1) out.push({ tier: 1, fade: 1 - t });
    if (t > 0) out.push({ tier: 2, fade: -t });
  } else if (d < q.rMax) {
    const fade = d > q.rMax - bMax ? clamp01((q.rMax - d) / bMax) : 1;
    if (fade > 0) out.push({ tier: 2, fade });
  }
  return out;
}

/** Покрытие пикселей частью: fade > 0 — fade, fade < 0 — −fade. */
export function coverage(p: LodPart): number {
  return p.fade >= 0 ? p.fade : -p.fade;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
