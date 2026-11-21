// Начальное состояние растительности (src/sim/flora/populate.ts, loadStand.ts) — построчный перенос:
//  • Genesis — голая земля без растений и семян: жизнь приходит только извне (если мир не изолирован) и от создателя;
//  • Wildlands — голая земля с почвенным банком семян трав региона; мир затем готовится 20 лет той же симуляцией
//    (этап 2.5): леса не расставляются, а вырастают;
//  • LoadStand — нагрузочный стенд TS (настоящие растения симуляции, расставленные по seed стенда) для замеров и
//    проверки пути с древесными; это не сценарий мира.
// Миграция сохранений фазы 2 (populateFromGreenness) не переносится: таких сохранений у Windows-версии нет.
using System;
using System.Collections.Generic;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    public static class Populate
    {
        /// <summary>Почвенный банк семян трав в начале подготовки Wildlands при пригодности 1 и весе колониста 1, г/м².</summary>
        public const double WildSeedBank = 0.3;
        /// <summary>Ниже этой пригодности банк семян вида не закладывается.</summary>
        public const double WildMinSuitability = 0.05;

        /// <summary>Температура вегетационного сезона ячейки: середина между средней и летней нормой.</summary>
        public static double SeasonTemp(World world, int cell) => world.Geo.TMean[cell] + 0.6 * world.Geo.TAmp[cell];

        /// <summary>
        /// Суточные средние до первых суток — по климату момента старта и текущей влаге; ведомость с нуля,
        /// точка отсчёта баланса — полный запас вещества.
        /// </summary>
        static void Finish(World world)
        {
            var geo = world.Geo;
            var f = world.Flora;
            var ctx = new TimeContext();
            ClimateModel.Context(world.Seed, world.Tick, world.Config.DaysPerSeason, ref ctx);
            var moisture = world.Env.Moisture;
            var capacity = world.Derived.Capacity;
            for (int i = 0; i < geo.N * geo.N; i++)
            {
                f.DayT[i] = (float)(geo.TMean[i] + geo.TAmp[i] * ctx.Seasonal + ctx.Anomaly);
                // Деление в double, как в JS. Для одиночной операции с записью во float результат совпал бы и при делении
                // во float (проверено подменой: G2 без расхождений), но запись повторяет выражение TS без исключений.
                f.DayW[i] = (float)((double)moisture[i] / capacity[i]);
            }
            Array.Clear(f.Ledger, 0, f.Ledger.Length);
            f.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(f, geo);
        }

        public static void Genesis(World world) => Finish(world);

        /// <summary>
        /// Wildlands, начало подготовки: голая земля с почвенным банком семян трав региона (по пригодности и весу колониста).
        /// Ни одного растения не ставится; семена региона во время подготовки — FloraState.RegionalSeedRain.
        /// </summary>
        public static void Wildlands(World world)
        {
            var geo = world.Geo;
            var f = world.Flora;
            var t = f.Species;
            int count = geo.N * geo.N;
            for (int i = 0; i < count; i++)
            {
                if (geo.WaterKind[i] != WaterKind.None) continue;
                double moistureRel = EnvFactory.ClimateMoisture(geo.Precip[i]);
                foreach (int s in t.Herbs)
                {
                    double suit = Suitability.Of(t, s, SeasonTemp(world, i), moistureRel, 1, f.Nutrient[i], geo.Soil[i]);
                    if (suit < WildMinSuitability) continue;
                    f.SeedBank[t.HerbSlot[s] * count + i] = (float)(WildSeedBank * suit * t.Colonist[s]);
                }
            }
            f.RegionalSeedRain = true;
            Finish(world);
        }

        /// <summary>
        /// Нагрузочный стенд (plantLoadStand): target древесных случайных видов и возраста на суше, биомасса — по возрасту;
        /// затем полог, покров и биомы. Возвращает число растений.
        /// </summary>
        public static int LoadStand(World world, int target)
        {
            var geo = world.Geo;
            var f = world.Flora;
            var t = f.Species;
            var w = f.Woody;
            var woody = new List<int>();
            for (int s = 0; s < t.Count; s++) if (t.Woody[s] == 1) woody.Add(s);
            var land = new List<int>();
            for (int c = 0; c < geo.N * geo.N; c++) if (geo.WaterKind[c] == WaterKind.None) land.Add(c);
            int k = 0;
            int limit = Math.Min(target, w.Capacity);
            while (w.Count < limit && k < limit * 4)
            {
                int c = land[(int)Math.Floor(Hash.CounterRandom(1, 1, k, 0) * land.Count)];
                int s = woody[(int)Math.Floor(Hash.CounterRandom(1, 2, k, 0) * woody.Count)];
                double age = 1 + Hash.CounterRandom(1, 3, k, 0) * 60;
                double b = Math.Min(t.MaxBiomass[s], 0.02 + 0.6 * age * age * 0.05);
                k++;
                if (f.WoodyCount[c] >= FloraState.MaxWoodyPerCell) continue;
                w.Spawn(s, (c % geo.N + Hash.CounterRandom(1, 4, k - 1, 0)) * geo.CellSize, (Math.Floor(c / (double)geo.N) + Hash.CounterRandom(1, 5, k - 1, 0)) * geo.CellSize, c, b, age);
                f.WoodyCount[c] = (byte)(f.WoodyCount[c] + 1);
            }
            Cover.Refresh(world, true);
            BiomeState.InitBiomes(world);
            return w.Count;
        }
    }
}
