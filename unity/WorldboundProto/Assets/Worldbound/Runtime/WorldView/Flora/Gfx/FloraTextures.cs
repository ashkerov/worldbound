// Текстуры растительности, нарисованные кодом (собственная работа проекта, внешних файлов нет):
// атлас листвы 4 × 4 плитки по 256 px — веточки с листьями своей формы у каждого вида, хвоя, пучок травы,
// клевер, черника, иван-чай, ковыль, лепестки. Яркость — в RGB (цвет даёт вершина), покрытие — в альфе.
// Мип-уровни строятся с сохранением покрытия (иначе кроны «тают» вдали при отсечении по альфе).
// Плюс бесшовная текстура шума порывов ветра.

using System;
using UnityEngine;

namespace Worldbound.FloraView
{
    public enum LeafTile { Oak = 0, Birch, Linden, Alder, Hazel, Willow, Rose, Spruce, Pine, Juniper, GrassClump, Clover, Bilberry, Fireweed, Feather, Petals }

    public static class FloraTextures
    {
        const int S = 256, Cols = 4, Rows = 4, W = S * Cols, H = S * Rows;
        public const float Cutoff = 0.5f;

        public static Rect Uv(LeafTile t)
        {
            int i = (int)t, cx = i % Cols, cy = i / Cols;
            float pad = 1.5f / W;
            return Rect.MinMaxRect(cx / (float)Cols + pad, 1 - (cy + 1) / (float)Rows + pad, (cx + 1) / (float)Cols - pad, 1 - cy / (float)Rows - pad);
        }

        // ───────── атлас ─────────

        public static Texture2D BuildLeafAtlas(bool compress = true)
        {
            var g = new float[W * H];
            var a = new float[W * H];
            for (int i = 0; i < g.Length; i++) g[i] = 0.8f; // цвет под прозрачными пикселями — без тёмной каймы в мипах
            for (int t = 0; t < Cols * Rows; t++) Paint(g, a, (LeafTile)t, (t % Cols) * S, H - (t / Cols + 1) * S);
            int mips = 1 + (int)Math.Log(W, 2);
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, mips, false) { name = "FloraLeafAtlas", wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Trilinear, anisoLevel = 4 };
            // Целевое покрытие каждой плитки на нулевом уровне.
            var cover = new float[Cols * Rows];
            for (int t = 0; t < cover.Length; t++) cover[t] = Coverage(a, W, (t % Cols) * S, (t / Cols) * S, S, 1);
            float[] cg = g, ca = a;
            int w = W;
            for (int m = 0; m < mips; m++)
            {
                if (m > 0)
                {
                    int nw = w / 2;
                    var ng = new float[nw * nw];
                    var na = new float[nw * nw];
                    for (int y = 0; y < nw; y++)
                        for (int x = 0; x < nw; x++)
                        {
                            int i0 = 2 * y * w + 2 * x;
                            float a0 = ca[i0], a1 = ca[i0 + 1], a2 = ca[i0 + w], a3 = ca[i0 + w + 1];
                            float sa = a0 + a1 + a2 + a3;
                            na[y * nw + x] = sa * 0.25f;
                            ng[y * nw + x] = sa > 1e-4f ? (cg[i0] * a0 + cg[i0 + 1] * a1 + cg[i0 + w] * a2 + cg[i0 + w + 1] * a3) / sa : 0.8f;
                        }
                    cg = ng; ca = na; w = nw;
                    // Сохранение покрытия: подбор множителя альфы для каждой плитки.
                    int ts = w / Cols;
                    if (ts >= 2)
                        for (int t = 0; t < cover.Length; t++)
                        {
                            float lo = 1, hi = 8;
                            for (int it = 0; it < 10; it++)
                            {
                                float mid = (lo + hi) * 0.5f;
                                if (Coverage(ca, w, (t % Cols) * ts, (t / Cols) * ts, ts, mid) < cover[t]) lo = mid; else hi = mid;
                            }
                            float k = (lo + hi) * 0.5f;
                            for (int y = 0; y < ts; y++)
                                for (int x = 0; x < ts; x++) { int i = ((t / Cols) * ts + y) * w + (t % Cols) * ts + x; ca[i] = Mathf.Min(1, ca[i] * k); }
                        }
                }
                var px = new Color32[w * w];
                for (int i = 0; i < px.Length; i++)
                {
                    byte v = (byte)Mathf.Clamp(Mathf.RoundToInt(cg[i] * 255), 0, 255);
                    px[i] = new Color32(v, v, v, (byte)Mathf.Clamp(Mathf.RoundToInt(ca[i] * 255), 0, 255));
                }
                tex.SetPixels32(px, m);
            }
            tex.Apply(false, false);
            if (compress) tex.Compress(true);
            tex.Apply(false, true);
            return tex;
        }

        static float Coverage(float[] a, int w, int ox, int oy, int size, float k)
        {
            int n = 0;
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++) if (a[(oy + y) * w + ox + x] * k > Cutoff) n++;
            return n / (float)(size * size);
        }

        static void Blend(float[] g, float[] a, int x, int y, float v, float alpha)
        {
            if (alpha <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
            int i = y * W + x;
            float na = alpha + a[i] * (1 - alpha);
            g[i] = (v * alpha + g[i] * a[i] * (1 - alpha)) / Mathf.Max(1e-4f, na);
            a[i] = na;
        }

        delegate float Shape(float u);

        /// <summary>Лист: профиль полуширины shape(u), u ∈ [−1, 1] от основания к кончику; прожилка и мягкий край.</summary>
        static void Leaf(float[] g, float[] a, int ox, int oy, Vector2 c, float len, float wid, float ang, float shade, Shape shape, bool veins = true)
        {
            float ca = Mathf.Cos(ang), sa = Mathf.Sin(ang);
            int r = Mathf.CeilToInt(len * 0.55f + 2);
            for (int y = -r; y <= r; y++)
                for (int x = -r; x <= r; x++)
                {
                    float u = (x * ca + y * sa) / (len * 0.5f), v = (-x * sa + y * ca) / (wid * 0.5f);
                    if (u <= -1 || u >= 1) continue;
                    float hw = shape(u);
                    if (hw <= 0.001f) continue;
                    float d = Mathf.Abs(v) / hw;
                    if (d > 1) continue;
                    float edge = Mathf.Clamp01((1 - d) * hw * wid * 0.45f);
                    float tone = shade * (0.86f + 0.14f * (1 - d)) * (0.9f + 0.1f * u);
                    if (veins)
                    {
                        if (Mathf.Abs(v) < 0.06f) tone *= 0.8f;
                        else if (Mathf.Abs(Mathf.Repeat(u * 3.5f - Mathf.Abs(v) * 1.6f, 1) - 0.5f) < 0.06f) tone *= 0.9f;
                    }
                    Blend(g, a, ox + Mathf.RoundToInt(c.x) + x, oy + Mathf.RoundToInt(c.y) + y, tone, edge);
                }
        }

        static void Line(float[] g, float[] a, int ox, int oy, Vector2 p0, Vector2 p1, float w0, float w1, float shade)
        {
            float len = Vector2.Distance(p0, p1);
            int steps = Mathf.Max(2, Mathf.CeilToInt(len * 1.5f));
            for (int i = 0; i <= steps; i++)
            {
                float t = i / (float)steps;
                var p = Vector2.Lerp(p0, p1, t);
                float w = Mathf.Lerp(w0, w1, t);
                int r = Mathf.CeilToInt(w + 1);
                for (int y = -r; y <= r; y++)
                    for (int x = -r; x <= r; x++)
                    {
                        float d = Mathf.Sqrt(x * x + y * y) / Mathf.Max(0.3f, w);
                        if (d < 1) Blend(g, a, ox + Mathf.RoundToInt(p.x) + x, oy + Mathf.RoundToInt(p.y) + y, shade * (0.9f + 0.1f * (1 - d)), Mathf.Clamp01((1 - d) * w * 1.2f));
                    }
            }
        }

        static float R(int t, int i, int k) => FloraHash.F(700 + t, i, k);

        static readonly Shape Ellipse = u => Mathf.Sqrt(1 - u * u);
        static readonly Shape Ovate = u => Mathf.Sqrt(1 - u * u) * (1 - 0.3f * u);
        static readonly Shape Obovate = u => Mathf.Sqrt(1 - u * u) * (1 + 0.25f * u) * (u > 0.85f ? 0.7f : 1);
        static readonly Shape Lanceolate = u => Mathf.Pow(1 - u * u, 0.9f) * (1 - 0.15f * u);
        static readonly Shape OakLobes = u => Mathf.Sqrt(1 - u * u) * (0.62f + 0.38f * Mathf.Abs(Mathf.Sin((u + 1) * Mathf.PI * 2.3f))) * (1 + 0.15f * u);
        static Shape Serrated(Shape s, float teeth, float depth) => u => s(u) * (1 - depth * Mathf.Abs(Mathf.Sin(u * teeth)));
        static readonly Shape Cordate = u => Mathf.Sqrt(1 - u * u) * (1 - 0.35f * u) * (u < -0.82f ? 0.75f : 1);

        /// <summary>Веточка: стебель снизу вверх с листьями поочерёдно (основа плиток лиственных).</summary>
        static void Spray(float[] g, float[] a, int t, int ox, int oy, int leaves, float len, float wid, float spread, Shape shape, float stemShade = 0.55f, float droop = 0)
        {
            var b = new Vector2(S * 0.5f, 6);
            var tip = new Vector2(S * (0.5f + (R(t, 0, 1) - 0.5f) * 0.12f), S * 0.92f);
            Line(g, a, ox, oy, b, tip, 2.2f, 1.1f, stemShade);
            // Боковые веточки.
            var side = new[] { (0.28f, -1f), (0.45f, 1f), (0.6f, -1f) };
            foreach (var (at, dir) in side)
            {
                var p = Vector2.Lerp(b, tip, at);
                var q = p + new Vector2(dir * S * 0.3f * spread, S * 0.2f);
                Line(g, a, ox, oy, p, q, 1.4f, 0.8f, stemShade);
            }
            for (int i = 0; i < leaves; i++)
            {
                float f = (i + 0.5f) / leaves;
                bool onSide = R(t, i, 2) < 0.45f;
                Vector2 basePt;
                float dir = i % 2 == 0 ? 1 : -1;
                if (onSide)
                {
                    var (at, sd) = side[i % side.Length];
                    var p = Vector2.Lerp(b, tip, at);
                    basePt = Vector2.Lerp(p, p + new Vector2(sd * S * 0.3f * spread, S * 0.2f), 0.4f + R(t, i, 3) * 0.6f);
                    dir = sd;
                }
                else basePt = Vector2.Lerp(b, tip, 0.15f + f * 0.85f);
                float l = len * (0.8f + R(t, i, 4) * 0.35f) * (onSide ? 0.9f : 1 - 0.25f * f);
                float ang = Mathf.PI * 0.5f - dir * (0.55f + R(t, i, 5) * 0.6f) * spread - droop * dir;
                var c = basePt + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * l * 0.5f;
                Leaf(g, a, ox, oy, c, l, wid * (0.85f + R(t, i, 6) * 0.3f), ang, 0.74f + R(t, i, 7) * 0.24f, shape);
            }
            // Верхушечный лист.
            Leaf(g, a, ox, oy, tip + new Vector2(0, len * 0.3f), len * 0.8f, wid * 0.85f, Mathf.PI * 0.5f, 0.9f, shape);
        }

        static void Needles(float[] g, float[] a, int t, int ox, int oy, int count, float reachK, float lift, float width, float shade, bool tufts)
        {
            var b = new Vector2(S * 0.5f, 4);
            var tip = new Vector2(S * 0.5f, S - 8);
            Line(g, a, ox, oy, b, tip, 3, 1.5f, 0.45f);
            if (!tufts)
            {
                for (int i = 0; i < count; i++)
                {
                    float y = 10 + R(t, i, 1) * (S - 22);
                    float side = i % 2 == 0 ? 1 : -1;
                    float along = 0.35f + 0.65f * (1 - y / S);
                    float reach = S * reachK * along * (0.75f + R(t, i, 2) * 0.4f);
                    var p = new Vector2(S * 0.5f, y);
                    Line(g, a, ox, oy, p, p + new Vector2(side * reach, reach * lift), width, width * 0.5f, shade * (0.75f + R(t, i, 3) * 0.3f));
                }
            }
            else
            {
                // Сосна: пучки длинных хвоинок, расходящиеся веером от побегов.
                for (int k = 0; k < 4; k++)
                {
                    var c = new Vector2(S * (0.3f + 0.4f * R(t, k, 9)), S * (0.25f + 0.17f * k));
                    Line(g, a, ox, oy, new Vector2(S * 0.5f, c.y - 20), c, 2, 1.4f, 0.45f);
                    for (int i = 0; i < count / 4; i++)
                    {
                        float ang = Mathf.PI * (0.1f + 0.8f * R(t, k * 100 + i, 4));
                        float reach = S * reachK * (0.6f + R(t, k * 100 + i, 5) * 0.4f);
                        Line(g, a, ox, oy, c, c + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * reach, width, width * 0.4f, shade * (0.8f + R(t, k * 100 + i, 6) * 0.25f));
                    }
                }
            }
        }

        static void Paint(float[] g, float[] a, LeafTile tile, int ox, int oy)
        {
            int t = (int)tile;
            switch (tile)
            {
                case LeafTile.Oak: Spray(g, a, t, ox, oy, 17, S * 0.25f, S * 0.15f, 0.95f, OakLobes); break;
                case LeafTile.Birch: Spray(g, a, t, ox, oy, 28, S * 0.14f, S * 0.1f, 1.1f, Serrated(Ovate, 26, 0.12f), 0.5f, 0.5f); break;
                case LeafTile.Linden: Spray(g, a, t, ox, oy, 18, S * 0.2f, S * 0.18f, 0.95f, Serrated(Cordate, 22, 0.06f)); break;
                case LeafTile.Alder: Spray(g, a, t, ox, oy, 18, S * 0.19f, S * 0.17f, 0.95f, Serrated(Obovate, 18, 0.07f)); break;
                case LeafTile.Hazel: Spray(g, a, t, ox, oy, 18, S * 0.2f, S * 0.17f, 1f, Serrated(Ellipse, 30, 0.08f)); break;
                case LeafTile.Willow: Spray(g, a, t, ox, oy, 26, S * 0.3f, S * 0.07f, 1.2f, Lanceolate, 0.5f, 0.35f); break;
                case LeafTile.Rose:
                    // Непарноперистые листья: мелкие листочки парами вдоль черешков.
                    Line(g, a, ox, oy, new Vector2(S * 0.5f, 4), new Vector2(S * 0.5f, S - 10), 2, 1, 0.5f);
                    for (int k = 0; k < 5; k++)
                    {
                        float y0 = S * (0.18f + k * 0.16f), dir = k % 2 == 0 ? 1 : -1;
                        var p0 = new Vector2(S * 0.5f, y0);
                        var p1 = p0 + new Vector2(dir * S * 0.32f, S * 0.12f);
                        Line(g, a, ox, oy, p0, p1, 1.2f, 0.7f, 0.5f);
                        for (int j = 0; j < 5; j++)
                        {
                            var q = Vector2.Lerp(p0, p1, (j + 1) / 5.5f);
                            float ang = Mathf.Atan2(p1.y - p0.y, p1.x - p0.x);
                            for (int s2 = -1; s2 <= 1; s2 += 2) Leaf(g, a, ox, oy, q + new Vector2(-Mathf.Sin(ang), Mathf.Cos(ang)) * s2 * 9, 22, 12, ang + s2 * 1.1f, 0.75f + R(t, k * 10 + j, s2 + 2) * 0.2f, Serrated(Ellipse, 20, 0.1f));
                        }
                        Leaf(g, a, ox, oy, p1, 22, 13, Mathf.Atan2(p1.y - p0.y, p1.x - p0.x), 0.85f, Ellipse);
                    }
                    break;
                case LeafTile.Spruce: Needles(g, a, t, ox, oy, 230, 0.4f, 0.45f, 2.1f, 0.78f, false); break;
                case LeafTile.Pine: Needles(g, a, t, ox, oy, 120, 0.32f, 0, 1.2f, 0.8f, true); break;
                case LeafTile.Juniper:
                    // Короткие колючие хвоинки мутовками по многим побегам.
                    for (int k = 0; k < 5; k++)
                    {
                        var p0 = new Vector2(S * 0.5f, 4);
                        var p1 = new Vector2(S * (0.2f + 0.15f * k), S * (0.6f + 0.35f * R(t, k, 1)));
                        Line(g, a, ox, oy, p0, p1, 2, 1, 0.45f);
                        for (int i = 0; i < 40; i++)
                        {
                            var q = Vector2.Lerp(p0, p1, 0.2f + 0.8f * R(t, k * 50 + i, 2));
                            float ang = R(t, k * 50 + i, 3) * Mathf.PI * 2;
                            Line(g, a, ox, oy, q, q + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * 13, 1.6f, 0.6f, 0.7f + R(t, k * 50 + i, 4) * 0.25f);
                        }
                    }
                    break;
                case LeafTile.GrassClump:
                    for (int i = 0; i < 46; i++)
                    {
                        float x = S * (0.08f + R(t, i, 1) * 0.84f);
                        float h = S * (0.35f + R(t, i, 2) * 0.6f);
                        float lean = (R(t, i, 3) - 0.5f) * 70;
                        Line(g, a, ox, oy, new Vector2(x, 2), new Vector2(x + lean * 0.5f, h * 0.6f), 2.6f, 2f, 0.62f + R(t, i, 4) * 0.2f);
                        Line(g, a, ox, oy, new Vector2(x + lean * 0.5f, h * 0.6f), new Vector2(x + lean, h), 2f, 0.6f, 0.78f + R(t, i, 4) * 0.2f);
                    }
                    break;
                case LeafTile.Clover:
                    // Тройчатые листья с белым «шевроном».
                    for (int i = 0; i < 9; i++)
                    {
                        var c = new Vector2(S * (0.18f + 0.64f * R(t, i, 1)), S * (0.18f + 0.64f * R(t, i, 2)));
                        float rot = R(t, i, 3) * Mathf.PI * 2;
                        for (int k = 0; k < 3; k++)
                        {
                            float ang = rot + k * Mathf.PI * 2 / 3;
                            var lc = c + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * 16;
                            Leaf(g, a, ox, oy, lc, 34, 30, ang, 0.82f + R(t, i, 4 + k) * 0.12f, Obovate, false);
                            Leaf(g, a, ox, oy, lc - new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * 2, 16, 6, ang + 1.57f, 1f, Ellipse, false);
                        }
                    }
                    break;
                case LeafTile.Bilberry: Spray(g, a, t, ox, oy, 18, S * 0.16f, S * 0.11f, 1.3f, Ellipse, 0.45f); break;
                case LeafTile.Fireweed:
                    Line(g, a, ox, oy, new Vector2(S * 0.5f, 2), new Vector2(S * 0.5f, S - 4), 2.5f, 1.2f, 0.5f);
                    for (int i = 0; i < 16; i++)
                    {
                        float y = S * (0.08f + i * 0.055f), dir = i % 2 == 0 ? 1 : -1;
                        float l = S * (0.36f - i * 0.013f);
                        float ang = Mathf.PI * 0.5f - dir * (0.95f - i * 0.02f);
                        Leaf(g, a, ox, oy, new Vector2(S * 0.5f, y) + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * l * 0.5f, l, l * 0.17f, ang, 0.8f, Lanceolate);
                    }
                    break;
                case LeafTile.Feather:
                    // Перистые ости ковыля: длинные шелковистые волоски.
                    for (int i = 0; i < 9; i++)
                    {
                        float x0 = S * (0.35f + 0.3f * R(t, i, 1));
                        var p = new Vector2(x0, 4);
                        for (int k = 0; k < 24; k++)
                        {
                            float f = k / 24f;
                            var q = p + new Vector2((0.6f + R(t, i, 2)) * 4.2f * f, 9.5f);
                            Line(g, a, ox, oy, p, q, 0.8f, 0.8f, 0.85f);
                            if (k > 4) for (int s2 = -1; s2 <= 1; s2 += 2) Line(g, a, ox, oy, q, q + new Vector2(s2 * 7 * (1 - f * 0.6f), 2), 0.6f, 0.3f, 0.95f);
                            p = q;
                        }
                    }
                    break;
                case LeafTile.Petals:
                    for (int k = 0; k < 4; k++)
                    {
                        var c = new Vector2(S * (k % 2 == 0 ? 0.28f : 0.72f), S * (k < 2 ? 0.28f : 0.72f));
                        int n = 5 + k;
                        for (int i = 0; i < n; i++)
                        {
                            float ang = i * Mathf.PI * 2 / n;
                            Leaf(g, a, ox, oy, c + new Vector2(Mathf.Cos(ang), Mathf.Sin(ang)) * 24, 50, 26, ang, 0.95f, Obovate, false);
                        }
                    }
                    break;
            }
        }

        // ───────── шум порывов ─────────

        /// <summary>Бесшовный шум 64 × 64 (R — крупные порывы, G — мелкая рябь).</summary>
        public static Texture2D BuildGustNoise()
        {
            const int N = 64;
            var px = new Color32[N * N];
            for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float r = Tile(11, x, y, N, 8), g = Tile(23, x, y, N, 16);
                    px[y * N + x] = new Color32((byte)(r * 255), (byte)(g * 255), 0, 255);
                }
            var t = new Texture2D(N, N, TextureFormat.RGBA32, true, true) { name = "FloraGust", wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Bilinear };
            t.SetPixels32(px);
            t.Apply(true, true);
            return t;
        }

        static float Tile(int seed, int x, int y, int n, int period)
        {
            float fx = x * period / (float)n, fy = y * period / (float)n;
            int xi = Mathf.FloorToInt(fx), yi = Mathf.FloorToInt(fy);
            float u = fx - xi, v = fy - yi;
            u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
            float a = FloraHash.F(seed, xi % period, yi % period), b = FloraHash.F(seed, (xi + 1) % period, yi % period);
            float c = FloraHash.F(seed, xi % period, (yi + 1) % period), d = FloraHash.F(seed, (xi + 1) % period, (yi + 1) % period);
            return Mathf.Lerp(Mathf.Lerp(a, b, u), Mathf.Lerp(c, d, u), v);
        }
    }
}
