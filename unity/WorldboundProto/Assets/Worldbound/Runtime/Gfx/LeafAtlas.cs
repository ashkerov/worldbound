// Атлас листвы, нарисованный кодом (перенос src/render/flora/textures.ts): плитки 256×256, 4 × 2,
// оттенки серого — цвет дают вершины. Листья собраны в округлую гроздь: вдали крона — облако, а не квадраты.

using UnityEngine;

namespace Worldbound.Gfx
{
    public enum LeafTile { Oak = 0, Birch = 1, Linden = 2, Willow = 3, Spruce = 4, Pine = 5, Grass = 6, Petal = 7 }

    public static class LeafAtlas
    {
        const int S = 256, Cols = 4, Rows = 2;

        public static Rect Uv(LeafTile t)
        {
            int i = (int)t, cx = i % Cols, cy = i / Cols;
            float pad = 2f / (S * Cols);
            return Rect.MinMaxRect(cx / (float)Cols + pad, 1 - (cy + 1) / (float)Rows + pad, (cx + 1) / (float)Cols - pad, 1 - cy / (float)Rows - pad);
        }

        public static Texture2D Build()
        {
            int w = S * Cols, h = S * Rows;
            var px = new Color32[w * h];
            for (int t = 0; t < Cols * Rows; t++) DrawTile(px, w, (LeafTile)t, (t % Cols) * S, h - (t / Cols + 1) * S);
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, true, false) { name = "LeafAtlas", wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Trilinear, anisoLevel = 4 };
            tex.SetPixels32(px);
            tex.Apply(true, true);
            return tex;
        }

        static void Blend(Color32[] px, int w, int x, int y, float v, float a)
        {
            if (a <= 0) return;
            int i = y * w + x;
            var c = px[i];
            float na = a + c.a / 255f * (1 - a);
            byte g = (byte)Mathf.Clamp(Mathf.RoundToInt((v * a + c.r / 255f * c.a / 255f * (1 - a)) / Mathf.Max(1e-4f, na) * 255), 0, 255);
            px[i] = new Color32(g, g, g, (byte)Mathf.RoundToInt(na * 255));
        }

        /// <summary>Лист — эллипс (заострённый на концах) с прожилкой; координаты плитки.</summary>
        static void Leaf(Color32[] px, int w, int ox, int oy, float cx, float cy, float len, float wid, float ang, float shade)
        {
            float ca = Mathf.Cos(ang), sa = Mathf.Sin(ang);
            int r = Mathf.CeilToInt(len);
            for (int y = -r; y <= r; y++)
                for (int x = -r; x <= r; x++)
                {
                    int X = Mathf.RoundToInt(cx) + x, Y = Mathf.RoundToInt(cy) + y;
                    if (X < 1 || Y < 1 || X >= S - 1 || Y >= S - 1) continue;
                    float u = (x * ca + y * sa) / (len * 0.5f), v = (-x * sa + y * ca) / (wid * 0.5f);
                    float widthAt = 1 - u * u;
                    if (widthAt <= 0) continue;
                    float d = v * v / (widthAt * widthAt);
                    if (d > 1) continue;
                    float edge = Mathf.Clamp01((1 - d) * 4);
                    float vein = Mathf.Abs(v) < 0.08f ? 0.82f : 1f;
                    Blend(px, w, ox + X, oy + Y, shade * (0.8f + 0.2f * u) * vein, edge);
                }
        }

        static void Line(Color32[] px, int w, int ox, int oy, Vector2 a, Vector2 b, float width, float shade)
        {
            int steps = Mathf.CeilToInt(Vector2.Distance(a, b) * 1.5f);
            for (int i = 0; i <= steps; i++)
            {
                var p = Vector2.Lerp(a, b, i / (float)steps);
                int r = Mathf.CeilToInt(width);
                for (int y = -r; y <= r; y++)
                    for (int x = -r; x <= r; x++)
                    {
                        int X = Mathf.RoundToInt(p.x) + x, Y = Mathf.RoundToInt(p.y) + y;
                        if (X < 0 || Y < 0 || X >= S || Y >= S) continue;
                        float d = Mathf.Sqrt(x * x + y * y) / width;
                        if (d < 1) Blend(px, w, ox + X, oy + Y, shade, Mathf.Clamp01((1 - d) * 3));
                    }
            }
        }

        static void DrawTile(Color32[] px, int w, LeafTile t, int ox, int oy)
        {
            int seed = 900 + (int)t;
            if (t == LeafTile.Spruce || t == LeafTile.Pine)
            {
                // Хвойная лапа: побег и хвоя по обе стороны (ель — короткая густая, сосна — длинные пучки).
                Line(px, w, ox, oy, new Vector2(S / 2f, 4), new Vector2(S / 2f, S - 10), 3, 0.55f);
                int needles = t == LeafTile.Spruce ? 170 : 90;
                for (int i = 0; i < needles; i++)
                {
                    float y = 10 + R.Rand(seed, i, 1) * (S - 20);
                    float side = i % 2 == 0 ? 1 : -1;
                    float along = 0.25f + 0.75f * (1 - y / S);
                    float reach = t == LeafTile.Pine ? S * 0.42f * (0.75f + R.Rand(seed, i, 2) * 0.3f) : S * 0.44f * along * (0.7f + R.Rand(seed, i, 2) * 0.4f);
                    float lift = t == LeafTile.Pine ? 0.9f : 0.55f;
                    Line(px, w, ox, oy, new Vector2(S / 2f, y), new Vector2(S / 2f + side * reach, y + reach * lift), t == LeafTile.Pine ? 1.4f : 2.4f, 0.7f + R.Rand(seed, i, 3) * 0.3f);
                }
                return;
            }
            if (t == LeafTile.Grass)
            {
                for (int i = 0; i < 26; i++)
                {
                    float x = S * (0.15f + R.Rand(seed, i, 1) * 0.7f);
                    float hgt = S * (0.5f + R.Rand(seed, i, 2) * 0.45f);
                    Line(px, w, ox, oy, new Vector2(x, 2), new Vector2(x + (R.Rand(seed, i, 3) - 0.5f) * 60, hgt), 2.6f, 0.75f + R.Rand(seed, i, 4) * 0.25f);
                }
                return;
            }
            if (t == LeafTile.Petal)
            {
                for (int i = 0; i < 7; i++) Leaf(px, w, ox, oy, S / 2f + Mathf.Cos(i * 0.9f) * 50, S / 2f + Mathf.Sin(i * 0.9f) * 50, 110, 46, i * 0.9f, 1);
                return;
            }
            (int count, float len, float wid) = t switch
            {
                LeafTile.Oak => (18, 0.3f, 0.2f),
                LeafTile.Birch => (27, 0.19f, 0.12f),
                LeafTile.Linden => (19, 0.25f, 0.21f),
                _ => (29, 0.32f, 0.08f), // Willow
            };
            for (int i = 0; i < count; i++)
            {
                float a = R.Rand(seed, i, 1) * Mathf.PI * 2;
                float rr = Mathf.Sqrt(R.Rand(seed, i, 2)) * 0.36f * (0.85f + 0.25f * Mathf.Sin(a * 3 + (int)t));
                float l = S * len * (0.8f + R.Rand(seed, i, 3) * 0.3f);
                float inner = 1 - rr / 0.36f;
                Leaf(px, w, ox, oy, S * (0.5f + Mathf.Cos(a) * rr), S * (0.5f + Mathf.Sin(a) * rr), l, S * wid * (0.85f + R.Rand(seed, i, 4) * 0.3f), a + Mathf.PI / 2 + (R.Rand(seed, i, 5) - 0.5f) * 1.6f, (0.72f + R.Rand(seed, i, 6) * 0.2f) * (1 - inner * 0.18f));
            }
        }
    }
}
