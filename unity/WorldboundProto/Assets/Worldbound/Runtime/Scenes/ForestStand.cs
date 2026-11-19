// Prototype B: нагрузочный стенд массовой растительности (10–300 тыс. деревьев) на местности 2 × 2 км.
// Деревья хранятся по чанкам 64 м. Каждый кадр задание Burst: отсечение чанков пирамидой видимости,
// выбор уровня детализации по расстоянию (LOD0 / LOD1 / LOD2), прореживание вдали по рангу с растяжением
// оставшихся (покрытие кронами сохраняется), запись экземпляров в пакеты (вид × уровень). Рисует InstanceSet:
// один вызов RenderMeshIndirect на пакет — 15 вызовов на все деревья мира.

using System;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;
using Worldbound.Gfx;

namespace Worldbound.Scenes
{
    public sealed class ForestStand : IDisposable
    {
        public const float Size = 2048;
        const float ChunkM = 64;
        const int Chunks = (int)(Size / ChunkM);
        public static readonly TreeKind[] Species = { TreeKind.Birch, TreeKind.Pine, TreeKind.Spruce, TreeKind.Oak, TreeKind.Shrub };
        const int Lods = 3;

        public struct Ranges { public float R0, R1, RThin, RMax; }
        public Ranges Lod = new() { R0 = 35, R1 = 140, RThin = 420, RMax = 1400 };

        NativeArray<Inst> trees;          // по чанкам, внутри чанка — по виду
        NativeArray<int> chunkStart;      // Chunks²+1
        NativeArray<float2> chunkY;       // мин/макс высота чанка
        NativeArray<byte> species;
        NativeArray<Inst> outBuf;         // пакеты: [вид][уровень] — сегменты длиной speciesCount
        NativeArray<int> outStart, outCount;
        readonly InstanceSet[] sets;
        public readonly GameObject Ground;
        public int TreeCount { get; }
        public float CullMs { get; private set; }

        public static float Height(float x, float z)
        {
            float h = Mathf.PerlinNoise(x * 0.0018f + 10, z * 0.0018f + 3) * 60 + Mathf.PerlinNoise(x * 0.008f, z * 0.008f + 7) * 12 + Mathf.PerlinNoise(x * 0.03f + 5, z * 0.03f) * 2.5f;
            return h;
        }

        /// <summary>Густота леса 0..1: массивы и поляны (шум), как сложившийся лес Wildlands.</summary>
        static float Density(float x, float z) => Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.3f, 0.6f, Mathf.PerlinNoise(x * 0.004f + 30, z * 0.004f + 11)));

        public ForestStand(int count, Material foliage, Material ground, Transform parent)
        {
            TreeCount = count;
            Ground = BuildGround(ground, parent);
            // Расстановка: случайные точки, принятые по густоте; вид — по высоте местности и шуму (ель выше, береза в низинах).
            var list = new Inst[count];
            var sp = new byte[count];
            int made = 0, tries = 0;
            while (made < count && tries < count * 20)
            {
                tries++;
                float x = R.Rand(17, tries, 1) * Size, z = R.Rand(17, tries, 2) * Size;
                if (R.Rand(17, tries, 3) > 0.15f + 0.85f * Density(x, z)) continue;
                float y = Height(x, z);
                float pick = Mathf.PerlinNoise(x * 0.01f + 50, z * 0.01f) + (y - 30) / 70f + R.Rand(17, tries, 4) * 0.35f;
                int s = R.Rand(17, tries, 5) < 0.12f ? 4 : pick > 1.05f ? 2 : pick > 0.8f ? 1 : pick > 0.55f ? 3 : 0;
                float age = 0.45f + R.Rand(17, tries, 6) * 0.65f;
                list[made] = new Inst { PosYaw = new float4(x, y - 0.15f, z, R.Rand(17, tries, 7) * 6.283f), ScaleSeed = new float4(age * (0.9f + R.Rand(17, tries, 8) * 0.2f), age, R.Rand(17, tries, 9), 1) };
                sp[made] = (byte)s;
                made++;
            }
            TreeCount = made;
            // Сортировка по чанкам (подсчётом), внутри — по виду.
            var counts = new int[Chunks * Chunks + 1];
            var key = new int[made];
            for (int i = 0; i < made; i++)
            {
                int cx = Mathf.Min(Chunks - 1, (int)(list[i].PosYaw.x / ChunkM)), cz = Mathf.Min(Chunks - 1, (int)(list[i].PosYaw.z / ChunkM));
                key[i] = (cz * Chunks + cx) * 8 + sp[i];
            }
            var order = new int[made];
            for (int i = 0; i < made; i++) order[i] = i;
            Array.Sort(key, order);
            trees = new NativeArray<Inst>(made, Allocator.Persistent);
            species = new NativeArray<byte>(made, Allocator.Persistent);
            chunkStart = new NativeArray<int>(Chunks * Chunks + 1, Allocator.Persistent);
            chunkY = new NativeArray<float2>(Chunks * Chunks, Allocator.Persistent);
            var spCount = new int[Species.Length];
            for (int c = 0; c < chunkY.Length; c++) chunkY[c] = new float2(1e9f, -1e9f);
            for (int k = 0; k < made; k++)
            {
                int i = order[k];
                trees[k] = list[i];
                species[k] = sp[i];
                spCount[sp[i]]++;
                int ch = key[k] / 8;
                counts[ch + 1]++;
                var y = chunkY[ch];
                chunkY[ch] = new float2(Mathf.Min(y.x, list[i].PosYaw.y), Mathf.Max(y.y, list[i].PosYaw.y + 22 * list[i].ScaleSeed.y));
            }
            for (int c = 0; c < Chunks * Chunks; c++) counts[c + 1] += counts[c];
            chunkStart.CopyFrom(counts);
            outStart = new NativeArray<int>(Species.Length * Lods, Allocator.Persistent);
            outCount = new NativeArray<int>(Species.Length * Lods, Allocator.Persistent);
            int at = 0;
            for (int s = 0; s < Species.Length; s++)
                for (int l = 0; l < Lods; l++) { outStart[s * Lods + l] = at; at += Mathf.Max(1, spCount[s]); }
            outBuf = new NativeArray<Inst>(at, Allocator.Persistent);
            sets = new InstanceSet[Species.Length * Lods];
            for (int s = 0; s < Species.Length; s++)
                for (int l = 0; l < Lods; l++)
                    sets[s * Lods + l] = new InstanceSet(Models.Tree(Species[s], 1000 + s * 17, l), foliage, 1024, l == 0);
        }

        static GameObject BuildGround(Material m, Transform parent)
        {
            const int N = 257;
            var go = new GameObject("forest-ground");
            go.transform.SetParent(parent, false);
            var v = new Vector3[N * N];
            var c = new Color[N * N];
            for (int z = 0; z < N; z++)
                for (int x = 0; x < N; x++)
                {
                    float px = x * Size / (N - 1), pz = z * Size / (N - 1);
                    v[z * N + x] = new Vector3(px, Height(px, pz), pz);
                    float d = Density(px, pz);
                    c[z * N + x] = Color.Lerp(new Color(0.36f, 0.55f, 0.22f), new Color(0.24f, 0.34f, 0.16f), d) * (0.92f + Mathf.PerlinNoise(px * 0.05f, pz * 0.05f) * 0.16f);
                }
            var t = new int[(N - 1) * (N - 1) * 6];
            int k = 0;
            for (int z = 0; z < N - 1; z++)
                for (int x = 0; x < N - 1; x++)
                {
                    int i = z * N + x;
                    t[k++] = i; t[k++] = i + N; t[k++] = i + 1; t[k++] = i + 1; t[k++] = i + N; t[k++] = i + N + 1;
                }
            var mesh = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32, vertices = v, colors = c, triangles = t, name = "forest-ground" };
            mesh.RecalculateNormals();
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = m;
            return go;
        }

        [BurstCompile]
        struct CullJob : IJob
        {
            [ReadOnly] public NativeArray<Inst> Trees;
            [ReadOnly] public NativeArray<byte> Species;
            [ReadOnly] public NativeArray<int> ChunkStart;
            [ReadOnly] public NativeArray<float2> ChunkY;
            [ReadOnly] public NativeArray<float4> Planes;
            [ReadOnly] public NativeArray<int> OutStart;
            public NativeArray<int> OutCount;
            public NativeArray<Inst> Out;
            public float3 Cam;
            public float R0, R1, RThin, RMax;

            public void Execute()
            {
                for (int i = 0; i < OutCount.Length; i++) OutCount[i] = 0;
                for (int cz = 0; cz < Chunks; cz++)
                    for (int cx = 0; cx < Chunks; cx++)
                    {
                        int c = cz * Chunks + cx;
                        int a = ChunkStart[c], b = ChunkStart[c + 1];
                        if (a == b) continue;
                        float2 y = ChunkY[c];
                        float3 mn = new float3(cx * ChunkM, y.x, cz * ChunkM), mx = new float3((cx + 1) * ChunkM, y.y, (cz + 1) * ChunkM);
                        float3 centre = (mn + mx) * 0.5f, ext = (mx - mn) * 0.5f;
                        float dMin = math.length(math.max(0, math.abs(Cam - centre) - ext));
                        if (dMin > RMax) continue;
                        bool visible = true;
                        for (int p = 0; p < 6 && visible; p++)
                        {
                            float4 pl = Planes[p];
                            float r = math.dot(ext, math.abs(pl.xyz));
                            if (math.dot(pl.xyz, centre) + pl.w < -r) visible = false;
                        }
                        if (!visible) continue;
                        for (int i = a; i < b; i++)
                        {
                            Inst t = Trees[i];
                            float d = math.distance(Cam, t.PosYaw.xyz + new float3(0, 6 * t.ScaleSeed.y, 0));
                            if (d > RMax) continue;
                            int lod = d < R0 ? 0 : d < R1 ? 1 : 2;
                            if (d > RThin)
                            {
                                float keep = (RThin / d) * (RThin / d);
                                if (t.ScaleSeed.z > keep) continue;
                                float grow = math.min(2f, math.rsqrt(keep));
                                t.ScaleSeed.x *= grow;
                                t.ScaleSeed.y *= math.sqrt(grow);
                            }
                            int bucket = Species[i] * Lods + lod;
                            int n = OutCount[bucket];
                            Out[OutStart[bucket] + n] = t;
                            OutCount[bucket] = n + 1;
                        }
                    }
            }
        }

        readonly Plane[] planes = new Plane[6];

        public void Update(Camera cam)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            GeometryUtility.CalculateFrustumPlanes(cam, planes);
            using var pl = new NativeArray<float4>(6, Allocator.TempJob);
            var tmp = pl;
            for (int i = 0; i < 6; i++) tmp[i] = new float4(planes[i].normal, planes[i].distance);
            new CullJob { Trees = trees, Species = species, ChunkStart = chunkStart, ChunkY = chunkY, Planes = pl, OutStart = outStart, OutCount = outCount, Out = outBuf, Cam = cam.transform.position, R0 = Lod.R0, R1 = Lod.R1, RThin = Lod.RThin, RMax = Lod.RMax }.Schedule().Complete();
            for (int k = 0; k < sets.Length; k++) sets[k].Set(outBuf, outStart[k], outCount[k]);
            CullMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
            var bounds = new Bounds(new Vector3(Size / 2, 50, Size / 2), new Vector3(Size * 2, 400, Size * 2));
            foreach (var s in sets) s.Draw(bounds);
        }

        public (int lod0, int lod1, int lod2, long triangles, int drawCalls) Stats()
        {
            int a = 0, b = 0, c = 0, calls = 0;
            long tris = 0;
            for (int k = 0; k < sets.Length; k++)
            {
                int n = sets[k].Count;
                if (n > 0) calls++;
                tris += sets[k].Triangles;
                if (k % Lods == 0) a += n; else if (k % Lods == 1) b += n; else c += n;
            }
            return (a, b, c, tris, calls);
        }

        public Vector3 DensestPoint()
        {
            int best = 0, bestN = -1;
            for (int c = 0; c < Chunks * Chunks; c++) { int n = chunkStart[c + 1] - chunkStart[c]; if (n > bestN) { bestN = n; best = c; } }
            float x = (best % Chunks + 0.5f) * ChunkM, z = (best / Chunks + 0.5f) * ChunkM;
            return new Vector3(x, Height(x, z), z);
        }

        public void Dispose()
        {
            foreach (var s in sets) s.Dispose();
            trees.Dispose(); species.Dispose(); chunkStart.Dispose(); chunkY.Dispose(); outBuf.Dispose(); outStart.Dispose(); outCount.Dispose();
            if (Ground) UnityEngine.Object.Destroy(Ground);
        }
    }
}
