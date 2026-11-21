// Конвейер генерации мира из seed (src/sim/worldgen/generate.ts, построчный перенос):
// каркас рельефа → эрозия → озёрные котловины → климат → гидрология → почвы и залежи → провинции →
// рельеф 2 м с руслами → горизонт. Только детерминированная арифметика (как в TS): побитно тот же мир.
using System;
using System.Collections.Generic;

namespace Worldbound.Sim.WorldGen
{
    public static class Generate
    {
        public const int WorldgenVersion = 1;
        const double DIAG = 1.4142135623730951;
        const double RefHoursPerYear = 480;
        const int Cell = WorldConfig.CellSize;

        struct Preset { public double T0, Amp, Precip; }

        static Preset ClimatePreset(Climate c) => c switch
        {
            Climate.Cold => new Preset { T0 = 1.5, Amp = 13, Precip = 560 },
            Climate.Warm => new Preset { T0 = 15.5, Amp = 7.5, Precip = 880 },
            _ => new Preset { T0 = 8.5, Amp = 10.5, Precip = 760 },
        };

        sealed class ShapeNoise
        {
            public Fbm WarpX, WarpZ, Base, HillMask;
            public Ridged Hills;
            public Fbm[] Bend, Wobble, WobbleFine;
            public Ridged[] Range;
        }

        sealed class Shape
        {
            public uint Seed;
            public double Size;
            public byte[] Edges;
            public double SeaBand, MountainBand;
            public ShapeNoise Noise;
        }

        static ShapeNoise MakeNoise(uint seed)
        {
            var s = new ShapeNoise
            {
                WarpX = new Fbm(seed, 1, 3),
                WarpZ = new Fbm(seed, 2, 3),
                Base = new Fbm(seed, 3, 5),
                HillMask = new Fbm(seed, 4, 3),
                Hills = new Ridged(seed, 5, 4),
                Bend = new Fbm[4],
                Wobble = new Fbm[4],
                WobbleFine = new Fbm[4],
                Range = new Ridged[4],
            };
            for (int e = 0; e < 4; e++) s.Bend[e] = new Fbm(seed, 18 + e, 2);
            for (int e = 0; e < 4; e++) s.Wobble[e] = new Fbm(seed, 10 + e, 3);
            for (int e = 0; e < 4; e++) s.WobbleFine[e] = new Fbm(seed, 14 + e, 3);
            for (int e = 0; e < 4; e++) s.Range[e] = new Ridged(seed, 20 + e, 5);
            return s;
        }

        static byte[] ChooseEdges(Rng rng)
        {
            byte S = EdgeKind.Sea, M = EdgeKind.Mountains;
            var patterns = new[] { new[] { S, M, M, M }, new[] { S, S, M, M }, new[] { S, M, S, M }, new[] { S, S, S, M } };
            var weights = new[] { 3, 4, 1, 1 };
            double pick = rng.Next() * 9;
            int p = 0;
            while (pick >= weights[p]) pick -= weights[p++];
            var b = patterns[p];
            int rot = rng.Int(4);
            return new[] { b[rot % 4], b[(rot + 1) % 4], b[(rot + 2) % 4], b[(rot + 3) % 4] };
        }

        static double MacroHeight(Shape s, double x, double z)
        {
            var nz = s.Noise;
            double wx = x + 320 * nz.WarpX.At(x / 2100, z / 2100);
            double wz = z + 320 * nz.WarpZ.At(x / 2100 + 7.7, z / 2100 - 3.1);
            double h = 16 + 22 * nz.Base.At(wx / 1500, wz / 1500);
            double hillMask = DMath.Smoothstep(-0.2, 0.45, nz.HillMask.At(wx / 2600, wz / 2600));
            h += hillMask * (30 + 70 * nz.Hills.At(wx / 950, wz / 950));
            double size = s.Size;
            double seaD = double.PositiveInfinity;
            for (int e = 0; e < 4; e++)
            {
                if (s.Edges[e] != EdgeKind.Sea) continue;
                double d = e == 0 ? z : e == 1 ? size - x : e == 2 ? size - z : x;
                if (d < seaD) seaD = d;
            }
            h += seaD < 4500 ? seaD * 0.011 : 49.5;
            for (int pass = 0; pass < 2; pass++)
            {
                for (int e = 0; e < 4; e++)
                {
                    byte kind = s.Edges[e];
                    if ((pass == 0) != (kind == EdgeKind.Mountains)) continue;
                    double d = e == 0 ? z : e == 1 ? size - x : e == 2 ? size - z : x;
                    if (d > (kind == EdgeKind.Sea ? s.SeaBand : s.MountainBand) + 1300) continue;
                    double along = e == 0 || e == 2 ? x : z;
                    double bend = kind == EdgeKind.Sea ? 650 * nz.Bend[e].At(along / 2600, 1.3 * e) : 0;
                    double dn = d + bend + 420 * nz.Wobble[e].At(along / 1700, 0.37 * e + 0.5) + 120 * nz.WobbleFine[e].At(along / 420, d / 420);
                    if (kind == EdgeKind.Mountains)
                    {
                        double t = DMath.Smoothstep(s.MountainBand, -s.MountainBand * 0.15, dn);
                        double m = nz.Range[e].At(wx / 720, wz / 720);
                        h += t * t * (210 + 520 * m) + (dn < 0 ? -dn * 0.22 : 0);
                    }
                    else
                    {
                        if (dn < s.SeaBand)
                        {
                            double k = s.SeaBand - dn;
                            h -= 0.13 * k * k / s.SeaBand;
                        }
                        double floor = -22 - (dn < 0 ? -dn * 0.03 : 0);
                        if (h < floor) h = floor + (h - floor) * 0.15;
                    }
                }
            }
            return h;
        }

        static float[] DistanceField(int n, byte[] mask, double cell)
        {
            const double INF = 1e9;
            var d = new float[n * n];
            for (int i = 0; i < n * n; i++) d[i] = (float)(mask[i] == 1 ? 0 : INF);
            double a = cell, b = cell * DIAG;
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    int i = z * n + x;
                    double v = d[i];
                    if (x > 0) v = Math.Min(v, d[i - 1] + a);
                    if (z > 0)
                    {
                        v = Math.Min(v, d[i - n] + a);
                        if (x > 0) v = Math.Min(v, d[i - n - 1] + b);
                        if (x < n - 1) v = Math.Min(v, d[i - n + 1] + b);
                    }
                    d[i] = (float)v;
                }
            for (int z = n - 1; z >= 0; z--)
                for (int x = n - 1; x >= 0; x--)
                {
                    int i = z * n + x;
                    double v = d[i];
                    if (x < n - 1) v = Math.Min(v, d[i + 1] + a);
                    if (z < n - 1)
                    {
                        v = Math.Min(v, d[i + n] + a);
                        if (x < n - 1) v = Math.Min(v, d[i + n + 1] + b);
                        if (x > 0) v = Math.Min(v, d[i + n - 1] + b);
                    }
                    d[i] = (float)v;
                }
            return d;
        }

        static byte[] OceanMask(int n, double[] h, byte[] edges)
        {
            var ocean = new byte[n * n];
            var queue = new int[n * n];
            int head = 0, tail = 0;
            void SeedCell(int i)
            {
                if (ocean[i] == 0 && h[i] < 0)
                {
                    ocean[i] = 1;
                    queue[tail++] = i;
                }
            }
            for (int k = 0; k < n; k++)
            {
                if (edges[0] == EdgeKind.Sea) SeedCell(k);
                if (edges[1] == EdgeKind.Sea) SeedCell(k * n + n - 1);
                if (edges[2] == EdgeKind.Sea) SeedCell((n - 1) * n + k);
                if (edges[3] == EdgeKind.Sea) SeedCell(k * n);
            }
            while (head < tail)
            {
                int c = queue[head++];
                int cx = c % n, cz = (c - cx) / n;
                if (cx > 0) SeedCell(c - 1);
                if (cx < n - 1) SeedCell(c + 1);
                if (cz > 0) SeedCell(c - n);
                if (cz < n - 1) SeedCell(c + n);
            }
            return ocean;
        }

        static double[] Accumulate(int n, int[] receiver, int[] order, double[] local)
        {
            var acc = (double[])local.Clone();
            for (int k = n * n - 1; k >= 0; k--)
            {
                int c = order[k];
                int r = receiver[c];
                if (r >= 0) acc[r] += acc[c];
            }
            return acc;
        }

        static double[] Filled(int count, double v)
        {
            var a = new double[count];
            for (int i = 0; i < count; i++) a[i] = v;
            return a;
        }

        static void Erode(int n, double[] h, byte[] ocean, int iterations, Action<double> progress)
        {
            double cellArea = Cell * Cell;
            const double kdt = 0.0042;
            var local = Filled(n * n, cellArea);
            var tmp = new double[n * n];
            for (int it = 0; it < iterations; it++)
            {
                var (_, receiver, order) = Flood.Run(n, h, ocean, 0.01);
                var area = Accumulate(n, receiver, order, local);
                for (int k = 0; k < n * n; k++)
                {
                    int c = order[k];
                    if (ocean[c] == 1) continue;
                    int r = receiver[c];
                    if (r < 0) continue;
                    double hr = h[r], hc = h[c];
                    if (hc <= hr) continue;
                    bool diagonal = c % n != r % n && (c - c % n) / n != (r - r % n) / n;
                    double f = kdt * Math.Sqrt(area[c]) / (diagonal ? Cell * DIAG : Cell);
                    h[c] = (hc + f * hr) / (1 + f);
                }
                if (it % 2 == 1)
                {
                    for (int z = 0; z < n; z++)
                        for (int x = 0; x < n; x++)
                        {
                            int i = z * n + x;
                            if (ocean[i] == 1 || x == 0 || z == 0 || x == n - 1 || z == n - 1)
                            {
                                tmp[i] = h[i];
                                continue;
                            }
                            double avg = (h[i - 1] + h[i + 1] + h[i - n] + h[i + n]) * 0.25;
                            tmp[i] = h[i] + 0.18 * (avg - h[i]);
                        }
                    Array.Copy(tmp, h, h.Length);
                }
                progress((it + 1) / (double)iterations);
            }
        }

        static void DigLakeBasins(int n, double size, double[] h, byte[] ocean, uint seed, Rng rng)
        {
            var (_, receiver, order) = Flood.Run(n, h, ocean, 0.01);
            var area = Accumulate(n, receiver, order, Filled(n * n, Cell * Cell));
            int wanted = size >= 4096 ? 2 + rng.Int(2) : 1 + rng.Int(2);
            var placed = new List<(double x, double z)>();
            int margin = (int)Math.Floor(n * 0.18);
            for (int attempt = 0; attempt < 4000 && placed.Count < wanted; attempt++)
            {
                int cx = margin + rng.Int(n - 2 * margin);
                int cz = margin + rng.Int(n - 2 * margin);
                int i = cz * n + cx;
                double hc = h[i];
                if (ocean[i] == 1 || hc < 4 || hc > 150) continue;
                if (area[i] < 0.15e6) continue;
                double x = (cx + 0.5) * Cell, z = (cz + 0.5) * Cell;
                bool near = false;
                foreach (var p in placed) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 700 * 700) { near = true; break; }
                if (near) continue;
                placed.Add((x, z));
                double radius = 100 + rng.Next() * 130;
                double depth = 6 + rng.Next() * 7;
                int reach = (int)Math.Ceiling(radius * 1.5 / Cell);
                for (int dz = -reach; dz <= reach; dz++)
                    for (int dx = -reach; dx <= reach; dx++)
                    {
                        int gx = cx + dx, gz = cz + dz;
                        if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
                        double px = (gx + 0.5) * Cell, pz = (gz + 0.5) * Cell;
                        double wobble = 0.75 + 0.5 * (HashNoise.At(seed, 90 + placed.Count, px / 160, pz / 160) + 0.7) / 1.4;
                        double r = radius * wobble;
                        double dd = ((px - x) * (px - x) + (pz - z) * (pz - z)) / (r * r);
                        if (dd >= 1) continue;
                        double t = 1 - dd;
                        h[gz * n + gx] -= depth * t * t;
                    }
            }
        }

        sealed class ClimateField
        {
            public float[] TMean, TAmp, Precip;
            public double WindX, WindZ;
        }

        static ClimateField ComputeClimate(int n, double size, double[] h, float[] seaDist, byte[] edges, Climate climate, uint seed, Rng rng)
        {
            var preset = ClimatePreset(climate);
            var seaEdges = new List<int>();
            for (int e = 0; e < 4; e++) if (edges[e] == EdgeKind.Sea) seaEdges.Add(e);
            int from = seaEdges[rng.Int(seaEdges.Count)];
            double tilt = (rng.Next() - 0.5) * 0.7;
            double wx = from == 1 ? -1 : from == 3 ? 1 : tilt;
            double wz = from == 0 ? 1 : from == 2 ? -1 : tilt;
            double wl = Math.Sqrt(wx * wx + wz * wz);
            wx /= wl;
            wz /= wl;
            const int f = 4;
            int m = n / f;
            var coarse = new double[m * m];
            var seaFrac = new double[m * m];
            for (int cz = 0; cz < m; cz++)
                for (int cx = 0; cx < m; cx++)
                {
                    double sum = 0, sea = 0;
                    for (int dz = 0; dz < f; dz++)
                        for (int dx = 0; dx < f; dx++)
                        {
                            double v = h[(cz * f + dz) * n + cx * f + dx];
                            sum += v > 0 ? v : 0;
                            if (v < 0) sea++;
                        }
                    coarse[cz * m + cx] = sum / (f * f);
                    seaFrac[cz * m + cx] = sea / (f * f);
                }
            var rain = new double[m * m];
            double step = Cell * f;
            bool alongX = from == 1 || from == 3;
            for (int line = 0; line < m; line++)
            {
                double q = 1, prev = -1;
                for (int k = 0; k < m; k++)
                {
                    int s = from == 0 || from == 3 ? k : m - 1 - k;
                    int i = alongX ? line * m + s : s * m + line;
                    double hc = coarse[i];
                    if (prev < 0) prev = hc;
                    double rise = hc > prev ? hc - prev : 0;
                    prev = hc;
                    double sea = seaFrac[i];
                    double r = q * (0.0045 + 0.022 * rise / step + 0.000012 * hc);
                    rain[i] = r * (1 - sea * 0.5);
                    q = q - r * (1 - sea) + sea * (1 - q) * 0.08;
                    if (q < 0.05) q = 0.05;
                }
            }
            double[] Blur(double[] src)
            {
                var o = new double[m * m];
                for (int z = 0; z < m; z++)
                    for (int x = 0; x < m; x++)
                    {
                        double s = 0;
                        int w = 0;
                        for (int dz = -2; dz <= 2; dz++)
                            for (int dx = -2; dx <= 2; dx++)
                            {
                                int xx = x + dx, zz = z + dz;
                                if (xx < 0 || zz < 0 || xx >= m || zz >= m) continue;
                                s += src[zz * m + xx];
                                w++;
                            }
                        o[z * m + x] = s / w;
                    }
                return o;
            }
            var smooth = Blur(Blur(rain));
            double mean = 0;
            int land = 0;
            for (int i = 0; i < m * m; i++)
                if (seaFrac[i] < 0.5)
                {
                    mean += smooth[i];
                    land++;
                }
            mean = land > 0 ? mean / land : 1;
            var tMean = new float[n * n];
            var tAmp = new float[n * n];
            var precip = new float[n * n];
            double latSpan = size >= 4096 ? 3.2 : 2;
            var wobbleNoise = new Noise2(seed, 70);
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    int i = z * n + x;
                    double hc = h[i] > 0 ? h[i] : 0;
                    double fx = DMath.Clamp((x + 0.5) / f - 0.5, 0, m - 1.0001);
                    double fz = DMath.Clamp((z + 0.5) / f - 0.5, 0, m - 1.0001);
                    int ix = (int)Math.Floor(fx), iz = (int)Math.Floor(fz);
                    double tx = fx - ix, tz = fz - iz;
                    double r0 = smooth[iz * m + ix] * (1 - tx) + smooth[iz * m + ix + 1] * tx;
                    double r1 = smooth[(iz + 1) * m + ix] * (1 - tx) + smooth[(iz + 1) * m + ix + 1] * tx;
                    double r = (r0 * (1 - tz) + r1 * tz) / mean;
                    double wobble = 1 + 0.08 * wobbleNoise.At(x / 40.0, z / 40.0);
                    precip[i] = (float)(preset.Precip * DMath.Clamp(0.5 + 0.55 * r, 0.35, 2.2) * wobble);
                    double coastal = 1 / (1 + seaDist[i] / 500.0);
                    tMean[i] = (float)(preset.T0 - latSpan * ((z + 0.5) / n - 0.5) - 0.0065 * hc + 0.6 * coastal);
                    tAmp[i] = (float)(preset.Amp * (1 - 0.3 * coastal));
                }
            return new ClimateField { TMean = tMean, TAmp = tAmp, Precip = precip, WindX = wx, WindZ = wz };
        }

        static double RunoffFraction(double precipMm, double tMean) => DMath.Clamp(0.22 + (precipMm - 500) / 2200 - (tMean - 8) * 0.012, 0.12, 0.65);
        static double ChannelDepth(double q) => Math.Min(4.5, 1.1 + 1.6 * Math.Sqrt(q));

        public sealed class Result
        {
            public Geo Geo;
            public string Hash;
        }

        public static Result World(WorldConfig config, Action<string, double> progress = null)
        {
            progress ??= (_, _) => { };
            double size = config.Meters;
            uint seed = config.Seed;
            int n = (int)(size / Cell);
            var rng = new Rng(seed, 101);
            var edges = ChooseEdges(rng);
            var shape = new Shape { Seed = seed, Size = size, Edges = edges, SeaBand = 0.17 * size + 220, MountainBand = 0.13 * size + 260, Noise = MakeNoise(seed) };

            progress("Рельеф", 0);
            var h = new double[n * n];
            for (int z = 0; z < n; z++)
            {
                for (int x = 0; x < n; x++) h[z * n + x] = MacroHeight(shape, (x + 0.5) * Cell, (z + 0.5) * Cell);
                if ((z & 63) == 0) progress("Рельеф", z / (double)n);
            }
            var ocean = OceanMask(n, h, edges);
            Erode(n, h, ocean, 10, fr => progress("Эрозия", fr));
            progress("Озёра", 0);
            DigLakeBasins(n, size, h, ocean, seed, rng);
            ocean = OceanMask(n, h, edges);
            progress("Климат", 0);
            var seaDist = DistanceField(n, ocean, Cell);
            var climate = ComputeClimate(n, size, h, seaDist, edges, config.Climate, seed, rng);

            progress("Реки и озёра", 0);
            var (filled, receiver, order) = Flood.Run(n, h, ocean, 0.002);
            var runoff = new double[n * n];
            for (int i = 0; i < n * n; i++)
            {
                if (ocean[i] == 1) continue;
                runoff[i] = climate.Precip[i] * RunoffFraction(climate.Precip[i], climate.TMean[i]) / 1000 * Cell * Cell;
            }
            var volume = Accumulate(n, receiver, order, runoff);
            var meanDischarge = new float[n * n];
            for (int i = 0; i < n * n; i++) meanDischarge[i] = (float)(volume[i] / (RefHoursPerYear * 3600));
            var waterKind = new byte[n * n];
            var waterLevel = new float[n * n];
            var lakeId = new short[n * n];
            for (int i = 0; i < n * n; i++) lakeId[i] = -1;
            var lakes = new List<Lake>();
            var candidate = new byte[n * n];
            for (int i = 0; i < n * n; i++) if (ocean[i] == 0 && filled[i] - h[i] > 0.4) candidate[i] = 1;
            var popIndex = new int[n * n];
            for (int k = 0; k < n * n; k++) popIndex[order[k]] = k;
            var component = new int[n * n];
            for (int i = 0; i < n * n; i++) component[i] = -1;
            var stack = new Stack<int>();
            for (int start = 0; start < n * n; start++)
            {
                if (candidate[start] == 0 || component[start] >= 0) continue;
                var cells = new List<int>();
                stack.Push(start);
                component[start] = start;
                while (stack.Count > 0)
                {
                    int c = stack.Pop();
                    cells.Add(c);
                    int cx = c % n, cz = (c - cx) / n;
                    for (int d = 0; d < 8; d++)
                    {
                        int x = cx + Flood.DX8[d], z = cz + Flood.DZ8[d];
                        if (x < 0 || z < 0 || x >= n || z >= n) continue;
                        int i = z * n + x;
                        if (candidate[i] == 1 && component[i] < 0)
                        {
                            component[i] = start;
                            stack.Push(i);
                        }
                    }
                }
                if (cells.Count < 6 || lakes.Count >= 32000)
                {
                    foreach (int c in cells) h[c] = filled[c];
                    continue;
                }
                double level = double.NegativeInfinity;
                int outlet = -1;
                double outletPop = double.PositiveInfinity;
                foreach (int c in cells)
                {
                    if (filled[c] > level) level = filled[c];
                    int r = receiver[c];
                    if ((r < 0 || component[r] != start) && popIndex[c] < outletPop)
                    {
                        outletPop = popIndex[c];
                        outlet = r;
                    }
                }
                int id = lakes.Count;
                lakes.Add(new Lake { Id = id, Level = level, Cells = cells.Count, Outlet = outlet });
                foreach (int c in cells)
                {
                    waterKind[c] = WaterKind.Lake;
                    waterLevel[c] = (float)level;
                    lakeId[c] = (short)id;
                }
            }
            double riverQ = size >= 4096 ? 0.09 : 0.06;
            const double wideQ = 0.7;
            for (int k = n * n - 1; k >= 0; k--)
            {
                int c = order[k];
                if (ocean[c] == 1)
                {
                    waterKind[c] = WaterKind.Sea;
                    waterLevel[c] = 0;
                    continue;
                }
                if (waterKind[c] == WaterKind.Lake) continue;
                double q = meanDischarge[c];
                if (q < riverQ)
                {
                    if (waterKind[c] == WaterKind.None) waterLevel[c] = (float)h[c];
                    continue;
                }
                double depth = ChannelDepth(q);
                double bed = filled[c] - depth;
                double level = bed + depth * 0.55;
                waterKind[c] = WaterKind.River;
                waterLevel[c] = (float)level;
                if (h[c] > bed) h[c] = bed;
                if (q >= wideQ)
                {
                    int r = receiver[c];
                    if (r < 0) continue;
                    int cx = c % n, cz = (c - cx) / n;
                    int fx = r % n - cx;
                    int fz = (r - r % n) / n - cz;
                    foreach (int side in new[] { -1, 1 })
                    {
                        int x = cx - fz * side, z = cz + fx * side;
                        if (x < 0 || z < 0 || x >= n || z >= n) continue;
                        int i = z * n + x;
                        if (ocean[i] == 1 || waterKind[i] != WaterKind.None) continue;
                        if (filled[i] > level + 3) continue;
                        if (receiver[i] != c && receiver[i] != r) continue;
                        waterKind[i] = WaterKind.River;
                        waterLevel[i] = (float)level;
                        double sideBed = level - depth * 0.35;
                        if (h[i] > sideBed) h[i] = sideBed;
                        if (meanDischarge[i] < q * 0.5) meanDischarge[i] = (float)(q * 0.5);
                    }
                }
            }
            for (int i = 0; i < n * n; i++) if (waterKind[i] == WaterKind.None) waterLevel[i] = (float)h[i];
            var waterMask = new byte[n * n];
            for (int i = 0; i < n * n; i++) waterMask[i] = (byte)(waterKind[i] != WaterKind.None ? 1 : 0);
            var waterDist = DistanceField(n, waterMask, Cell);
            var finalSeaDist = DistanceField(n, ocean, Cell);
            var slope = new float[n * n];
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    double hx = (h[z * n + Math.Min(n - 1, x + 1)] - h[z * n + Math.Max(0, x - 1)]) / (2 * Cell);
                    double hz = (h[Math.Min(n - 1, z + 1) * n + x] - h[Math.Max(0, z - 1) * n + x]) / (2 * Cell);
                    slope[z * n + x] = (float)Math.Sqrt(hx * hx + hz * hz);
                }

            progress("Почвы", 0);
            var soil = new byte[n * n];
            var fertility = new float[n * n];
            var deposit = new byte[n * n];
            var depositRichness = new byte[n * n];
            var patchNoise = new Noise2(seed, 60);
            var patch2Noise = new Noise2(seed, 61);
            var veinNoise = new Noise2(seed, 62);
            var oreRidges = new Ridged(seed, 63, 2);
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    int i = z * n + x;
                    double px = (x + 0.5) * Cell, pz = (z + 0.5) * Cell;
                    double hc = h[i];
                    double s = slope[i];
                    double wd = waterDist[i];
                    double sd = finalSeaDist[i];
                    double patch = patchNoise.At(px / 260, pz / 260);
                    double patch2 = patch2Noise.At(px / 140, pz / 140);
                    byte kind = waterKind[i];
                    byte t;
                    if (kind == WaterKind.Sea) t = Soils.Sand;
                    else if (kind == WaterKind.River) t = Soils.Alluvial;
                    else if (kind == WaterKind.Lake) t = Soils.Clay;
                    else if (s > 0.55 || hc > 430) t = Soils.Rock;
                    else if (sd < 48 && hc < 5) t = Soils.Sand;
                    else if (wd < 28 + 4 * Math.Sqrt(meanDischarge[i]) && s < 0.12) t = Soils.Alluvial;
                    else if (s < 0.035 && (climate.Precip[i] > 820 || wd < 90) && patch > 0.15) t = Soils.Peat;
                    else if (s < 0.07 && hc < 70 && patch2 > 0.12) t = Soils.Clay;
                    else if (s > 0.32 && patch2 < -0.25) t = Soils.Rock;
                    else if (sd < 160 && patch < -0.3) t = Soils.Sand;
                    else t = Soils.Loam;
                    soil[i] = t;
                    fertility[i] = (float)DMath.Clamp01(Soils.All[t].Fertility * (1 - 0.5 * DMath.Smoothstep(0.2, 0.6, s)) * (0.88 + 0.24 * (patch2 + 0.7) / 1.4));
                    if (kind != WaterKind.None) continue;
                    double vein = veinNoise.At(px / 90, pz / 90);
                    if (hc > 220 && vein > 0.42 && oreRidges.At(px / 300, pz / 300) > 0.55)
                    {
                        deposit[i] = DepositKind.Ore;
                        depositRichness[i] = (byte)JsMath.Round(DMath.Clamp01((vein - 0.42) * 3) * 255);
                    }
                    else if (t == Soils.Rock && s > 0.4 && vein > 0)
                    {
                        deposit[i] = DepositKind.Stone;
                        depositRichness[i] = (byte)JsMath.Round(DMath.Clamp01(s) * 255);
                    }
                    else if (t == Soils.Clay && vein > 0.25)
                    {
                        deposit[i] = DepositKind.Clay;
                        depositRichness[i] = (byte)JsMath.Round(DMath.Clamp01((vein - 0.25) * 2.5) * 255);
                    }
                    else if ((t == Soils.Sand || (t == Soils.Alluvial && wd <= Cell)) && vein > 0.3)
                    {
                        deposit[i] = DepositKind.Sand;
                        depositRichness[i] = (byte)JsMath.Round(DMath.Clamp01((vein - 0.3) * 2.5) * 255);
                    }
                }

            progress("Провинции", 0);
            var (provinceOf, provinces) = BuildProvinces(n, h, ocean, waterKind, slope, meanDischarge, finalSeaDist, lakeId, climate, rng);
            progress("Детализация рельефа", 0);
            var terrain = BuildFineTerrain(n, size, h, slope, waterDist, waterKind, seed, fr => progress("Детализация рельефа", fr));
            CarveChannels(terrain, n, h, waterKind, waterLevel, receiver, meanDischarge);
            progress("Горизонт", 0);
            var horizon = BuildHorizon(shape, terrain);
            var upstreamOrder = new int[n * n];
            for (int k = 0; k < n * n; k++) upstreamOrder[k] = order[n * n - 1 - k];
            var height32 = new float[n * n];
            for (int i = 0; i < n * n; i++) height32[i] = (float)h[i];
            var geo = new Geo
            {
                N = n, CellSize = Cell, Edges = edges, Height = height32, Slope = slope, WaterKind = waterKind, WaterLevel = waterLevel,
                WaterDist = waterDist, SeaDist = finalSeaDist, Receiver = receiver, UpstreamOrder = upstreamOrder, MeanDischarge = meanDischarge,
                LakeId = lakeId, Lakes = lakes.ToArray(), TMean = climate.TMean, TAmp = climate.TAmp, Precip = climate.Precip, Soil = soil,
                Fertility = fertility, Deposit = deposit, DepositRichness = depositRichness, ProvinceOf = provinceOf, Provinces = provinces,
                WindX = climate.WindX, WindZ = climate.WindZ, Terrain = terrain, Horizon = horizon,
            };
            progress("Готово", 1);
            return new Result { Geo = geo, Hash = HashGeo(geo) };
        }

        public static string HashGeo(Geo g)
        {
            var hs = new StateHasher().AddInt(WorldgenVersion).AddInt(g.N).AddInt(g.Edges[0] | (g.Edges[1] << 2) | (g.Edges[2] << 4) | (g.Edges[3] << 6))
                .AddArray(g.Height).AddArray(g.WaterKind).AddArray(g.WaterLevel).AddArray(g.Receiver).AddArray(g.MeanDischarge).AddArray(g.TMean)
                .AddArray(g.TAmp).AddArray(g.Precip).AddArray(g.Soil).AddArray(g.Fertility).AddArray(g.Deposit).AddArray(g.ProvinceOf)
                .AddArray(g.Terrain.Data).AddArray(g.Horizon.Data);
            foreach (var p in g.Provinces)
            {
                hs.AddInt(p.Cells);
                foreach (char ch in p.Name) hs.AddInt(ch);
            }
            return hs.Digest();
        }

        sealed class Stat { public int Cells; public double X, Z, H, T, P, Slope; public int Coast, Lake, River, High; }

        static (ushort[], Province[]) BuildProvinces(int n, double[] h, byte[] ocean, byte[] waterKind, float[] slope, float[] discharge, float[] seaDist, short[] lakeId, ClimateField climate, Rng rng)
        {
            var land = new List<int>();
            for (int i = 0; i < n * n; i++) if (ocean[i] == 0) land.Add(i);
            double cellArea = Cell * Cell;
            int count = (int)DMath.Clamp(JsMath.Round(land.Count * cellArea / 0.45e6), 3, 48);
            var seeds = new List<int>();
            for (int k = 0; k < count && land.Count > 0; k++)
            {
                int best = -1;
                double bestD = -1;
                for (int t = 0; t < 16; t++)
                {
                    int c = land[rng.Int(land.Count)];
                    int cx = c % n, cz = (c - cx) / n;
                    double d = double.PositiveInfinity;
                    foreach (int s in seeds)
                    {
                        int sx = s % n, sz = (s - sx) / n;
                        double dd = (sx - cx) * (sx - cx) + (sz - cz) * (sz - cz);
                        if (dd < d) d = dd;
                    }
                    if (d > bestD)
                    {
                        bestD = d;
                        best = c;
                    }
                }
                if (best >= 0 && !seeds.Contains(best)) seeds.Add(best);
            }
            var cost = Filled(n * n, double.PositiveInfinity);
            var province = new ushort[n * n];
            var heap = new List<int>();
            bool Less(int a, int b) => cost[a] < cost[b] || (cost[a] == cost[b] && a < b);
            void Push(int i)
            {
                heap.Add(i);
                int k = heap.Count - 1;
                while (k > 0)
                {
                    int p = (k - 1) >> 1;
                    if (!Less(heap[k], heap[p])) break;
                    (heap[k], heap[p]) = (heap[p], heap[k]);
                    k = p;
                }
            }
            int Pop()
            {
                int top = heap[0];
                int last = heap[heap.Count - 1];
                heap.RemoveAt(heap.Count - 1);
                if (heap.Count > 0)
                {
                    heap[0] = last;
                    int k = 0;
                    for (;;)
                    {
                        int l = 2 * k + 1, r = l + 1, m = k;
                        if (l < heap.Count && Less(heap[l], heap[m])) m = l;
                        if (r < heap.Count && Less(heap[r], heap[m])) m = r;
                        if (m == k) break;
                        (heap[k], heap[m]) = (heap[m], heap[k]);
                        k = m;
                    }
                }
                return top;
            }
            for (int k = 0; k < seeds.Count; k++)
            {
                cost[seeds[k]] = 0;
                province[seeds[k]] = (ushort)(k + 1);
                Push(seeds[k]);
            }
            var done = new byte[n * n];
            while (heap.Count > 0)
            {
                int c = Pop();
                if (done[c] == 1) continue;
                done[c] = 1;
                int cx = c % n, cz = (c - cx) / n;
                for (int d = 0; d < 8; d++)
                {
                    int x = cx + Flood.DX8[d], z = cz + Flood.DZ8[d];
                    if (x < 0 || z < 0 || x >= n || z >= n) continue;
                    int i = z * n + x;
                    if (ocean[i] == 1 || done[i] == 1) continue;
                    double dist = d % 2 == 1 ? DIAG : 1;
                    double climb = Math.Abs(h[i] - h[c]);
                    double river = waterKind[i] == WaterKind.River && discharge[i] > 0.5 ? 25 : 0;
                    double nc = cost[c] + dist * (1 + climb * 0.35) + river;
                    if (nc < cost[i])
                    {
                        cost[i] = nc;
                        province[i] = province[c];
                        Push(i);
                    }
                }
            }
            var used = new HashSet<string>();
            var provinces = new List<Province>();
            var stats = new Stat[seeds.Count];
            for (int k = 0; k < stats.Length; k++) stats[k] = new Stat();
            foreach (int i in land)
            {
                int id = province[i];
                if (id == 0) continue;
                var st = stats[id - 1];
                int x = i % n;
                st.Cells++;
                st.X += (x + 0.5) * Cell;
                st.Z += ((i - x) / n + 0.5) * Cell;
                st.H += h[i] > 0 ? h[i] : 0;
                st.T += climate.TMean[i];
                st.P += climate.Precip[i];
                st.Slope += slope[i];
                if (seaDist[i] < 200) st.Coast++;
                if (lakeId[i] >= 0) st.Lake++;
                if (waterKind[i] == WaterKind.River) st.River++;
                if (h[i] > 260) st.High++;
            }
            for (int k = 0; k < stats.Length; k++)
            {
                var st = stats[k];
                double c = Math.Max(1, st.Cells);
                double meanH = st.H / c;
                string kind;
                if (st.High / c > 0.45 || meanH > 300) kind = "mountains";
                else if (meanH > 160) kind = "highland";
                else if (st.Lake / c > 0.06) kind = "lakeland";
                else if (st.Coast / c > 0.28) kind = "coast";
                else if (st.River / c > 0.03) kind = "valley";
                else if (st.Slope / c > 0.11) kind = "hills";
                else kind = "plain";
                provinces.Add(new Province { Id = k + 1, Name = Names.Province(kind, rng, used), Kind = kind, X = st.X / c, Z = st.Z / c, Cells = st.Cells, MeanHeight = meanH, MeanTemp = st.T / c, MeanPrecip = st.P / c });
            }
            return (province, provinces.ToArray());
        }

        static double Catmull(double p0, double p1, double p2, double p3, double t)
        {
            double t2 = t * t;
            return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
        }

        static Heights BuildFineTerrain(int n, double size, double[] h, float[] slope, float[] waterDist, byte[] waterKind, uint seed, Action<double> progress)
        {
            const double spacing = WorldConfig.HeightSpacing;
            int samples = (int)(size / spacing) + 1;
            var heights = new float[samples * samples];
            var rough = new double[n * n];
            for (int i = 0; i < n * n; i++)
            {
                double nearWater = DMath.Smoothstep(6, 26, waterDist[i]);
                rough[i] = waterKind[i] != WaterKind.None ? 0.05 : (0.3 + 2.6 * DMath.Smoothstep(0.06, 0.7, slope[i])) * nearWater;
            }
            var rowX = new double[n * samples];
            var colIndex = new int[samples];
            var colT = new double[samples];
            for (int ix = 0; ix < samples; ix++)
            {
                double fx = ix * spacing / Cell - 0.5;
                colIndex[ix] = (int)Math.Floor(fx);
                colT[ix] = fx - Math.Floor(fx);
            }
            double At(int x, int row) => h[row + (x < 0 ? 0 : x >= n ? n - 1 : x)];
            for (int cz = 0; cz < n; cz++)
            {
                int row = cz * n;
                for (int ix = 0; ix < samples; ix++)
                {
                    int cx = colIndex[ix];
                    rowX[cz * samples + ix] = Catmull(At(cx - 1, row), At(cx, row), At(cx + 1, row), At(cx + 2, row), colT[ix]);
                }
            }
            var coarse = new Noise2(seed, 80);
            var fine = new Noise2(seed, 81);
            int ClampRow(int z) => (z < 0 ? 0 : z >= n ? n - 1 : z) * samples;
            for (int iz = 0; iz < samples; iz++)
            {
                double pz = iz * spacing;
                double fz = pz / Cell - 0.5;
                int cz = (int)Math.Floor(fz);
                double tz = fz - cz;
                int r0 = ClampRow(cz - 1), r1 = ClampRow(cz), r2 = ClampRow(cz + 1), r3 = ClampRow(cz + 2);
                int rz = (int)DMath.Clamp(cz, 0, n - 2);
                double ttz = DMath.Clamp01(fz - rz);
                for (int ix = 0; ix < samples; ix++)
                {
                    double b = Catmull(rowX[r0 + ix], rowX[r1 + ix], rowX[r2 + ix], rowX[r3 + ix], tz);
                    double px = ix * spacing;
                    int cx = colIndex[ix];
                    int rx = (int)DMath.Clamp(cx, 0, n - 2);
                    double ttx = DMath.Clamp01(colT[ix] + cx - rx);
                    double a = rough[rz * n + rx] * (1 - ttx) + rough[rz * n + rx + 1] * ttx;
                    double bb = rough[(rz + 1) * n + rx] * (1 - ttx) + rough[(rz + 1) * n + rx + 1] * ttx;
                    double r = a * (1 - ttz) + bb * ttz;
                    if (r > 0.01) b += r * (coarse.At(px / 46, pz / 46) * 1.7 + fine.At(px / 13, pz / 13) * 0.55);
                    heights[iz * samples + ix] = (float)b;
                }
                if ((iz & 127) == 0) progress(iz / (double)samples);
            }
            return new Heights { Samples = samples, Spacing = spacing, Data = heights };
        }

        static void CarveChannels(Heights terrain, int n, double[] h, byte[] waterKind, float[] waterLevel, int[] receiver, float[] discharge)
        {
            double sp = terrain.Spacing;
            int samples = terrain.Samples;
            var heights = terrain.Data;
            for (int c = 0; c < n * n; c++)
            {
                if (waterKind[c] != WaterKind.River) continue;
                int r = receiver[c];
                double ax = (c % n + 0.5) * Cell, az = (Math.Floor(c / (double)n) + 0.5) * Cell;
                double bx = r >= 0 ? (r % n + 0.5) * Cell : ax;
                double bz = r >= 0 ? (Math.Floor(r / (double)n) + 0.5) * Cell : az;
                double la = waterLevel[c];
                double lb = r >= 0 ? Math.Min(la, waterKind[r] == WaterKind.None ? la : waterLevel[r]) : la;
                double depth = Math.Max(0.6, la - h[c]);
                double half = Math.Min(9, 2.6 + 2.2 * Math.Sqrt(discharge[c]));
                double bank = half + 4;
                int x0 = (int)Math.Max(0, Math.Floor((Math.Min(ax, bx) - bank) / sp));
                int x1 = (int)Math.Min(samples - 1, Math.Ceiling((Math.Max(ax, bx) + bank) / sp));
                int z0 = (int)Math.Max(0, Math.Floor((Math.Min(az, bz) - bank) / sp));
                int z1 = (int)Math.Min(samples - 1, Math.Ceiling((Math.Max(az, bz) + bank) / sp));
                double dx = bx - ax, dz = bz - az;
                double len2 = dx * dx + dz * dz;
                for (int iz = z0; iz <= z1; iz++)
                    for (int ix = x0; ix <= x1; ix++)
                    {
                        double px = ix * sp, pz = iz * sp;
                        double t = len2 > 0 ? DMath.Clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
                        double qx = ax + dx * t - px, qz = az + dz * t - pz;
                        double dist = Math.Sqrt(qx * qx + qz * qz);
                        if (dist >= bank) continue;
                        double level = la + (lb - la) * t;
                        double k = dist / half;
                        double target = dist < half ? level - 0.15 - depth * (1 - k * k) : level - 0.15 + (dist - half) * 0.45;
                        int o = iz * samples + ix;
                        if (heights[o] > target) heights[o] = (float)target;
                    }
            }
        }

        static Heights BuildHorizon(Shape shape, Heights terrain)
        {
            double size = shape.Size;
            double extent = Math.Max(3000, size * 0.9);
            const double spacing = 32;
            int samples = (int)JsMath.Round((size + 2 * extent) / spacing) + 1;
            double originX = -extent, originZ = -extent;
            var heights = new float[samples * samples];
            int ts = terrain.Samples;
            double EdgeHeight(double x, double z)
            {
                int ix = (int)JsMath.Round(DMath.Clamp(x, 0, size) / terrain.Spacing);
                int iz = (int)JsMath.Round(DMath.Clamp(z, 0, size) / terrain.Spacing);
                return terrain.Data[(int)DMath.Clamp(iz, 0, ts - 1) * ts + (int)DMath.Clamp(ix, 0, ts - 1)];
            }
            for (int iz = 0; iz < samples; iz++)
                for (int ix = 0; ix < samples; ix++)
                {
                    double x = originX + ix * spacing, z = originZ + iz * spacing;
                    double outside = Math.Max(Math.Max(Math.Max(-x, x - size), Math.Max(-z, z - size)), 0);
                    double v;
                    if (outside <= 0) v = EdgeHeight(x, z);
                    else
                    {
                        double t = DMath.Smoothstep(0, 420, outside);
                        v = EdgeHeight(x, z) * (1 - t) + MacroHeight(shape, x, z) * t;
                    }
                    heights[iz * samples + ix] = (float)v;
                }
            return new Heights { Samples = samples, Spacing = spacing, Data = heights, OriginX = originX, OriginZ = originZ };
        }
    }
}
