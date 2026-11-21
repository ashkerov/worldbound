// Погода (src/sim/env/weather.ts): стохастические ячейки осадков, дрейфующие по ветру над сеткой чанков.
// Регулятор рождает ячейки, когда выпавшее отстаёт от климатической нормы.
using System;

namespace Worldbound.Sim.Env
{
    public struct Wind { public double X, Z, Speed; }

    public static class Weather
    {
        public const int Period = 50;
        public const double StepHours = Period / (double)SimTime.TicksPerHour;
        const double MmPerUnit = 8;
        const double DriftPerStep = 160;
        const int SysWindDir = 51, SysWindSpeed = 52, SysSpawn = 53;

        public static void WindAt(World world, long tick, ref Wind o)
        {
            double hours = tick / (double)SimTime.TicksPerHour;
            double turn = 0.55 * ClimateModel.TimeNoise(world.Seed, SysWindDir, hours / 14);
            double c = DMath.DCos(turn), s = DMath.DSin(turn);
            double bx = world.Geo.WindX, bz = world.Geo.WindZ;
            o.X = bx * c - bz * s;
            o.Z = bx * s + bz * c;
            o.Speed = 5.5 + 3.5 * ClimateModel.TimeNoise(world.Seed, SysWindSpeed, hours / 5);
        }

        public static double SeasonalPrecipFactor(double yearFrac) => 1 + 0.25 * DMath.DCos(DMath.TWO_PI * (yearFrac - 0.55));

        static double Envelope(double age, double life)
        {
            double t = age / life;
            if (t < 0.2) return t / 0.2;
            if (t > 0.7) return (1 - t) / 0.3;
            return 1;
        }

        static double StormMean(double worldSize)
        {
            const double radius = 1000, lifeHours = 6, meanEnvelope = 0.7;
            double area = Math.PI * radius * radius / 3;
            return meanEnvelope * area * MmPerUnit * lifeHours / (worldSize * worldSize);
        }

        public static void Run(World world, long tick)
        {
            var w = world.Env.Weather;
            var cells = w.Cells;
            double size = world.WorldSize;
            int seed = unchecked((int)world.Seed);
            int tick32 = unchecked((int)tick);
            var wind = new Wind();
            WindAt(world, tick, ref wind);

            int dps = world.Config.DaysPerSeason;
            double yf = SimTime.YearFraction(tick, dps);
            w.Balance[0] += world.Derived.LandMeanPrecip / SimTime.HoursPerYear(dps) * SeasonalPrecipFactor(yf) * StepHours;

            double drift = DriftPerStep * (wind.Speed / 6);
            int free = -1;
            for (int k = 0; k < WeatherState.MaxCells; k++)
            {
                int o = k * WeatherState.Stride;
                double life = cells[o + 5];
                if (life <= 0)
                {
                    if (free < 0) free = k;
                    continue;
                }
                double age = cells[o + 4] + 1.0;
                if (age >= life)
                {
                    Array.Clear(cells, o, WeatherState.Stride);
                    if (free < 0) free = k;
                    continue;
                }
                cells[o + 4] = (float)age;
                cells[o] = (float)(cells[o] + wind.X * drift);
                cells[o + 1] = (float)(cells[o + 1] + wind.Z * drift);
            }

            double deficit = w.Balance[0] - w.Balance[1];
            double p = DMath.Clamp(deficit / StormMean(size), 0, 0.85);
            if (free >= 0 && Hash.CounterRandom(seed, SysSpawn, 0, tick32) < p)
            {
                int o = free * WeatherState.Stride;
                const double margin = 900;
                double R(int k) => Hash.CounterRandom(seed, SysSpawn, k, tick32);
                double ux = R(1), uz = R(2);
                cells[o] = (float)(-margin + ux * (size + 2 * margin) - wind.X * size * 0.35 * R(3));
                cells[o + 1] = (float)(-margin + uz * (size + 2 * margin) - wind.Z * size * 0.35 * R(3));
                cells[o + 2] = (float)(600 + 900 * R(4));
                cells[o + 3] = (float)(0.55 + 0.9 * R(5));
                cells[o + 4] = 0;
                cells[o + 5] = (float)JsMath.Round((3 + 6 * R(6)) / StepHours);
            }

            int chunks = w.Chunks;
            for (int cz = 0; cz < chunks; cz++)
                for (int cx = 0; cx < chunks; cx++)
                {
                    double px = (cx + 0.5) * WorldConfig.ChunkSize;
                    double pz = (cz + 0.5) * WorldConfig.ChunkSize;
                    double rate = 0, cloud = 0.06;
                    for (int k = 0; k < WeatherState.MaxCells; k++)
                    {
                        int o = k * WeatherState.Stride;
                        double life = cells[o + 5];
                        if (life <= 0) continue;
                        double dx = px - cells[o], dz = pz - cells[o + 1];
                        double d2 = dx * dx + dz * dz;
                        double radius = cells[o + 2];
                        double env = Envelope(cells[o + 4], life);
                        double strength = cells[o + 3] * env;
                        double cloudR = radius * 1.6;
                        if (d2 < cloudR * cloudR)
                        {
                            double t = 1 - d2 / (cloudR * cloudR);
                            cloud += t * (0.45 + 0.45 * env);
                        }
                        if (d2 < radius * radius)
                        {
                            double t = 1 - d2 / (radius * radius);
                            rate += strength * t * t;
                        }
                    }
                    int i = cz * chunks + cx;
                    double mm = rate * MmPerUnit;
                    w.ChunkRate[i] = (float)mm;
                    w.ChunkCloud[i] = (float)(cloud > 1 ? 1 : cloud);
                    w.ChunkAccum[i] = (float)(w.ChunkAccum[i] + mm * StepHours);
                }
        }
    }
}
