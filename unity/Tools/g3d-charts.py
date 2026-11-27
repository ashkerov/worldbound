"""Графики Stage 2.5: заполнение хранилища древесных в настоящем Wildlands (замер tools/wildlands-store-measure.ts и
эталон G3 D–F) и прогресс подготовки в сборке (-wbprepbench). SVG вручную, без библиотек; цвета — проверенная
категориальная палитра (слоты 1–4), светлая тема.
Запуск: python unity/Tools/g3d-charts.py [docs/unity-stage2-5]
"""
import json
import math
import os
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs/unity-stage2-5'
SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
SURFACE, INK, INK2, GRID, REF = '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df', '#8a8984'
FONT = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"'
RU = {'hazel': 'лещина', 'wild-rose': 'шиповник', 'willow-shrub': 'ивняк', 'juniper': 'можжевельник', 'birch': 'берёза', 'pine': 'сосна', 'spruce': 'ель', 'oak': 'дуб', 'linden': 'липа', 'alder': 'ольха'}


def frame(title, ylabel, x0, y0, x1, y1, xmax, ymax, xstep, xlabel, refs=()):
    X = lambda t: x0 + (x1 - x0) * t / xmax
    Y = lambda v: y1 - (y1 - y0) * v / ymax
    body = [f'<text x="{x0}" y="22" font-size="14" font-weight="600" fill="{INK}" {FONT}>{title}</text>']
    for i in range(5):
        v = ymax * i / 4
        body.append(f'<line x1="{x0}" x2="{x1}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{GRID}"/>')
        body.append(f'<text x="{x0 - 6}" y="{Y(v) + 4:.1f}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>{v:g}</text>')
    t = 0
    while t <= xmax + 1e-9:
        body.append(f'<text x="{X(t):.1f}" y="{y1 + 16}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>{t:g}</text>')
        t += xstep
    body.append(f'<line x1="{x0}" x2="{x1}" y1="{y1}" y2="{y1}" stroke="{INK2}"/>')
    body.append(f'<text x="{(x0 + x1) / 2}" y="{y1 + 32}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>{xlabel}</text>')
    body.append(f'<text x="{x0}" y="{y0 - 10}" font-size="11" fill="{INK2}" {FONT}>{ylabel}</text>')
    for kind, v, label in refs:
        if kind == 'y':
            body.append(f'<line x1="{x0}" x2="{x1}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{REF}" stroke-dasharray="4 3"/>')
            body.append(f'<text x="{x0 + 4}" y="{Y(v) - 4:.1f}" font-size="11" fill="{INK2}" {FONT}>{label}</text>')
        else:
            body.append(f'<line x1="{X(v):.1f}" x2="{X(v):.1f}" y1="{y0}" y2="{y1}" stroke="{REF}" stroke-dasharray="4 3"/>')
            body.append(f'<text x="{X(v) + 4:.1f}" y="{y0 + 12}" font-size="11" fill="{INK2}" {FONT}>{label}</text>')
    return X, Y, body


def lines(path, title, ylabel, series, xmax, ymax, xstep, xlabel, refs=(), fmt='{:.0f}'):
    W, H, x0, y0, x1, y1 = 760, 320, 64, 40, 600, 260
    X, Y, body = frame(title, ylabel, x0, y0, x1, y1, xmax, ymax, xstep, xlabel, refs)
    ends = []
    for name, pts, color in series:
        body.append(f'<polyline points="{" ".join(f"{X(t):.1f},{Y(v):.1f}" for t, v in pts)}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"><title>{name}</title></polyline>')
        ends.append([Y(pts[-1][1]), name, pts[-1][1]])
    ends.sort()
    for k in range(1, len(ends)):
        ends[k][0] = max(ends[k][0], ends[k - 1][0] + 14)
    for y, name, v in ends:
        body.append(f'<text x="{x1 + 8}" y="{y + 4:.1f}" font-size="12" fill="{INK}" {FONT}>{name} · {fmt.format(v)}</text>')
    open(path, 'w', encoding='utf-8').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{title}"><rect width="{W}" height="{H}" fill="{SURFACE}"/>{"".join(body)}</svg>\n')


def stacked(path, title, rows, species, xmax):
    """Состав древесных по годам (доли видов, %): 7 крупнейших видов и «остальные»."""
    W, H, x0, y0, x1, y1 = 760, 340, 64, 40, 560, 280
    X, Y, body = frame(title, '%', x0, y0, x1, y1, xmax, 100, 5, 'годы мира (подготовка — первые 20)', (('x', 20, 'конец подготовки'),))
    totals = [sum(r['bySpecies']) or 1 for r in rows]
    last = rows[-1]['bySpecies']
    order = sorted([i for i, c in enumerate(last) if c], key=lambda i: -last[i])
    top, rest = order[:7], order[7:]
    groups = [(RU.get(species[i], species[i]), [i]) for i in top] + ([('остальные', rest)] if rest else [])
    base = [0.0] * len(rows)
    for gi, (name, idx) in enumerate(groups):
        share = [sum(r['bySpecies'][i] for i in idx) / totals[k] * 100 for k, r in enumerate(rows)]
        topv = [base[k] + share[k] for k in range(len(rows))]
        pts = [f'{X(r["year"]):.1f},{Y(topv[k]):.1f}' for k, r in enumerate(rows)] + [f'{X(r["year"]):.1f},{Y(base[k]):.1f}' for k, r in reversed(list(enumerate(rows)))]
        color = SERIES[gi] if gi < 7 else '#b4b2ac'
        body.append(f'<polygon points="{" ".join(pts)}" fill="{color}" stroke="{SURFACE}" stroke-width="1"><title>{name}</title></polygon>')
        y = y0 + 6 + gi * 22
        body.append(f'<rect x="{x1 + 24}" y="{y - 9}" width="12" height="12" rx="2" fill="{color}"/>')
        body.append(f'<text x="{x1 + 42}" y="{y + 1}" font-size="12" fill="{INK}" {FONT}>{name} · {share[-1]:.0f} %</text>')
        base = topv
    open(path, 'w', encoding='utf-8').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{title}"><rect width="{W}" height="{H}" fill="{SURFACE}"/>{"".join(body)}</svg>\n')


def main():
    os.makedirs(OUT, exist_ok=True)
    m = json.load(open(os.path.join(OUT, 'wildlands-store-ts.json'), encoding='utf-8'))
    sp = m['species']
    runs = {r['size']: r for r in m['runs']}
    ser = []
    for k, size in enumerate(['S', 'M']):
        if size in runs:
            ser.append((f'{size}/42', [(r['year'], r['fill'] * 100) for r in runs[size]['rows']], SERIES[k]))
    xmax = max(r['rows'][-1]['year'] for r in runs.values())
    lines(os.path.join(OUT, 'store-fill.svg'), 'Wildlands: заполнение хранилища древесных, % ёмкости', '%', ser, xmax, 100, 5, 'годы мира (подготовка — первые 20)',
          (('y', 90, 'с 90 % приживание плавно стихает'), ('x', 20, 'конец подготовки')), '{:.1f}')
    for size in ['S', 'M']:
        if size in runs:
            stacked(os.path.join(OUT, f'store-species-{size}.svg'), f'Wildlands {size}/42: состав древесных по годам', runs[size]['rows'], sp, runs[size]['rows'][-1]['year'])
    pb = os.path.join(OUT, 'prep-bench-player.json')
    if os.path.exists(pb):
        b = json.load(open(pb, encoding='utf-8'))
        ser = []
        for k, r in enumerate(b['runs']):
            pts = [(p[0] * 100, p[3]) for p in r['progress']]
            ser.append((f"{r['size']}: прошло", pts, SERIES[k * 2]))
            eta = [(p[0] * 100, p[3] + p[4]) for p in r['progress'] if p[4] is not None]
            if eta:
                ser.append((f"{r['size']}: прошло + оценка", eta, SERIES[k * 2 + 1]))
        ymax = max(v for _, pts, _ in ser for _, v in pts)
        lines(os.path.join(OUT, 'prep-progress.svg'), 'Подготовка в сборке: прошедшее время и оценка полного, с', 'с', ser, 100, math.ceil(ymax / 60) * 60, 10, 'готовность, %')
    print('ok')


main()
