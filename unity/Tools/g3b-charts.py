"""Графики Stage 2.3 из эталона G3 B (Golden/flora-g3b.json; C# совпадает с ним побитно): состав трав B1/B2 по годам,
заселение поля, ошибка баланса. Без внешних библиотек — SVG вручную. Цвета — проверенная категориальная палитра
(8 слотов, фиксированный порядок, светлая тема).
Запуск: python unity/Tools/g3b-charts.py [Golden/flora-g3b.json] [docs/unity-stage2-3]
"""
import json
import math
import os
import struct
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else 'unity/WorldboundProto/Golden/flora-g3b.json'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'docs/unity-stage2-3'
SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
SURFACE, INK, INK2, GRID = '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df'
NAMES = {'meadow-grass': 'мятлик', 'feather-grass': 'ковыль', 'sedge': 'осока', 'clover': 'клевер', 'meadow-flowers': 'луговое разнотравье',
         'fireweed': 'иван-чай', 'bilberry': 'черника', 'moss': 'мох'}
FONT = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"'


def f64(h):
    return struct.unpack('>d', bytes.fromhex(h))[0]


def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
            f'<rect width="{w}" height="{h}" fill="{SURFACE}"/>{body}</svg>\n')


def axes(x0, y0, x1, y1, ymax, yticks, ylabel, years):
    out = []
    for t in yticks:
        y = y1 - (y1 - y0) * t / ymax
        out.append(f'<line x1="{x0}" x2="{x1}" y1="{y:.1f}" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{x0 - 6}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>{t:g}</text>')
    for yr in range(0, years + 1, 2):
        x = x0 + (x1 - x0) * yr / years
        out.append(f'<text x="{x:.1f}" y="{y1 + 16}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>{yr}</text>')
    out.append(f'<line x1="{x0}" x2="{x1}" y1="{y1}" y2="{y1}" stroke="{INK2}" stroke-width="1"/>')
    out.append(f'<text x="{(x0 + x1) / 2}" y="{y1 + 32}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>годы</text>')
    out.append(f'<text x="{x0}" y="{y0 - 10}" font-size="11" fill="{INK2}" {FONT}>{ylabel}</text>')
    return ''.join(out)


def nice(v):
    e = 10 ** math.floor(math.log10(v))
    for m in (1, 2, 2.5, 5, 10):
        if m * e >= v:
            return m * e
    return 10 * e


def composition(run, herbs, label, path):
    days = run['days']
    cells = run['setup']['plot']['n'] ** 2
    years = len(days) / 20
    # Среднее по полю, г/м², в середине лета каждого года (сутки 8 года: доля года ≈ 0,5).
    pts = [(d['day'] / 20, [f64(x) / cells for x in d['herbs']['biomass']]) for d in days]
    W, H, x0, y0, x1, y1 = 760, 360, 56, 40, 560, 300
    ymax = nice(max(sum(v) for _, v in pts))
    body = [f'<text x="{x0}" y="22" font-size="14" font-weight="600" fill="{INK}" {FONT}>{label}: средняя биомасса трав по полю, г/м²</text>',
            axes(x0, y0, x1, y1, ymax, [ymax * i / 4 for i in range(5)], 'г/м²', int(years))]
    X = lambda t: x0 + (x1 - x0) * t / years
    Y = lambda v: y1 - (y1 - y0) * v / ymax
    base = [0.0] * len(pts)
    for h in range(len(herbs)):
        top = [base[i] + pts[i][1][h] for i in range(len(pts))]
        poly = [f'{X(pts[i][0]):.1f},{Y(top[i]):.1f}' for i in range(len(pts))] + [f'{X(pts[i][0]):.1f},{Y(base[i]):.1f}' for i in reversed(range(len(pts)))]
        body.append(f'<polygon points="{" ".join(poly)}" fill="{SERIES[h]}" stroke="{SURFACE}" stroke-width="1" stroke-linejoin="round"><title>{NAMES[herbs[h]]}</title></polygon>')
        base = top
    # Легенда справа (8 рядов > 4 — без подписей на графике), в порядке слоёв сверху вниз.
    for k, h in enumerate(reversed(range(len(herbs)))):
        y = y0 + 6 + k * 22
        last = pts[-1][1][h]
        body.append(f'<rect x="{x1 + 24}" y="{y - 9}" width="12" height="12" rx="2" fill="{SERIES[h]}"/>')
        body.append(f'<text x="{x1 + 42}" y="{y + 1}" font-size="12" fill="{INK}" {FONT}>{NAMES[herbs[h]]}</text>')
        body.append(f'<text x="{W - 12}" y="{y + 1}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>{last:.0f}</text>')
    body.append(f'<text x="{W - 12}" y="{y0 - 10}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>год 20</text>')
    open(path, 'w', encoding='utf-8').write(svg(W, H, ''.join(body), f'{label}: состав трав по годам'))


def lines(series, title, ylabel, path, ymax=None, log=False, fmt='{:.0f}'):
    W, H, x0, y0, x1, y1 = 760, 320, 64, 40, 620, 260
    years = max(len(s[1]) for s in series) / 20
    vals = [v for _, s, _ in series for v in s]
    if log:
        lo, hi = math.floor(math.log10(min(v for v in vals if v > 0))), math.ceil(math.log10(max(vals)))
        Y = lambda v: y1 - (y1 - y0) * (math.log10(max(v, 10 ** lo)) - lo) / (hi - lo)
        ticks = [(Y(10 ** e), f'1e{e}') for e in range(lo, hi + 1)]
    else:
        ymax = ymax or nice(max(vals))
        Y = lambda v: y1 - (y1 - y0) * v / ymax
        ticks = [(Y(ymax * i / 4), f'{ymax * i / 4:g}') for i in range(5)]
    X = lambda t: x0 + (x1 - x0) * t / years
    body = [f'<text x="{x0}" y="22" font-size="14" font-weight="600" fill="{INK}" {FONT}>{title}</text>']
    for y, t in ticks:
        body.append(f'<line x1="{x0}" x2="{x1}" y1="{y:.1f}" y2="{y:.1f}" stroke="{GRID}"/>')
        body.append(f'<text x="{x0 - 6}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{INK2}" {FONT}>{t}</text>')
    for yr in range(0, int(years) + 1, 2):
        body.append(f'<text x="{X(yr):.1f}" y="{y1 + 16}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>{yr}</text>')
    body.append(f'<line x1="{x0}" x2="{x1}" y1="{y1}" y2="{y1}" stroke="{INK2}"/>')
    body.append(f'<text x="{(x0 + x1) / 2}" y="{y1 + 32}" text-anchor="middle" font-size="11" fill="{INK2}" {FONT}>годы</text>')
    body.append(f'<text x="{x0}" y="{y0 - 10}" font-size="11" fill="{INK2}" {FONT}>{ylabel}</text>')
    for name, s, color in series:
        pts = ' '.join(f'{X((i + 1) / 20):.1f},{Y(v):.1f}' for i, v in enumerate(s))
        body.append(f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="2" stroke-linejoin="round"><title>{name}</title></polyline>')
        body.append(f'<text x="{x1 + 8}" y="{Y(s[-1]) + 4:.1f}" font-size="12" fill="{INK}" {FONT}>{name} · {fmt.format(s[-1])}</text>')
    open(path, 'w', encoding='utf-8').write(svg(W, H, ''.join(body), title))


def main():
    g = json.load(open(SRC, encoding='utf-8'))
    herbs = g['herbs']
    os.makedirs(OUT, exist_ok=True)
    composition(g['B1'], herbs, 'B1 (WET: суглинок, 750 мм)', os.path.join(OUT, 'b1-composition.svg'))
    composition(g['B2'], herbs, 'B2 (DRY: песок, 260 мм, +11 °C)', os.path.join(OUT, 'b2-composition.svg'))
    occ = lambda r: [d['herbs']['occupied'] / r['setup']['plot']['n'] ** 2 * 100 for d in r['days']]
    lines([('B1', occ(g['B1']), SERIES[0]), ('B2', occ(g['B2']), SERIES[1])], 'Доля ячеек с травостоем > 1 г/м², %', '%',
          os.path.join(OUT, 'occupancy.svg'), ymax=100)
    err = lambda r: [f64(d['balanceError']) for d in r['days']]
    lines([('B1', err(g['B1']), SERIES[0]), ('B2', err(g['B2']), SERIES[1])], 'Относительная ошибка баланса вещества по суткам (порог 1e-4)', 'доля',
          os.path.join(OUT, 'balance.svg'), log=True, fmt='{:.1e}')
    # Таблица для отчёта: середина лета (сутки 8 года) по годам 1, 5, 10, 15, 20.
    for key in ('B1', 'B2'):
        r = g[key]
        cells = r['setup']['plot']['n'] ** 2
        print(f'{key}: год | ' + ' | '.join(NAMES[h] for h in herbs) + ' | занято, % | фронт, столбец | банк, г/м²')
        for y in (1, 2, 5, 10, 15, 20):
            d = r['days'][(y - 1) * 20 + 7]
            hb = d['herbs']
            bank = sum(f64(x) for x in hb['bank']) / cells
            print(f'  {y} | ' + ' | '.join(f'{f64(x) / cells:.1f}' for x in hb['biomass']) + f" | {hb['occupied'] / cells * 100:.1f} | {hb['frontier']} | {bank:.2f}")
        b = r['days'][-1]['biomeCounts']
        print(f'  биомы в конце: ' + ', '.join(f'{i}:{c}' for i, c in enumerate(b) if c))


main()
