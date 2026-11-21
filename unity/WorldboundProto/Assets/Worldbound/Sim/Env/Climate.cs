// Температура и свет (src/sim/env/climate.ts): не хранятся, а вычисляются — норма ячейки + сезонный ход +
// суточный ход + погодная аномалия. Чистые функции без состояния: их же вызывает Burst-задание воды.
using System;

namespace Worldbound.Sim.Env
{
    public struct TimeContext
    {
        public double Seasonal, Diurnal, Anomaly;
        public SunState Sun;
    }

    public static class ClimateModel
    {
        const int SysAnomaly = 41;
        const double Inv2_32 = 1.0 / 4294967296.0;

        /// <summary>Гладкий шум во времени, [−1, 1]: значения в узлах из хеша, между ними — ступень Эрмита.</summary>
        public static double TimeNoise(uint seed, int system, double t)
        {
            double fi = Math.Floor(t);
            double f = t - fi;
            int i = JsMath.ToInt32(fi);
            int s32 = unchecked((int)seed);
            double a = Hash.Hash4(s32, system, i, 0) * Inv2_32 * 2 - 1;
            double b = Hash.Hash4(s32, system, unchecked(JsMath.ToInt32(fi + 1)), 0) * Inv2_32 * 2 - 1;
            double s = f * f * (3 - 2 * f);
            return a + (b - a) * s;
        }

        public static double TemperatureAnomaly(uint seed, long tick)
        {
            double days = tick / (double)SimTime.TicksPerDay;
            return 2.6 * TimeNoise(seed, SysAnomaly, days * 0.6) + 1.1 * TimeNoise(seed, SysAnomaly + 1, days * 2.1);
        }

        public static void Context(uint seed, long tick, int daysPerSeason, ref TimeContext ctx)
        {
            double yf = SimTime.YearFraction(tick, daysPerSeason);
            double df = SimTime.DayFraction(tick);
            ctx.Seasonal = Sun.SeasonalSwing(yf - 0.04);
            ctx.Diurnal = DMath.DCos(DMath.TWO_PI * (df - 0.625));
            ctx.Anomaly = TemperatureAnomaly(seed, tick);
            Sun.Direction(df, yf, ref ctx.Sun);
        }

        /// <summary>Температура воздуха у поверхности, °C (tMean, tAmp — нормы ячейки из Geo).</summary>
        public static double CellTemperature(float tMean, float tAmp, double seasonal, double diurnal, double anomaly, double cloud)
        {
            double diurnalAmp = 4.6 * (1 - 0.6 * cloud);
            return tMean + tAmp * seasonal + diurnalAmp * diurnal + anomaly;
        }

        /// <summary>Освещённость поверхности 0..1.</summary>
        public static double CellLight(in TimeContext ctx, double cloud) => DMath.Smoothstep(-0.05, 0.6, ctx.Sun.Y) * (1 - 0.6 * cloud);

        /// <summary>Билинейная смесь четырёх соседних чанков (тот же порядок операций, что sampleChunks).</summary>
        public static double Bilinear(float a, float b, float d, float e, double tx, double tz) => (a * (1 - tx) + b * tx) * (1 - tz) + (d * (1 - tx) + e * tx) * tz;
    }

    /// <summary>Предвычисленные индексы и веса выборки поля чанков для каждой ячейки (chunkSampler).</summary>
    public sealed class ChunkSampler
    {
        public readonly int Chunks;
        public readonly int[] Base;
        public readonly double[] Tx, Tz;

        public ChunkSampler(int n, int chunks)
        {
            Chunks = chunks;
            int count = n * n;
            Base = new int[count];
            Tx = new double[count];
            Tz = new double[count];
            int c = chunks;
            double per = n / (double)c;
            for (int cell = 0; cell < count; cell++)
            {
                int x = cell % n;
                int z = (cell - x) / n;
                double fx = (x + 0.5) / per - 0.5;
                double fz = (z + 0.5) / per - 0.5;
                if (fx < 0) fx = 0; else if (fx > c - 1) fx = c - 1;
                if (fz < 0) fz = 0; else if (fz > c - 1) fz = c - 1;
                double ix = Math.Floor(fx), iz = Math.Floor(fz);
                if (ix > c - 2) ix = c - 2;
                if (iz > c - 2) iz = c - 2;
                Base[cell] = (int)(iz * c + ix);
                Tx[cell] = fx - ix;
                Tz[cell] = fz - iz;
            }
        }

        public double Sample(float[] field, int cell)
        {
            int k = Base[cell];
            int c = Chunks;
            return ClimateModel.Bilinear(field[k], field[k + 1], field[k + c], field[k + c + 1], Tx[cell], Tz[cell]);
        }
    }
}
