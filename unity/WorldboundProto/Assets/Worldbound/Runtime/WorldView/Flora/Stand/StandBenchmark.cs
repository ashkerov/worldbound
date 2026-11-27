// Замеры стенда: сценарии камеры и запись показателей кадра. Время CPU и GPU кадра — FrameTimingManager
// (реальные значения драйвера; в Null Device/headless GPU не измеряется — такие прогоны не выдаются за замеры).
// Треугольники и вызовы растительности — собственный счёт рендера (встроенные счётчики Unity не учитывают
// RenderMeshIndirect); вызовы, пакеты и SetPass кадра — счётчики Unity (ProfilerRecorder).

using System;
using System.Collections.Generic;
using System.Globalization;
using Unity.Profiling;
using UnityEngine;

namespace Worldbound.FloraView.Stand
{
    public static class StandViews
    {
        public static readonly string[] Names = { "overview", "flight", "forest", "grass", "mixed" };
        public static readonly string[] Titles = { "Высокий обзор", "Полёт над лесом", "Внутри леса", "В высокой траве", "Смешанная территория" };

        /// <summary>Положение и поворот камеры сценария в момент t ∈ [0, 1].</summary>
        public static void Pose(string view, float t, Func<float, float, float> height, out Vector3 pos, out Quaternion rot)
        {
            const float C = StandTerrain.Size * 0.5f;
            switch (view)
            {
                case "overview":
                {
                    float a = -0.6f + t * 0.9f;
                    pos = new Vector3(C + Mathf.Sin(a) * 1150, 0, C - Mathf.Cos(a) * 1150);
                    pos.y = height(pos.x, pos.z) + 640;
                    rot = Quaternion.Euler(38, -a * Mathf.Rad2Deg, 0);
                    break;
                }
                case "flight":
                {
                    pos = new Vector3(Mathf.Lerp(260, 1820, t), 0, 1330 + Mathf.Sin(t * 6) * 40);
                    pos.y = height(pos.x, pos.z) + 58;
                    rot = Quaternion.Euler(14, 90 + Mathf.Sin(t * 5) * 12, 0);
                    break;
                }
                case "forest":
                {
                    var c = SyntheticFloraSource.BiomeCentre[(int)SyntheticFloraSource.Biome.Dense];
                    pos = new Vector3(c.x - 30 + t * 22, 0, c.y - 40 + t * 70);
                    pos.y = height(pos.x, pos.z) + 1.7f;
                    rot = Quaternion.Euler(3, 10 + Mathf.Sin(t * 4.5f) * 55, 0);
                    break;
                }
                case "grass":
                {
                    var c = SyntheticFloraSource.BiomeCentre[(int)SyntheticFloraSource.Biome.Meadow];
                    pos = new Vector3(c.x - 60 + t * 25, 0, c.y + 30 + t * 12);
                    pos.y = height(pos.x, pos.z) + 1.15f;
                    rot = Quaternion.Euler(6, 35 + t * 80, 0);
                    break;
                }
                default: // mixed
                {
                    pos = new Vector3(Mathf.Lerp(620, 1500, t), 0, 980);
                    pos.y = height(pos.x, pos.z) + 30;
                    rot = Quaternion.Euler(16, 25, 0);
                    break;
                }
            }
        }
    }

    public sealed class StandRecorder : IDisposable
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        readonly List<double> frame = new(4096), cpu = new(4096), gpu = new(4096), cull = new(4096), grass = new(4096), apply = new(4096);
        readonly List<double> visible = new(4096), tris = new(4096), calls = new(4096), lodChanges = new(4096), gcAlloc = new(4096);
        readonly FrameTiming[] timings = new FrameTiming[1];
        ProfilerRecorder batches, draws, setpass, total, sys, gfx, gcRec;
        long maxBatches, maxDraws, maxSetPass;
        readonly int gc0;
        readonly long mono0;

        public StandRecorder()
        {
            batches = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Batches Count");
            draws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
            setpass = ProfilerRecorder.StartNew(ProfilerCategory.Render, "SetPass Calls Count");
            total = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Total Used Memory");
            sys = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "System Used Memory");
            gfx = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Gfx Used Memory");
            gcRec = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
            gc0 = GC.CollectionCount(0);
            mono0 = UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong();
        }

        public void Frame(in FloraFrameStats s, long groundTris)
        {
            frame.Add(Time.unscaledDeltaTime * 1000);
            FrameTimingManager.CaptureFrameTimings();
            if (FrameTimingManager.GetLatestTimings(1, timings) > 0)
            {
                cpu.Add(timings[0].cpuFrameTime);
                if (timings[0].gpuFrameTime > 0 && timings[0].gpuFrameTime < 1000) gpu.Add(timings[0].gpuFrameTime); // отбрасываем сбойные значения драйвера
            }
            cull.Add(s.CullMs); grass.Add(s.GrassMs); apply.Add(s.ApplyMs);
            visible.Add(s.TreesVisible + s.ShrubsVisible + s.GrassVisible);
            tris.Add(s.Triangles + groundTris);
            calls.Add(s.DrawCalls);
            lodChanges.Add(s.LodChanges);
            if (gcRec.Valid) gcAlloc.Add(gcRec.LastValue);
            maxBatches = Math.Max(maxBatches, batches.LastValue);
            maxDraws = Math.Max(maxDraws, draws.LastValue);
            maxSetPass = Math.Max(maxSetPass, setpass.LastValue);
        }

        static string F(double v) => v.ToString("0.##", Inv);

        static string Stat(List<double> l)
        {
            if (l.Count == 0) return "null";
            var s = new List<double>(l);
            s.Sort();
            double mean = 0;
            foreach (var v in s) mean += v;
            mean /= s.Count;
            return $"{{ \"mean\": {F(mean)}, \"p50\": {F(s[s.Count / 2])}, \"p95\": {F(s[Math.Min(s.Count - 1, (int)(s.Count * 0.95))])}, \"p99\": {F(s[Math.Min(s.Count - 1, (int)(s.Count * 0.99))])}, \"max\": {F(s[^1])} }}";
        }

        public int Frames => frame.Count;

        public string Json(string extra)
        {
            double sum = 0;
            int over50 = 0, over100 = 0;
            foreach (var v in frame) { sum += v; if (v > 50) over50++; if (v > 100) over100++; }
            double lodSum = 0;
            foreach (var v in lodChanges) lodSum += v;
            return $"{{ {extra}, \"frames\": {frame.Count}, \"fps\": {(frame.Count / Math.Max(1e-6, sum / 1000)).ToString("0.#", Inv)}, \"frameMs\": {Stat(frame)}, \"cpuMs\": {Stat(cpu)}, \"gpuMs\": {Stat(gpu)}, " +
                   $"\"framesOver50ms\": {over50}, \"framesOver100ms\": {over100}, \"floraCullMs\": {Stat(cull)}, \"grassGenMs\": {Stat(grass)}, \"chunkApplyMs\": {Stat(apply)}, " +
                   $"\"visibleInstances\": {Stat(visible)}, \"triangles\": {Stat(tris)}, \"floraDrawCalls\": {Stat(calls)}, \"lodChangesPerSecond\": {F(lodSum / Math.Max(1e-6, sum / 1000))}, " +
                   $"\"gcAllocBytesPerFrame\": {Stat(gcAlloc)}, \"gcCollections\": {GC.CollectionCount(0) - gc0}, \"monoHeapGrowthKB\": {(UnityEngine.Profiling.Profiler.GetMonoUsedSizeLong() - mono0) / 1024}, " +
                   $"\"unityBatchesMax\": {maxBatches}, \"unityDrawCallsMax\": {maxDraws}, \"setPassMax\": {maxSetPass}, " +
                   $"\"memoryMB\": {{ \"totalUsed\": {total.LastValue / 1048576}, \"system\": {sys.LastValue / 1048576}, \"gfx\": {gfx.LastValue / 1048576} }} }}";
        }

        public void Dispose() { batches.Dispose(); draws.Dispose(); setpass.Dispose(); total.Dispose(); sys.Dispose(); gfx.Dispose(); gcRec.Dispose(); }
    }
}
