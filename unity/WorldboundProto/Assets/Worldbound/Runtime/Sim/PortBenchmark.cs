// Prototype C: сверка C#-переноса шага воды с эталоном TypeScript и замер скорости и памяти.
// Эталон (tools/unity-golden.ts) лежит в StreamingAssets/golden: входы каждого часа и FNV-хеши выходов TS.
// Сверка побитная: те же хеши байтов float-массивов. Запуск: из редактора (batchmode) и из сборки (-wbport).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;

namespace Worldbound.Sim
{
    public static class PortBenchmark
    {
        sealed class Golden
        {
            public int N, Count;
            public double CellSize, Compression, Melt, TsMs, TsKernelMedian, TsKernelMin, TsKernelP95;
            public int TsKernelEqual;
            public List<double> Sun = new();
            public List<double[]> Totals = new();
            public List<string[]> Hashes = new();
            public List<long[]> Vectors = new();
        }

        static Golden ReadGolden(string dir)
        {
            var g = new Golden();
            var inv = CultureInfo.InvariantCulture;
            foreach (var line in File.ReadAllLines(Path.Combine(dir, "golden.txt")))
            {
                var p = line.Split(' ');
                switch (p[0])
                {
                    case "world": g.N = int.Parse(p[1]); g.CellSize = double.Parse(p[2], inv); g.Count = int.Parse(p[3]); break;
                    case "compression": g.Compression = double.Parse(p[1], inv); break;
                    case "melt": g.Melt = double.Parse(p[1], inv); break;
                    case "tsms": g.TsMs = double.Parse(p[1], inv); break;
                    case "hour":
                        g.Sun.Add(double.Parse(p[1], inv));
                        g.Totals.Add(new[] { double.Parse(p[2], inv), double.Parse(p[3], inv), double.Parse(p[4], inv), double.Parse(p[5], inv), double.Parse(p[6], inv) });
                        g.Hashes.Add(p[7..15]);
                        break;
                    case "tskernel": g.TsKernelEqual = int.Parse(p[1]); g.TsKernelMedian = double.Parse(p[2], inv); g.TsKernelMin = double.Parse(p[3], inv); g.TsKernelP95 = double.Parse(p[4], inv); break;
                    case "vec": g.Vectors.Add(new[] { long.Parse(p[1]), long.Parse(p[2]), long.Parse(p[3]), long.Parse(p[4]), long.Parse(p[5]) }); break;
                }
            }
            return g;
        }

        static T[] Slice<T>(byte[] src, ref int offset, int count) where T : unmanaged
        {
            var a = new T[count];
            int bytes = count * UnsafeUtility.SizeOf<T>();
            Buffer.BlockCopy(src, offset, a, 0, bytes);
            offset += bytes;
            return a;
        }

        static string Fnv<T>(T[] a) where T : unmanaged
        {
            var b = new byte[a.Length * UnsafeUtility.SizeOf<T>()];
            Buffer.BlockCopy(a, 0, b, 0, b.Length);
            uint h = 2166136261;
            foreach (var x in b) h = (h ^ x) * 16777619;
            return h.ToString("x8");
        }

        /// <summary>Сверка и замер. Возвращает отчёт JSON (строкой) и пишет его в outFile, если задан.</summary>
        public static string Run(string goldenDir, string outFile, int perfLoops = 6)
        {
            var g = ReadGolden(goldenDir);
            int n = g.Count;
            int off = 0;
            var stat = File.ReadAllBytes(Path.Combine(goldenDir, "static.bin"));
            var s = new WaterStatic
            {
                Count = n,
                CellArea = g.CellSize * g.CellSize,
                Kind = Slice<byte>(stat, ref off, n),
                Capacity = Slice<float>(stat, ref off, n),
                DrainHour = Slice<float>(stat, ref off, n),
                WaterDist = Slice<float>(stat, ref off, n),
                Receiver = Slice<int>(stat, ref off, n),
                UpstreamOrder = Slice<int>(stat, ref off, n),
            };
            var start = File.ReadAllBytes(Path.Combine(goldenDir, "start.bin"));
            var inputs = File.ReadAllBytes(Path.Combine(goldenDir, "inputs.bin"));
            int hours = g.Sun.Count;
            off = 0;
            var precip = Slice<double>(inputs, ref off, hours * n);
            var cloud = Slice<double>(inputs, ref off, hours * n);
            var temp = Slice<double>(inputs, ref off, hours * n);
            var green = Slice<float>(inputs, ref off, hours * n);
            // Накопители флоры перед каждым часом (между часами их обнуляет суточный шаг флоры — другая система).
            var accPreBytes = File.ReadAllBytes(Path.Combine(goldenDir, "accpre.bin"));
            off = 0;
            var accPre = Slice<float>(accPreBytes, ref off, hours * n * 4);
            void SetAcc(WaterState st, int h)
            {
                int a = h * n * 4;
                Array.Copy(accPre, a, st.AccT, 0, n);
                Array.Copy(accPre, a + n, st.AccW, 0, n);
                Array.Copy(accPre, a + 2 * n, st.AccRunoff, 0, n);
                Array.Copy(accPre, a + 3 * n, st.AccMinT, 0, n);
            }

            WaterState Fresh()
            {
                int o = 0;
                var st = new WaterState
                {
                    Moisture = Slice<float>(start, ref o, n),
                    Snow = Slice<float>(start, ref o, n),
                    AccT = Slice<float>(start, ref o, n),
                    AccW = Slice<float>(start, ref o, n),
                    AccRunoff = Slice<float>(start, ref o, n),
                    AccMinT = Slice<float>(start, ref o, n),
                    Runoff = new float[n],
                    Discharge = new float[n],
                    AccHours = new byte[n],
                };
                return st;
            }

            var report = new StringBuilder();
            var inv = CultureInfo.InvariantCulture;
            report.Append("{\n");

            // 1. Хеш: векторы TS.
            int vecOk = 0;
            foreach (var v in g.Vectors) if (WbHash.Hash4((int)v[0], (int)v[1], (int)v[2], (int)v[3]) == (uint)v[4]) vecOk++;
            report.Append($" \"hashVectors\": {{ \"total\": {g.Vectors.Count}, \"equal\": {vecOk} }},\n");

            // 2. Managed: сверка по часам.
            var ms = Fresh();
            int managedEqual = 0;
            double managedMaxTotalDiff = 0;
            var firstMismatch = "";
            for (int h = 0; h < hours; h++)
            {
                SetAcc(ms, h);
                var p0 = ms.PrecipTotal; var e0 = ms.Evaporated; var s0 = ms.ToSea; var l0 = ms.LocalTotal; var c0 = ms.Capillary;
                WaterKernel.Step(s, ms, precip.AsSpan(h * n, n), cloud.AsSpan(h * n, n), temp.AsSpan(h * n, n), green.AsSpan(h * n, n), g.Compression, g.Melt, g.Sun[h]);
                var got = new[] { Fnv(ms.Moisture), Fnv(ms.Snow), Fnv(ms.Runoff), Fnv(ms.Discharge), Fnv(ms.AccT), Fnv(ms.AccW), Fnv(ms.AccRunoff), Fnv(ms.AccMinT) };
                bool eq = true;
                for (int k = 0; k < 8; k++) if (got[k] != g.Hashes[h][k]) { eq = false; if (firstMismatch == "") firstMismatch = $"час {h}, массив {k}: {got[k]} ≠ {g.Hashes[h][k]}"; }
                if (eq) managedEqual++;
                var t = g.Totals[h];
                managedMaxTotalDiff = Math.Max(managedMaxTotalDiff, Math.Max(Math.Abs(ms.PrecipTotal - p0 - t[0]), Math.Max(Math.Abs(ms.Evaporated - e0 - t[1]), Math.Max(Math.Abs(ms.ToSea - s0 - t[2]), Math.Max(Math.Abs(ms.LocalTotal - l0 - t[3]), Math.Abs(ms.Capillary - c0 - t[4]))))));
            }
            report.Append($" \"managed\": {{ \"hoursBitwiseEqual\": {managedEqual}, \"hours\": {hours}, \"maxTotalsAbsDiff\": {managedMaxTotalDiff.ToString("R", inv)}, \"firstMismatch\": \"{firstMismatch}\" }},\n");

            // 3. Burst: сверка по часам.
            var bs = Fresh();
            int burstEqual = 0;
            string burstMismatch = "";
            using (var nat = new NativeWater(s, bs))
            {
                for (int h = 0; h < hours; h++)
                {
                    SetAcc(bs, h);
                    nat.SetAcc(bs);
                    nat.Step(precip, cloud, temp, green, h * n, g.Compression, g.Melt, g.Sun[h]);
                    nat.CopyBack(bs);
                    var got = new[] { Fnv(bs.Moisture), Fnv(bs.Snow), Fnv(bs.Runoff), Fnv(bs.Discharge), Fnv(bs.AccT), Fnv(bs.AccW), Fnv(bs.AccRunoff), Fnv(bs.AccMinT) };
                    bool eq = true;
                    for (int k = 0; k < 8; k++) if (got[k] != g.Hashes[h][k]) { eq = false; if (burstMismatch == "") burstMismatch = $"час {h}, массив {k}"; }
                    if (eq) burstEqual++;
                }
                report.Append($" \"burst\": {{ \"hoursBitwiseEqual\": {burstEqual}, \"hours\": {hours}, \"firstMismatch\": \"{burstMismatch}\" }},\n");

                // 4. Скорость: perfLoops проходов по 24 часа (состояние продолжается; сверка уже сделана).
                var tm = new List<double>();
                var tb = new List<double>();
                var sw = new Stopwatch();
                long gc0 = GC.GetTotalMemory(false);
                for (int loop = 0; loop < perfLoops; loop++)
                {
                    for (int h = 0; h < hours; h++)
                    {
                        sw.Restart();
                        WaterKernel.Step(s, ms, precip.AsSpan(h * n, n), cloud.AsSpan(h * n, n), temp.AsSpan(h * n, n), green.AsSpan(h * n, n), g.Compression, g.Melt, g.Sun[h]);
                        sw.Stop();
                        tm.Add(sw.Elapsed.TotalMilliseconds);
                    }
                }
                long gcManaged = GC.GetTotalMemory(false) - gc0;
                gc0 = GC.GetTotalMemory(false);
                for (int loop = 0; loop < perfLoops; loop++)
                {
                    for (int h = 0; h < hours; h++)
                    {
                        sw.Restart();
                        nat.Step(precip, cloud, temp, green, h * n, g.Compression, g.Melt, g.Sun[h]);
                        sw.Stop();
                        tb.Add(sw.Elapsed.TotalMilliseconds);
                    }
                }
                long gcBurst = GC.GetTotalMemory(false) - gc0;
                tm.Sort();
                tb.Sort();
                string Ms(List<double> l) => $"{{ \"median\": {l[l.Count / 2].ToString("0.###", inv)}, \"min\": {l[0].ToString("0.###", inv)}, \"p95\": {l[(int)(l.Count * 0.95)].ToString("0.###", inv)} }}";
                report.Append($" \"msPerHour\": {{ \"typescriptRealSystemNode\": {g.TsMs.ToString("0.###", inv)}, \"typescriptKernelNode\": {{ \"median\": {g.TsKernelMedian.ToString("0.###", inv)}, \"min\": {g.TsKernelMin.ToString("0.###", inv)}, \"p95\": {g.TsKernelP95.ToString("0.###", inv)}, \"hoursEqualToRealSystem\": {g.TsKernelEqual} }}, \"csharpManaged\": {Ms(tm)}, \"csharpBurstJobs\": {Ms(tb)}, \"workerThreads\": {Unity.Jobs.LowLevel.Unsafe.JobsUtility.JobWorkerCount} }},\n");
                // Память: состояние и статика шага воды — одинаковые массивы в TS (TypedArray) и C#.
                long stateBytes = (long)n * (4 * 8 + 1);
                long staticBytes = (long)n * (1 + 4 * 3 + 4 * 2);
                report.Append($" \"memory\": {{ \"stateBytes\": {stateBytes}, \"staticBytes\": {staticBytes}, \"gcHeapGrowthManagedLoopBytes\": {gcManaged}, \"gcHeapGrowthBurstLoopBytes\": {gcBurst} }},\n");
            }
            report.Append($" \"cells\": {n}, \"hours\": {hours}, \"runtime\": \"{UnityEngine.Application.unityVersion} {(UnityEngine.Application.isEditor ? "editor" : "player")} {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}\"\n}}\n");
            var json = report.ToString();
            if (!string.IsNullOrEmpty(outFile)) File.WriteAllText(outFile, json);
            return json;
        }
    }

    /// <summary>Нативные массивы для Burst-версии (создаются один раз).</summary>
    sealed class NativeWater : IDisposable
    {
        NativeArray<byte> kind, accHours;
        NativeArray<float> capacity, drainHour, waterDist, green, moisture, snow, runoff, discharge, accT, accW, accRunoff, accMinT;
        NativeArray<int> receiver, order;
        NativeArray<double> precip, cloud, t, sums, totals;
        readonly double toM3s;
        readonly int n;

        public NativeWater(WaterStatic s, WaterState st)
        {
            n = s.Count;
            var a = Allocator.Persistent;
            kind = new NativeArray<byte>(s.Kind, a);
            capacity = new NativeArray<float>(s.Capacity, a);
            drainHour = new NativeArray<float>(s.DrainHour, a);
            waterDist = new NativeArray<float>(s.WaterDist, a);
            receiver = new NativeArray<int>(s.Receiver, a);
            order = new NativeArray<int>(s.UpstreamOrder, a);
            moisture = new NativeArray<float>(st.Moisture, a);
            snow = new NativeArray<float>(st.Snow, a);
            runoff = new NativeArray<float>(st.Runoff, a);
            discharge = new NativeArray<float>(st.Discharge, a);
            accT = new NativeArray<float>(st.AccT, a);
            accW = new NativeArray<float>(st.AccW, a);
            accRunoff = new NativeArray<float>(st.AccRunoff, a);
            accMinT = new NativeArray<float>(st.AccMinT, a);
            accHours = new NativeArray<byte>(st.AccHours, a);
            green = new NativeArray<float>(n, a);
            precip = new NativeArray<double>(n, a);
            cloud = new NativeArray<double>(n, a);
            t = new NativeArray<double>(n, a);
            sums = new NativeArray<double>(n * 4, a);
            totals = new NativeArray<double>(5, a);
            toM3s = s.CellArea / 1000 / 3600;
        }

        public void Step(double[] p, double[] c, double[] tt, float[] g, int offset, double compression, double melt, double sun)
        {
            NativeArray<double>.Copy(p, offset, precip, 0, n);
            NativeArray<double>.Copy(c, offset, cloud, 0, n);
            NativeArray<double>.Copy(tt, offset, t, 0, n);
            NativeArray<float>.Copy(g, offset, green, 0, n);
            var cells = new WaterCellJob { Kind = kind, Capacity = capacity, DrainHour = drainHour, WaterDist = waterDist, Greenness = green, Precip = precip, Cloud = cloud, T = t, Moisture = moisture, Snow = snow, Runoff = runoff, AccT = accT, AccW = accW, AccRunoff = accRunoff, AccMinT = accMinT, AccHours = accHours, Sums = sums, Compression = compression, MeltPerDegree = melt, SunFactor = sun };
            var route = new WaterRouteJob { Kind = kind, Receiver = receiver, Order = order, Runoff = runoff, Discharge = discharge, Sums = sums, Totals = totals, ToM3s = toM3s };
            route.Schedule(cells.Schedule(n, 1024)).Complete();
        }

        public void SetAcc(WaterState st)
        {
            accT.CopyFrom(st.AccT);
            accW.CopyFrom(st.AccW);
            accRunoff.CopyFrom(st.AccRunoff);
            accMinT.CopyFrom(st.AccMinT);
        }

        public void CopyBack(WaterState st)
        {
            moisture.CopyTo(st.Moisture);
            snow.CopyTo(st.Snow);
            runoff.CopyTo(st.Runoff);
            discharge.CopyTo(st.Discharge);
            accT.CopyTo(st.AccT);
            accW.CopyTo(st.AccW);
            accRunoff.CopyTo(st.AccRunoff);
            accMinT.CopyTo(st.AccMinT);
        }

        public void Dispose()
        {
            kind.Dispose(); accHours.Dispose(); capacity.Dispose(); drainHour.Dispose(); waterDist.Dispose(); green.Dispose();
            moisture.Dispose(); snow.Dispose(); runoff.Dispose(); discharge.Dispose(); accT.Dispose(); accW.Dispose(); accRunoff.Dispose(); accMinT.Dispose();
            receiver.Dispose(); order.Dispose(); precip.Dispose(); cloud.Dispose(); t.Dispose(); sums.Dispose(); totals.Dispose();
        }
    }
}
