// Травяной покров вокруг камеры по полю травяного яруса снимка (не декорация: нет травы — нет пучков).
// Задание Burst перебирает ячейки 8 м в радиусе травы (с отсечением по пирамиде видимости), для каждого вида
// ячейки берёт число пучков из его биомассы (г/м² → пучков на м², предел вида), места — хеш (ячейка, вид, номер):
// пучок k всегда стоит в одном месте, при росте биомассы добавляются новые, старые не переезжают.
// Куртины клевера и цветов — шум пятен по мировым координатам. Вдали остаётся доля пучков по номеру
// (k < n·keep(d)) — они становятся шире, а последний растворяется попиксельно: без мерцания и скачков.
// Уровни: 0 — листья геометрией, 1 — упрощённые пучки, 2 — перекрещенные карточки; переходы — растворением.
// При неподвижной камере и неизменном поле пересчёта нет.

using System;
using System.Collections.Generic;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.FloraView
{
    public struct HerbJobParams
    {
        public float GramsPerTuft, MaxPerM2, HeightLow, HeightHigh, Patch, PatchScale, Width;
        public int Visual;
        public int HasFar;
    }

    [BurstCompile]
    struct GrassJob : IJob
    {
        [ReadOnly] public NativeArray<byte> Herbs, HerbCell, Canopy;
        [ReadOnly] public NativeArray<HerbJobParams> Species;
        [ReadOnly] public NativeArray<float> Heights;
        [ReadOnly] public NativeArray<float4> Planes;
        public int HeightSamples;
        public float HeightSpacing;
        public int Cells, HerbCount;
        public float CellSize;
        public float3 Cam;
        public float Radius, Lod0, Lod1, Band, Density;
        public int Capacity;
        public NativeArray<int> BucketStart, BucketCount;
        public NativeArray<GrassGpu> Out;
        public NativeArray<int> Total;

        float Keep(float d)
        {
            if (d < Lod0) return 1;
            if (d < Lod1) return math.lerp(1f, 0.5f, (d - Lod0) / (Lod1 - Lod0));
            return math.lerp(0.5f, 0.22f, math.saturate((d - Lod1) / (Radius - Lod1)));
        }

        public void Execute()
        {
            int buckets = HerbCount * 3;
            for (int b = 0; b < buckets; b++) BucketCount[b] = 0;
            Pass(false);
            int run = 0;
            for (int b = 0; b < buckets; b++) { BucketStart[b] = run; run += BucketCount[b]; BucketCount[b] = 0; }
            Total[0] = run;
            Pass(true);
        }

        void Pass(bool write)
        {
            float cs = CellSize;
            int x0 = math.max(0, (int)math.floor((Cam.x - Radius) / cs)), x1 = math.min(Cells - 1, (int)math.floor((Cam.x + Radius) / cs));
            int z0 = math.max(0, (int)math.floor((Cam.z - Radius) / cs)), z1 = math.min(Cells - 1, (int)math.floor((Cam.z + Radius) / cs));
            for (int cz = z0; cz <= z1; cz++)
                for (int cx = x0; cx <= x1; cx++)
                {
                    float3 mn = new float3(cx * cs, 0, cz * cs), mx = mn + new float3(cs, 0, cs);
                    float gy = FloraJobMath.Height(Heights, HeightSamples, HeightSpacing, mn.x + cs * 0.5f, mn.z + cs * 0.5f);
                    mn.y = gy - 3; mx.y = gy + 3;
                    float dMin = math.length(math.max(0, math.abs(Cam - (mn + mx) * 0.5f) - (mx - mn) * 0.5f));
                    if (dMin > Radius) continue;
                    if (!FloraJobMath.BoxVisible(Planes, mn, mx)) continue;
                    int c = cz * Cells + cx;
                    float green = HerbCell[c * 4 + 2] / 255f, straw = HerbCell[c * 4 + 3] / 255f, canopy = Canopy[c * 4] / 255f;
                    float heightK = HerbCell[c * 4 + 1] > 0 ? math.clamp(HerbCell[c * 4 + 1] / 45f, 0.6f, 1.5f) : 1;
                    float keepMax = Keep(dMin);
                    for (int h = 0; h < HerbCount; h++)
                    {
                        byte v = Herbs[c * HerbCount + h];
                        if (v == 0) continue;
                        var sp = Species[h];
                        float f = v / 255f, grams = f * f * 1020f;
                        float perM2 = math.min(sp.MaxPerM2, grams / sp.GramsPerTuft) * Density;
                        float n = perM2 * cs * cs;
                        if (sp.Patch > 0) n *= 1 + sp.Patch; // куртины: кандидатов больше, часть отсеивается шумом
                        int kmax = math.min((int)math.ceil(n * keepMax), 900);
                        float hBase = math.lerp(sp.HeightLow, sp.HeightHigh, math.saturate(grams / 400f)) * heightK;
                        for (int k = 0; k < kmax; k++)
                        {
                            uint key = (uint)c * 16u + (uint)h;
                            float px = mn.x + FloraJobMath.F(key, (uint)k, 1) * cs, pz = mn.z + FloraJobMath.F(key, (uint)k, 2) * cs;
                            if (sp.Patch > 0)
                            {
                                float pn = FloraJobMath.Noise((uint)(77 + h), px / sp.PatchScale, pz / sp.PatchScale);
                                if (pn < sp.Patch * 0.75f + FloraJobMath.F(key, (uint)k, 3) * 0.25f) continue;
                            }
                            float py = FloraJobMath.Height(Heights, HeightSamples, HeightSpacing, px, pz);
                            float3 pos = new float3(px, py, pz);
                            float d = math.distance(Cam, pos + new float3(0, 0.3f, 0));
                            if (d > Radius) continue;
                            float keep = Keep(d);
                            float vis = math.saturate(n * keep - k);
                            if (vis <= 0) continue;
                            float fadeOut = math.saturate((d - Radius * 0.82f) / (Radius * 0.18f));
                            float remove = math.max(1 - vis, fadeOut);
                            // Уровень и переход.
                            int level = d < Lod0 ? 0 : d < Lod1 ? 1 : 2;
                            if (level == 2 && sp.HasFar == 0) continue;
                            int lB = -1;
                            float fA = remove, fB = 0;
                            float w0 = Lod0 * Band * 0.5f, w1 = Lod1 * Band * 0.5f;
                            if (math.abs(d - Lod0) < w0) { float t = (d - (Lod0 - w0)) / (2 * w0); level = 0; lB = 1; fA = math.max(t, remove); fB = -(t * (1 - remove)); }
                            else if (math.abs(d - Lod1) < w1 && sp.HasFar != 0) { float t = (d - (Lod1 - w1)) / (2 * w1); level = 1; lB = 2; fA = math.max(t, remove); fB = -(t * (1 - remove)); }
                            float rnd = FloraJobMath.F(key, (uint)k, 4);
                            float grow = math.min(1.7f, math.rsqrt(keep));
                            var g = new GrassGpu
                            {
                                PosYaw = new float4(pos, rnd * 6.2831853f),
                                Scale = new float4(sp.Width * (0.8f + 0.4f * FloraJobMath.F(key, (uint)k, 5)) * grow, hBase * (0.75f + 0.5f * FloraJobMath.F(key, (uint)k, 6)) * (1 - 0.6f * fadeOut), rnd, fA),
                                Extra = new float4(sp.Visual, green, straw, canopy),
                            };
                            Emit(write, h * 3 + level, g);
                            if (lB >= 0 && fB < -0.002f) { g.Scale.w = fB; Emit(write, h * 3 + lB, g); }
                        }
                    }
                }
        }

        void Emit(bool write, int bucket, in GrassGpu g)
        {
            int n = BucketCount[bucket];
            BucketCount[bucket] = n + 1;
            if (!write) return;
            int at = BucketStart[bucket] + n;
            if (at < Capacity) Out[at] = g;
        }
    }

    public sealed class FloraGrassRenderer : IDisposable
    {
        public readonly List<HerbProfile> Profiles;
        readonly Material material;
        NativeArray<HerbJobParams> species;
        NativeArray<GrassGpu> output;
        NativeArray<int> bucketStart, bucketCount, total;
        NativeArray<float4> planes;
        readonly Plane[] framePlanes = new Plane[6];
        GraphicsBuffer gpu, args;
        readonly GraphicsBuffer.IndirectDrawIndexedArgs[] argData;
        readonly MaterialPropertyBlock[] props;
        readonly int buckets;
        Vector3 lastPos;
        Quaternion lastRot;
        float lastRadius;
        long lastFieldVersion = -1;
        bool hasResult;
        static readonly int InstancesId = Shader.PropertyToID("_FloraInstances"), OffsetId = Shader.PropertyToID("_FloraInstanceOffset");

        public int Visible, DrawCalls;
        public long Triangles;
        public float GenMs;
        public bool Regenerated;

        public FloraGrassRenderer(List<HerbProfile> profiles, Material material)
        {
            Profiles = profiles;
            this.material = material;
            buckets = profiles.Count * 3;
            species = new NativeArray<HerbJobParams>(profiles.Count, Allocator.Persistent);
            for (int i = 0; i < profiles.Count; i++)
            {
                var p = profiles[i];
                species[i] = new HerbJobParams { GramsPerTuft = p.GramsPerTuft, MaxPerM2 = p.MaxPerM2, HeightLow = p.HeightLow, HeightHigh = p.HeightHigh, Patch = p.Patch, PatchScale = p.PatchScale, Width = p.Width, Visual = p.VisualIndex, HasFar = p.Lods[2] != null && p.Lods[2].GetIndexCount(0) > 0 ? 1 : 0 };
            }
            bucketStart = new NativeArray<int>(buckets, Allocator.Persistent);
            bucketCount = new NativeArray<int>(buckets, Allocator.Persistent);
            total = new NativeArray<int>(1, Allocator.Persistent);
            planes = new NativeArray<float4>(6, Allocator.Persistent);
            args = new GraphicsBuffer(GraphicsBuffer.Target.IndirectArguments, buckets, GraphicsBuffer.IndirectDrawIndexedArgs.size);
            argData = new GraphicsBuffer.IndirectDrawIndexedArgs[buckets];
            props = new MaterialPropertyBlock[buckets];
            for (int b = 0; b < buckets; b++) props[b] = new MaterialPropertyBlock();
            Allocate(16384);
        }

        void Allocate(int capacity)
        {
            if (output.IsCreated) output.Dispose();
            output = new NativeArray<GrassGpu>(capacity, Allocator.Persistent, NativeArrayOptions.UninitializedMemory);
            gpu?.Release();
            gpu = new GraphicsBuffer(GraphicsBuffer.Target.Structured, capacity, UnsafeUtility.SizeOf<GrassGpu>());
        }

        public void Update(Camera cam, FloraFieldStore fields, FloraTerrain terrain, FloraRenderSettings s)
        {
            Regenerated = false;
            var t = cam.transform;
            float radius = s.GrassRadius * Mathf.Max(0.5f, s.DrawDistance);
            bool same = hasResult && fields.Version == lastFieldVersion && Mathf.Approximately(radius, lastRadius) && (t.position - lastPos).sqrMagnitude < 0.04f && Quaternion.Angle(t.rotation, lastRot) < 0.7f;
            if (same) return;
            var t0 = Time.realtimeSinceStartupAsDouble;
            GeometryUtility.CalculateFrustumPlanes(cam, framePlanes);
            for (int i = 0; i < 6; i++) planes[i] = new float4(framePlanes[i].normal, framePlanes[i].distance - 1.5f * 0); // пучки малы — без запаса
            int capacity = Mathf.Min(s.GrassMaxInstances, Mathf.Max(output.Length, 16384));
            if (capacity > output.Length) Allocate(Mathf.NextPowerOfTwo(capacity));
            var job = new GrassJob
            {
                Herbs = fields.Herbs, HerbCell = fields.HerbCell, Canopy = fields.Canopy, Species = species,
                Heights = terrain.Heights, HeightSamples = terrain.Samples, HeightSpacing = terrain.Spacing,
                Planes = planes, Cells = fields.Grid.Cells, HerbCount = fields.HerbCount, CellSize = fields.Grid.CellSize,
                Cam = t.position, Radius = radius, Lod0 = s.GrassLod0 * Mathf.Max(0.5f, s.DrawDistance), Lod1 = s.GrassLod1 * Mathf.Max(0.5f, s.DrawDistance), Band = s.CrossFade ? 0.2f : 0, Density = s.GrassDensity,
                Capacity = Mathf.Min(output.Length, s.GrassMaxInstances), BucketStart = bucketStart, BucketCount = bucketCount, Out = output, Total = total,
            };
            job.Schedule().Complete();
            int n = Mathf.Min(total[0], job.Capacity);
            bool regrow = total[0] > output.Length && output.Length < s.GrassMaxInstances;
            if (regrow) { Allocate(Mathf.Min(s.GrassMaxInstances, Mathf.NextPowerOfTwo(total[0]))); n = 0; }
            else if (n > 0) gpu.SetData(output, 0, 0, n);
            Visible = n;
            Triangles = 0;
            for (int b = 0; b < buckets; b++)
            {
                var mesh = Profiles[b / 3].Lods[b % 3];
                int start = bucketStart[b], c = Mathf.Clamp(n - start, 0, bucketCount[b]);
                if (mesh == null || mesh.GetIndexCount(0) == 0) { argData[b] = default; continue; }
                Triangles += (long)c * mesh.GetIndexCount(0) / 3;
                argData[b] = new GraphicsBuffer.IndirectDrawIndexedArgs { indexCountPerInstance = mesh.GetIndexCount(0), instanceCount = (uint)c, startIndex = mesh.GetIndexStart(0), baseVertexIndex = mesh.GetBaseVertex(0) };
                props[b].SetBuffer(InstancesId, gpu);
                props[b].SetInt(OffsetId, start);
            }
            args.SetData(argData);
            lastPos = t.position; lastRot = t.rotation; lastRadius = radius; lastFieldVersion = fields.Version;
            hasResult = !regrow; // буфер вырос — пересчитать в следующем кадре
            Regenerated = true;
            GenMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        public void Draw(Camera cam, float radius, int layer)
        {
            DrawCalls = 0;
            for (int b = 0; b < buckets; b++)
            {
                if (argData[b].instanceCount == 0) continue;
                var rp = new RenderParams(material) { worldBounds = new Bounds(cam.transform.position, Vector3.one * (radius * 2 + 20)), matProps = props[b], shadowCastingMode = ShadowCastingMode.Off, receiveShadows = true, layer = layer };
                Graphics.RenderMeshIndirect(rp, Profiles[b / 3].Lods[b % 3], args, 1, b);
                DrawCalls++;
            }
        }

        public void Invalidate() => hasResult = false;

        public void Dispose()
        {
            species.Dispose(); bucketStart.Dispose(); bucketCount.Dispose(); total.Dispose(); planes.Dispose();
            if (output.IsCreated) output.Dispose();
            gpu?.Release(); args?.Release();
            foreach (var p in Profiles) foreach (var m in p.Lods) if (m) UnityEngine.Object.Destroy(m);
        }
    }
}
