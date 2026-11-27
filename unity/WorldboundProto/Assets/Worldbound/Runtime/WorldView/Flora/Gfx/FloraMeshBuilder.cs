// Построитель процедурной геометрии растений. Формат вершины, общий для шейдеров WB/Flora*:
//   POSITION, NORMAL;
//   COLOR     — rgb: базовый (летний) цвет, a: затенение в глубине кроны (AO, 1 — открыто);
//   TEXCOORD0 — листва: uv атласа листьев; кора: (обхват 0..1, длина вдоль ветви в метрах) для процедурной коры;
//   TEXCOORD1 — x: гибкость (вес качания 0..1), y: часть (0 кора, 1 листва, 2 цветки, 3 плоды),
//               z: случайное число карточки (порядок опадания и смены цвета), w: доля высоты растения 0..1.

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.FloraView
{
    public static class FloraPart
    {
        public const float Bark = 0, Leaf = 1, Flower = 2, Fruit = 3;
    }

    public sealed class FloraMeshBuilder
    {
        readonly List<Vector3> pos = new(4096);
        readonly List<Vector3> nor = new(4096);
        readonly List<Color> col = new(4096);
        readonly List<Vector2> uv = new(4096);
        readonly List<Vector4> ex = new(4096);
        readonly List<int> idx = new(8192);
        /// <summary>Высота растения для нормировки w (доля высоты).</summary>
        public float RefHeight = 1;

        public int Triangles => idx.Count / 3;
        public int Vertices => pos.Count;

        public int Vertex(Vector3 p, Vector3 n, Color c, Vector2 t, float sway, float part, float rnd)
        {
            pos.Add(p); nor.Add(n); col.Add(c); uv.Add(t);
            ex.Add(new Vector4(sway, part, rnd, Mathf.Clamp01(p.y / Mathf.Max(0.01f, RefHeight))));
            return pos.Count - 1;
        }

        public void Tri(int a, int b, int c) { idx.Add(a); idx.Add(b); idx.Add(c); }

        /// <summary>Листовая карточка: прямоугольник (центр, полуоси right/up), нормаль объёма кроны, цвет снизу/сверху.</summary>
        public void Card(Vector3 c, Vector3 right, Vector3 up, Vector3 normal, Color lo, Color hi, float swayLo, float swayHi, float rnd, Rect uvr, float part = 1)
        {
            int a = Vertex(c - right - up, normal, lo, new Vector2(uvr.xMin, uvr.yMin), swayLo, part, rnd);
            int b = Vertex(c + right - up, normal, lo, new Vector2(uvr.xMax, uvr.yMin), swayLo, part, rnd);
            int d = Vertex(c + right + up, normal, hi, new Vector2(uvr.xMax, uvr.yMax), swayHi, part, rnd);
            int e = Vertex(c - right + up, normal, hi, new Vector2(uvr.xMin, uvr.yMax), swayHi, part, rnd);
            Tri(a, b, d); Tri(a, d, e);
        }

        /// <summary>
        /// Ветвь или ствол: трубка по сглаженной кривой с переносом системы координат (без скручивания).
        /// radius(t), sway(t) — по доле длины; color(p, t).
        /// </summary>
        public void Tube(IList<Vector3> ctrl, int sides, int segments, Func<float, float> radius, Func<float, float> sway, Func<Vector3, float, Color> color, float rnd = 0, bool cap = true)
        {
            int n = Mathf.Max(1, segments);
            var pts = new Vector3[n + 1];
            for (int i = 0; i <= n; i++) pts[i] = Catmull(ctrl, i / (float)n);
            float length = 0;
            var along = new float[n + 1];
            for (int i = 1; i <= n; i++) { length += Vector3.Distance(pts[i - 1], pts[i]); along[i] = length; }
            Vector3 tan0 = (pts[1] - pts[0]).normalized;
            Vector3 side = Vector3.Cross(tan0, Mathf.Abs(tan0.y) > 0.9f ? Vector3.right : Vector3.up).normalized;
            int baseIndex = pos.Count;
            for (int i = 0; i <= n; i++)
            {
                Vector3 tan = (i < n ? pts[i + 1] - pts[i] : pts[i] - pts[i - 1]).normalized;
                if (i > 0 && i < n) tan = ((pts[i + 1] - pts[i]).normalized + (pts[i] - pts[i - 1]).normalized).normalized;
                side = (side - tan * Vector3.Dot(side, tan)).normalized; // перенос рамки
                Vector3 fwd = Vector3.Cross(tan, side);
                float t = i / (float)n, r = radius(t), s = sway(t);
                for (int k = 0; k <= sides; k++)
                {
                    float a = k * Mathf.PI * 2 / sides;
                    Vector3 nr = side * Mathf.Cos(a) + fwd * Mathf.Sin(a);
                    Vector3 p = pts[i] + nr * r;
                    Vertex(p, nr, color(p, t), new Vector2(k / (float)sides, along[i]), s, FloraPart.Bark, rnd);
                }
            }
            for (int i = 0; i < n; i++)
                for (int k = 0; k < sides; k++)
                {
                    int a = baseIndex + i * (sides + 1) + k, b = a + sides + 1;
                    Tri(a, b, a + 1); Tri(a + 1, b, b + 1);
                }
            if (cap && radius(1) > 0.004f)
            {
                // Торец конца ветви — конус в точку (без дырок в силуэте вблизи).
                Vector3 tip = pts[n] + (pts[n] - pts[n - 1]).normalized * radius(1) * 1.5f;
                int ti = Vertex(tip, (pts[n] - pts[n - 1]).normalized, color(tip, 1), new Vector2(0.5f, length), sway(1), FloraPart.Bark, rnd);
                int ring = baseIndex + n * (sides + 1);
                for (int k = 0; k < sides; k++) Tri(ring + k, ti, ring + k + 1);
            }
        }

        public static Vector3 Catmull(IList<Vector3> p, float t)
        {
            int n = p.Count - 1;
            if (n <= 0) return p[0];
            float f = Mathf.Clamp01(t) * n;
            int i = Mathf.Min(n - 1, Mathf.FloorToInt(f));
            float u = f - i;
            Vector3 p0 = p[Mathf.Max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Mathf.Min(n, i + 2)];
            return 0.5f * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
        }

        public Bounds Bounds()
        {
            if (pos.Count == 0) return new Bounds(Vector3.zero, Vector3.one);
            var b = new Bounds(pos[0], Vector3.zero);
            foreach (var p in pos) b.Encapsulate(p);
            return b;
        }

        public Mesh Build(string name)
        {
            var m = new Mesh { name = name, indexFormat = pos.Count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            m.SetVertices(pos); m.SetNormals(nor); m.SetColors(col); m.SetUVs(0, uv); m.SetUVs(1, ex);
            m.SetTriangles(idx, 0, true);
            m.UploadMeshData(true);
            return m;
        }
    }
}
