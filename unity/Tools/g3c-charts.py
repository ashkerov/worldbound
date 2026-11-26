"""Графики Stage 2.4 из эталона G3 C (Golden/flora-g3c.json; C# совпадает с ним побитно): сукцессия C2 (seed 1–3) —
число кустарников и деревьев, полог деревьев у опушки, заполнение хранилища древесных. SVG вручную, без библиотек.
Цвета — проверенная категориальная палитра (слоты 1–3), светлая тема.
Запуск: python unity/Tools/g3c-charts.py [Golden/flora-g3c.json] [docs/unity-stage2-4]
"""
import json
import math
import os
import struct
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'unity/WorldboundProto/Golden/flora-g3c.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'docs/unity-stage2-4'
SERIES = ['#2a78d6', '#eb6834', '#1baf7a']
SURFACE, INK, INK2, GRID, REF = '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df', '#8a8984'
FONT = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"'


def f64(h):
    return struct.unpack('>d', bytes.fromhex(h))[0]


def nice(v):
    if v <= 0:
        return 1
    e = 10 ** math.floor(math.log10(v))
    for m in (1, 2, 2.5, 5, 10):
        if m * e >= v:
            return m * e
    return 10 * e


def lines(series, title, ylabel, path, years, ymax=None, ref=None, fmt='{:.0f}'):
    """series: [(имя, [(год, значение)], цвет)]; ref: (значение, подпись) — пороговая линия."""
    W, H, x0, y0, x1, y1 = 760, 320, 64, 40, 620, 260
    vals = [v for _, s, _ in series for _, v in s] + ([ref[0]] if ref else [])
    ymax = ymax or nice(max(vals))
    X = lambda t: x0 + (x1 - x0) * t / years
    Y = lambda v: y1 - (y1 - y0) * v / ymax
    body = [f'<text x="{x0}" y="22" font-size="14" font-weight="600" fill="{INK}" {FONT}>{title}</text>']
    for i in range(5):
        v = ymax * i / 4
        body.append(f'<line x1="{x0}" x2="{x1}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{GRID}"/>')
        body.append(f'<text x="{x0 - 6}" y="{Y(v) + 4:.1f}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>{v:g}</text>')
    for yr in range(0, years + 1, 5):
        body.append(f'<text x="{X(yr):.1f}" y="{y1 + 16}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>{yr}</text>')
    body.append(f'<line x1="{x0}" x2="{x1}" y1="{y1}" y2="{y1}" stroke="{INK2}"/>')
    body.append(f'<text x="{(x0 + x1) / 2}" y="{y1 + 32}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>годы</text>')
    body.append(f'<text x="{x0}" y="{y0 - 10}" font-size="11" fill="{INK2}" {FONT}>{ylabel}</text>')
    if ref:
        body.append(f'<line x1="{x0}" x2="{x1}" y1="{Y(ref[0]):.1f}" y2="{Y(ref[0]):.1f}" stroke="{REF}" stroke-dasharray="4 3"/>')
        body.append(f'<text x="{x0 + 4}" y="{Y(ref[0]) - 4:.1f}" font-size="11" fill="{INK2}" {FONT}>{ref[1]}</text>')
    ends = []
    for name, s, color in series:
        pts = ' '.join(f'{X(t):.1f},{Y(v):.1f}' for t, v in s)
        body.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"><title>{name}</title></polyline>')
        ends.append([Y(s[-1][1]), name, s[-1][1]])
    # Подписи у правого края без наложения: не ближе 14 px друг к другу.
    ends.sort()
    for k in range(1, len(ends)):
        ends[k][0] = max(ends[k][0], ends[k - 1][0] + 14)
    for y, name, v in ends:
        body.append(f'<text x="{x1 + 8}" y="{y + 4:.1f}" font-size="12" fill="{INK}" {FONT}>{name} · {fmt.format(v)}</text>')
    open(path, 'w', encoding='utf-8').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{title}"><rect width="{W}" height="{H}" fill="{SURFACE}"/>{"".join(body)}</svg>\n')


def main():
    g = json.load(open(SRC, encoding='utf-8'))
    runs = g['runs']
    os.makedirs(OUT, exist_ok=True)
    seeds = [1, 2, 3]
    years = 50

    def per_year(seed, fn, zone=0):
        out = []
        for p in runs[f'C2-{seed}']['probes']:
            y = int(p['label'].split()[1])
            out.append((y, fn(p['zones'][zone])))
        return out

    lines([(f'seed {s}', per_year(s, lambda z: z['shrubs']), SERIES[k]) for k, s in enumerate(seeds)],
          'C2: число кустарников на поле (столбцы 6–47)', 'шт.', os.path.join(OUT, 'c2-shrubs.svg'), years)
    lines([(f'seed {s}', per_year(s, lambda z: z['trees']), SERIES[k]) for k, s in enumerate(seeds)],
          'C2: число деревьев на поле', 'шт.', os.path.join(OUT, 'c2-trees.svg'), years)
    lines([(f'seed {s}', per_year(s, lambda z: f64(z['treeCover']) * 100, 1), SERIES[k]) for k, s in enumerate(seeds)],
          'C2: покрытие деревьями у опушки (столбцы 6–15), %', '%', os.path.join(OUT, 'c2-near-tree-cover.svg'), years, ref=(5, 'критерий теста: > 5 % к 50-му году'), fmt='{:.1f}')
    cap = 48 * 48 * 4

    def store(seed):
        return [(d['day'] / 20, d['store'][0] / cap * 100) for d in runs[f'C2-{seed}']['days'] if d['day'] % 5 == 0]

    lines([(f'seed {s}', store(s), SERIES[k]) for k, s in enumerate(seeds)],
          'C2: заполнение хранилища древесных (ёмкость 9216), %', '%', os.path.join(OUT, 'c2-store.svg'), years, ymax=100, ref=(90, 'с 90 % приживание плавно стихает'), fmt='{:.0f}')
    print('ok')


main()
