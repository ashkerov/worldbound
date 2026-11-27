# Таблицы отчёта рендера растительности из JSON замеров стенда (FloraStand.exe -flbench ...).
# python unity/Tools/flora-report-tables.py unity/Results/flora/bench-medium.json [ещё файлы...]
import json
import sys

TITLES = {"overview": "Высокий обзор", "flight": "Полёт над лесом", "forest": "Внутри леса", "grass": "В высокой траве", "mixed": "Смешанная территория", "live": "Смешанная + обновления чанков"}


def n(v):
    return f"{v:,}".replace(",", " ")


def f(v, d=1):
    return "—" if v is None else f"{v:.{d}f}".replace(".", ",")


for path in sys.argv[1:]:
    d = json.load(open(path, encoding="utf-8"))
    print(f"\n### {d['quality']} — {d['gpu']}, {d['api']}, {d['resolution']} (renderScale {d['renderScale']}), vsync {d['vsync']}\n")
    print(f"Инициализация рендера {d['floraInitMs']} мс (запекание импосторов {d['impostorBakeMs']} мс); треугольников во всех моделях {n(d['meshTriangles'])}; меши {d['meshMB']} МБ, текстуры {d['textureMB']} МБ; ошибок контрольных сумм {d['checksumFailures']}, расхождений состояния {d['stateMismatches']}; источник не изменён рендером: {d['sourceUnchangedByRenderer']}\n")
    print("| Деревьев (+кустов) | Сценарий | к/с | Кадр p50 / p95 / p99, мс | CPU / GPU кадра (ср.), мс | Треуг. (ср./макс), тыс. | Вызовов флоры | Видимых экз. (ср.) | Смен LOD/с | Отсечение / трава, мс (ср.) | GC, Б/кадр | Память, МБ |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in d["runs"]:
        fm, cpu, gpu = r["frameMs"], r["cpuMs"], r["gpuMs"]
        tri, vis = r["triangles"], r["visibleInstances"]
        print(f"| {n(r['trees'])} (+{n(r['shrubs'])}) | {TITLES.get(r['view'], r['view'])} | **{f(r['fps'])}** | {f(fm['p50'])} / {f(fm['p95'])} / {f(fm['p99'])} | {f(cpu['mean'] if cpu else None)} / {f(gpu['mean'] if gpu else None)} | "
              f"{f(tri['mean'] / 1000, 0)} / {f(tri['max'] / 1000, 0)} | {f(r['floraDrawCalls']['mean'], 0)} | {f(vis['mean'], 0)} | {f(r['lodChangesPerSecond'], 0)} | {f(r['floraCullMs']['mean'], 2)} / {f(r['grassGenMs']['mean'], 2)} | {f(r['gcAllocBytesPerFrame']['mean'], 0) if r['gcAllocBytesPerFrame'] else '—'} | {r['memoryMB']['totalUsed']} |")
    for r in d["runs"]:
        if r["view"] == "live" or r.get("initialLoadMs"):
            print(f"\n- {n(r['trees'])} деревьев, {r['view']}: построение мира {r['worldBuildMs']} мс, полная загрузка в рендер {r['initialLoadMs']} мс; пакетов за прогон {r['chunkUpdates']}, применение пакета до {r['chunkUpdateMsMax']} мс, за кадр до {r['chunkApplyFrameMsMax']} мс; изменилось чанков в шаге {r['chunksChangedPerUpdate']}")
