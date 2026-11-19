// Процедурная геометрия (перенос src/render/flora/geometry.ts): построитель меша с цветами вершин,
// uv атласа и uv2 = (sway, part, rnd); ветви по кривым, облака листовых карточек; детерминированный хеш.

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.Gfx
{
    public static class R
    {
        /// <summary>Детерминированное число 0..1 из целых (тот же хеш, что rand() в TS-рендере).</summary>
        public static float Rand(params int[] k)
        {
            uint h = 2166136261;
            foreach (var v in k)
            {
                h = (h ^ (uint)v) * 16777619u;
                h = (h ^ (h >> 15)) * 2246822507u;
            }
            h ^= h >> 13;
            h *= 3266489909u;
            h ^= h >> 16;
            return h / 4294967296f;
        }

        public static float Noise2(int seed, float x, float y)
        {
            int xi = Mathf.FloorToInt(x), yi = Mathf.FloorToInt(y);
            float xf = x - xi, yf = y - yi;
            float u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
            float a = Rand(seed, xi, yi), b = Rand(seed, xi + 1, yi), c = Rand(seed, xi, yi + 1), d = Rand(seed, xi + 1, yi + 1);
            return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        }
    }

    public sealed class GeoBuilder
    {
        readonly List<Vector3> pos = new();
        readonly List<Vector3> nor = new();
        readonly List<Color> col = new();
        readonly List<Vector2> uv = new();
        readonly List<Vector3> ex = new();
        readonly List<int> idx = new();

        public int Triangles => idx.Count / 3;

        public void Tri(Vector3 a, Vector3 b, Vector3 c, Vector3 n, Color ca, Color cb, Color cc, Vector2 ua, Vector2 ub, Vector2 uc, float sa, float sb, float sc, float part, float rnd)
        {
            int i = pos.Count;
            pos.Add(a); pos.Add(b); pos.Add(c);
            nor.Add(n); nor.Add(n); nor.Add(n);
            col.Add(ca); col.Add(cb); col.Add(cc);
            uv.Add(ua); uv.Add(ub); uv.Add(uc);
            ex.Add(new Vector3(sa, part, rnd)); ex.Add(new Vector3(sb, part, rnd)); ex.Add(new Vector3(sc, part, rnd));
            idx.Add(i); idx.Add(i + 1); idx.Add(i + 2);
        }

        /// <summary>Листовая карточка: квадрат в плоскости (right, up), общая нормаль объёма кроны.</summary>
        public void Card(Vector3 c, Vector3 right, Vector3 up, Vector3 shade, Color lo, Color hi, float swayLo, float swayHi, float rnd, Rect uvr, float part = 1)
        {
            Vector3 a = c - right - up, b = c + right - up, cc = c + right + up, d = c - right + up;
            Vector2 u0 = new(uvr.xMin, uvr.yMin), u1 = new(uvr.xMax, uvr.yMin), u2 = new(uvr.xMax, uvr.yMax), u3 = new(uvr.xMin, uvr.yMax);
            Tri(a, b, cc, shade, lo, lo, hi, u0, u1, u2, swayLo, swayLo, swayHi, part, rnd);
            Tri(a, cc, d, shade, lo, hi, hi, u0, u2, u3, swayLo, swayHi, swayHi, part, rnd);
        }

        /// <summary>Ветвь переменной толщины вдоль кривой Катмулла — Рома.</summary>
        public void Limb(Vector3[] pts, float r0, float r1, int sides, System.Func<Vector3, Color> color, System.Func<Vector3, float> sway, float flare = 0, int steps = 0)
        {
            int n = steps > 0 ? steps : Mathf.Max(3, pts.Length * 2);
            var rings = new List<Vector3[]>();
            var norms = new List<Vector3[]>();
            for (int i = 0; i <= n; i++)
            {
                float t = (float)i / n;
                Vector3 p = Catmull(pts, t), tan = (Catmull(pts, Mathf.Min(1, t + 0.01f)) - Catmull(pts, Mathf.Max(0, t - 0.01f))).normalized;
                Vector3 side = Vector3.Cross(tan, Mathf.Abs(tan.y) > 0.95f ? Vector3.right : Vector3.up).normalized;
                Vector3 fwd = Vector3.Cross(side, tan).normalized;
                float r = (r0 + (r1 - r0) * t) * (1 + flare * Mathf.Pow(Mathf.Max(0, 1 - t * 9), 2));
                var ring = new Vector3[sides + 1];
                var nr = new Vector3[sides + 1];
                for (int k = 0; k <= sides; k++)
                {
                    float a = k * Mathf.PI * 2 / sides;
                    nr[k] = side * Mathf.Cos(a) + fwd * Mathf.Sin(a);
                    ring[k] = p + nr[k] * r;
                }
                rings.Add(ring);
                norms.Add(nr);
            }
            for (int i = 1; i <= n; i++)
                for (int k = 0; k < sides; k++)
                {
                    Vector3 a = rings[i - 1][k], b = rings[i][k], c = rings[i - 1][k + 1], d = rings[i][k + 1];
                    Quad(a, b, c, d, norms[i - 1][k], norms[i][k], norms[i - 1][k + 1], norms[i][k + 1], color, sway);
                }
        }

        void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, Vector3 na, Vector3 nb, Vector3 nc, Vector3 nd, System.Func<Vector3, Color> color, System.Func<Vector3, float> sway)
        {
            void V(Vector3 p, Vector3 n) { pos.Add(p); nor.Add(n); col.Add(color(p)); uv.Add(Vector2.zero); ex.Add(new Vector3(sway(p), 0, 0)); }
            int i = pos.Count;
            V(a, na); V(b, nb); V(c, nc); V(d, nd);
            idx.Add(i); idx.Add(i + 1); idx.Add(i + 2);
            idx.Add(i + 2); idx.Add(i + 1); idx.Add(i + 3);
        }

        static Vector3 Catmull(Vector3[] p, float t)
        {
            int n = p.Length - 1;
            float f = t * n;
            int i = Mathf.Min(n - 1, Mathf.FloorToInt(f));
            float u = f - i;
            Vector3 p0 = p[Mathf.Max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Mathf.Min(n, i + 2)];
            return 0.5f * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
        }

        /// <summary>Готовый меш Unity (сфера, цилиндр…) с матрицей, цветом и частью растения.</summary>
        public void Add(Mesh m, Matrix4x4 mat, System.Func<Vector3, Vector3, Color> color, float sway = 0, float part = 0, float rnd = 0)
        {
            var v = m.vertices; var nn = m.normals; var t = m.triangles;
            int b = pos.Count;
            for (int i = 0; i < v.Length; i++)
            {
                var p = mat.MultiplyPoint3x4(v[i]);
                var n = mat.MultiplyVector(nn[i]).normalized;
                pos.Add(p); nor.Add(n); col.Add(color(p, n)); uv.Add(Vector2.zero); ex.Add(new Vector3(sway, part, rnd));
            }
            foreach (var k in t) idx.Add(b + k);
        }

        public Mesh Build(string name)
        {
            var m = new Mesh { name = name, indexFormat = pos.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            m.SetVertices(pos); m.SetNormals(nor); m.SetColors(col); m.SetUVs(0, uv); m.SetUVs(1, ex);
            m.SetTriangles(idx, 0);
            m.RecalculateBounds();
            return m;
        }
    }

    public struct CrownStyle
    {
        public int Seed, Cards;
        public float Size, Bottom, Top, Aspect;
        public Color Base, Sunlit;
        public Vector3 Centre;
        public Rect Uv;
    }

    public static class Crown
    {
        /// <summary>Облако листовых карточек на эллипсоиде (как blob() в TS).</summary>
        public static void Blob(GeoBuilder b, Vector3 c, Vector3 radii, CrownStyle s, int index)
        {
            for (int k = 0; k < s.Cards; k++)
            {
                float u = R.Rand(s.Seed, index, k, 1) * Mathf.PI * 2;
                float y = R.Rand(s.Seed, index, k, 2) * 1.45f - 0.45f;
                float r = Mathf.Sqrt(Mathf.Max(0, 1 - y * y));
                var dir = new Vector3(Mathf.Cos(u) * r, y, Mathf.Sin(u) * r);
                float depth = 0.7f + R.Rand(s.Seed, index, k, 3) * 0.32f;
                var p = c + Vector3.Scale(dir, radii) * depth;
                var tmp = new Vector3(R.Rand(s.Seed, index, k, 4) - 0.5f, R.Rand(s.Seed, index, k, 5) - 0.5f, R.Rand(s.Seed, index, k, 6) - 0.5f);
                var right = Vector3.Cross(dir, tmp).normalized;
                var up = (Vector3.Cross(right, dir) + new Vector3(0, 0.55f, 0)).normalized;
                float size = s.Size * (0.75f + R.Rand(s.Seed, index, k, 7) * 0.5f);
                right *= size;
                up *= size * (s.Aspect > 0 ? s.Aspect : 1);
                var shade = ((p - s.Centre).normalized + new Vector3(0, 0.35f, 0)).normalized;
                float h = Mathf.Clamp01((p.y - s.Bottom) / (s.Top - s.Bottom));
                float light = (0.55f + 0.55f * h) * (0.8f + 0.2f * depth) * (0.9f + R.Rand(s.Seed, index, k, 8) * 0.2f);
                var cc = Color.Lerp(s.Base, s.Sunlit, h * 0.6f + R.Rand(s.Seed, index, k, 9) * 0.22f) * light;
                float sw = 0.05f + h * 0.12f;
                b.Card(p, right, up, shade, cc * 0.84f, cc * 1.06f, sw, sw * 1.5f, R.Rand(s.Seed, index, k, 10), s.Uv);
            }
        }
    }
}
