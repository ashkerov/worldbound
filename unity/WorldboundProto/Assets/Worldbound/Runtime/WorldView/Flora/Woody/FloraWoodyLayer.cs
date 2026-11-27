// Слой древесных (деревья или кустарники): архетипы и их уровни детализации, экземпляры по чанкам,
// отсечение заданиями Burst и отрисовка через Graphics.RenderMeshIndirect — один вызов на непустой пакет
// (архетип × уровень) и один общий вызов на все импосторы слоя. GameObject на растение нет.
// FloraTreeRenderer и FloraShrubRenderer — два экземпляра этого слоя со своими профилями и дальностями.

using System;
using System.Collections.Generic;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.FloraView
{
    public sealed unsafe class FloraWoodyLayer : IDisposable
    {
        public readonly string Name;
        public readonly bool Shrubs;
        public readonly List<WoodyProfile> Profiles;
        public readonly List<WoodyArchetype> Archetypes = new();
        readonly Material material;
        readonly FloraImpostors impostors;
        readonly int chunkCount;
        public readonly int Buckets;

        // Экземпляры по чанкам.
        NativeArray<UnsafeList<WoodyInstance>> lists;
        public NativeArray<float3> ChunkMin, ChunkMax;
        public NativeArray<int> ChunkCount;
        public int Total { get; private set; }

        // Буферы отсечения (постоянные, без выделений в кадре).
        NativeArray<float4> planes;
        NativeList<int> visible;
        NativeArray<int> counts, offsets, bucketStart, bucketCount, total, changes;
        NativeArray<WoodyGpu> output;
        readonly Plane[] framePlanes = new Plane[6];

        GraphicsBuffer gpu, args;
        readonly GraphicsBuffer.IndirectDrawIndexedArgs[] argData;
        readonly MaterialPropertyBlock[] props;
        readonly Mesh[] bucketMesh;
        readonly int[] bucketLevel;
        static readonly int InstancesId = Shader.PropertyToID("_FloraInstances"), OffsetId = Shader.PropertyToID("_FloraInstanceOffset"),
            LevelId = Shader.PropertyToID("_FloraLodLevel"), RefHeightId = Shader.PropertyToID("_FloraRefHeight");

        // Статистика последнего кадра.
        public int Visible, DrawCalls, LodChanges;
        public readonly int[] PerLevel = new int[4];
        public long Triangles;
        public float CullMs;
        bool grow;

        public FloraWoodyLayer(string name, bool shrubs, List<WoodyProfile> profiles, Material material, FloraImpostors impostors, int chunkCount)
        {
            Name = name;
            Shrubs = shrubs;
            Profiles = profiles;
            this.material = material;
            this.impostors = impostors;
            this.chunkCount = chunkCount;
            foreach (var p in profiles)
                foreach (var a in p.Archetypes) { a.Index = Archetypes.Count; Archetypes.Add(a); }
            Buckets = Archetypes.Count * 3 + 1;
            lists = new NativeArray<UnsafeList<WoodyInstance>>(chunkCount, Allocator.Persistent);
            for (int k = 0; k < chunkCount; k++) lists[k] = new UnsafeList<WoodyInstance>(0, Allocator.Persistent);
            ChunkMin = new NativeArray<float3>(chunkCount, Allocator.Persistent);
            ChunkMax = new NativeArray<float3>(chunkCount, Allocator.Persistent);
            ChunkCount = new NativeArray<int>(chunkCount, Allocator.Persistent);
            planes = new NativeArray<float4>(6, Allocator.Persistent);
            visible = new NativeList<int>(chunkCount, Allocator.Persistent);
            counts = new NativeArray<int>(chunkCount * Buckets, Allocator.Persistent);
            offsets = new NativeArray<int>(chunkCount * Buckets, Allocator.Persistent);
            bucketStart = new NativeArray<int>(Buckets, Allocator.Persistent);
            bucketCount = new NativeArray<int>(Buckets, Allocator.Persistent);
            total = new NativeArray<int>(1, Allocator.Persistent);
            changes = new NativeArray<int>(chunkCount, Allocator.Persistent);
            Allocate(16384);
            args = new GraphicsBuffer(GraphicsBuffer.Target.IndirectArguments, Buckets, GraphicsBuffer.IndirectDrawIndexedArgs.size);
            argData = new GraphicsBuffer.IndirectDrawIndexedArgs[Buckets];
            props = new MaterialPropertyBlock[Buckets];
            bucketMesh = new Mesh[Buckets];
            bucketLevel = new int[Buckets];
            for (int b = 0; b < Buckets; b++)
            {
                props[b] = new MaterialPropertyBlock();
                bool imp = b == Buckets - 1;
                bucketMesh[b] = imp ? impostors?.Quad : Archetypes[b / 3].Lods[b % 3];
                bucketLevel[b] = imp ? 3 : b % 3;
                props[b].SetFloat(LevelId, bucketLevel[b]);
                props[b].SetFloat(RefHeightId, imp ? 10 : Archetypes[b / 3].RefHeight);
            }
        }

        public UnsafeList<WoodyInstance>* ListsPtr => (UnsafeList<WoodyInstance>*)NativeArrayUnsafeUtility.GetUnsafePtr(lists);

        void Allocate(int capacity)
        {
            if (output.IsCreated) output.Dispose();
            output = new NativeArray<WoodyGpu>(capacity, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
            gpu?.Release();
            gpu = new GraphicsBuffer(GraphicsBuffer.Target.Structured, capacity, UnsafeUtility.SizeOf<WoodyGpu>());
        }

        /// <summary>Пересчитать общее число экземпляров после изменения чанков.</summary>
        public void RefreshTotals()
        {
            int t = 0;
            for (int k = 0; k < chunkCount; k++) t += ChunkCount[k];
            Total = t;
        }

        public void Clear()
        {
            for (int k = 0; k < chunkCount; k++)
            {
                var l = lists[k];
                l.Clear();
                lists[k] = l;
                ChunkCount[k] = 0;
            }
            Total = 0;
        }

        /// <summary>Отсечение и выбор уровней (синхронно, задания на рабочих потоках), затем загрузка экземпляров в GPU.</summary>
        public void Cull(Camera cam, in LodParams lod, bool useImpostors)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            if (grow) { Allocate(Mathf.NextPowerOfTwo(output.Length + 1)); grow = false; }
            GeometryUtility.CalculateFrustumPlanes(cam, framePlanes);
            for (int i = 0; i < 6; i++) planes[i] = new float4(framePlanes[i].normal, framePlanes[i].distance);
            float3 camPos = cam.transform.position;
            var p = new CullParams { Lod = lod, Cam = camPos, Buckets = Buckets, Archetypes = Archetypes.Count, Impostors = useImpostors && impostors != null, Capacity = output.Length };
            visible.Clear();
            var h1 = new ChunkCullJob { Min = ChunkMin, Max = ChunkMax, Count = ChunkCount, Planes = planes, Cam = camPos, MaxDist = lod.Max * 1.7f * lod.Bias, Visible = visible.AsParallelWriter() }.Schedule(chunkCount, 16);
            var h2 = new CountJob { Visible = visible.AsDeferredJobArray(), Lists = ListsPtr, Planes = planes, P = p, Counts = counts }.Schedule(visible, 1, h1);
            var h3 = new PrefixJob { Visible = visible, Counts = counts, Offsets = offsets, BucketStart = bucketStart, BucketCount = bucketCount, Total = total, Buckets = Buckets }.Schedule(h2);
            var h4 = new WriteJob { Visible = visible.AsDeferredJobArray(), Lists = ListsPtr, Planes = planes, Offsets = offsets, P = p, Out = output, Changes = changes }.Schedule(visible, 1, h3);
            h4.Complete();
            int n = total[0];
            if (n > output.Length) { grow = true; n = output.Length; }
            if (n > 0) gpu.SetData(output, 0, 0, n);
            Visible = n;
            LodChanges = 0;
            for (int s = 0; s < visible.Length; s++) LodChanges += changes[s];
            Array.Clear(PerLevel, 0, 4);
            Triangles = 0;
            for (int b = 0; b < Buckets; b++)
            {
                int c = bucketCount[b];
                int start = bucketStart[b];
                if (start + c > n) c = Math.Max(0, n - start);
                PerLevel[bucketLevel[b]] += c;
                var mesh = bucketMesh[b];
                if (mesh == null) { argData[b] = default; continue; }
                Triangles += (long)c * mesh.GetIndexCount(0) / 3;
                argData[b] = new GraphicsBuffer.IndirectDrawIndexedArgs { indexCountPerInstance = mesh.GetIndexCount(0), instanceCount = (uint)c, startIndex = mesh.GetIndexStart(0), baseVertexIndex = mesh.GetBaseVertex(0), startInstance = 0 };
                props[b].SetBuffer(InstancesId, gpu);
                props[b].SetInt(OffsetId, start);
            }
            args.SetData(argData);
            CullMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        /// <summary>Вызовы отрисовки. shadowLevels[i] — отбрасывает ли тень уровень i.</summary>
        public void Draw(Camera cam, in LodParams lod, bool[] shadowLevels, int layer)
        {
            DrawCalls = 0;
            Vector3 c = cam.transform.position;
            for (int b = 0; b < Buckets; b++)
            {
                if (argData[b].instanceCount == 0) continue;
                int level = bucketLevel[b];
                bool imp = level == 3;
                var mat = imp ? impostors.Material : material;
                // Границы пакета — куб вокруг камеры по дальности уровня: тени считаются только в нужных каскадах.
                float reach = (level == 0 ? lod.T0 : level == 1 ? lod.T1 : level == 2 ? (lod.Levels > 3 ? lod.T2 : lod.Max) : lod.Max) * 1.8f * lod.Bias + 40;
                var rp = new RenderParams(mat)
                {
                    worldBounds = new Bounds(c, new Vector3(reach * 2, reach * 2, reach * 2)),
                    matProps = props[b],
                    shadowCastingMode = !imp && level < shadowLevels.Length && shadowLevels[level] ? ShadowCastingMode.On : ShadowCastingMode.Off,
                    receiveShadows = !imp,
                    layer = layer,
                };
                Graphics.RenderMeshIndirect(rp, bucketMesh[b], args, 1, b);
                DrawCalls++;
            }
        }

        public void Dispose()
        {
            for (int k = 0; k < chunkCount; k++) lists[k].Dispose();
            lists.Dispose();
            ChunkMin.Dispose(); ChunkMax.Dispose(); ChunkCount.Dispose();
            planes.Dispose(); visible.Dispose(); counts.Dispose(); offsets.Dispose(); bucketStart.Dispose(); bucketCount.Dispose(); total.Dispose(); changes.Dispose();
            if (output.IsCreated) output.Dispose();
            gpu?.Release();
            args?.Release();
            foreach (var a in Archetypes)
                if (a.Lods != null) foreach (var m in a.Lods) if (m) UnityEngine.Object.Destroy(m);
        }
    }

    /// <summary>Деревья: модели трёх уровней и импосторы вдали.</summary>
    public static class FloraTreeRenderer
    {
        public static LodParams Lod(FloraRenderSettings s, float bias) => new()
        {
            T0 = s.TreeLod0 * s.DrawDistance, T1 = s.TreeLod1 * s.DrawDistance, T2 = s.TreeLod2 * s.DrawDistance,
            Thin = s.TreeThin * s.DrawDistance, Max = s.TreeMax * s.DrawDistance, Band = s.FadeBand, Bias = bias, SizeRef = 14, Levels = 4, CrossFade = s.CrossFade,
        };

        public static bool[] Shadows(FloraRenderSettings s) => new[] { s.TreeShadowsLod0, s.TreeShadowsLod1, s.TreeShadowsLod2, false };
    }

    /// <summary>Кустарники: три уровня моделей, без импосторов (вдали кусты скрыты пологом и цветом рельефа).</summary>
    public static class FloraShrubRenderer
    {
        public static LodParams Lod(FloraRenderSettings s, float bias) => new()
        {
            T0 = s.ShrubLod0 * s.DrawDistance, T1 = s.ShrubLod1 * s.DrawDistance, T2 = s.ShrubMax * s.DrawDistance,
            Thin = s.ShrubMax * 0.6f * s.DrawDistance, Max = s.ShrubMax * s.DrawDistance, Band = s.FadeBand, Bias = bias, SizeRef = 3, Levels = 3, CrossFade = s.CrossFade,
        };

        public static bool[] Shadows(FloraRenderSettings s) => new[] { s.ShrubShadows, s.ShrubShadows, false, false };
    }
}
