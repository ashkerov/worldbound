// Суточный шаг растительности (src/sim/flora/system.ts: floraSystem, processCell) — Stage 2.2: расписание и голая земля.
//
// Расписание — как в TS: период 50 тактов, фаза 25 (никогда не совпадает с часовым шагом воды); 6 порций в час,
// 144 в сутки. Ячейки — строки z ≡ час (mod 24), в порции sub — столбцы [⌊sub·n/6⌋, ⌊(sub+1)·n/6⌋), только суша;
// древесные — индексы ≡ час + 24·sub (mod 144) до highWater, зафиксированного в начале порции; позиции края — так же.
// Полог пересчитывается в порции 0 часа 0 суток; lastSliceHour — после 6-й порции часа.
//
// Перенесено: суточные средние и сброс накопителей воды, почва (выветривание, вымывание, разложение), живой покров
// (вход испарения), суточное обновление биома. Ветви трав, банка семян, древесных, колонизации и семян региона —
// этапы 2.3–2.5. Там, где TS пошёл бы в такую ветвь (в ячейке есть вид или семена, есть живые древесные, мир открыт
// колонистам или идёт подготовка Wildlands), шаг останавливается исключением FloraNotPortedException — молчаливого
// расхождения с эталоном нет. Для мира без растений и семян (Genesis + изоляция) перенесённая часть побитно равна TS:
// неперенесённые ветви в нём не выполняются.
using System;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    /// <summary>Шаг дошёл до ветви модели, которая ещё не перенесена на C#.</summary>
    public sealed class FloraNotPortedException : Exception
    {
        public FloraNotPortedException(string message) : base(message) { }
    }

    public static class FloraSystem
    {
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
        public static readonly double[] GerminationSeason = { 0.02, 0.4 };
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
            for (int k = 0; k < f.SlotSpecies.Length; k++) if (f.SlotSpecies[k] != SpeciesTable.NoSpecies) return "есть травы — этап 2.3";
            for (int k = 0; k < f.SeedBank.Length; k++) if (f.SeedBank[k] > 0) return "есть банк семян трав — этап 2.3";
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

            // ── Травяной ярус (проходы 1–2), семена трав, прорастание, старение банка — этап 2.3.
            // Без видов в слотах проходы TS не меняют ничего, кроме записи запаса питания тем же значением.
            int s0 = c * FloraState.Slots;
            for (int k = 0; k < FloraState.Slots; k++)
                if (f.SlotSpecies[s0 + k] != SpeciesTable.NoSpecies) throw new FloraNotPortedException($"травяной ярус (ячейка {c}) — этап 2.3");
            int count = geo.N * geo.N;
            var herbs = f.Species.Herbs;
            bool germinationSeason = ctx.YearFrac >= GerminationSeason[0] && ctx.YearFrac < GerminationSeason[1] && T > 6 && snow < 1;
            for (int h = 0; h < herbs.Length; h++)
            {
                float bank = f.SeedBank[h * count + c];
                // Прорастание идёт при банке ≥ 0,002 г/м², старение — при банке > 0.
                if (bank > 0 || (germinationSeason && bank >= MinGerminatingBank)) throw new FloraNotPortedException($"банк семян трав (ячейка {c}) — этап 2.3");
            }

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
            if (f.RegionalSeedRain) throw new FloraNotPortedException("regionalSeedRain (семена региона) — этап 2.5");
            world.Env.Greenness[c] = (float)Cover.GreennessOf(world, c);
            UpdateBiome(world, c, dt, ctx.YearFrac, ctx.HoldDays);
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
