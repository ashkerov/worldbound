// Часовой шаг воды (src/sim/env/water.ts): осадки → снег или почва; таяние; ведёрная модель влаги;
// капиллярная подпитка у рек и озёр; сток по дереву стока → расход рек; накопители условий для растений.
// Арифметика ячейки вынесена в чистые статические функции (LandCell, Route) — их вызывают и обычный
// управляемый цикл, и Burst-задания адаптера Unity; поэтому оба пути считают одно и то же.
using System;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Env
{
    /// <summary>Общие для всех ячеек величины часа (считаются один раз).</summary>
    public struct WaterHourParams
    {
        public double Compression, MeltPerDegree, SunFactor, Seasonal, Diurnal, Anomaly;
    }

    /// <summary>Результат шага ячейки суши до записи во float-хранилище.</summary>
    public struct WaterCellResult
    {
        public double Moisture, Snow, Out, Et, Add, T;
    }

    /// <summary>
    /// Ускоритель шага ячеек (Burst/Jobs в адаптере Unity). Обязан давать побитно тот же результат, что
    /// управляемый цикл: пишет состояние ячеек и по каждой ячейке [осадки, испарение, местный сток, подпитка]
    /// в sums (суммирование потом идёт в ядре по индексу — тот же порядок сложения, что в TS).
    /// </summary>
    public interface IWaterAccelerator
    {
        void Cells(World world, in WaterHourParams p, double[] sums);
        double Route(World world);
    }

    public static class Water
    {
        public const double SnowThreshold = 0.5;
        public const double DegreeDayFactor = 3.2;
        public const double RealHoursPerYear = 8760;
        public const double CapillaryRange = 40;
        public const double CapillaryRate = 0.03;
        public const double PetPerDegree = 0.0084;

        public static WaterHourParams Params(World world, long tick)
        {
            var ctx = new TimeContext();
            ClimateModel.Context(world.Seed, tick, world.Config.DaysPerSeason, ref ctx);
            double compression = RealHoursPerYear / SimTime.HoursPerYear(world.Config.DaysPerSeason);
            return new WaterHourParams
            {
                Compression = compression,
                MeltPerDegree = DegreeDayFactor / 24 * compression,
                SunFactor = 0.35 + 0.65 * DMath.Smoothstep(-0.05, 0.5, ctx.Sun.Y),
                Seasonal = ctx.Seasonal,
                Diurnal = ctx.Diurnal,
                Anomaly = ctx.Anomaly,
            };
        }

        /// <summary>Ячейка суши: снег, таяние, влага, подпитка, испарение, дренаж. Чистая функция.</summary>
        public static WaterCellResult LandCell(double precip, double cloud, double t, double moisture, double snowIn, double cap, double drainHour, double wd, double cover, in WaterHourParams p)
        {
            double snow = snowIn;
            double input = 0;
            if (t < SnowThreshold) snow += precip;
            else input += precip;
            if (t > 0 && snow > 0)
            {
                double melt = Math.Min(snow, p.MeltPerDegree * t);
                snow -= melt;
                input += melt;
            }
            double m = moisture + input;
            double outv = 0;
            if (m > cap)
            {
                outv = m - cap;
                m = cap;
            }
            double add = 0;
            if (wd < CapillaryRange && m < cap)
            {
                add = Math.Min(cap - m, cap * CapillaryRate * (1 - wd / CapillaryRange));
                m += add;
            }
            double pet = t > -4 ? (t + 4) * PetPerDegree * p.Compression * p.SunFactor * (1 - 0.5 * cloud) * (0.5 + 0.5 * (cover > 1 ? 1 : cover)) : 0;
            double et = Math.Min(m, pet * (m / cap) * (snow > 5 ? 0.2 : 1));
            m -= et;
            double drain = drainHour * m * (m / cap);
            m -= drain;
            outv += drain;
            return new WaterCellResult { Moisture = m, Snow = snow, Out = outv, Et = et, Add = add, T = t };
        }

        public static void Run(World world, long tick, IWaterAccelerator accelerator = null, double[] sumsScratch = null)
        {
            var geo = world.Geo;
            var env = world.Env;
            var weather = env.Weather;
            var d = world.Derived;
            int count = geo.N * geo.N;
            double cellArea = geo.CellSize * geo.CellSize;
            var p = Params(world, tick);
            double landPrecip = 0, evaporated = 0, precipTotal = 0, localTotal = 0, capillary = 0;
            var runoff = env.Runoff;
            if (accelerator != null)
            {
                accelerator.Cells(world, in p, sumsScratch);
                for (int i = 0; i < count; i++)
                {
                    int o = i * 4;
                    if (geo.WaterKind[i] == WaterKind.Sea) continue;
                    double pr = sumsScratch[o];
                    landPrecip += pr;
                    precipTotal += pr;
                    if (geo.WaterKind[i] != WaterKind.None)
                    {
                        localTotal += pr;
                        continue;
                    }
                    capillary += sumsScratch[o + 3];
                    evaporated += sumsScratch[o + 1];
                    localTotal += sumsScratch[o + 2];
                }
            }
            else
            {
                // Массивы — в локальные переменные: JIT не перечитывает поля объектов на каждой ячейке.
                var s = world.Sampler;
                var f = world.Flora;
                int c = s.Chunks;
                int[] sBase = s.Base;
                double[] sTx = s.Tx, sTz = s.Tz;
                float[] chunkCloud = weather.ChunkCloud, chunkAccum = weather.ChunkAccum;
                byte[] kinds = geo.WaterKind;
                float[] tMean = geo.TMean, tAmp = geo.TAmp, waterDist = geo.WaterDist;
                float[] pFactor = d.PFactor, capacity = d.Capacity, drainHour = d.DrainHour;
                float[] moisture = env.Moisture, snow = env.Snow, greenness = env.Greenness;
                float[] accT = f.AccT, accW = f.AccW, accRunoff = f.AccRunoff, accMinT = f.AccMinT;
                byte[] accHours = f.AccHours;
                for (int i = 0; i < count; i++)
                {
                    byte kind = kinds[i];
                    if (kind == WaterKind.Sea)
                    {
                        runoff[i] = 0;
                        continue;
                    }
                    int k = sBase[i];
                    double tx = sTx[i], tz = sTz[i];
                    double cloud = ClimateModel.Bilinear(chunkCloud[k], chunkCloud[k + 1], chunkCloud[k + c], chunkCloud[k + c + 1], tx, tz);
                    double precip = ClimateModel.Bilinear(chunkAccum[k], chunkAccum[k + 1], chunkAccum[k + c], chunkAccum[k + c + 1], tx, tz) * pFactor[i];
                    landPrecip += precip;
                    precipTotal += precip;
                    if (kind != WaterKind.None)
                    {
                        runoff[i] = (float)precip;
                        localTotal += precip;
                        continue;
                    }
                    double t = ClimateModel.CellTemperature(tMean[i], tAmp[i], p.Seasonal, p.Diurnal, p.Anomaly, cloud);
                    double cap = capacity[i];
                    var r = LandCell(precip, cloud, t, moisture[i], snow[i], cap, drainHour[i], waterDist[i], greenness[i], in p);
                    capillary += r.Add;
                    moisture[i] = (float)r.Moisture;
                    snow[i] = (float)r.Snow;
                    runoff[i] = (float)r.Out;
                    evaporated += r.Et;
                    localTotal += r.Out;
                    accT[i] = (float)(accT[i] + t);
                    accW[i] = (float)(accW[i] + r.Moisture / cap);
                    accRunoff[i] = (float)(accRunoff[i] + r.Out);
                    if (t < accMinT[i]) accMinT[i] = (float)t;
                    if (accHours[i] < 255) accHours[i]++;
                }
            }
            world.Flora.Capillary[0] += capillary;
            double toM3s = cellArea / 1000 / 3600;
            double toSea = accelerator != null ? accelerator.Route(world) : Route(count, geo.UpstreamOrder, geo.WaterKind, geo.Receiver, runoff, env.Discharge, toM3s);
            Array.Clear(weather.ChunkAccum, 0, weather.ChunkAccum.Length);
            weather.Balance[1] += landPrecip / d.LandCells;
            env.WaterTotals[0] += precipTotal;
            env.WaterTotals[1] += evaporated;
            env.WaterTotals[2] += toSea / toM3s;
            env.WaterTotals[3] += localTotal;
            env.LastHourStep = (int)Math.Floor(tick / (double)SimTime.TicksPerHour);
        }

        /// <summary>Сток по дереву: от истоков к устьям. Возвращает поток в море, м³/с.</summary>
        public static double Route(int count, int[] order, byte[] kind, int[] receiver, float[] runoff, float[] discharge, double toM3s)
        {
            Array.Clear(discharge, 0, discharge.Length);
            double toSea = 0;
            for (int k = 0; k < count; k++)
            {
                int i = order[k];
                if (kind[i] == WaterKind.Sea) continue;
                double q = discharge[i] + runoff[i] * toM3s;
                discharge[i] = (float)q;
                int r = receiver[i];
                if (r < 0 || kind[r] == WaterKind.Sea) toSea += q;
                else discharge[r] = (float)(discharge[r] + q);
            }
            return toSea;
        }
    }
}
