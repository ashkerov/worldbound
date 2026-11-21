# WORLDBOUND — Unity Stage 2.0: основа данных флоры

Дата: 2026-11-21 · Ветка: `experiment/unity-windows-prototype` · План: `docs/UNITY_MIGRATION_STAGE2_PLAN.md` (этап 2.0) · Результаты: `docs/unity-stage2-0/`

**Эталон TypeScript — снимок `c8c6f838e2`** (2026-11-19). Он входит в ветку `experiment/unity-windows-prototype` и включает все изменения фазы 3 до него, в том числе slice 5. **`main` на GitHub этих изменений пока не содержит** (`origin/main` = `6335d38`, slice 4). Исходники TS в ветке после `c8c6f838e2` не менялись.

> С 2026-11-21 эталонный снимок — `7b2fbabbc1` (= `c8c6f838e2` + `export` у `herbCapacity`/`herbShade`, поведение не изменилось; см. `docs/UNITY_STAGE2_1_REPORT.md`). Результаты этого отчёта сняты с `c8c6f838e2` и остаются в силе.

Этап 2.0 переносит **только данные и чистые функции**. Флора не добавлена в расписание `Simulation`. Роста, размножения, сукцессии, колонизации, Burst-ускорителя флоры, визуализации растений и секции `FLOR` нет — по условию этапа.

## 1. Что реализовано

| Структура / функция | Файл C# | TS-источник | Примечание |
|---|---|---|---|
| Каталог растений (18 видов) и биомов (16) | `Sim/Flora/Catalog/PlantCatalog.g.cs`, `BiomeCatalog.g.cs` | `content/plants/plants.json`, `content/biomes/biomes.json` | Сгенерированы `tools/unity-catalog-export.ts` из записей, прочитанных загрузчиками TS со схемами. Числа — биты IEEE-754, плюс SHA-256 исходного JSON (окончания строк LF) и пояснения блока `calibration` |
| Типы записей | `Sim/Flora/CatalogTypes.cs` | `species.ts`, `biomes.ts` | `PlantSpecies`, `Range4`, `PlantForm`, `LeafHabit`, `HerbCommunity`/`Community`, `Biome`, `BiomeRule` |
| `SpeciesTable` | `Sim/Flora/SpeciesTable.cs` | `speciesTable` | Все 41 поле и `Herbs`; те же производные (`lightNeed = 1 − 0,92·тень`, `nutrientHalf`) и значения по умолчанию; `SpeciesTable.Default` — как `SPECIES` |
| Отклики | `Sim/Flora/Suitability.cs` (`Suitability`) | `suitability.ts` | `Trapezoid`, `TempResponse`, `MoistureResponse` (+1e−9), `LightResponse`, `NutrientResponse`, `SoilResponse`, `Of` (общая пригодность) |
| Размеры, свет, вместимость | `Sim/Flora/Suitability.cs` (`FloraMath`) | `system.ts` | `WoodyHeight`, `CrownRadius`, `LayerOf`, `LightAt`, `GroundLight`, `HerbShade`, `HerbCapacity`; ярусы 2/6/15 м, `TallTree` |
| Классификатор биомов | `Sim/Flora/Biomes.cs` | `biomes.ts` | `RuleMatches` (режимы −1/0/+1), `Classify`, `ConfirmsChange` (триггер Шмитта), `BiomeInput`. Суточное сглаживание (`biomeState.ts`) — этап 2.1–2.2 |
| Идентификаторы | `Sim/Core/Ids.cs` | `src/shared/ids.ts` | `EntityKind`, `EntityId.Make` (тип 4 бита, поколение 8, индекс 20; маски как 32-битные операции JS), `Kind`/`Generation`/`Index`, `Key` для `counterRandom` |
| `WoodyStore` | `Sim/Flora/WoodyStore.cs` | `woodyStore.ts` | SoA (13 столбцов), `HighWater`, `Count`, стек свободных LIFO, поколения 255 → 0, `IdOf`, `FreeSlots`, `Restore` |
| `FloraState`, `BiomeTrack`, ведомость | `Sim/Flora/FloraState.cs` | `state.ts` | Все массивы с типами TS (float32, float64, byte, ushort/short); `Create` (как `createFlora`), `NutrientStock`, `NutrientBudget`, `HerbBiomass`, `WoodyCapacity`, `InitialNutrient`, пределы (`Slots`, `MaxWoodyPerCell`, `WoodyPerCellMean`) |

Накопители `accT`, `accW`, `accRunoff`, `accMinT`, `accHours`, `capillary` в `FloraState` — **те же массивы**, что пишет часовой шаг воды (`Env.FloraInputs`). Это одно состояние, а не копия; в TS они тоже часть `FloraState`.

## 2. Созданные и изменённые файлы

**Новые:**
- `tools/unity-catalog-export.ts` — генератор каталогов; `--check` — проверка, что `.g.cs` соответствуют JSON;
- `tools/unity-flora-golden.ts` — эталоны G0/G1 с настоящего кода TS;
- `unity/WorldboundProto/Assets/Worldbound/Sim/Flora/Catalog/PlantCatalog.g.cs`, `BiomeCatalog.g.cs`;
- `unity/WorldboundProto/Assets/Worldbound/Sim/Flora/CatalogTypes.cs`, `SpeciesTable.cs`, `Suitability.cs`, `Biomes.cs`, `WoodyStore.cs`, `FloraState.cs`;
- `unity/WorldboundProto/Assets/Worldbound/Sim/Core/Ids.cs`;
- `unity/WorldboundProto/Assets/Worldbound/SimTests/FloraGolden.cs` — проверка G0/G1 (в существующей сборке проверок `Worldbound.Sim.Golden`);
- `unity/WorldboundProto/Golden/flora-g0g1.json` — эталон, 3,1 МБ, вне сборки;
- `docs/UNITY_STAGE2_0_REPORT.md`, `docs/unity-stage2-0/*`.

**Изменённые:**
- `SimTests/MiniJson.cs` — разбор битов double/float;
- `tools/simcli/Program.cs` — режим `flora`;
- `Editor/BuildTools.cs` (`RunSimTests`) и `Runtime/App/WorldApp.cs` (`-wbsimtest`) — проверка флоры в редакторе и сборке;
- `docs/UNITY_MIGRATION_STAGE2_PLAN.md`, `DEVELOPMENT_PLAN.md`, `PROJECT_CONTEXT.md`.

## 3. Результаты G0 и G1

Все значения сравниваются **по битам** с эталоном, снятым с настоящего кода TS (Node 24). Входы векторов тоже переданы битами — C# считает на тех же числах.

| Раздел | Что проверяется | Проверок | Расхождений |
|---|---|---|---|
| G0.sha256 | SHA-256 `plants.json` и `biomes.json`: сгенерированные константы = эталон = файлы на диске | 4 | 0 |
| G0.plants | Все поля 18 записей каталога (строки, перечисления, 30 числовых полей, предпочтения почв) | 577 | 0 |
| G0.speciesTable | Все поля `SpeciesTable` (33 вещественных, 7 целых, `Herbs`), порядок почв | 852 | 0 |
| G0.biomes | id, имя, цвет, вода, 17 порогов каждого из 16 биомов | 321 | 0 |
| G1.trapezoid | 600 трапеций: точки, вырожденный оптимум, случайные значения | 600 | 0 |
| G1.responses | Температура, влага, свет, питание, почва — сетки и границы трапеций каждого вида (± 10⁻¹², ± 10⁻⁶) | 25 038 | 0 |
| G1.suitability | Общая пригодность: 300 случайных условий на вид | 5 400 | 0 |
| G1.heightCrown | Высота и крона древесных: 0, 10⁻⁹, B½, Bmax и 120 случайных биомасс на вид | 2 640 | 0 |
| G1.herbCapacity | Вместимость трав: 200 точек на вид | 1 600 | 0 |
| G1.light | `LightAt` на границах ярусов (2, 6, 15 м ± 10⁻⁶) и случайных высотах, `GroundLight`, `HerbShade` | 5 706 | 0 |
| G1.biomes | 3000 случайных показателей + показатели на каждом пороге ± запас: классификация, совпадение со всеми правилами в 3 режимах, `ConfirmsChange` | 9 483 | 0 |
| G1.ids | `makeId`: все виды (включая −1 и 16), поколения 0…511 и отрицательные (маска 255 → 0), индексы до 2²⁰−1; разбор 300 случайных id | 994 | 0 |
| G1.rng | `mix32`, `hash4` / `counterRandom` (ключи > 2³¹, отрицательные, id деревьев, `c·32+s`), sfc32 (5 потоков), seed из строки (кириллица) | 904 | 0 |
| G1.woodyStore | 600 операций (выделение и освобождение, в том числе повторное освобождение): индекс, `highWater`, `count`, стек, `IdOf` после каждой; 13 столбцов; 300 циклов поколения 255 → 0; заполнение (−1) и LIFO; `Restore` и его ошибка | 916 | 0 |
| G1.floraState | `createFlora` на мире S/42 (26 массивов состояния, 12 массивов `BiomeTrack`, 13 столбцов древесных), ёмкость; заполненное состояние (травы, банк семян, опад, питание, 20 000 древесных с освобождениями, ведомость): массивы, `nutrientStock`, `nutrientBudget`, `herbBiomass`, стек | 113 | 0 |
| **Всего** | | **55 148** | **0** |

**Чувствительность проверена.** Временная замена сложения в double на сложение во float в двух местах (`NutrientStock`, `LightAt`) сразу дала 2227 расхождений света и неверный `nutrientStock`. После возврата всё снова OK.

## 4. .NET 6 и Unity

| Среда | G0/G1 | Отпечаток всех вычисленных значений | Время проверки |
|---|---|---|---|
| .NET 6 (CoreCLR, `tools/simcli`) | 55 148 / 0 | `dab1d2e7` | 2,2 с |
| Unity редактор (Mono JIT) | 55 148 / 0 | `dab1d2e7` | 3,2 с |
| Сборка Windows (Mono) | 55 148 / 0 | `dab1d2e7` | 3,0 с |

Отпечаток (FNV по всем вычисленным C# значениям) одинаков во всех трёх средах. Детерминизм подтверждён ещё и так: эталон перегенерирован после изменения инструмента, а данные проверки не изменились (проверка снова OK).

## 5. Сохранность Stage 1

| Проверка | .NET 6 | Редактор | Сборка |
|---|---|---|---|
| Генератор, 6 миров — побитно | OK | OK | OK |
| Среда, 2880 часов — побитно (Mono; Burst) | OK | OK; OK | OK; OK |
| Сохранение S, M | OK | OK | OK |
| Устойчивость WBSV (27 вариантов + 2 резервные копии, в том числе версии секций) | OK | OK | OK |
| Темп и пауза, хост | OK | OK | OK |

Также проверено:
- **Сборка Windows:** 23 с, 101,7 МБ. Эталонных данных нет (`docs/unity-stage2-0/build-contents-check.json`); код проверок `Worldbound.Sim.Golden.dll` — в сборке, как и раньше.
- **TS-проект:** `npm run typecheck`, `eslint` новых инструментов, `check:content`, `check:assets` — без ошибок. `npx tsx tools/unity-catalog-export.ts --check` — каталоги соответствуют JSON.
- **Математика воды, погоды и генерации не менялась.** `Simulation` не трогался.

Свёрнутый режим (мир M, ×8, `background-continue.json`): активно — 59,8 обновления в секунду; свёрнуто — 2,0 в секунду, рендер выключен, 3200 из 3200 тактов, CPU 5,2 % ядра; после восстановления — 59,7, такты по графику. Ограничение кадров (`frame-cap-player.json`, 1080p, 60 Гц): VSync — 59,7 к/с, 30 — 30,0, 60 — 59,7, 90 — 89,7, 120 — 100,6 (предел видеокарты).

## 6. Производительность и выделение памяти

| Замер | TS (Node 24) | .NET 6 | Mono (редактор) | Mono (сборка) |
|---|---|---|---|---|
| `createFlora` мира S, мс | 3,5–5,2 | 2,0–2,4 | 3,0 | 12,7 |
| `createFlora` мира M, мс | — | 5,4–5,6 | 8,5 | 25,2 |
| Память состояния флоры S / M, МБ | — | 21,8 / 87,3 | 22,0 / 87,4 | 20,9 / 81,9 |
| Детерминированное заполнение S (тестовое), мс | 25–27 | 8,8–9,4 | 23,3 | 24,3 |
| `nutrientStock` S (заполненное состояние), мс | 4,8–4,9 | 2,6–2,8 | 2,9 | 3,7 |
| `suitability`, нс на вызов | 31,3 | 42,3–42,8 | 42,2 | 47,1 |
| `lightAt` + `woodyHeight`, нс на вызов | 17,0 | 12,5–16,5 | 15,0 | 14,9 |
| Сборки мусора / прирост кучи в горячем цикле (4 млн вызовов) | — | 0 / 0 Б | 0 / 0 Б | 0 / 0 Б |

- Чистые функции не выделяют память.
- `suitability` на Mono медленнее V8 примерно в 1,4–1,5 раза — то же соотношение «обычный C# против TS», что и в Stage 1. Для поведения флоры (этапы 2.2–2.5) нужен Burst (план, раздел 7).
- Память почти целиком — заранее выделенное хранилище древесных: мир M — 1 048 576 мест × 13 столбцов ≈ 40 МБ, плюс стек свободных 4 МБ (в TS стек растёт по мере освобождений). К ним добавляются банк семян 8 трав × 262 144 × 4 Б = 8 МБ, полог 4 МБ и остальные массивы.
- Время `createFlora` в сборке — первое выполнение после запуска (JIT Mono); в редакторе код уже прогрет.

## 7. Ограничения

1. **`herbCapacity` и `herbShade` сверены с формулой, а не с вызовом TS.** В `system.ts` это модульные функции без `export`, а эталон не меняет код TS. Формулы продублированы в `tools/unity-flora-golden.ts` построчно поверх экспортированных `nutrientResponse` и `SPECIES`. Полную проверку они получат в этапе 2.3 сценарием трав (G3 B).
2. **`LayerOf`** проверяется через `lightAt` на границах ярусов (в TS не экспортирована).
3. **Правило арифметики для следующих этапов.** В C# `float + float` и `1 - float` считаются во float, в JS — в double. Везде, где TS складывает элементы `Float32Array`, в C# нужно явно приводить к double. Это найдено при переносе (`NutrientStock`, `LightAt`) и закреплено проверкой чувствительности. Добавлено в план (раздел 11).
4. Каталоги — сгенерированные данные. Загрузки JSON во время работы (моды) нет — по условию этапа. Изменение JSON требует перегенерации: `--check` в TS и G0 в C# это обнаруживают.
5. Для проверки SHA-256 по файлам нужна папка `content/` репозитория рядом с эталонами. В сборке без репозитория сверяются только константы с эталоном.
6. Не перенесено, по плану — этап 2.1 и дальше:
   - `greennessOf`, `refreshCover`;
   - сглаживание биома (`updateBiome`, `initBiomes`);
   - `populate` (Genesis, Wildlands);
   - `processCell`, `processWoody`, колонизация;
   - подготовка Wildlands, `FLOR`, полный хеш состояния.
7. Эталон G0/G1 — 3,1 МБ в репозитории, вне сборки.
8. Хранилище древесных выделяется целиком сразу (M ≈ 44 МБ со стеком). Ленивое выделение по `highWater` — возможная оптимизация, без неё поведение совпадает с TS.

## 8. Как проверить

```
npx tsx tools/unity-catalog-export.ts --check    # каталоги соответствуют JSON
npx tsx tools/unity-flora-golden.ts              # эталон G0/G1 (Golden/flora-g0g1.json)
bash tools/simcli/run.sh flora                   # .NET 6
Unity.exe -batchmode -quit -nographics -projectPath unity\WorldboundProto -executeMethod Worldbound.EditorTools.BuildTools.RunSimTests
WorldboundProto.exe -batchmode -nographics -wbsimtest <папка Golden> <файл.json>
```
