// Процедурные модели растений и природных деталей (перенос src/render/flora/woody.ts, herbs.ts и прототипа 1A).
// Деревья — три уровня детализации: 0 — ветви и сотни карточек, 1 — тот же силуэт крупными карточками,
// 2 — дальний: десяток крупных карточек и простой ствол.

using System;
using UnityEngine;

namespace Worldbound.Gfx
{
    public enum TreeKind { Birch, Pine, Spruce, Oak, Shrub, Rose }

    public static class Models
    {
        static Color C(int hex) => new(((hex >> 16) & 255) / 255f, ((hex >> 8) & 255) / 255f, (hex & 255) / 255f);
        static Vector3 V(float x, float y, float z) => new(x, y, z);
        static Func<Vector3, float> Sway(float k) => p => Mathf.Max(0, p.y) * Mathf.Max(0, p.y) * k;

        static (int cards, float size) Detail(int lod, int cards, float size) => lod switch
        {
            0 => (cards, size),
            1 => (Mathf.Max(4, Mathf.RoundToInt(cards * 0.22f)), size * 1.85f),
            _ => (Mathf.Max(2, Mathf.RoundToInt(cards * 0.07f)), size * 3.1f),
        };

        public static Mesh Tree(TreeKind kind, int seed, int lod) => kind switch
        {
            TreeKind.Birch => Birch(seed, lod),
            TreeKind.Pine => Pine(seed, lod),
            TreeKind.Spruce => Spruce(seed, lod),
            TreeKind.Oak => Oak(seed, lod),
            TreeKind.Shrub => Shrub(seed, lod),
            _ => Rose(seed, lod),
        };

        static Mesh Birch(int seed, int lod)
        {
            var b = new GeoBuilder();
            float height = 10 + R.Rand(seed, 1) * 1.5f, lean = (R.Rand(seed, 2) - 0.5f) * 1.1f;
            Color white = C(0xe9e5da), mark = C(0x2f2c28);
            Func<Vector3, Color> bark = p =>
            {
                float f = R.Rand(seed, Mathf.FloorToInt(p.y * 5), Mathf.FloorToInt(Mathf.Atan2(p.z, p.x) * 1.7f));
                return (f < 0.16f ? mark : white * (0.9f + f * 0.1f)) * (p.y < 1.1f ? 0.5f + p.y * 0.45f : 1);
            };
            var trunk = new[] { V(0, -0.4f, 0), V(lean * 0.25f, height * 0.35f, 0.08f), V(lean * 0.7f, height * 0.7f, -0.08f), V(lean, height, 0) };
            b.Limb(trunk, 0.2f, 0.03f, lod == 0 ? 8 : lod == 1 ? 5 : 3, bark, Sway(0.0012f), 0.35f, lod == 2 ? 3 : 0);
            var (cards, size) = Detail(lod, 30, 0.55f);
            var st = new CrownStyle { Seed = seed, Cards = cards, Size = size, Base = C(0x6e9e3c), Sunlit = C(0xc6da62), Bottom = height * 0.4f, Top = height + 1, Centre = V(lean * 0.7f, height * 0.72f, 0), Uv = LeafAtlas.Uv(LeafTile.Birch) };
            int branches = lod == 0 ? 8 : 5;
            for (int i = 0; i < branches; i++)
            {
                float t = 0.42f + i / (float)(branches - 1) * 0.52f;
                var from = Sample(trunk, t);
                float a = i * 2.4f + R.Rand(seed, 10 + i) * 0.9f, reach = (1.15f - t) * 2.8f + 0.6f;
                var tip = from + V(Mathf.Cos(a) * reach, 0.5f + R.Rand(seed, 20 + i) * 0.8f, Mathf.Sin(a) * reach);
                var sag = tip + V(Mathf.Cos(a) * 0.5f, -1.0f, Mathf.Sin(a) * 0.5f);
                if (lod < 2) b.Limb(new[] { from, Vector3.Lerp(from, tip, 0.55f) + V(0, 0.35f, 0), tip, sag }, 0.055f, 0.012f, lod == 0 ? 4 : 3, bark, p => p.y * 0.012f, 0, lod == 0 ? 0 : 4);
                Crown.Blob(b, tip, V(1.2f, 0.95f, 1.2f), st, i);
                if (lod < 2) Crown.Blob(b, sag, V(0.75f, 1.1f, 0.75f), Half(st), i + 20);
            }
            Crown.Blob(b, Sample(trunk, 1), V(1.1f, 1.25f, 1.1f), st, 40);
            return b.Build("birch" + lod);
        }

        static CrownStyle Half(CrownStyle s) { s.Cards = Mathf.Max(2, s.Cards / 2); return s; }

        static Mesh Pine(int seed, int lod)
        {
            var b = new GeoBuilder();
            float height = 14 + R.Rand(seed, 1) * 2, lean = (R.Rand(seed, 2) - 0.5f) * 0.8f;
            Color low = C(0x5a4636), high = C(0xb5683a);
            Func<Vector3, Color> bark = p => Color.Lerp(low, high, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(height * 0.3f, height * 0.6f, p.y))) * (0.8f + R.Noise2(seed, p.y * 3, Mathf.Atan2(p.z, p.x) * 3) * 0.35f);
            var trunk = new[] { V(0, -0.4f, 0), V(lean * 0.2f, height * 0.4f, 0.1f), V(lean * 0.6f, height * 0.75f, -0.1f), V(lean, height, 0) };
            b.Limb(trunk, 0.3f, 0.05f, lod == 0 ? 8 : lod == 1 ? 5 : 3, bark, Sway(0.0006f), 0.4f, lod == 2 ? 3 : 0);
            var (cards, size) = Detail(lod, 26, 0.62f);
            var st = new CrownStyle { Seed = seed, Cards = cards, Size = size, Base = C(0x2f5a3a), Sunlit = C(0x7aa060), Bottom = height * 0.55f, Top = height + 1, Centre = V(lean * 0.8f, height * 0.82f, 0), Uv = LeafAtlas.Uv(LeafTile.Pine), Aspect = 0.75f };
            int clumps = lod == 0 ? 7 : 5;
            for (int i = 0; i < clumps; i++)
            {
                float t = 0.62f + i / (float)clumps * 0.36f + R.Rand(seed, 30 + i) * 0.04f;
                var from = Sample(trunk, Mathf.Min(1, t));
                float a = i * 2.2f + R.Rand(seed, 31 + i) * 1.2f, reach = i == clumps - 1 ? 0.2f : 1.4f + R.Rand(seed, 32 + i) * 1.4f;
                var tip = from + V(Mathf.Cos(a) * reach, 0.4f + R.Rand(seed, 33 + i) * 0.5f, Mathf.Sin(a) * reach);
                if (lod < 2 && reach > 0.5f) b.Limb(new[] { from, Vector3.Lerp(from, tip, 0.5f) + V(0, 0.25f, 0), tip }, 0.09f, 0.03f, lod == 0 ? 4 : 3, bark, p => p.y * 0.004f, 0, lod == 0 ? 0 : 3);
                Crown.Blob(b, tip, V(1.6f, 0.75f, 1.6f), st, i);
            }
            return b.Build("pine" + lod);
        }

        static Mesh Spruce(int seed, int lod)
        {
            var b = new GeoBuilder();
            float height = 14 + R.Rand(seed, 1) * 3;
            Color barkC = C(0x463629), dark = C(0x1f4a35), tipC = C(0x58905c);
            b.Limb(new[] { V(0, -0.4f, 0), V(0.04f, height * 0.5f, 0.02f), V(0, height, 0) }, 0.32f, 0.03f, lod == 0 ? 7 : 4, p => barkC * (0.75f + R.Noise2(seed, p.y * 2, p.x * 6) * 0.5f), Sway(0.0005f), 0.45f, lod == 2 ? 3 : 0);
            var uv = LeafAtlas.Uv(LeafTile.Spruce);
            int tiers = lod == 0 ? 12 : lod == 1 ? 6 : 4;
            for (int i = 0; i < tiers; i++)
            {
                float t = i / (float)(tiers - 1), y = 1.2f + t * (height - 1.9f);
                float reach = Mathf.Pow(1 - t, 0.9f) * (3.2f + R.Rand(seed, 50 + i) * 0.5f) + 0.35f;
                int boughs = lod == 0 ? Mathf.RoundToInt(7 + (1 - t) * 6) : lod == 1 ? Mathf.RoundToInt(4 + (1 - t) * 3) : 3;
                for (int j = 0; j < boughs; j++)
                {
                    float a = j / (float)boughs * Mathf.PI * 2 + i * 0.7f + R.Rand(seed, i, j, 1) * 0.3f;
                    var outv = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                    float len = reach * (0.8f + R.Rand(seed, i, j, 2) * 0.35f) * (lod == 2 ? 1.15f : 1);
                    float droop = 0.4f + R.Rand(seed, i, j, 3) * 0.2f - t * 0.22f;
                    var along = outv * Mathf.Cos(droop) + V(0, -Mathf.Sin(droop), 0);
                    var centre = V(0, y, 0) + along * (len * 0.5f + 0.1f);
                    float tone = 0.62f + t * 0.45f + R.Rand(seed, i, j, 4) * 0.12f;
                    Color lo = dark * tone * 0.8f, hi = Color.Lerp(dark, tipC, 0.75f) * tone * 1.05f;
                    var shade = (outv * 0.55f + V(0, 0.85f, 0)).normalized;
                    var right = V(-outv.z, 0, outv.x) * len * (lod == 0 ? 0.34f : 0.5f);
                    float sw = 0.02f + t * 0.06f;
                    b.Card(centre, right, along * len * 0.5f, shade, lo, hi, sw, sw + len * 0.03f, R.Rand(seed, i, j, 5), uv);
                    if (lod == 0) b.Card(centre, Vector3.Cross(along, V(-outv.z, 0, outv.x)).normalized * len * 0.2f, along * len * 0.5f, shade, lo, hi, sw, sw + len * 0.03f, R.Rand(seed, i, j, 6), uv);
                }
            }
            b.Card(V(0, height + 0.45f, 0), V(0.36f, 0, 0), V(0, 0.9f, 0), Vector3.up, dark, tipC, 0.08f, 0.12f, 0.1f, uv);
            b.Card(V(0, height + 0.45f, 0), V(0, 0, 0.36f), V(0, 0.9f, 0), Vector3.up, dark, tipC, 0.08f, 0.12f, 0.2f, uv);
            return b.Build("spruce" + lod);
        }

        static Mesh Oak(int seed, int lod)
        {
            var b = new GeoBuilder();
            Color barkA = C(0x55412f), barkB = C(0x382a1f);
            Func<Vector3, Color> bark = p => Color.Lerp(barkA, barkB, R.Noise2(seed, p.y * 1.4f, Mathf.Atan2(p.z, p.x) * 2.5f)) * (0.8f + Mathf.Min(1, p.y / 5) * 0.3f);
            float lean = (R.Rand(seed, 1) - 0.5f) * 0.8f;
            var fork = V(lean, 3.6f, (R.Rand(seed, 2) - 0.5f) * 0.8f);
            b.Limb(new[] { V(0, -0.4f, 0), V(lean * 0.2f, 1.4f, 0.1f), V(lean * 0.7f, 2.8f, fork.z * 0.6f), fork }, 0.62f, 0.4f, lod == 0 ? 10 : lod == 1 ? 5 : 4, bark, Sway(0.0003f), 0.7f, lod == 0 ? 0 : 4);
            var (cards, size) = Detail(lod, 62, 0.95f);
            var st = new CrownStyle { Seed = seed, Cards = cards, Size = size, Base = C(0x3a7030), Sunlit = C(0x93ba4a), Bottom = 4, Top = 12, Centre = V(lean, 7.4f, fork.z), Uv = LeafAtlas.Uv(LeafTile.Oak) };
            int limbs = lod == 0 ? 6 : 5;
            for (int i = 0; i < limbs; i++)
            {
                float a = i / (float)limbs * Mathf.PI * 2 + R.Rand(seed, 10 + i) * 0.8f, reach = i == 0 ? 0.3f : 2.6f + R.Rand(seed, 20 + i) * 1.5f;
                var c = V(fork.x + Mathf.Cos(a) * reach, i == 0 ? 9.6f : 6.4f + R.Rand(seed, 30 + i) * 2.2f, fork.z + Mathf.Sin(a) * reach);
                float radius = i == 0 ? 2.9f : 2.2f + R.Rand(seed, 40 + i) * 0.9f;
                var elbow = Vector3.Lerp(fork, c, 0.5f) + V(0, i == 0 ? 0.6f : -0.3f, 0);
                if (lod < 2 && (lod == 0 || i > 0)) b.Limb(new[] { fork + V(0, -0.5f, 0), elbow, c + V(0, -0.5f, 0) }, 0.3f, 0.08f, lod == 0 ? 6 : 3, bark, p => p.y * 0.006f, 0, lod == 0 ? 0 : 3);
                Crown.Blob(b, c, V(radius, radius * 0.78f, radius), st, i);
            }
            return b.Build("oak" + lod);
        }

        static Mesh Shrub(int seed, int lod)
        {
            var b = new GeoBuilder();
            var (cards, size) = Detail(lod, 22, 0.42f);
            var st = new CrownStyle { Seed = seed, Cards = cards, Size = size, Base = C(0x4a7d36), Sunlit = C(0x9cc256), Bottom = 0.3f, Top = 2.6f, Centre = V(0, 1.2f, 0), Uv = LeafAtlas.Uv(LeafTile.Linden) };
            int stems = lod == 0 ? 7 : 4;
            for (int i = 0; i < stems; i++)
            {
                float a = i / (float)stems * Mathf.PI * 2 + R.Rand(seed, i) * 0.6f, outv = 0.5f + R.Rand(seed, 10 + i) * 0.5f, h = 1.6f + R.Rand(seed, 20 + i) * 0.7f;
                var tip = V(Mathf.Cos(a) * outv, h, Mathf.Sin(a) * outv);
                if (lod < 2) b.Limb(new[] { V(0, -0.1f, 0), tip * 0.5f, tip }, 0.035f, 0.012f, 3, _ => C(0x6b5644), p => p.y * 0.03f, 0, 3);
                Crown.Blob(b, tip + V(0, -0.3f, 0), V(0.75f, 0.65f, 0.75f), st, i);
            }
            return b.Build("shrub" + lod);
        }

        static Mesh Rose(int seed, int lod)
        {
            var b = new GeoBuilder();
            var (cards, size) = Detail(lod, 20, 0.26f);
            var st = new CrownStyle { Seed = seed, Cards = cards, Size = size, Base = C(0x3e7234), Sunlit = C(0x8fb852), Bottom = 0, Top = 1.6f, Centre = V(0, 0.6f, 0), Uv = LeafAtlas.Uv(LeafTile.Birch) };
            var sphere = Prim(PrimitiveType.Sphere);
            int canes = lod == 0 ? 6 : 3;
            for (int i = 0; i < canes; i++)
            {
                float a = i / (float)canes * Mathf.PI * 2 + R.Rand(seed, i) * 0.7f, reach = 0.7f + R.Rand(seed, 10 + i) * 0.4f;
                var c = V(Mathf.Cos(a) * reach * 0.6f, 0.75f + R.Rand(seed, 20 + i) * 0.3f, Mathf.Sin(a) * reach * 0.6f);
                Crown.Blob(b, c, V(0.55f, 0.45f, 0.55f), st, i);
                for (int k = 0; k < (lod == 0 ? 6 : 2); k++)
                {
                    float u = R.Rand(seed, i, k, 1) * Mathf.PI * 2, y = R.Rand(seed, i, k, 2) * 0.8f, rr = Mathf.Sqrt(1 - y * y) * 0.55f;
                    var m = Matrix4x4.TRS(c + V(Mathf.Cos(u) * rr, y * 0.4f, Mathf.Sin(u) * rr), Quaternion.identity, Vector3.one * 0.11f);
                    b.Add(sphere, m, (_, _) => R.Rand(seed, i, k) < 0.5f ? C(0xf08cb0) : C(0xffffff), 0.05f, 2, R.Rand(seed, i, k, 3));
                }
            }
            return b.Build("rose" + lod);
        }

        static Vector3 Sample(Vector3[] pts, float t)
        {
            int n = pts.Length - 1;
            float f = t * n;
            int i = Mathf.Min(n - 1, Mathf.FloorToInt(f));
            return Vector3.Lerp(pts[i], pts[i + 1], f - i);
        }

        static readonly System.Collections.Generic.Dictionary<PrimitiveType, Mesh> prims = new();

        public static Mesh Prim(PrimitiveType t)
        {
            if (prims.TryGetValue(t, out var m)) return m;
            var go = GameObject.CreatePrimitive(t);
            m = go.GetComponent<MeshFilter>().sharedMesh;
            UnityEngine.Object.Destroy(go);
            prims[t] = m;
            return m;
        }

        // ───────── травы и цветы (part 2 — соцветия, видны в цветение) ─────────

        static void Blade(GeoBuilder b, float ox, float oz, float dir, float h, float w, float lean, Color baseC, Color tip, float rnd, float part = 1)
        {
            float fx = Mathf.Cos(dir), fz = Mathf.Sin(dir), px = -fz, pz = fx;
            Vector3 P(float t) { float bend = lean * t * t; return V(ox + fx * bend * h, h * t * (1 - 0.25f * lean * t), oz + fz * bend * h); }
            for (int k = 0; k < 3; k++)
            {
                float t0 = k / 3f, t1 = (k + 1) / 3f, w0 = w * (1 - t0 * 0.85f), w1 = w * (1 - t1 * 0.85f);
                Vector3 a = P(t0), c = P(t1);
                Color c0 = Color.Lerp(baseC, tip, t0), c1 = Color.Lerp(baseC, tip, t1);
                var al = a - V(px, 0, pz) * w0; var ar = a + V(px, 0, pz) * w0; var cl = c - V(px, 0, pz) * w1; var cr = c + V(px, 0, pz) * w1;
                if (k == 2) b.Tri(al, ar, c, Vector3.up, c0, c0, c1, Vector2.zero, Vector2.zero, Vector2.zero, t0 * t0, t0 * t0, 1, part, rnd);
                else
                {
                    b.Tri(al, ar, cr, Vector3.up, c0, c0, c1, Vector2.zero, Vector2.zero, Vector2.zero, t0 * t0, t0 * t0, t1 * t1, part, rnd);
                    b.Tri(al, cr, cl, Vector3.up, c0, c1, c1, Vector2.zero, Vector2.zero, Vector2.zero, t0 * t0, t1 * t1, t1 * t1, part, rnd);
                }
            }
        }

        /// <summary>Пучок травы (part 0 — без текстуры: цвет вершин; эталон высоты 1 м).</summary>
        public static Mesh GrassTuft(int v)
        {
            var b = new GeoBuilder();
            Color baseC = C(0x3f6a2c), tip = C(0x86a852);
            for (int k = 0; k < 9; k++)
            {
                float a = k * 2.39f + v, r = 0.05f + R.Rand(1, v, k) * 0.12f;
                Blade(b, Mathf.Cos(a) * r, Mathf.Sin(a) * r, a + R.Rand(2, v, k), 0.55f + R.Rand(3, v, k) * 0.45f, 0.024f, 0.35f + R.Rand(4, v, k) * 0.3f, baseC, tip, 0, 0);
            }
            return b.Build("grass" + v);
        }

        /// <summary>Цветок: листья у земли, стебли и цветки из лепестков (ромашка, лютик, колокольчик…).</summary>
        public static Mesh Flower(int v)
        {
            var b = new GeoBuilder();
            var kinds = new[] { (C(0xffffff), C(0xf2c230), 9, 0.07f), (C(0xf8d02a), C(0xe0a020), 5, 0.05f), (C(0x4c6ee0), C(0x30307a), 8, 0.055f), (C(0x9a70d8), C(0x6a48a8), 5, 0.045f), (C(0xe8554a), C(0x402020), 6, 0.06f) };
            var (petal, core, petals, rad) = kinds[v % kinds.Length];
            Color leaf = C(0x4f8a3a), stem = C(0x4e7f34);
            for (int k = 0; k < 5; k++) { float a = k * 2.39f + v; Blade(b, Mathf.Cos(a) * 0.04f, Mathf.Sin(a) * 0.04f, a, 0.3f + R.Rand(41, v, k) * 0.15f, 0.025f, 0.6f, leaf, leaf * 1.25f, 0, 0); }
            for (int k = 0; k < 3; k++)
            {
                float a = k * 2.2f + v, h = 0.6f + R.Rand(42, v, k) * 0.35f;
                var top = V(Mathf.Cos(a) * 0.07f + Mathf.Cos(a) * 0.05f, h, Mathf.Sin(a) * 0.07f + Mathf.Sin(a) * 0.05f);
                var bot = V(Mathf.Cos(a) * 0.07f, 0, Mathf.Sin(a) * 0.07f);
                b.Tri(bot - V(0.006f, 0, 0), bot + V(0.006f, 0, 0), top, Vector3.up, stem, stem, stem, Vector2.zero, Vector2.zero, Vector2.zero, 0, 0, 1, 0, 0);
                b.Tri(bot - V(0, 0, 0.006f), bot + V(0, 0, 0.006f), top, Vector3.up, stem, stem, stem, Vector2.zero, Vector2.zero, Vector2.zero, 0, 0, 1, 0, 0);
                for (int p = 0; p < petals; p++)
                {
                    float a0 = p / (float)petals * Mathf.PI * 2, a1 = a0 + Mathf.PI * 2 / petals * 0.8f;
                    b.Tri(top, top + V(Mathf.Cos(a0) * rad, 0.012f, Mathf.Sin(a0) * rad), top + V(Mathf.Cos(a1) * rad, 0.012f, Mathf.Sin(a1) * rad), Vector3.up, petal, petal, petal, Vector2.zero, Vector2.zero, Vector2.zero, 1, 1, 1, 2, 0.1f + k * 0.2f);
                }
                b.Tri(top + V(-rad * 0.3f, 0.015f, 0), top + V(rad * 0.3f, 0.015f, 0), top + V(0, 0.02f, rad * 0.3f), Vector3.up, core, core, core, Vector2.zero, Vector2.zero, Vector2.zero, 1, 1, 1, 2, 0.1f + k * 0.2f);
            }
            return b.Build("flower" + v);
        }

        public static Mesh Reed()
        {
            var b = new GeoBuilder();
            Color baseC = C(0x4c7036), tip = C(0x9db35c);
            for (int k = 0; k < 8; k++) { float a = k * 1.1f; Blade(b, Mathf.Cos(a) * 0.12f, Mathf.Sin(a) * 0.12f, a + 1, 1.0f + (k % 3) * 0.3f, 0.03f, 0.25f, baseC, tip, 0, 0); }
            var cyl = Prim(PrimitiveType.Cylinder);
            for (int k = 0; k < 2; k++) b.Add(cyl, Matrix4x4.TRS(V(k * 0.1f - 0.05f, 1.3f + k * 0.2f, k * 0.06f), Quaternion.identity, V(0.07f, 0.11f, 0.07f)), (_, _) => C(0x5a3a22), 1.2f);
            return b.Build("reed");
        }

        /// <summary>Камень: икосфера, искажённая шумом, со срезами граней и мхом сверху (для WB/Ground).</summary>
        public static Mesh Rock(int seed, int detail = 2)
        {
            var src = Prim(PrimitiveType.Sphere);
            var v = src.vertices;
            var t = src.triangles;
            var outV = new Vector3[v.Length];
            for (int i = 0; i < v.Length; i++)
            {
                var p = v[i] * 2;
                float n1 = R.Noise2(seed, p.x * 1.3f + p.y * 1.9f, p.z * 1.3f - p.y * 0.7f) - 0.5f, n2 = R.Noise2(seed + 7, p.x * 3.7f - p.y * 2.1f, p.z * 3.7f + p.y * 1.3f) - 0.5f;
                p *= 1 + n1 * 0.55f + n2 * 0.16f;
                p.y = Mathf.Max(-0.55f, Mathf.Min(0.72f + n1 * 0.2f, p.y)) * 0.78f;
                p.z *= 0.86f;
                outV[i] = p;
            }
            var m = new Mesh { vertices = outV, triangles = t };
            m.RecalculateNormals();
            var nn = m.normals;
            var cols = new Color[outV.Length];
            for (int i = 0; i < outV.Length; i++)
            {
                var c = Color.Lerp(C(0xa7a195), C(0x7b756b), R.Noise2(seed + 3, outV[i].x * 2.2f + outV[i].y, outV[i].z * 2.2f - outV[i].y));
                cols[i] = Color.Lerp(c, C(0x5d7a3a), Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.66f, 0.97f, nn[i].y + R.Noise2(seed + 4, outV[i].x * 3, outV[i].z * 3) * 0.3f)) * 0.6f);
            }
            m.colors = cols;
            m.name = "rock" + seed;
            return m;
        }
    }
}
