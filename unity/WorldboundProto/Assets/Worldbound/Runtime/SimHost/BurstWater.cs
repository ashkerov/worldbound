// Ускоритель часового шага воды на Burst + Jobs для ядра Worldbound.Sim.
// Ячейки независимы → IJobParallelFor; арифметика ячейки — те же чистые функции ядра (ClimateModel.Bilinear,
// ClimateModel.CellTemperature, Water.LandCell), скомпилированные Burst в режиме FloatMode.Strict, поэтому результат
// побитно совпадает с управляемым циклом и с TS. Суммы по ячейкам складываются в ядре по индексу (порядок TS).
// Массивы мира не копируются: они закреплены (GCHandle) и видны заданиям как NativeArray. Dispose снимает закрепление.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Worldbound.Sim;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.SimHost
{
    public sealed unsafe class BurstWater : IWaterAccelerator, IDisposable
    {
        readonly List<GCHandle> handles = new();
#if ENABLE_UNITY_COLLECTIONS_CHECKS
        readonly List<AtomicSafetyHandle> safety = new();
#endif
        readonly World world;
        CellsJob cells;
        RouteJob route;
        double[] pinnedSums;
        NativeArray<double> toSea;
        readonly int count;
        public int BatchSize = 2048;
        bool disposed;

        public BurstWater(World w)
        {
            world = w;
            var g = w.Geo;
            var e = w.Env;
            var f = w.Flora;
            var d = w.Derived;
            count = g.N * g.N;
            cells = new CellsJob
            {
                Kind = View(g.WaterKind), Base = View(w.Sampler.Base), Tx = View(w.Sampler.Tx), Tz = View(w.Sampler.Tz),
                ChunkCloud = View(e.Weather.ChunkCloud), ChunkAccum = View(e.Weather.ChunkAccum), PFactor = View(d.PFactor),
                TMean = View(g.TMean), TAmp = View(g.TAmp), Capacity = View(d.Capacity), DrainHour = View(d.DrainHour), WaterDist = View(g.WaterDist),
                Greenness = View(e.Greenness), Moisture = View(e.Moisture), Snow = View(e.Snow), Runoff = View(e.Runoff),
                AccT = View(f.AccT), AccW = View(f.AccW), AccRunoff = View(f.AccRunoff), AccMinT = View(f.AccMinT), AccHours = View(f.AccHours),
                Chunks = e.Weather.Chunks,
            };
            toSea = new NativeArray<double>(1, Allocator.Persistent);
            route = new RouteJob
            {
                Order = View(g.UpstreamOrder), Kind = View(g.WaterKind), Receiver = View(g.Receiver), Runoff = View(e.Runoff), Discharge = View(e.Discharge),
                ToSea = toSea, ToM3s = g.CellSize * g.CellSize / 1000.0 / 3600,
            };
        }

        NativeArray<T> View<T>(T[] array) where T : unmanaged
        {
            var h = GCHandle.Alloc(array, GCHandleType.Pinned);
            handles.Add(h);
            var na = NativeArrayUnsafeUtility.ConvertExistingDataToNativeArray<T>((void*)h.AddrOfPinnedObject(), array.Length, Allocator.None);
#if ENABLE_UNITY_COLLECTIONS_CHECKS
            var s = AtomicSafetyHandle.Create();
            safety.Add(s);
            NativeArrayUnsafeUtility.SetAtomicSafetyHandle(ref na, s);
#endif
            return na;
        }

        public void Cells(World w, in WaterHourParams p, double[] sums)
        {
            if (!ReferenceEquals(sums, pinnedSums))
            {
                pinnedSums = sums;
                cells.Sums = View(sums);
            }
            cells.P = p;
            cells.Schedule(count, BatchSize).Complete();
        }

        public double Route(World w)
        {
            route.Run();
            return toSea[0];
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
#if ENABLE_UNITY_COLLECTIONS_CHECKS
            foreach (var s in safety) AtomicSafetyHandle.Release(s);
            safety.Clear();
#endif
            foreach (var h in handles) h.Free();
            handles.Clear();
            if (toSea.IsCreated) toSea.Dispose();
        }

        /// <summary>Проверка, что задания действительно скомпилированы Burst (в сборке и в редакторе).</summary>
        public static bool IsBurstActive()
        {
            var o = new NativeArray<int>(1, Allocator.TempJob);
            new BurstProbe { Out = o }.Run();
            bool burst = o[0] == 1;
            o.Dispose();
            return burst;
        }

        [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard, CompileSynchronously = true)]
        struct BurstProbe : IJob
        {
            public NativeArray<int> Out;

            public void Execute()
            {
                Out[0] = 1;
                Managed(ref Out);
            }

            [BurstDiscard]
            static void Managed(ref NativeArray<int> o) => o[0] = 2;
        }

        [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard, CompileSynchronously = true)]
        struct CellsJob : IJobParallelFor
        {
            [ReadOnly] public NativeArray<byte> Kind;
            [ReadOnly] public NativeArray<int> Base;
            [ReadOnly] public NativeArray<double> Tx, Tz;
            [ReadOnly] public NativeArray<float> ChunkCloud, ChunkAccum, PFactor, TMean, TAmp, Capacity, DrainHour, WaterDist, Greenness;
            public NativeArray<float> Moisture, Snow, Runoff, AccT, AccW, AccRunoff, AccMinT;
            public NativeArray<byte> AccHours;
            /// <summary>По ячейке: [осадки, испарение, местный сток, подпитка].</summary>
            [NativeDisableParallelForRestriction] public NativeArray<double> Sums;
            public int Chunks;
            public WaterHourParams P;

            public void Execute(int i)
            {
                int o = i * 4;
                byte kind = Kind[i];
                if (kind == WaterKind.Sea)
                {
                    Runoff[i] = 0;
                    Sums[o] = 0;
                    Sums[o + 1] = 0;
                    Sums[o + 2] = 0;
                    Sums[o + 3] = 0;
                    return;
                }
                int k = Base[i];
                int c = Chunks;
                double tx = Tx[i], tz = Tz[i];
                double cloud = ClimateModel.Bilinear(ChunkCloud[k], ChunkCloud[k + 1], ChunkCloud[k + c], ChunkCloud[k + c + 1], tx, tz);
                double precip = ClimateModel.Bilinear(ChunkAccum[k], ChunkAccum[k + 1], ChunkAccum[k + c], ChunkAccum[k + c + 1], tx, tz) * PFactor[i];
                Sums[o] = precip;
                if (kind != WaterKind.None)
                {
                    Runoff[i] = (float)precip;
                    Sums[o + 1] = 0;
                    Sums[o + 2] = precip;
                    Sums[o + 3] = 0;
                    return;
                }
                double t = ClimateModel.CellTemperature(TMean[i], TAmp[i], P.Seasonal, P.Diurnal, P.Anomaly, cloud);
                double cap = Capacity[i];
                var r = Water.LandCell(precip, cloud, t, Moisture[i], Snow[i], cap, DrainHour[i], WaterDist[i], Greenness[i], in P);
                Moisture[i] = (float)r.Moisture;
                Snow[i] = (float)r.Snow;
                Runoff[i] = (float)r.Out;
                Sums[o + 1] = r.Et;
                Sums[o + 2] = r.Out;
                Sums[o + 3] = r.Add;
                AccT[i] = (float)(AccT[i] + t);
                AccW[i] = (float)(AccW[i] + r.Moisture / cap);
                AccRunoff[i] = (float)(AccRunoff[i] + r.Out);
                if (t < AccMinT[i]) AccMinT[i] = (float)t;
                if (AccHours[i] < 255) AccHours[i] = (byte)(AccHours[i] + 1);
            }
        }

        /// <summary>Сток по дереву (последовательно, от истоков к устьям) — та же арифметика, что Water.Route.</summary>
        [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard, CompileSynchronously = true)]
        struct RouteJob : IJob
        {
            [ReadOnly] public NativeArray<int> Order, Receiver;
            [ReadOnly] public NativeArray<byte> Kind;
            [ReadOnly] public NativeArray<float> Runoff;
            public NativeArray<float> Discharge;
            public NativeArray<double> ToSea;
            public double ToM3s;

            public void Execute()
            {
                for (int i = 0; i < Discharge.Length; i++) Discharge[i] = 0;
                double toSea = 0;
                for (int k = 0; k < Order.Length; k++)
                {
                    int i = Order[k];
                    if (Kind[i] == WaterKind.Sea) continue;
                    double q = Discharge[i] + Runoff[i] * ToM3s;
                    Discharge[i] = (float)q;
                    int r = Receiver[i];
                    if (r < 0 || Kind[r] == WaterKind.Sea) toSea += q;
                    else Discharge[r] = (float)(Discharge[r] + q);
                }
                ToSea[0] = toSea;
            }
        }
    }
}
