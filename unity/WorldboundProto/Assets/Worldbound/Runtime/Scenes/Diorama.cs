// Prototype A: визуальная сцена WORLDBOUND 150 × 150 м (по мотивам прототипа 1A): холмы, скальное плато,
// река с прудом, лес из нескольких видов, кустарники, трава и цветы, камыш, камни, бревно, дом, животные.
// Всё процедурное, детерминированное; растительность — InstanceSet (как в стенде B).

using System.Collections.Generic;
using Unity.Mathematics;
using UnityEngine;
using Worldbound.Gfx;

namespace Worldbound.Scenes
{
    public sealed class Diorama : System.IDisposable
    {
        public const float Half = 75;
        public const float WaterY = 0.35f;
        public static readonly Vector3 House = new(18, 0, 14);
        readonly List<InstanceSet> sets = new();
        readonly List<GameObject> objects = new();
        public int Plants { get; private set; }
        public readonly Transform Root;

        // ───────── рельеф ─────────

        static float RiverX(float z) => -18 + Mathf.Sin(z * 0.045f) * 12 + Mathf.Sin(z * 0.11f + 1) * 3;
        static readonly Vector2 Pond = new(-30, -42);
        const float PondR = 13;

        /// <summary>Расстояние до воды (река или пруд) по горизонтали и полуширина реки.</summary>
        public static float WaterDist(float x, float z)
        {
            float river = Mathf.Abs(x - RiverX(z)) - (3.2f + Mathf.Sin(z * 0.07f) * 0.8f);
            if (z < Pond.y + 4) river = 1e3f; // река впадает в пруд
            float pond = Vector2.Distance(new Vector2(x, z), Pond) - PondR;
            return Mathf.Min(river, pond);
        }

        public static float Plateau(float x, float z) => Mathf.Max(x - 32 + Mathf.Sin(z * 0.15f) * 3, z - 30 + Mathf.Sin(x * 0.13f) * 3) > 0 && x > 18 && z > 12 ? 1 : 0;

        public static float Height(float x, float z)
        {
            float h = 1.6f + Mathf.PerlinNoise(x * 0.025f + 3, z * 0.025f + 9) * 3.2f + Mathf.PerlinNoise(x * 0.09f, z * 0.09f) * 0.6f;
            // Плато на северо-востоке со скальным обрывом.
            float edge = Mathf.Min(x - 30 + Mathf.Sin(z * 0.15f) * 3, z - 28 + Mathf.Sin(x * 0.13f) * 3);
            h += Mathf.SmoothStep(0, 1, Mathf.InverseLerp(-2.5f, 2.5f, edge)) * 7.5f;
            // Русло и пруд.
            float wd = WaterDist(x, z);
            if (wd < 4) h = Mathf.Lerp(h, -0.9f, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(4, -1.2f, wd)));
            // Площадка под дом.
            float hd = Vector2.Distance(new Vector2(x, z), new Vector2(House.x, House.z));
            if (hd < 9) h = Mathf.Lerp(h, 3.1f, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(9, 6, hd)));
            return h;
        }

        static float Slope(float x, float z) => new Vector2(Height(x + 0.5f, z) - Height(x - 0.5f, z), Height(x, z + 0.5f) - Height(x, z - 0.5f)).magnitude;
        static float Trail(float x, float z) => Mathf.Abs(z - (House.z - 2 + (x - House.x) * 0.25f + Mathf.Sin(x * 0.08f) * 4)) + (x > House.x ? 1e3f : 0);

        public Diorama(Material foliage, Material ground, Material water, Transform parent)
        {
            Root = new GameObject("diorama").transform;
            Root.SetParent(parent, false);
            BuildTerrain(ground);
            BuildWater(water);
            BuildPlants(foliage);
            BuildRocks(ground);
            BuildHouse(ground);
            BuildSurroundings(ground, foliage);
        }

        /// <summary>За краем участка — продолжение холмов и дальний лес (LOD2), чтобы горизонт не был пустым.</summary>
        void BuildSurroundings(Material g, Material f)
        {
            const int N = 97;
            const float S = 900;
            var v = new Vector3[N * N];
            var c = new Color[N * N];
            for (int z = 0; z < N; z++)
                for (int x = 0; x < N; x++)
                {
                    float px = -S + x * 2 * S / (N - 1), pz = -S + z * 2 * S / (N - 1);
                    float inside = Mathf.Max(Mathf.Abs(px), Mathf.Abs(pz));
                    float h = 1.2f + Mathf.PerlinNoise(px * 0.006f + 2, pz * 0.006f) * 22 * Mathf.InverseLerp(80, 300, inside) + Mathf.PerlinNoise(px * 0.025f + 3, pz * 0.025f + 9) * 3.2f;
                    v[z * N + x] = new Vector3(px, inside < Half + 4 ? -3 : h, pz);
                    c[z * N + x] = Color.Lerp(new Color(0.36f, 0.5f, 0.2f), new Color(0.25f, 0.36f, 0.17f), Mathf.PerlinNoise(px * 0.01f, pz * 0.01f));
                }
            Mesh(g, v, c, N, "surroundings", false);
            float H(float x, float z) => 1.2f + Mathf.PerlinNoise(x * 0.006f + 2, z * 0.006f) * 22 * Mathf.InverseLerp(80, 300, Mathf.Max(Mathf.Abs(x), Mathf.Abs(z))) + Mathf.PerlinNoise(x * 0.025f + 3, z * 0.025f + 9) * 3.2f;
            var kinds = new[] { TreeKind.Spruce, TreeKind.Pine, TreeKind.Oak, TreeKind.Birch };
            for (int k = 0; k < kinds.Length; k++)
            {
                var data = new List<Inst>();
                for (int i = 0; i < 9000 && data.Count < 1800; i++)
                {
                    float x = (R.Rand(900 + k, i, 1) * 2 - 1) * 800, z = (R.Rand(900 + k, i, 2) * 2 - 1) * 800;
                    if (Mathf.Max(Mathf.Abs(x), Mathf.Abs(z)) < Half + 12 || Mathf.PerlinNoise(x * 0.008f + k * 7, z * 0.008f) < 0.5f) continue;
                    float s = 0.7f + R.Rand(910 + k, i) * 0.5f;
                    data.Add(new Inst { PosYaw = new float4(x, H(x, z) - 0.3f, z, R.Rand(920 + k, i) * 6.28f), ScaleSeed = new float4(s, s, R.Rand(930 + k, i), 1) });
                }
                var set = new InstanceSet(Models.Tree(kinds[k], 950 + k, 2), f, data.Count, false);
                set.Set(data.ToArray());
                sets.Add(set);
            }
        }

        void BuildTerrain(Material m)
        {
            const int N = 241; // шаг 0,625 м
            var v = new Vector3[N * N];
            var c = new Color[N * N];
            for (int z = 0; z < N; z++)
                for (int x = 0; x < N; x++)
                {
                    float px = -Half + x * 150f / (N - 1), pz = -Half + z * 150f / (N - 1);
                    float h = Height(px, pz);
                    v[z * N + x] = new Vector3(px, h, pz);
                    float lush = Mathf.PerlinNoise(px * 0.06f + 4, pz * 0.06f);
                    var grass = Color.Lerp(new Color(0.42f, 0.56f, 0.2f), new Color(0.28f, 0.46f, 0.17f), lush);
                    float wd = WaterDist(px, pz);
                    var col = grass;
                    if (wd < 1.2f) col = Color.Lerp(new Color(0.46f, 0.4f, 0.28f), col, Mathf.InverseLerp(0.1f, 1.2f, wd)); // влажный берег
                    if (wd < 0.1f) col = new Color(0.27f, 0.25f, 0.18f); // дно
                    float slope = Slope(px, pz);
                    col = Color.Lerp(col, new Color(0.43f, 0.41f, 0.37f) * (0.85f + Mathf.PerlinNoise(px * 0.5f, pz * 0.3f) * 0.3f), Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.55f, 1.1f, slope)));
                    float tr = Trail(px, pz);
                    if (tr < 1.4f && wd > 1) col = Color.Lerp(new Color(0.55f, 0.45f, 0.32f), col, Mathf.InverseLerp(0.6f, 1.4f, tr));
                    c[z * N + x] = col;
                }
            Mesh(m, v, c, N, "terrain", true);
        }

        GameObject Mesh(Material m, Vector3[] v, Color[] c, int n, string name, bool shadow)
        {
            var t = new List<int>();
            for (int z = 0; z < n - 1; z++)
                for (int x = 0; x < n - 1; x++)
                {
                    int i = z * n + x;
                    t.AddRange(new[] { i, i + n, i + 1, i + 1, i + n, i + n + 1 });
                }
            var mesh = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32, vertices = v, colors = c, name = name };
            mesh.SetTriangles(t, 0);
            mesh.RecalculateNormals();
            return Obj(name, mesh, m, Matrix4x4.identity, shadow);
        }

        GameObject Obj(string name, Mesh mesh, Material m, Matrix4x4 mat, bool shadow)
        {
            var go = new GameObject(name);
            go.transform.SetParent(Root, false);
            go.transform.SetPositionAndRotation(mat.GetColumn(3), mat.rotation);
            go.transform.localScale = mat.lossyScale;
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = shadow ? UnityEngine.Rendering.ShadowCastingMode.On : UnityEngine.Rendering.ShadowCastingMode.Off;
            objects.Add(go);
            return go;
        }

        void BuildWater(Material m)
        {
            const int N = 121;
            var v = new Vector3[N * N];
            var c = new Color[N * N];
            for (int z = 0; z < N; z++)
                for (int x = 0; x < N; x++)
                {
                    float px = -Half + x * 150f / (N - 1), pz = -Half + z * 150f / (N - 1);
                    float depth = WaterY - Height(px, pz);
                    v[z * N + x] = new Vector3(px, depth > -0.3f ? WaterY : -5, pz);
                    c[z * N + x] = new Color(Mathf.Clamp01(depth / 1.2f), 0, 0, 1);
                }
            var go = Mesh(m, v, c, N, "water", false);
            go.GetComponent<MeshRenderer>().receiveShadows = false;
        }

        struct Spot { public float X, Z, Scale; }

        static List<Spot> Scatter(int seed, int attempts, int limit, System.Func<float, float, int, float> accept, float gap = 0, List<Spot> taken = null)
        {
            var outL = new List<Spot>();
            for (int i = 0; i < attempts && outL.Count < limit; i++)
            {
                float x = (R.Rand(seed, i, 1) * 2 - 1) * (Half - 1.5f), z = (R.Rand(seed, i, 2) * 2 - 1) * (Half - 1.5f);
                float s = accept(x, z, i);
                if (s <= 0) continue;
                if (gap > 0)
                {
                    bool near = false;
                    foreach (var t in outL) if ((t.X - x) * (t.X - x) + (t.Z - z) * (t.Z - z) < gap * gap) { near = true; break; }
                    if (!near && taken != null) foreach (var t in taken) if ((t.X - x) * (t.X - x) + (t.Z - z) * (t.Z - z) < gap * gap) { near = true; break; }
                    if (near) continue;
                }
                outL.Add(new Spot { X = x, Z = z, Scale = s });
            }
            return outL;
        }

        void Plant(Mesh mesh, Material mat, List<Spot> spots, int seed, bool shadows, float heightScale = 1, float sink = 0.15f)
        {
            if (spots.Count == 0) return;
            var data = new Inst[spots.Count];
            for (int i = 0; i < spots.Count; i++)
            {
                var s = spots[i];
                float sq = 0.9f + R.Rand(seed, i, 3) * 0.2f;
                data[i] = new Inst { PosYaw = new float4(s.X, Height(s.X, s.Z) - sink, s.Z, R.Rand(seed, i, 4) * 6.283f), ScaleSeed = new float4(s.Scale, s.Scale * sq * heightScale, R.Rand(seed, i, 5), 1) };
            }
            var set = new InstanceSet(mesh, mat, data.Length, shadows);
            set.Set(data);
            sets.Add(set);
            Plants += data.Length;
        }

        bool Clear(float x, float z, float margin) => WaterDist(x, z) > 1.5f + margin && Vector2.Distance(new Vector2(x, z), new Vector2(House.x, House.z)) > 8 + margin && Trail(x, z) > 1.6f + margin;

        void BuildPlants(Material f)
        {
            var taken = new List<Spot>();
            var spruces = Scatter(501, 3000, 70, (x, z, i) => Plateau(x, z) > 0 && Clear(x, z, 1) && Slope(x, z) < 0.4f ? 0.65f + R.Rand(502, i) * 0.45f : 0, 3.4f, taken);
            taken.AddRange(spruces);
            var pines = Scatter(503, 3000, 24, (x, z, i) => (Plateau(x, z) > 0 || x > 40) && Clear(x, z, 1) ? 0.6f + R.Rand(504, i) * 0.4f : 0, 5, taken);
            taken.AddRange(pines);
            var oaks = Scatter(505, 3000, 16, (x, z, i) =>
            {
                if (Plateau(x, z) > 0 || !Clear(x, z, 2.5f) || Slope(x, z) > 0.3f) return 0;
                bool edge = x < -50 || z > 48 || z < -55 || Mathf.PerlinNoise(x / 16 + 5, z / 16) > 0.62f;
                return edge ? 0.75f + R.Rand(506, i) * 0.4f : 0;
            }, 9, taken);
            taken.AddRange(oaks);
            var birches = Scatter(507, 4000, 34, (x, z, i) =>
            {
                float wd = WaterDist(x, z);
                if (Plateau(x, z) > 0 || wd < 3 || wd > 14 || !Clear(x, z, 0.5f)) return 0;
                return 0.7f + R.Rand(508, i) * 0.4f;
            }, 4.2f, taken);
            taken.AddRange(birches);
            for (int v = 0; v < 2; v++)
            {
                Plant(Models.Tree(TreeKind.Spruce, 603 + v, 0), f, spruces.FindAll(s => spruces.IndexOf(s) % 2 == v), 611 + v, true);
                Plant(Models.Tree(TreeKind.Pine, 607 + v, 0), f, pines.FindAll(s => pines.IndexOf(s) % 2 == v), 615 + v, true);
                Plant(Models.Tree(TreeKind.Oak, 601 + v, 0), f, oaks.FindAll(s => oaks.IndexOf(s) % 2 == v), 621 + v, true);
                Plant(Models.Tree(TreeKind.Birch, 605 + v, 0), f, birches.FindAll(s => birches.IndexOf(s) % 2 == v), 631 + v, true);
            }
            var shrubs = Scatter(509, 6000, 90, (x, z, i) =>
            {
                if (!Clear(x, z, 0.3f) || Slope(x, z) > 0.45f) return 0;
                bool nearTree = taken.Exists(t => (t.X - x) * (t.X - x) + (t.Z - z) * (t.Z - z) < 40);
                return nearTree || R.Rand(510, i) < 0.25f ? 0.6f + R.Rand(511, i) * 0.6f : 0;
            }, 2.2f, taken);
            Plant(Models.Tree(TreeKind.Shrub, 640, 0), f, shrubs.FindAll(s => shrubs.IndexOf(s) % 2 == 0), 641, true);
            Plant(Models.Tree(TreeKind.Rose, 642, 0), f, shrubs.FindAll(s => shrubs.IndexOf(s) % 2 == 1), 643, true);

            // Трава: сплошной покров открытых мест, куртинами; на плато и у воды реже.
            bool Open(float x, float z) => WaterDist(x, z) > 0.4f && Trail(x, z) > 1.1f && Vector2.Distance(new Vector2(x, z), new Vector2(House.x, House.z)) > 6.2f && Slope(x, z) < 0.55f;
            var grass = Scatter(520, 160000, 70000, (x, z, i) =>
            {
                if (!Open(x, z)) return 0;
                float lush = Mathf.PerlinNoise(x / 9 + 7, z / 9);
                if (R.Rand(521, i) > 0.4f + lush * 0.75f) return 0;
                return 0.35f + lush * 0.3f + R.Rand(522, i) * 0.2f;
            });
            var parts = new[] { new List<Spot>(), new List<Spot>(), new List<Spot>() };
            for (int i = 0; i < grass.Count; i++) parts[i % 3].Add(grass[i]);
            for (int v = 0; v < 3; v++) Plant(Models.GrassTuft(v), f, parts[v], 523 + v, false, 1, 0.02f);
            // Цветы — пятнами, каждый вид своим пятном.
            for (int v = 0; v < 5; v++)
            {
                int vv = v;
                var flowers = Scatter(530 + v, 30000, 1600, (x, z, i) => Open(x, z) && Mathf.PerlinNoise(x / 8 + vv * 13, z / 8 + vv * 7) > 0.62f ? 0.6f + R.Rand(540 + vv, i) * 0.5f : 0);
                Plant(Models.Flower(v), f, flowers, 550 + v, false, 1, 0.02f);
            }
            var reeds = Scatter(560, 20000, 260, (x, z, i) =>
            {
                float wd = WaterDist(x, z);
                return wd > -1.2f && wd < 0.7f && Mathf.PerlinNoise(x / 5, z / 5) > 0.42f ? 0.8f + R.Rand(561, i) * 0.6f : 0;
            });
            Plant(Models.Reed(), f, reeds, 562, false, 1, 0.1f);
        }

        void BuildRocks(Material g)
        {
            var meshes = new[] { Models.Rock(701), Models.Rock(702), Models.Rock(703) };
            var rocks = Scatter(570, 9000, 80, (x, z, i) =>
            {
                float s = Slope(x, z);
                bool cliffFoot = s > 0.5f && s < 1.6f;
                float wd = WaterDist(x, z);
                bool shore = wd > -0.6f && wd < 1.2f && R.Rand(571, i) < 0.3f;
                bool field = Clear(x, z, 0.5f) && R.Rand(572, i) < 0.03f;
                return cliffFoot ? 0.8f + R.Rand(573, i) * 1.8f : shore ? 0.25f + R.Rand(574, i) * 0.5f : field ? 0.4f + R.Rand(575, i) * 0.8f : 0;
            }, 1.4f);
            for (int i = 0; i < rocks.Count; i++)
            {
                var s = rocks[i];
                var mat = Matrix4x4.TRS(new Vector3(s.X, Height(s.X, s.Z) - s.Scale * 0.25f, s.Z), Quaternion.Euler((R.Rand(576, i) - 0.5f) * 30, R.Rand(577, i) * 360, (R.Rand(578, i) - 0.5f) * 30), Vector3.one * s.Scale * new Vector3(1, 0.75f + R.Rand(579, i) * 0.5f, 1).y);
                Obj("rock", meshes[i % 3], g, mat, s.Scale > 0.5f);
            }
            // Поваленное бревно на лугу.
            var log = new GeoBuilder();
            var cyl = Models.Prim(PrimitiveType.Cylinder);
            log.Add(cyl, Matrix4x4.TRS(Vector3.zero, Quaternion.Euler(0, 0, 90), new Vector3(0.7f, 1.8f, 0.7f)), (p, n) => Mathf.Abs(n.x) > 0.9f ? new Color(0.79f, 0.66f, 0.45f) : new Color(0.35f, 0.26f, 0.19f));
            Obj("log", log.Build("log"), g, Matrix4x4.TRS(new Vector3(-8, Height(-8, 30) + 0.3f, 30), Quaternion.Euler(0, 35, 0), Vector3.one), true);
        }

        /// <summary>Бревенчатый дом: сруб, двускатная крыша, труба, крыльцо, окна, забор.</summary>
        void BuildHouse(Material g)
        {
            var b = new GeoBuilder();
            var cyl = Models.Prim(PrimitiveType.Cylinder);
            var cube = Models.Prim(PrimitiveType.Cube);
            Color logC = new(0.5f, 0.35f, 0.22f), logD = new(0.38f, 0.26f, 0.16f), roofC = new(0.42f, 0.24f, 0.18f), stone = new(0.55f, 0.53f, 0.5f);
            float w = 7, d = 5.5f, wallH = 2.8f;
            for (int row = 0; row < 8; row++)
            {
                float y = 0.18f + row * 0.35f;
                Color c = row % 2 == 0 ? logC : logD;
                b.Add(cyl, Matrix4x4.TRS(new Vector3(0, y, d / 2), Quaternion.Euler(0, 0, 90), new Vector3(0.36f, w / 2 + 0.3f, 0.36f)), (_, _) => c);
                b.Add(cyl, Matrix4x4.TRS(new Vector3(0, y, -d / 2), Quaternion.Euler(0, 0, 90), new Vector3(0.36f, w / 2 + 0.3f, 0.36f)), (_, _) => c);
                b.Add(cyl, Matrix4x4.TRS(new Vector3(w / 2, y + 0.17f, 0), Quaternion.Euler(90, 0, 0), new Vector3(0.36f, d / 2 + 0.3f, 0.36f)), (_, _) => c);
                b.Add(cyl, Matrix4x4.TRS(new Vector3(-w / 2, y + 0.17f, 0), Quaternion.Euler(90, 0, 0), new Vector3(0.36f, d / 2 + 0.3f, 0.36f)), (_, _) => c);
            }
            b.Add(cube, Matrix4x4.TRS(new Vector3(0, wallH / 2, 0), Quaternion.identity, new Vector3(w - 0.2f, wallH, d - 0.2f)), (_, _) => logD);
            // Крыша: два ската с напуском.
            float ridge = wallH + 2.1f;
            for (int s = -1; s <= 1; s += 2)
            {
                var rot = Quaternion.Euler(s * 38, 0, 0);
                // Тёс рядами внахлёст: каждый ряд чуть другого тона.
                for (int row = 0; row < 7; row++)
                {
                    float k = (row + 0.5f) / 7;
                    var c = new Vector3(0, ridge - (ridge - wallH) * k + 0.05f + row * 0.004f, s * d * 0.6f * k);
                    Color rc = roofC * (0.86f + R.Rand(77, row, s + 2) * 0.22f);
                    b.Add(cube, Matrix4x4.TRS(c, rot, new Vector3(w + 1.2f, 0.12f, d * 0.78f / 6.2f)), (_, _) => rc);
                }
            }
            // Фронтоны.
            b.Add(cube, Matrix4x4.TRS(new Vector3(w / 2 - 0.05f, wallH + 0.8f, 0), Quaternion.identity, new Vector3(0.2f, 1.6f, d * 0.55f)), (_, _) => logC);
            b.Add(cube, Matrix4x4.TRS(new Vector3(-w / 2 + 0.05f, wallH + 0.8f, 0), Quaternion.identity, new Vector3(0.2f, 1.6f, d * 0.55f)), (_, _) => logC);
            // Труба, дверь, окна, крыльцо.
            b.Add(cube, Matrix4x4.TRS(new Vector3(-w / 4, ridge + 0.3f, d * 0.15f), Quaternion.identity, new Vector3(0.7f, 2.2f, 0.7f)), (p, _) => stone * (0.85f + R.Noise2(9, p.y * 6, p.x * 6) * 0.3f));
            b.Add(cube, Matrix4x4.TRS(new Vector3(0.6f, 1.05f, -d / 2 - 0.2f), Quaternion.identity, new Vector3(1.0f, 2.0f, 0.12f)), (_, _) => new Color(0.3f, 0.19f, 0.12f));
            foreach (float x in new[] { -2.2f, 2.3f })
            {
                b.Add(cube, Matrix4x4.TRS(new Vector3(x, 1.5f, -d / 2 - 0.2f), Quaternion.identity, new Vector3(1.0f, 0.85f, 0.1f)), (_, _) => new Color(0.38f, 0.42f, 0.4f));
                b.Add(cube, Matrix4x4.TRS(new Vector3(x, 1.5f, -d / 2 - 0.27f), Quaternion.identity, new Vector3(0.06f, 0.85f, 0.04f)), (_, _) => new Color(0.86f, 0.82f, 0.72f));
                b.Add(cube, Matrix4x4.TRS(new Vector3(x, 1.5f, -d / 2 - 0.26f), Quaternion.identity, new Vector3(1.2f, 1.05f, 0.06f)), (_, _) => new Color(0.86f, 0.82f, 0.72f));
            }
            b.Add(cube, Matrix4x4.TRS(new Vector3(0.6f, 0.15f, -d / 2 - 1.0f), Quaternion.identity, new Vector3(3.2f, 0.3f, 1.4f)), (_, _) => logC * 1.1f);
            float baseY = Height(House.x, House.z) - 0.05f;
            Obj("house", b.Build("house"), g, Matrix4x4.TRS(new Vector3(House.x, baseY, House.z), Quaternion.Euler(0, 20, 0), Vector3.one), true);
            // Забор вокруг огорода.
            var f = new GeoBuilder();
            for (int i = 0; i < 18; i++)
            {
                float a = i / 18f * Mathf.PI * 1.3f + 2.4f;
                var p = new Vector3(Mathf.Cos(a) * 8.5f, 0, Mathf.Sin(a) * 8.5f);
                f.Add(cube, Matrix4x4.TRS(p + new Vector3(0, 0.55f, 0), Quaternion.identity, new Vector3(0.12f, 1.1f, 0.12f)), (_, _) => logD);
                if (i > 0)
                {
                    float a0 = (i - 0.5f) / 18f * Mathf.PI * 1.3f + 2.4f;
                    f.Add(cube, Matrix4x4.TRS(new Vector3(Mathf.Cos(a0) * 8.5f, 0.75f, Mathf.Sin(a0) * 8.5f), Quaternion.Euler(0, -a0 * Mathf.Rad2Deg, 0), new Vector3(0.06f, 0.1f, 8.5f * Mathf.PI * 1.3f / 18 + 0.1f)), (_, _) => logC);
                }
            }
            Obj("fence", f.Build("fence"), g, Matrix4x4.TRS(new Vector3(House.x, baseY, House.z), Quaternion.identity, Vector3.one), true);
        }

        public void Draw()
        {
            var bounds = new Bounds(Vector3.zero, new Vector3(2000, 300, 2000));
            foreach (var s in sets) s.Draw(bounds);
        }

        public long Triangles { get { long t = 0; foreach (var s in sets) t += s.Triangles; return t; } }
        public int DrawCalls => sets.Count;

        public void Dispose()
        {
            foreach (var s in sets) s.Dispose();
            if (Root) Object.Destroy(Root.gameObject);
        }
    }
}
