// Суточный шаг растительности (src/sim/flora/system.ts: floraSystem, processCell) — Stage 2.2: расписание и голая земля;
// Stage 2.3: травяной ярус (рост, конкуренция, отмирание, семена, расселение, прорастание, старение банка семян).
//
// Расписание — как в TS: период 50 тактов, фаза 25 (никогда не совпадает с часовым шагом воды); 6 порций в час,
// 144 в сутки. Ячейки — строки z ≡ час (mod 24), в порции sub — столбцы [⌊sub·n/6⌋, ⌊(sub+1)·n/6⌋), только суша;
// древесные — индексы ≡ час + 24·sub (mod 144) до highWater, зафиксированного в начале порции; позиции края — так же.
// Полог пересчитывается в порции 0 часа 0 суток; lastSliceHour — после 6-й порции часа.
//
// Перенесено: суточные средние и сброс накопителей воды, травяной ярус целиком (два прохода роста и потерь с общими
// ограничениями ячейки, исчезновение популяции в опад, семена в сезон плодоношения, расселение двумя пакетами,
// прорастание банка, старение банка в опад), почва (выветривание, вымывание, разложение), живой покров (вход испарения),
// суточное обновление биома. Ветви древесных, колонизации и семян региона — этапы 2.4–2.5: там, где TS пошёл бы в такую
// ветвь (есть живые древесные, мир открыт колонистам или идёт подготовка Wildlands), шаг останавливается исключением
// FloraNotPortedException — молчаливого расхождения с эталоном нет. Мир без древесных (Genesis + изоляция, с травами и
// банком семян или без них) перенесённая часть ведёт побитно равно TS.
//
// Точки округления — как в TS: всё считается в double, во float32 округляется только запись в массив состояния
// (слоты, банк, опад, запас питания). Значения массивов float читаются в double до арифметики.
using System;
using System.Diagnostics;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    /// <summary>Шаг дошёл до ветви модели, которая ещё не перенесена на C#.</summary>
    public sealed class FloraNotPortedException : Exception
    {
        public FloraNotPortedException(string message) : base(message) { }
    }

    /// <summary>
    /// Замер частей суточного шага — только для стендов (FloraSystem.Profile = null — без замеров). Состояние мира не
    /// читает и не меняет: метки времени снимаются вокруг частей шага.
    /// </summary>
    public sealed class FloraProfile
    {
        public long Portions, Cells, OccupiedSlots, SeedingSlots, Germinations;
        public long HerbTicks, SeedTicks, GerminationTicks, AgingTicks, SoilTicks, BiomeTicks;
        public static double Ms(long ticks) => ticks * 1000.0 / Stopwatch.Frequency;
    }

    public static class FloraSystem
    {
        /// <summary>Замер частей шага (стенд); null — без замеров.</summary>
        public static FloraProfile Profile;

        /// <summary>Частей в игровом часе и их период в тактах.</summary>
        public const int Substeps = 6;
        public const int Period = SimTime.TicksPerHour / Substeps;
        /// <summary>Сдвиг на полпорции: шаг флоры не совпадает в одном такте с часовым шагом воды.</summary>
        public const int Phase = Period / 2;

        // Константы system.ts (почва).
        const double DecayFast = 2.5;
        const double DecayWood = 0.18;
        const double WeatheringBase = 0.4;
        const double WeatheringFertility = 1.6;
        /// <summary>Банк семян меньше этого (г/м²) не прорастает.</summary>
        const double MinGerminatingBank = 0.002;
        /// <summary>Сезон плодоношения трав (доля года) и сезон прорастания банка.</summary>
        public static readonly double[] HerbSeedSeason = { 0.4, 0.66 };
        public static readonly double[] GerminationSeason = { 0.02, 0.4 };
        /// <summary>Ниже этой биомассы (г/м²) локальная популяция вида исчезает, остаток — в опад.</summary>
        public const double HerbExtinction = 0.02;
        /// <summary>Цена дыхания в тени: множитель потерь при недостатке света.</summary>
        const double ShadeLoss = 2;
        /// <summary>Корневой запас многолетника, зимующий под землёй: доля предельной биомассы.</summary>
        const double RootReserve = 0.1;
        /// <summary>Система счётчикового генератора: расселение семян трав (SYS_HERB_SEED).</summary>
        const int SysHerbSeed = 312;

        // Рабочие массивы прохода 1 (модульные Float64Array в TS). Флора всех симуляций идёт под BiomeState.Gate.
        static readonly double[] Grow = new double[FloraState.Slots];
        static readonly double[] Lose = new double[FloraState.Slots];
        static readonly double[] Fix = new double[FloraState.Slots];
        static readonly double[] FitOf = new double[FloraState.Slots];
        static readonly double[] CapOf = new double[FloraState.Slots];
        // Биом (biomeState.ts).
        const double EmaPerYear = 3;
        const double GrowingT = 8;
        const double Autumn = 0.68;

        /// <summary>Контекст суток — как модульный объект ctx в TS.</summary>
        public struct DayContext
        {
            public double Dt, YearFrac;
            public long DayOfYear, DaysPerYear, Day;
            public double CellArea;
            public long HoldDays;
        }

        /// <summary>
        /// Почему этот мир нельзя вести перенесённой частью флоры (null — можно). Проверка заранее, для интерфейса;
        /// сам шаг дополнительно останавливается в каждой неперенесённой ветви.
        /// </summary>
        public static string Unsupported(World world)
        {
            var f = world.Flora;
            if (f.RegionalSeedRain) return "идёт подготовка Wildlands (семена региона) — этап 2.5";
            if (!world.Config.Isolated) return "мир открыт колонистам извне (колонизация через край) — этап 2.5";
            if (f.Woody.Count > 0) return "есть древесные растения — этап 2.4";
            // Травы и банк семян трав перенесены (этап 2.3).
            return null;
        }

        /// <summary>Одна порция суточного шага (вызывается в такты с tick ≡ 25 (mod 50)).</summary>
        public static void Run(World world, long tick)
        {
            lock (BiomeState.Gate) RunLocked(world, tick);
        }

        static void RunLocked(World world, long tick)
        {
            long hour = (long)Math.Floor(tick / (double)SimTime.TicksPerHour);
            int sub = (int)Math.Floor((tick - hour * SimTime.TicksPerHour) / (double)Period);
            int slice = (int)(hour % 24);
            var geo = world.Geo;
            var f = world.Flora;
            var ctx = new DayContext();
            ctx.DaysPerYear = (long)world.Config.DaysPerSeason * SimTime.SeasonsPerYear;
            ctx.Dt = 1.0 / ctx.DaysPerYear;
            ctx.YearFrac = SimTime.YearFraction(tick, world.Config.DaysPerSeason);
            ctx.Day = (long)Math.Floor(hour / 24.0);
            ctx.DayOfYear = ctx.Day % ctx.DaysPerYear;
            ctx.CellArea = geo.CellSize * geo.CellSize;
            ctx.HoldDays = Math.Max(2, (long)JsMath.Round(ctx.DaysPerYear / 4.0));
            if (slice == 0 && sub == 0) Cover.Refresh(world, false);
            if (Profile != null) Profile.Portions++;
            int n = geo.N;
            // Ячейки: строки z ≡ час (mod 24), в каждой порции — свой отрезок столбцов.
            int x0 = (int)Math.Floor(sub * n / (double)Substeps);
            int x1 = (int)Math.Floor((sub + 1) * n / (double)Substeps);
            for (int z = slice; z < n; z += 24)
                for (int x = x0; x < x1; x++)
                {
                    int c = z * n + x;
                    if (geo.WaterKind[c] == WaterKind.None) ProcessCell(world, c, in ctx);
                }
            // Древесные: индекс ≡ час (mod 24), в каждой порции — каждый шестой из них; граница — на начало порции.
            var w = f.Woody;
            int high = w.HighWater;
            int stride = 24 * Substeps;
            for (int i = slice + 24 * sub; i < high; i += stride)
                if (w.Alive[i] == 1) throw new FloraNotPortedException($"processWoody (растение {i}) — этап 2.4");
            // Край мира: колонизация извне. Изоляция действует с момента готовности мира (во время подготовки мир открыт).
            if (!world.Config.Isolated || f.RegionalSeedRain)
            {
                int edge = 4 * n;
                if (slice + 24 * sub < edge) throw new FloraNotPortedException("colonizeEdge (колонизация через край) — этап 2.5");
            }
            if (sub == Substeps - 1) f.LastSliceHour = hour;
        }

        /// <summary>Суточный шаг ячейки суши (processCell): перенесены средние, почва, покров, биом.</summary>
        static void ProcessCell(World world, int c, in DayContext ctx)
        {
            var f = world.Flora;
            var geo = world.Geo;
            int hours = f.AccHours[c];
            if (hours > 0)
            {
                f.DayT[c] = (float)((double)f.AccT[c] / hours);
                f.DayW[c] = (float)((double)f.AccW[c] / hours);
            }
            double T = f.DayT[c];
            double W = f.DayW[c];
            double runoff = f.AccRunoff[c];
            f.AccT[c] = 0;
            f.AccW[c] = 0;
            f.AccRunoff[c] = 0;
            f.AccMinT[c] = 99;
            f.AccHours[c] = 0;
            double dt = ctx.Dt;
            double area = ctx.CellArea;
            double snow = world.Env.Snow[c];
            var ledger = f.Ledger;

            var prof = Profile;
            long t0 = prof != null ? Stopwatch.GetTimestamp() : 0;
            var t = f.Species;
            double light = FloraMath.GroundLight(f.Canopy, c);
            bool cold = T < 2 || snow > 5;
            int s0 = c * FloraState.Slots;

            // ── Травяной ярус, проход 1: прирост и потери всех видов от одной и той же картины ячейки.
            double total = 0;
            for (int k = 0; k < FloraState.Slots; k++) total += f.SlotBiomass[s0 + k];
            double nutrient = f.Nutrient[c];
            double sumGrow = 0, sumLoss = 0, needN = 0, growCap = 0;
            for (int k = 0; k < FloraState.Slots; k++)
            {
                Grow[k] = 0;
                Lose[k] = 0;
                Fix[k] = 0;
                int s = f.SlotSpecies[s0 + k];
                if (s == SpeciesTable.NoSpecies) continue;
                double b = f.SlotBiomass[s0 + k];
                double fit = HerbFit(world, s, c, light);
                double capacity = FloraMath.HerbCapacity(t, s, fit, nutrient);
                FitOf[k] = fit;
                CapOf[k] = capacity;
                double crowd = capacity > 0 ? 1 - total / capacity : -1;
                if (!cold && crowd > 0)
                {
                    Grow[k] = t.Growth[s] * dt * b * fit * Suitability.NutrientResponse(t, s, nutrient) * crowd;
                    if (capacity > growCap) growCap = capacity;
                }
                double loss = t.Mortality[s] * dt * b;
                // Зимой надземная часть отмирает, многолетник зимует корневищами (до 10 % предельной биомассы).
                double reserve = Math.Min(b, RootReserve * t.MaxBiomass[s]);
                if (cold && t.Dieback[s] == 1) loss += Math.Max(0, 0.35 * (b - reserve));
                // Листопадные кустарнички теряют на зиму только листья.
                else if (cold && t.Evergreen[s] == 0) loss += Math.Max(0, 0.02 * (b - reserve));
                if (fit < 0.05 && T > 5) loss += 0.08 * b;
                // Углеродный баланс в тени: виду, которому не хватает света, дыхание обходится дороже прироста.
                if (!cold) loss += ShadeLoss * (1 - Suitability.LightResponse(t, s, light)) * dt * b;
                Lose[k] = Math.Min(b, loss);
                Fix[k] = t.Fixes[s] * dt * Math.Min(1, b / (0.5 * t.MaxBiomass[s]));
                sumGrow += Grow[k];
                sumLoss += Lose[k];
                needN += Grow[k] * t.Nutrient[s];
            }
            // Проход 2: общие ограничения — суммарный прирост не выводит ячейку за вместимость лучшего из растущих видов,
            // и на прирост уходит не больше половины запаса питания.
            double scale = 1;
            double room = growCap - (total - sumLoss);
            if (sumGrow > 0 && sumGrow > room) scale = room > 0 ? room / sumGrow : 0;
            if (needN * scale > 0.5 * nutrient) scale = needN > 0 ? Math.Min(scale, 0.5 * nutrient / needN) : 0;
            double pool = nutrient;
            for (int k = 0; k < FloraState.Slots; k++)
            {
                int slot = s0 + k;
                int s = f.SlotSpecies[slot];
                if (s == SpeciesTable.NoSpecies) continue;
                double g = Grow[k] * scale;
                double loss = Lose[k];
                double b = f.SlotBiomass[slot] + g - loss;
                pool += Fix[k] - g * t.Nutrient[s];
                AddLitterFast(f, c, loss, s);
                ledger[Ledger.Photosynthesis] += g * area / 1000;
                ledger[Ledger.Litterfall] += loss * area / 1000;
                ledger[Ledger.Fixation] += Fix[k] * area;
                if (b < HerbExtinction)
                {
                    // Локальная популяция исчезла: остаток уходит в опад.
                    AddLitterFast(f, c, b, s);
                    ledger[Ledger.Litterfall] += b * area / 1000;
                    b = 0;
                    f.SlotSpecies[slot] = SpeciesTable.NoSpecies;
                }
                f.SlotBiomass[slot] = (float)b;
            }
            f.Nutrient[c] = (float)pool;
            if (prof != null)
            {
                prof.Cells++;
                for (int k = 0; k < FloraState.Slots; k++) if (f.SlotSpecies[s0 + k] != SpeciesTable.NoSpecies) prof.OccupiedSlots++;
                long t1 = Stopwatch.GetTimestamp();
                prof.HerbTicks += t1 - t0;
                t0 = t1;
            }

            // ── Размножение трав: семена из биомассы в сезон плодоношения, разнос по ядру вида в банки семян.
            double yf = ctx.YearFrac;
            if (yf >= HerbSeedSeason[0] && yf < HerbSeedSeason[1] && !cold)
            {
                double seasonShare = dt / (HerbSeedSeason[1] - HerbSeedSeason[0]);
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    int slot = s0 + k;
                    int s = f.SlotSpecies[slot];
                    if (s == SpeciesTable.NoSpecies || FitOf[k] < 0.2) continue;
                    double b = f.SlotBiomass[slot];
                    if (b < 5) continue;
                    double seeds = t.SeedAlloc[s] * seasonShare * b * FitOf[k];
                    f.SlotBiomass[slot] = (float)(b - seeds);
                    DisperseHerbSeeds(world, c, s, seeds, in ctx);
                    if (prof != null) prof.SeedingSlots++;
                }
            }
            if (prof != null) { long t1 = Stopwatch.GetTimestamp(); prof.SeedTicks += t1 - t0; t0 = t1; }

            // ── Прорастание банка семян весной и в начале лета: там, где есть зазор в травостое и условия.
            if (yf >= GerminationSeason[0] && yf < GerminationSeason[1] && T > 6 && snow < 1)
            {
                Germinate(world, c, light, dt);
                if (prof != null) prof.Germinations++;
            }
            if (prof != null) { long t1 = Stopwatch.GetTimestamp(); prof.GerminationTicks += t1 - t0; t0 = t1; }

            // ── Старение банка семян: невсхожие семена уходят в опад.
            int count = geo.N * geo.N;
            var herbs = t.Herbs;
            for (int h = 0; h < herbs.Length; h++)
            {
                int o = h * count + c;
                double bank = f.SeedBank[o];
                if (bank <= 0) continue;
                int s = herbs[h];
                double dead = bank * Math.Min(1, dt / t.SeedBankYears[s]);
                f.SeedBank[o] = (float)(bank - dead);
                AddLitterFast(f, c, dead, s);
                ledger[Ledger.Litterfall] += dead * area / 1000;
            }
            if (prof != null) { long t1 = Stopwatch.GetTimestamp(); prof.AgingTicks += t1 - t0; t0 = t1; }

            // ── Почва: выветривание, вымывание, разложение опада (быстрый — со скоростью по качеству опада видов).
            double weathering = (WeatheringBase + WeatheringFertility * geo.Fertility[c]) * dt;
            double nut = f.Nutrient[c] + weathering;
            ledger[Ledger.Weathering] += weathering * area;
            double capW = world.Derived.Capacity[c];
            double leach = nut * Math.Min(0.3, runoff / (capW * 3));
            nut -= leach;
            ledger[Ledger.Leaching] += leach * area;
            double decomp = DMath.Clamp((T + 3) / 18, 0, 1.4) * DMath.Smoothstep(0.05, 0.35, W) * (1 - 0.5 * DMath.Smoothstep(0.92, 1, W));
            double litterMass = f.LitterFast[c];
            double quality = litterMass > 1e-6 ? DMath.Clamp(f.LitterFastQ[c] / litterMass, 0.05, 5) : 1;
            double kFast = Math.Min(0.9, DecayFast * quality * decomp * dt);
            double kWood = Math.Min(0.9, DecayWood * decomp * dt);
            double lf = litterMass * kFast;
            double lfN = f.LitterFastN[c] * kFast;
            double lw = f.LitterWood[c] * kWood;
            double lwN = f.LitterWoodN[c] * kWood;
            f.LitterFast[c] = (float)(litterMass - lf);
            f.LitterFastN[c] = (float)(f.LitterFastN[c] - lfN);
            f.LitterFastQ[c] = (float)(f.LitterFastQ[c] * (1 - kFast));
            f.LitterWood[c] = (float)(f.LitterWood[c] - lw);
            f.LitterWoodN[c] = (float)(f.LitterWoodN[c] - lwN);
            nut += lfN + lwN;
            ledger[Ledger.Decomposition] += (lf + lw) * area / 1000;
            f.Nutrient[c] = (float)nut;
            if (prof != null) { long t1 = Stopwatch.GetTimestamp(); prof.SoilTicks += t1 - t0; t0 = t1; }
            if (f.RegionalSeedRain) throw new FloraNotPortedException("regionalSeedRain (семена региона) — этап 2.5");
            world.Env.Greenness[c] = (float)Cover.GreennessOf(world, c);
            UpdateBiome(world, c, dt, ctx.YearFrac, ctx.HoldDays);
            if (prof != null) prof.BiomeTicks += Stopwatch.GetTimestamp() - t0;
        }

        /// <summary>Отклик вида на условия ячейки за сутки (без питания): температура × влага × свет × почва (herbFit).</summary>
        public static double HerbFit(World world, int s, int c, double light)
        {
            var f = world.Flora;
            var t = f.Species;
            return Suitability.TempResponse(t, s, f.DayT[c]) * Suitability.MoistureResponse(t, s, f.DayW[c]) * Suitability.LightResponse(t, s, light)
                * Suitability.SoilResponse(t, s, world.Geo.Soil[c]);
        }

        /// <summary>Опад в ячейку (addLitterFast): масса г/м², элемент питания и качество опада — по виду.</summary>
        static void AddLitterFast(FloraState f, int cell, double perM2, int s)
        {
            var t = f.Species;
            f.LitterFast[cell] = (float)(f.LitterFast[cell] + perM2);
            f.LitterFastN[cell] = (float)(f.LitterFastN[cell] + perM2 * t.Nutrient[s]);
            f.LitterFastQ[cell] = (float)(f.LitterFastQ[cell] + perM2 * t.LitterQuality[s]);
        }

        /// <summary>
        /// Ядро расселения (dispersalTarget): дальность d = min(max, 3·mean·u²), направление равномерно; u и v —
        /// счётчиковый генератор от (seed, system, key, day·64 + salt·2 [+1]).
        /// </summary>
        public static void DispersalTarget(World world, double x, double z, int s, long key, long salt, long day, int system, out double tx, out double tz)
        {
            var t = world.Flora.Species;
            int seed = unchecked((int)world.Seed);
            int k = unchecked((int)key);
            double u = Hash.CounterRandom(seed, system, k, unchecked((int)(day * 64 + salt * 2)));
            double v = Hash.CounterRandom(seed, system, k, unchecked((int)(day * 64 + salt * 2 + 1)));
            double d = Math.Min(t.DispersalMax[s], 3 * t.DispersalMean[s] * u * u);
            double a = DMath.TWO_PI * v;
            tx = x + d * DMath.DCos(a);
            tz = z + d * DMath.DSin(a);
        }

        /// <summary>Индекс суши для точки или −1 (за границей мира или на воде) — landCellAt.</summary>
        public static int LandCellAt(World world, double x, double z)
        {
            int size = world.WorldSize;
            if (!(x >= 0 && z >= 0 && x < size && z < size)) return -1;
            var geo = world.Geo;
            int c = (int)Math.Floor(z / geo.CellSize) * geo.N + (int)Math.Floor(x / geo.CellSize);
            return geo.WaterKind[c] == WaterKind.None ? c : -1;
        }

        /// <summary>Семена трав: половина остаётся в своей ячейке, остальные — двумя «пакетами» по ядру расселения вида.</summary>
        static void DisperseHerbSeeds(World world, int c, int s, double seeds, in DayContext ctx)
        {
            var f = world.Flora;
            int n = world.Geo.N;
            int count = n * n;
            int h = f.Species.HerbSlot[s];
            double area = ctx.CellArea;
            double local = seeds * 0.5;
            f.SeedBank[h * count + c] = (float)(f.SeedBank[h * count + c] + local);
            double x = (c % n + 0.5) * world.Geo.CellSize;
            double z = (c / n + 0.5) * world.Geo.CellSize;
            for (int p = 0; p < 2; p++)
            {
                double packet = (seeds - local) / 2;
                DispersalTarget(world, x, z, s, (long)c * 32 + s, p, ctx.Day, SysHerbSeed, out double tx, out double tz);
                int tc = LandCellAt(world, tx, tz);
                if (tc < 0)
                {
                    // Унесено за пределы суши мира (за край или в воду): элемент питания уходит из учёта как вынос.
                    f.Ledger[Ledger.Exported] += packet * area * f.Species.Nutrient[s];
                    continue;
                }
                f.SeedBank[h * count + tc] = (float)(f.SeedBank[h * count + tc] + packet);
            }
        }

        /// <summary>Прорастание (germinate): вид в ячейке есть — пополняет свой слот; нет — занимает свободный, если есть зазор.</summary>
        static void Germinate(World world, int c, double light, double dt)
        {
            var f = world.Flora;
            var t = f.Species;
            int count = world.Geo.N * world.Geo.N;
            int s0 = c * FloraState.Slots;
            double total = 0;
            for (int k = 0; k < FloraState.Slots; k++) total += f.SlotBiomass[s0 + k];
            var herbs = t.Herbs;
            for (int h = 0; h < herbs.Length; h++)
            {
                int o = h * count + c;
                double bank = f.SeedBank[o];
                if (bank < MinGerminatingBank) continue;
                int s = herbs[h];
                double fit = HerbFit(world, s, c, light);
                if (fit < 0.15) continue;
                double capacity = FloraMath.HerbCapacity(t, s, fit, f.Nutrient[c]);
                // Место для всходов — зазор в травостое.
                double gap = 1 - total / capacity;
                if (gap <= 0) continue;
                // Подстилка мешает прорасти мелким семенам сильнее, чем крупным.
                double litterHalf = 80 * (1 + 400 * t.SeedMass[s]);
                double litter = 1 / (1 + f.LitterFast[c] / litterHalf);
                double amount = bank * Math.Min(1, t.Establishment[s] * fit * gap * litter * dt * 6);
                int slot = -1, free = -1;
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    int sk = f.SlotSpecies[s0 + k];
                    if (sk == s) slot = s0 + k;
                    else if (sk == SpeciesTable.NoSpecies && free < 0) free = s0 + k;
                }
                if (slot < 0)
                {
                    if (free < 0) continue;
                    slot = free;
                    f.SlotSpecies[slot] = (byte)s;
                    f.SlotBiomass[slot] = 0;
                }
                f.SeedBank[o] = (float)(bank - amount);
                f.SlotBiomass[slot] = (float)(f.SlotBiomass[slot] + amount);
                total += amount;
            }
        }

        /// <summary>
        /// Суточное обновление биома ячейки суши (updateBiome в biomeState.ts): в вегетацию показатели подмешиваются
        /// в сглаженные; классификация; смена — только с запасом порога и после holdDays суток подряд.
        /// </summary>
        public static void UpdateBiome(World world, int c, double dt, double yearFrac, long holdDays)
        {
            var f = world.Flora;
            var b = f.Biome;
            if (f.DayT[c] <= GrowingT || yearFrac >= Autumn)
            {
                // Вне вегетации входы не меняются; без ожидающего кандидата классификация дала бы вчерашний результат.
                if (b.Days[c] == 0) return;
            }
            else
            {
                double a = Math.Min(1, EmaPerYear * dt);
                var h = BiomeState.HerbsOf(world, c);
                // Разности — в double, как в JS (float − float в C# считалась бы во float).
                b.Herb[c] = (float)(b.Herb[c] + a * (h[0] - b.Herb[c]));
                b.Steppe[c] = (float)(b.Steppe[c] + a * (h[1] - b.Steppe[c]));
                b.Wet[c] = (float)(b.Wet[c] + a * (h[2] - b.Wet[c]));
                b.Pioneer[c] = (float)(b.Pioneer[c] + a * (h[3] - b.Pioneer[c]));
                b.Moisture[c] = (float)(b.Moisture[c] + a * ((double)f.DayW[c] - b.Moisture[c]));
                b.Tree[c] = (float)(b.Tree[c] + a * ((double)f.TreeCover[c] - b.Tree[c]));
                b.Shrub[c] = (float)(b.Shrub[c] + a * ((double)f.ShrubCover[c] - b.Shrub[c]));
                b.Conifer[c] = (float)(b.Conifer[c] + a * ((double)f.ConiferCover[c] - b.Conifer[c]));
                b.Tall[c] = (float)(b.Tall[c] + a * ((double)f.TallCover[c] - b.Tall[c]));
            }
            int next = BiomeState.ClassifyTracked(world, c);
            // Пересечение порога без запаса не считается сменой.
            if (next != b.Current[c] && !Biomes.ConfirmsChange(b.Current[c], next, BiomeState.Input)) next = b.Current[c];
            if (next == b.Current[c])
            {
                b.Candidate[c] = (byte)next;
                b.Days[c] = 0;
                return;
            }
            if (next != b.Candidate[c])
            {
                b.Candidate[c] = (byte)next;
                b.Days[c] = 1;
            }
            else if (b.Days[c] < 255) b.Days[c] = (byte)(b.Days[c] + 1);
            if (b.Days[c] >= holdDays)
            {
                b.Current[c] = (byte)next;
                b.Days[c] = 0;
            }
        }
    }
}
