// Отсечение и выбор уровней древесных — задания Burst на рабочих потоках, без выделений памяти в кадре:
//   1) ChunkCull — чанки: пустота, дальность, пирамида видимости (по AABB чанка с запасом на кроны);
//   2) Count     — по видимым чанкам параллельно: уровни растений, число записей на (чанк × пакет);
//   3) Prefix    — смещения пакетов в общем буфере экземпляров;
//   4) Write     — по видимым чанкам параллельно: запись экземпляров GPU на свои места, счёт смен уровней.
// Пакет = (архетип × уровень 0–2) или общий пакет импосторов. Счёт и запись вызывают одну и ту же
// чистую функцию Classify — результат совпадает побитно, гонок нет (каждый чанк пишет в свой диапазон).

using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;

namespace Worldbound.FloraView
{
    public struct CullParams
    {
        public LodParams Lod;
        public float3 Cam;
        public int Buckets, Archetypes;
        public bool Impostors;
        public int Capacity;
    }

    public static class FloraCulling
    {
        public static int Classify(in WoodyInstance w, in CullParams p, in NativeArray<float4> planes, out int b0, out float f0, out int b1, out float f1, out float grow)
        {
            b0 = b1 = -1; f0 = f1 = 0; grow = 1;
            float3 c = w.Pos + new float3(0, w.CentreY, 0);
            if (!FloraJobMath.SphereVisible(planes, c, w.Radius)) return 0;
            float d = math.distance(p.Cam, c);
            float de = d * w.LodScale / p.Lod.Bias;
            int n = FloraLOD.Select(p.Lod, de, w.Seed, out int l0, out f0, out int l1, out f1, out grow);
            if (n == 0) return 0;
            b0 = Bucket(w, l0, p);
            if (n == 2) b1 = Bucket(w, l1, p);
            if (b0 < 0) { b0 = b1; f0 = f1; b1 = -1; n--; }
            if (n == 2 && b1 < 0) n = 1;
            return n;
        }

        static int Bucket(in WoodyInstance w, int level, in CullParams p)
        {
            if (level < 3) return w.Archetype * 3 + level;
            return p.Impostors && w.ImpostorRow >= 0 ? p.Archetypes * 3 : -1;
        }

        public static WoodyGpu Gpu(in WoodyInstance w, float fade, float grow)
        {
            return new WoodyGpu
            {
                PosYaw = new float4(w.Pos, w.Yaw),
                Scale = new float4(w.ScaleXZ * grow, w.ScaleY * math.sqrt(grow), w.Seed, w.Leaf),
                Extra = new float4(w.Health, fade, w.Visual, w.ImpostorRow),
            };
        }
    }

    [BurstCompile]
    struct ChunkCullJob : IJobParallelFor
    {
        [ReadOnly] public NativeArray<float3> Min, Max;
        [ReadOnly] public NativeArray<int> Count;
        [ReadOnly] public NativeArray<float4> Planes;
        public float3 Cam;
        public float MaxDist;
        public NativeList<int>.ParallelWriter Visible;

        public void Execute(int c)
        {
            if (Count[c] == 0) return;
            float3 mn = Min[c], mx = Max[c];
            float dist = math.length(math.max(0, math.abs(Cam - (mn + mx) * 0.5f) - (mx - mn) * 0.5f));
            if (dist > MaxDist) return;
            if (!FloraJobMath.BoxVisible(Planes, mn, mx)) return;
            Visible.AddNoResize(c);
        }
    }

    [BurstCompile]
    unsafe struct CountJob : IJobParallelForDefer
    {
        [ReadOnly] public NativeArray<int> Visible;
        [ReadOnly, NativeDisableUnsafePtrRestriction] public UnsafeList<WoodyInstance>* Lists;
        [ReadOnly] public NativeArray<float4> Planes;
        public CullParams P;
        [NativeDisableParallelForRestriction] public NativeArray<int> Counts; // [слот × пакет]

        public void Execute(int slot)
        {
            int k = Visible[slot];
            var list = Lists[k];
            int baseIdx = slot * P.Buckets;
            for (int b = 0; b < P.Buckets; b++) Counts[baseIdx + b] = 0;
            for (int i = 0; i < list.Length; i++)
            {
                int n = FloraCulling.Classify(list.Ptr[i], P, Planes, out int b0, out _, out int b1, out _, out _);
                if (n >= 1) Counts[baseIdx + b0]++;
                if (n == 2) Counts[baseIdx + b1]++;
            }
        }
    }

    [BurstCompile]
    struct PrefixJob : IJob
    {
        [ReadOnly] public NativeList<int> Visible;
        [ReadOnly] public NativeArray<int> Counts;
        public NativeArray<int> Offsets, BucketStart, BucketCount;
        public NativeArray<int> Total;
        public int Buckets;

        public void Execute()
        {
            int slots = Visible.Length, run = 0;
            for (int b = 0; b < Buckets; b++)
            {
                BucketStart[b] = run;
                for (int s = 0; s < slots; s++)
                {
                    Offsets[s * Buckets + b] = run;
                    run += Counts[s * Buckets + b];
                }
                BucketCount[b] = run - BucketStart[b];
            }
            Total[0] = run;
        }
    }

    [BurstCompile]
    unsafe struct WriteJob : IJobParallelForDefer
    {
        [ReadOnly] public NativeArray<int> Visible;
        [NativeDisableUnsafePtrRestriction] public UnsafeList<WoodyInstance>* Lists;
        [ReadOnly] public NativeArray<float4> Planes;
        [ReadOnly] public NativeArray<int> Offsets;
        public CullParams P;
        [NativeDisableParallelForRestriction] public NativeArray<WoodyGpu> Out;
        [NativeDisableParallelForRestriction] public NativeArray<int> Changes; // [слот]

        public void Execute(int slot)
        {
            int k = Visible[slot];
            var list = Lists[k];
            int baseIdx = slot * P.Buckets;
            int changes = 0;
            // Локальные курсоры пакетов этого чанка (смещения из Prefix).
            var cursor = new NativeArray<int>(P.Buckets, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            for (int b = 0; b < P.Buckets; b++) cursor[b] = Offsets[baseIdx + b];
            for (int i = 0; i < list.Length; i++)
            {
                ref var w = ref list.Ptr[i];
                int n = FloraCulling.Classify(w, P, Planes, out int b0, out float f0, out int b1, out float f1, out float grow);
                int lod = 255;
                if (n >= 1)
                {
                    int at = cursor[b0]++;
                    if (at < P.Capacity) Out[at] = FloraCulling.Gpu(w, f0, grow);
                    lod = b0 == P.Archetypes * 3 ? 3 : b0 % 3;
                }
                if (n == 2)
                {
                    int at = cursor[b1]++;
                    if (at < P.Capacity) Out[at] = FloraCulling.Gpu(w, f1, grow);
                }
                if (lod != w.LastLod && lod != 255 && w.LastLod != 255) changes++;
                w.LastLod = lod;
            }
            Changes[slot] = changes;
            cursor.Dispose();
        }
    }
}
