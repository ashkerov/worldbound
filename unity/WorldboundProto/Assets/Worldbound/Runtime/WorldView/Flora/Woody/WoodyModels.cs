// Процедурные модели древесных видов (собственная работа проекта). Каждый вид — свой скелет и своя крона:
//   ель — конус ярусов свисающих лап и шпиль; сосна — голый ствол с оранжевой корой и пучками хвои на вершине,
//   у старой — зонтик; берёза — белый ствол, крутые ветви с повислыми концами, ажурная крона; дуб — короткий
//   ствол, развилка на скелетные сучья, широкий шатёр; липа — правильный купол; ольха — часто многоствольная,
//   яйцевидная тёмная крона; лещина и ива — многоствольные кусты; шиповник — дуги побегов с цветками и плодами;
//   можжевельник — колонна. Возрастные архетипы (молодое, взрослое ×2, старое) — разные скелеты и пропорции.
// Уровни: 0 — полный скелет с побегами второго порядка и плотной листвой (видна зимняя графика ветвей);
// 1 — скелетные ветви и вчетверо меньше, но крупнее карточек; 2 — тот же силуэт десятком крупных карточек и простым
// стволом. Все уровни строятся из одних и тех же точек скелета — силуэт и цвет при смене уровня не скачут.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Worldbound.FloraView
{
    public static class WoodyModels
    {
        /// <summary>Тип рисунка коры для шейдера (TEXCOORD1.z у коры).</summary>
        const float BarkFurrowed = 0.05f, BarkSmooth = 0.3f, BarkBirch = 0.55f, BarkFlaky = 0.8f;

        static Color C(int hex) => new Color(((hex >> 16) & 255) / 255f, ((hex >> 8) & 255) / 255f, (hex & 255) / 255f).linear;
        static Vector3 V(float x, float y, float z) => new(x, y, z);

        sealed class Ctx
        {
            public FloraMeshBuilder B;
            public WoodyProfile P;
            public WoodyArchetype A;
            public int Lod, Seed;
            public float H, R;
            public Vector3 Centre;
            public float Bottom, Top;
            public Rect Uv;
            public float R01(int a, int b = 0, int c = 0) => FloraHash.F(Seed, a, b, c);
            public float Rs(int a, int b = 0, int c = 0) => FloraHash.F(Seed, a, b, c) * 2 - 1;
        }

        public static Mesh Build(WoodyProfile p, WoodyArchetype a, int lod)
        {
            var c = new Ctx { B = new FloraMeshBuilder { RefHeight = a.RefHeight }, P = p, A = a, Lod = lod, Seed = a.Seed * 7919 + 17, H = a.RefHeight, R = a.RefCrown, Uv = FloraTextures.Uv(p.Tile) };
            switch (p.Kind)
            {
                case WoodyKind.Spruce: Spruce(c); break;
                case WoodyKind.Pine: Pine(c); break;
                case WoodyKind.Juniper: Juniper(c); break;
                case WoodyKind.WildRose: Rose(c); break;
                default: Broadleaf(c, Params(p.Kind, a.Form)); break;
            }
            return c.B.Build($"{p.Key}-{a.Form}-{a.Seed}-lod{lod}");
        }

        // ───────── общие части ─────────

        /// <summary>Облако листовых карточек вокруг точки (гроздь на конце ветви). branchSway — гибкость места.</summary>
        static void Cluster(Ctx c, Vector3 at, Vector3 radii, int id, int cards0, float size0, float branchSway, float aspect = 1, Vector3? upBias = null)
        {
            int lod = c.Lod;
            (int n, float size, float depthMin) = lod switch
            {
                0 => (cards0, size0, 0.45f),
                1 => (Mathf.Max(3, Mathf.RoundToInt(cards0 * 0.27f)), size0 * 1.8f, 0.3f),
                _ => (Mathf.Max(2, Mathf.RoundToInt(cards0 * 0.1f)), size0 * 2.8f, 0.2f),
            };
            var bias = upBias ?? Vector3.up;
            for (int k = 0; k < n; k++)
            {
                float u = c.R01(id, k, 1) * Mathf.PI * 2, y = c.R01(id, k, 2) * 1.5f - 0.5f;
                float rr = Mathf.Sqrt(Mathf.Max(0, 1 - y * y));
                var dir = V(Mathf.Cos(u) * rr, y, Mathf.Sin(u) * rr);
                float depth = depthMin + (1 - depthMin) * Mathf.Sqrt(c.R01(id, k, 3));
                var p = at + Vector3.Scale(dir, radii) * depth;
                var outward = (p - c.Centre); outward.y *= 0.7f;
                outward = outward.sqrMagnitude > 1e-6f ? outward.normalized : Vector3.up;
                var n0 = (outward * 0.62f + dir * 0.38f + V(0, 0.28f, 0)).normalized;
                // Плоскость карточки: в основном лицом наружу, с разбросом.
                var cn = (dir * 0.7f + V(c.Rs(id, k, 4), c.Rs(id, k, 5), c.Rs(id, k, 6)) * 0.55f).normalized;
                var right = Vector3.Cross(cn, Mathf.Abs(cn.y) > 0.9f ? Vector3.right : Vector3.up).normalized;
                float roll = c.Rs(id, k, 7) * 0.9f;
                right = Quaternion.AngleAxis(roll * Mathf.Rad2Deg, cn) * right;
                var up = Vector3.Cross(right, cn).normalized;
                if (Vector3.Dot(up, bias) < 0) up = -up;
                float s = size * (0.75f + c.R01(id, k, 8) * 0.5f);
                float h = Mathf.Clamp01((p.y - c.Bottom) / Mathf.Max(0.1f, c.Top - c.Bottom));
                var baseC = Color.Lerp(c.P.LeafBase, c.P.LeafLit, Mathf.Clamp01(h * 0.42f + c.R01(id, k, 9) * 0.28f + Mathf.Max(0, outward.y) * 0.12f));
                float inner = Mathf.Clamp01(Vector3.Distance(p, c.Centre) / Mathf.Max(0.5f, c.R));
                float ao = Mathf.Clamp01(0.42f + 0.5f * inner + 0.2f * h);
                var lo = baseC * 0.86f; lo.a = ao * 0.92f;
                var hi = baseC * 1.04f; hi.a = Mathf.Min(1, ao * 1.05f);
                float sw = Mathf.Clamp01(branchSway * (0.8f + 0.2f * inner));
                c.B.Card(p, right * s, up * s * aspect, n0, lo, hi, sw * 0.85f, sw, c.R01(id, k, 10), c.Uv, FloraPart.Leaf);
            }
        }

        static void Trunk(Ctx c, List<Vector3> pts, float r0, float r1, float flare, int barkHex, float barkType, Func<Vector3, float, Color> colorOverride = null, float sway0 = 0, float sway1 = 0.05f)
        {
            bool shrub = c.P.Shrub;
            int sides = shrub ? (c.Lod == 0 ? 5 : c.Lod == 1 ? 4 : 3) : c.Lod == 0 ? 9 : c.Lod == 1 ? 6 : 4;
            int segs = shrub ? (c.Lod == 0 ? 5 : c.Lod == 1 ? 3 : 2) : c.Lod == 0 ? Math.Max(6, pts.Count * 3) : c.Lod == 1 ? Math.Max(4, pts.Count * 2) : 3;
            var bark = C(barkHex);
            int seed = c.Seed;
            c.B.Tube(pts, sides, segs,
                t => Mathf.Lerp(r0, r1, Mathf.Pow(t, 0.8f)) * (1 + flare * Mathf.Pow(Mathf.Max(0, 1 - t * 10), 2)),
                t => Mathf.Lerp(sway0, sway1, t),
                colorOverride ?? ((p, t) => bark * (0.82f + 0.25f * FloraHash.Noise(seed, p.y * 1.3f, Mathf.Atan2(p.z, p.x) * 2.5f))),
                barkType);
        }

        static void Branch(Ctx c, List<Vector3> pts, float r0, float r1, int barkHex, float barkType, float sway0, float sway1, int sides, int segs)
        {
            var bark = C(barkHex);
            c.B.Tube(pts, sides, segs, t => Mathf.Lerp(r0, r1, t), t => Mathf.Lerp(sway0, sway1, t), (p, t) => bark * (0.85f + 0.15f * t), barkType);
        }

        // ───────── лиственные деревья и кусты (общий скелет с параметрами вида) ─────────

        sealed class BroadParams
        {
            public float CrownBase;          // низ кроны, доля высоты
            public bool Excurrent = true;    // лидер до вершины (берёза, липа, ольха) или развилка (дуб)
            public int Stems = 1;            // многоствольность
            public float StemSpread;         // разлёт стволов у основания, м (кусты)
            public float StemLean;           // наклон стволов наружу, доля
            public int Primaries;            // скелетных ветвей на ствол (уровень 0)
            public float ElevLow, ElevHigh;  // угол ветвей над горизонтом внизу/вверху кроны, градусы
            public float Droop;              // повислость концов
            public Func<float, float> Envelope; // ширина кроны по высоте (0 низ … 1 верх кроны)
            public float ClusterR;           // радиус грозди, доля радиуса кроны
            public float ClusterV = 0.8f;    // вертикальная доля радиуса грозди
            public int ClusterCards;
            public float CardSize;
            public int Twigs = 2;            // побегов второго порядка на ветвь (уровень 0)
            public float TrunkR;             // радиус ствола у земли, доля высоты
            public int BarkHex;
            public float BarkType;
            public float Wiggle = 0.3f;      // извилистость ветвей
            public bool Hanging;             // свисающие грозди (берёза)
        }

        static float Ovoid(float u) => Mathf.Pow(Mathf.Sin(Mathf.PI * Mathf.Clamp01(u * 0.88f + 0.08f)), 0.75f);
        static float Dome(float u) { float d = (u - 0.38f) / (u < 0.38f ? 0.52f : 0.66f); return Mathf.Sqrt(Mathf.Max(0.04f, 1 - d * d)); }
        static float Cone(float u) => Mathf.Clamp01(1.05f - u * 0.95f);
        static float Vase(float u) => Mathf.Clamp01(0.35f + 0.75f * Mathf.Sqrt(u)) * (u > 0.85f ? (1 - u) / 0.15f * 0.6f + 0.4f : 1);

        static BroadParams Params(WoodyKind k, WoodyForm f)
        {
            bool young = f == WoodyForm.Young, old = f == WoodyForm.Old;
            switch (k)
            {
                case WoodyKind.Birch:
                    return new BroadParams { CrownBase = young ? 0.2f : old ? 0.42f : 0.36f, Primaries = young ? 9 : 15, ElevLow = 38, ElevHigh = 68, Droop = 0.75f, Envelope = Ovoid, ClusterR = 0.32f, ClusterV = 1.05f, ClusterCards = 16, CardSize = 0.55f, Twigs = 3, TrunkR = 0.013f, BarkHex = 0xe7e3d8, BarkType = BarkBirch, Wiggle = 0.35f, Hanging = true };
                case WoodyKind.Oak:
                    return new BroadParams { CrownBase = young ? 0.25f : old ? 0.26f : 0.3f, Excurrent = young, Primaries = young ? 8 : old ? 7 : 6, ElevLow = 12, ElevHigh = 52, Droop = 0.15f, Envelope = Dome, ClusterR = 0.33f, ClusterV = 0.72f, ClusterCards = young ? 18 : 26, CardSize = 0.85f, Twigs = 4, TrunkR = old ? 0.034f : 0.026f, BarkHex = 0x4f4032, BarkType = BarkFurrowed, Wiggle = 0.65f };
                case WoodyKind.Linden:
                    return new BroadParams { CrownBase = young ? 0.2f : 0.28f, Primaries = young ? 10 : 14, ElevLow = 28, ElevHigh = 62, Droop = 0.25f, Envelope = Dome, ClusterR = 0.32f, ClusterV = 0.8f, ClusterCards = 17, CardSize = 0.8f, Twigs = 2, TrunkR = 0.022f, BarkHex = 0x5b5248, BarkType = BarkFurrowed, Wiggle = 0.3f };
                case WoodyKind.Alder:
                    return new BroadParams { CrownBase = young ? 0.18f : 0.3f, Stems = f == WoodyForm.Mature ? 2 : old ? 3 : 1, StemSpread = 0.35f, StemLean = 0.06f, Primaries = young ? 9 : 11, ElevLow = 35, ElevHigh = 60, Droop = 0.2f, Envelope = u => Ovoid(u) * (1 - 0.3f * u), ClusterR = 0.34f, ClusterV = 0.85f, ClusterCards = 15, CardSize = 0.72f, Twigs = 2, TrunkR = 0.016f, BarkHex = 0x4c4944, BarkType = BarkSmooth, Wiggle = 0.3f };
                case WoodyKind.Hazel:
                    return new BroadParams { CrownBase = 0.12f, Stems = 6, StemSpread = 0.3f, StemLean = 0.22f, Primaries = 3, ElevLow = 50, ElevHigh = 75, Droop = 0.45f, Envelope = Vase, ClusterR = 0.36f, ClusterV = 0.8f, ClusterCards = 9, CardSize = 0.58f, Twigs = 1, TrunkR = 0.012f, BarkHex = 0x7a6450, BarkType = BarkSmooth, Wiggle = 0.25f };
                default: // WillowShrub
                    return new BroadParams { CrownBase = 0.1f, Stems = 8, StemSpread = 0.35f, StemLean = 0.18f, Primaries = 2, ElevLow = 60, ElevHigh = 80, Droop = 0.35f, Envelope = u => Dome(u * 0.9f), ClusterR = 0.34f, ClusterV = 0.9f, ClusterCards = 9, CardSize = 0.5f, Twigs = 1, TrunkR = 0.008f, BarkHex = 0x6a5e4a, BarkType = BarkSmooth, Wiggle = 0.25f };
            }
        }

        static void Broadleaf(Ctx c, BroadParams bp)
        {
            float H = c.H, R = c.R;
            int lod = c.Lod;
            bool shrub = c.P.Shrub;
            c.Bottom = H * bp.CrownBase;
            c.Top = H;
            float crownMid = c.Bottom + (H - c.Bottom) * 0.5f;
            c.Centre = V(0, crownMid, 0);
            float lean = c.Rs(1) * (shrub ? 0 : 0.04f) * H;
            float leanAz = c.R01(2) * Mathf.PI * 2;
            var leanDir = V(Mathf.Cos(leanAz), 0, Mathf.Sin(leanAz));
            int clusterId = 0;

            for (int s = 0; s < bp.Stems; s++)
            {
                // Ствол.
                float sa = s * 2.39996f + c.R01(3, s) * 0.8f;
                var sdir = V(Mathf.Cos(sa), 0, Mathf.Sin(sa));
                var basePos = bp.Stems > 1 ? sdir * bp.StemSpread * Mathf.Sqrt(c.R01(4, s)) * (shrub ? 1 : 0.6f) : Vector3.zero;
                float stemH = H * (bp.Stems > 1 ? 0.78f + 0.22f * c.R01(5, s) : 1);
                if (s == 0) stemH = H;
                var outLean = (bp.Stems > 1 ? sdir * bp.StemLean * stemH : Vector3.zero) + leanDir * lean;
                float trunkEnd = bp.Excurrent ? stemH * 0.96f : Mathf.Max(c.Bottom * 1.15f, H * 0.34f);
                var pts = new List<Vector3>();
                int tp = 5;
                for (int i = 0; i <= tp; i++)
                {
                    float t = i / (float)tp;
                    var p = basePos + outLean * (t * t) + V(0, -0.3f + (trunkEnd + 0.3f) * t, 0);
                    p += V(c.Rs(6, s, i), 0, c.Rs(7, s, i)) * (0.08f * H * bp.Wiggle * t * (1 - t) * 2);
                    pts.Add(p);
                }
                float r0 = H * bp.TrunkR * (bp.Stems > 1 ? 0.7f : 1) * (s == 0 ? 1 : 0.8f), r1 = bp.Excurrent ? r0 * 0.12f : r0 * 0.6f;
                if (shrub) r0 = Mathf.Max(r0, 0.025f);
                Trunk(c, pts, r0, r1, shrub ? 0.2f : 0.55f, bp.BarkHex, bp.BarkType, BarkColor(c, bp), 0, shrub ? 0.4f : 0.08f);

                // Развилка дуба: 3–5 скелетных сучьев от верха ствола.
                var top = pts[pts.Count - 1];
                int basePrim = shrub || bp.Stems == 1 ? bp.Primaries : Mathf.Max(4, Mathf.RoundToInt(bp.Primaries / Mathf.Sqrt(bp.Stems) * (s == 0 ? 1.15f : 0.85f)));
                int prim = lod == 0 ? basePrim : lod == 1 ? Mathf.Max(3, Mathf.RoundToInt(basePrim * 0.75f)) : Mathf.Max(2, Mathf.RoundToInt(basePrim * 0.6f));
                for (int i = 0; i < prim; i++)
                {
                    // Равномерное заполнение с тем же набором точек на всех уровнях: выборка через шаг.
                    int src = lod == 0 ? i : Mathf.RoundToInt(i * basePrim / (float)prim);
                    float tt = bp.Excurrent ? (src + 0.5f + c.Rs(10, s, src) * 0.35f) / basePrim : 0.3f + 0.7f * c.R01(10, s, src);
                    float attachY = bp.Excurrent ? Mathf.Lerp(c.Bottom, trunkEnd * 0.97f, tt) : trunkEnd;
                    float u = Mathf.Clamp01((attachY - c.Bottom) / (H - c.Bottom));
                    float az = src * 2.39996f + s * 1.3f + c.Rs(11, s, src) * 0.5f;
                    var dir = V(Mathf.Cos(az), 0, Mathf.Sin(az));
                    float elev = Mathf.Lerp(bp.ElevLow, bp.ElevHigh, u) + c.Rs(12, s, src) * 10;
                    var attach = FloraMeshBuilder.Catmull(pts, Mathf.Clamp01((attachY + 0.3f) / (trunkEnd + 0.3f)));
                    // Длина — до оболочки кроны на высоте конца ветви.
                    float er = 1;
                    float tipY;
                    float L;
                    if (bp.Excurrent)
                    {
                        float uTip = Mathf.Clamp01(u + 0.12f);
                        er = bp.Envelope(uTip);
                        L = R * er * (0.85f + 0.3f * c.R01(13, s, src)) / Mathf.Max(0.35f, Mathf.Cos(elev * Mathf.Deg2Rad));
                        L = Mathf.Min(L, (H - attachY) * 1.6f + R * 0.3f);
                    }
                    else
                    {
                        // Скелетный сук дуба: к точке на оболочке кроны.
                        float targetU = 0.25f + 0.6f * c.R01(14, s, src);
                        float targetY = c.Bottom + (H - c.Bottom) * targetU;
                        float rad = R * bp.Envelope(targetU) * (0.7f + 0.25f * c.R01(15, s, src));
                        L = new Vector2(rad, targetY - attachY).magnitude;
                        elev = Mathf.Atan2(targetY - attachY, rad) * Mathf.Rad2Deg;
                    }
                    float ce = Mathf.Cos(elev * Mathf.Deg2Rad), se = Mathf.Sin(elev * Mathf.Deg2Rad);
                    var tip = attach + dir * (L * ce) + V(0, L * se, 0);
                    tipY = tip.y;
                    float droop = bp.Droop * L * 0.35f;
                    var mid1 = Vector3.Lerp(attach, tip, 0.35f) + V(c.Rs(16, s, src), c.Rs(17, s, src) * 0.5f, c.Rs(18, s, src)) * (L * 0.08f * bp.Wiggle) + V(0, L * 0.05f, 0);
                    var mid2 = Vector3.Lerp(attach, tip, 0.7f) + V(c.Rs(19, s, src), 0, c.Rs(20, s, src)) * (L * 0.08f * bp.Wiggle) + V(0, -droop * 0.4f, 0);
                    var end = tip + V(0, -droop, 0) + dir * (droop * 0.2f);
                    var limb = new List<Vector3> { attach, mid1, mid2, end };
                    float lr0 = Mathf.Max(0.012f, r0 * (bp.Excurrent ? 0.42f : 0.62f) * Mathf.Sqrt(L / Mathf.Max(1, R)) * (1 - u * 0.4f));
                    if (lod < 2 || !bp.Excurrent || i % 2 == 0)
                        Branch(c, limb, lr0, 0.01f, bp.BarkHex, bp.BarkType, 0.1f, 0.75f, shrub ? (lod == 0 ? 4 : 3) : lod == 0 ? 5 : lod == 1 ? 4 : 3, shrub ? (lod == 0 ? 4 : 2) : lod == 0 ? 6 : 3);
                    float sw = shrub ? 0.95f : 0.8f;
                    // Гроздья: на конце, в середине и на побегах второго порядка.
                    float cr = R * bp.ClusterR * (0.85f + 0.3f * c.R01(21, s, src)) * (bp.Excurrent ? Mathf.Lerp(0.8f, 1.05f, er) : 1.15f);
                    var radii = V(cr, cr * bp.ClusterV, cr);
                    Cluster(c, end + V(0, bp.Hanging ? -cr * 0.35f : cr * 0.15f, 0), radii, clusterId++, bp.ClusterCards, bp.CardSize, sw);
                    Cluster(c, FloraMeshBuilder.Catmull(limb, 0.62f) + V(0, cr * 0.25f, 0), radii * 0.8f, clusterId++, Mathf.RoundToInt(bp.ClusterCards * 0.7f), bp.CardSize, sw * 0.8f);
                    int twigs = bp.Twigs + (bp.Excurrent ? 0 : 2);
                    for (int k = 0; k < twigs; k++)
                    {
                        float at = 0.38f + 0.5f * (k + c.R01(22, s, src * 10 + k)) / twigs;
                        var from = FloraMeshBuilder.Catmull(limb, at);
                        float ta = az + (k % 2 == 0 ? 1 : -1) * (0.6f + 0.5f * c.R01(23, s, src * 10 + k));
                        var tdir = V(Mathf.Cos(ta), 0, Mathf.Sin(ta));
                        float tl = L * (0.32f + 0.18f * c.R01(24, s, src * 10 + k)) * (bp.Excurrent ? 1 : 1.25f);
                        var tend = from + tdir * tl * 0.8f + V(0, tl * (bp.Hanging ? -0.35f : 0.35f + 0.25f * c.R01(25, s, src * 10 + k)), 0);
                        if (lod == 0)
                            Branch(c, new List<Vector3> { from, Vector3.Lerp(from, tend, 0.5f) + V(0, tl * 0.12f, 0), tend }, lr0 * 0.45f, 0.006f, bp.BarkHex, bp.BarkType, 0.45f, 0.95f, 3, 3);
                        Cluster(c, tend, radii * 0.78f, clusterId++, Mathf.RoundToInt(bp.ClusterCards * 0.7f), bp.CardSize, sw);
                    }
                }
                // Вершина и заполнение кроны изнутри (крона не просвечивает насквозь).
                if (bp.Excurrent)
                {
                    float cr = R * bp.ClusterR * 1.1f;
                    Cluster(c, top + V(0, cr * 0.2f, 0), V(cr * 0.9f, cr, cr * 0.9f), clusterId++, bp.ClusterCards, bp.CardSize, 0.7f);
                }
                int fill = shrub ? 1 : 3;
                for (int k = 0; k < fill; k++)
                {
                    float u = 0.35f + 0.4f * k / Mathf.Max(1, fill - 1);
                    float y = c.Bottom + (H - c.Bottom) * u;
                    float w = R * bp.Envelope(u) * 0.5f;
                    float a = k * 2.1f + s;
                    Cluster(c, basePos + outLean * 0.6f + V(Mathf.Cos(a) * w * 0.5f, y, Mathf.Sin(a) * w * 0.5f), V(w, w * 0.8f, w), clusterId++, bp.ClusterCards, bp.CardSize * 1.1f, 0.5f);
                }
            }
            // Цветки липы — мелкие светлые соцветия по внешней поверхности кроны (видны только в окно цветения).
            if (c.P.Bloom.a > 0 && c.P.Kind == WoodyKind.Linden && lod < 2)
                Sprinkle(c, lod == 0 ? 140 : 40, 0.28f, FloraPart.Flower, c.P.Bloom, LeafTile.Petals);
        }

        static Func<Vector3, float, Color> BarkColor(Ctx c, BroadParams bp)
        {
            int seed = c.Seed;
            var bark = C(bp.BarkHex);
            if (c.P.Kind == WoodyKind.Birch)
            {
                var dark = C(0x37332f);
                return (p, t) =>
                {
                    float n = FloraHash.Noise(seed, p.y * 2.2f, Mathf.Atan2(p.z, p.x) * 1.5f);
                    float basal = Mathf.Clamp01(1 - (p.y + 0.3f) / (1.6f + n * 0.8f));
                    return Color.Lerp(bark * (0.92f + 0.08f * n), dark, basal * 0.85f);
                };
            }
            return (p, t) => bark * (0.82f + 0.28f * FloraHash.Noise(seed, p.y * 1.3f, Mathf.Atan2(p.z, p.x) * 2.5f)) * (p.y < 0.4f ? 0.8f : 1);
        }

        /// <summary>Мелкие карточки (цветки, плоды) по внешней поверхности кроны.</summary>
        static void Sprinkle(Ctx c, int count, float size, float part, Color color, LeafTile tile)
        {
            var uv = FloraTextures.Uv(tile);
            for (int k = 0; k < count; k++)
            {
                float u = c.R01(900, k, 1) * Mathf.PI * 2, y = c.R01(900, k, 2) * 1.4f - 0.4f;
                float rr = Mathf.Sqrt(Mathf.Max(0, 1 - y * y));
                var dir = V(Mathf.Cos(u) * rr, y, Mathf.Sin(u) * rr);
                float hr = (c.Top - c.Bottom) * 0.5f;
                var p = c.Centre + Vector3.Scale(dir, V(c.R * 0.95f, hr * 0.92f, c.R * 0.95f));
                var right = Vector3.Cross(dir, Vector3.up).normalized;
                if (right.sqrMagnitude < 0.01f) right = Vector3.right;
                var up = Vector3.Cross(right, dir).normalized;
                var col = color * (0.9f + 0.2f * c.R01(900, k, 3)); col.a = 1;
                c.B.Card(p, right * size, up * size, (dir + Vector3.up * 0.4f).normalized, col, col, 0.9f, 1, c.R01(900, k, 4), uv, part);
            }
        }

        // ───────── ель ─────────

        static void Spruce(Ctx c)
        {
            float H = c.H, R = c.R;
            int lod = c.Lod;
            var form = c.A.Form;
            c.Bottom = form == WoodyForm.Young ? 0.05f * H : form == WoodyForm.Old ? 0.14f * H : 0.09f * H;
            c.Top = H;
            c.Centre = V(0, H * 0.4f, 0);
            float bend = c.Rs(1) * 0.012f * H;
            var trunk = new List<Vector3> { V(0, -0.3f, 0), V(bend, H * 0.35f, 0), V(-bend * 0.5f, H * 0.7f, bend), V(0, H, 0) };
            Trunk(c, trunk, 0.016f * H + 0.04f, 0.015f, 0.5f, 0x4a3b30, BarkFlaky, null, 0, 0.05f);
            float spacing = lod == 0 ? Mathf.Max(0.38f, H / 27f) : lod == 1 ? H / 16f : H / 7f;
            int perWhorl = lod == 0 ? 6 : lod == 1 ? 5 : 4;
            var uv = c.Uv;
            var dark = c.P.LeafBase;
            var tipC = c.P.LeafLit;
            int w = 0;
            for (float y = c.Bottom; y < H - 0.5f; y += spacing * (0.85f + 0.3f * c.R01(30, w)), w++)
            {
                float u = (y - c.Bottom) / (H - c.Bottom);
                float reach = R * Mathf.Pow(1 - u, 0.92f) * (0.88f + 0.24f * c.R01(31, w)) + 0.22f;
                if (form == WoodyForm.Old) reach *= 0.85f + 0.35f * FloraHash.Noise(c.Seed, y * 0.4f, 0);
                float rot = w * 0.9f + c.R01(32, w) * 0.6f;
                for (int j = 0; j < perWhorl; j++)
                {
                    if (form == WoodyForm.Old && c.R01(33, w, j) < 0.12f) continue; // прорехи старой ели
                    float a = rot + j * Mathf.PI * 2 / perWhorl + c.Rs(34, w, j) * 0.25f;
                    var outv = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                    float len = reach * (0.82f + 0.3f * c.R01(35, w, j));
                    float droop = 0.25f + 0.35f * (1 - u) + c.Rs(36, w, j) * 0.08f;
                    var along = (outv * Mathf.Cos(droop) - Vector3.up * Mathf.Sin(droop)).normalized;
                    var root = V(0, y, 0);
                    var tip = root + along * len + Vector3.up * (len * 0.12f); // конец лапы чуть приподнят
                    if (lod == 0 && len > 1.2f && u < 0.6f)
                        Branch(c, new List<Vector3> { root, Vector3.Lerp(root, tip, 0.5f) - Vector3.up * len * 0.06f, tip }, 0.02f + 0.012f * len, 0.006f, 0x4a3b30, BarkFlaky, 0.1f, 0.6f, 3, 2);
                    var right = Vector3.Cross(Vector3.up, along).normalized;
                    float tone = 0.86f + 0.26f * u + c.R01(37, w, j) * 0.1f;
                    var lo = Color.Lerp(dark, tipC, 0.2f) * tone; lo.a = 0.5f + 0.3f * u;
                    var hi = Color.Lerp(dark, tipC, 0.85f) * tone; hi.a = 0.85f + 0.15f * u;
                    var shade = (outv * 0.62f + Vector3.up * 0.78f).normalized;
                    int cards = lod == 0 ? 3 : lod == 1 ? 2 : 1;
                    for (int k = 0; k < cards; k++)
                    {
                        float f0 = k / (float)cards, f1 = (k + 1) / (float)cards;
                        var a0 = Vector3.Lerp(root + along * 0.15f, tip, f0);
                        var a1 = Vector3.Lerp(root + along * 0.15f, tip, Mathf.Min(1, f1 + 0.25f));
                        var mid = (a0 + a1) * 0.5f;
                        var half = (a1 - a0) * 0.5f;
                        float wdt = len * (lod == 0 ? 0.36f : lod == 1 ? 0.46f : 0.55f) * (1 - 0.35f * f0);
                        float sw0 = 0.15f + 0.8f * f0, sw1 = 0.15f + 0.8f * Mathf.Min(1, f1 + 0.25f);
                        var l2 = Color.Lerp(lo, hi, f0); var h2 = Color.Lerp(lo, hi, Mathf.Min(1, f1 + 0.2f));
                        // Лапа — две перекрещенные плоскости (сверху и сбоку не «лист бумаги»).
                        var flat = (right + Vector3.up * 0.18f).normalized;
                        c.B.Card(mid, flat * wdt, half, shade, l2, h2, sw0, sw1, c.R01(38, w * 16 + j, k), uv);
                        var tilt = (Vector3.up * 0.8f + right * 0.3f).normalized;
                        c.B.Card(mid + Vector3.up * wdt * 0.12f, tilt * wdt * 0.62f, half, shade, l2, h2, sw0, sw1, c.R01(39, w * 16 + j, k), uv);
                    }
                }
                // Внутренняя «шуба» у ствола: заполняет просветы конуса.
                if (lod > 0 || w % 2 == 0)
                {
                    float shell = reach * 0.62f;
                    Cluster(c, V(0, y + spacing * 0.3f, 0), V(shell, spacing * 0.9f + 0.3f, shell), 500 + w, lod == 0 ? 10 : 8, Mathf.Max(0.45f, reach * 0.42f), 0.25f, 0.9f);
                }
            }
            // Шпиль.
            var top = V(0, H - 0.9f, 0);
            var lc = c.P.LeafBase; lc.a = 1;
            var hc = c.P.LeafLit; hc.a = 1;
            float ts = Mathf.Max(0.3f, H * 0.035f);
            c.B.Card(top + V(0, ts, 0), V(ts * 0.6f, 0, 0), V(0, ts * 1.6f, 0), Vector3.up, lc, hc, 0.6f, 0.8f, 0.2f, uv);
            c.B.Card(top + V(0, ts, 0), V(0, 0, ts * 0.6f), V(0, ts * 1.6f, 0), Vector3.up, lc, hc, 0.6f, 0.8f, 0.3f, uv);
        }

        // ───────── сосна ─────────

        static void Pine(Ctx c)
        {
            float H = c.H, R = c.R;
            int lod = c.Lod;
            var form = c.A.Form;
            float crownBase = form == WoodyForm.Young ? 0.18f : form == WoodyForm.Old ? 0.6f : 0.52f + 0.06f * c.R01(1);
            c.Bottom = H * crownBase;
            c.Top = H;
            c.Centre = V(0, (c.Bottom + H) * 0.5f, 0);
            float lean = c.Rs(2) * 0.03f * H;
            float leanAz = c.R01(3) * 6.28f;
            var ld = V(Mathf.Cos(leanAz), 0, Mathf.Sin(leanAz));
            var trunk = new List<Vector3>();
            for (int i = 0; i <= 5; i++)
            {
                float t = i / 5f;
                trunk.Add(V(0, -0.3f + (H * 0.97f + 0.3f) * t, 0) + ld * (lean * t * t) + V(c.Rs(4, i), 0, c.Rs(5, i)) * (0.15f * t * (1 - t)));
            }
            var low = C(0x5a4a3e); var high = C(0xb86a3c);
            int seed = c.Seed;
            float hh = H;
            Trunk(c, trunk, 0.018f * H + 0.05f, 0.03f, 0.45f, 0x5a4a3e, BarkFlaky,
                (p, t) => Color.Lerp(low, high, Mathf.SmoothStep(0, 1, Mathf.InverseLerp(hh * 0.32f, hh * 0.55f, p.y))) * (0.85f + 0.25f * FloraHash.Noise(seed, p.y * 2f, Mathf.Atan2(p.z, p.x) * 2)), 0, 0.06f);
            int whorls = lod == 0 ? (form == WoodyForm.Young ? 9 : 8) : lod == 1 ? 6 : 4;
            int per = lod == 0 ? 5 : lod == 1 ? 4 : 3;
            int cid = 0;
            for (int w = 0; w < whorls; w++)
            {
                float u = (w + 0.3f * c.R01(10, w)) / whorls;
                float y = Mathf.Lerp(c.Bottom, H * 0.93f, u);
                float env = form == WoodyForm.Old ? Mathf.Lerp(0.55f, 1.05f, Mathf.Sqrt(u)) * (u > 0.85f ? 0.7f : 1) : form == WoodyForm.Young ? Cone(u) : Ovoid(u) * (1 - 0.25f * u);
                float rot = w * 1.7f + c.R01(11, w);
                for (int j = 0; j < per; j++)
                {
                    float a = rot + j * Mathf.PI * 2 / per + c.Rs(12, w, j) * 0.45f;
                    var dir = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                    float L = R * env * (0.75f + 0.4f * c.R01(13, w, j)) + 0.3f;
                    float elev = (form == WoodyForm.Old ? 18 : 12) + 20 * c.R01(14, w, j);
                    var attach = FloraMeshBuilder.Catmull(trunk, Mathf.Clamp01((y + 0.3f) / (H * 0.97f + 0.3f)));
                    var tip = attach + dir * L * Mathf.Cos(elev * Mathf.Deg2Rad) + Vector3.up * (L * Mathf.Sin(elev * Mathf.Deg2Rad) + L * 0.15f);
                    var mid = Vector3.Lerp(attach, tip, 0.5f) - Vector3.up * L * 0.05f + V(c.Rs(15, w, j), 0, c.Rs(16, w, j)) * L * 0.08f;
                    var limb = new List<Vector3> { attach, mid, tip };
                    if (lod < 2 || j % 2 == 0)
                        Branch(c, limb, 0.035f + 0.025f * L, 0.012f, 0x7a5038, BarkFlaky, 0.1f, 0.7f, lod == 0 ? 5 : 3, lod == 0 ? 4 : 2);
                    float cr = Mathf.Max(0.7f, R * 0.36f) * (0.85f + 0.3f * c.R01(17, w, j));
                    var radii = V(cr, cr * 0.55f, cr);
                    var outUp = (dir + Vector3.up * 0.8f).normalized;
                    Cluster(c, tip + Vector3.up * cr * 0.15f, radii, cid++, 18, 0.62f, 0.85f, 0.85f, outUp);
                    if (L > 1.6f) Cluster(c, FloraMeshBuilder.Catmull(limb, 0.6f) + Vector3.up * cr * 0.25f, radii * 0.75f, cid++, 12, 0.58f, 0.6f, 0.85f, outUp);
                }
            }
            // Вершина.
            float tc = Mathf.Max(0.8f, R * 0.4f);
            Cluster(c, V(0, H * 0.97f, 0) + ld * lean, V(tc, tc * 0.7f, tc), cid++, 20, 0.62f, 0.7f, 0.85f);
        }

        // ───────── можжевельник ─────────

        static void Juniper(Ctx c)
        {
            float H = c.H, R = c.R;
            bool columnar = c.A.Seed % 2 == 1;
            c.Bottom = 0.05f * H; c.Top = H; c.Centre = V(0, H * 0.5f, 0);
            int stems = columnar ? 4 : 7;
            int cid = 0;
            for (int s = 0; s < stems; s++)
            {
                float a = s * 2.39996f + c.R01(1, s);
                var dir = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                float h = H * (0.65f + 0.35f * c.R01(2, s));
                float spread = columnar ? R * 0.3f : R * 0.85f;
                var end = dir * spread * (0.6f + 0.4f * c.R01(3, s)) + Vector3.up * h;
                var stem = new List<Vector3> { V(0, -0.1f, 0), dir * spread * 0.25f + Vector3.up * h * 0.4f, end };
                if (c.Lod < 2) Branch(c, stem, 0.045f, 0.012f, 0x6a4a36, BarkFlaky, 0.05f, 0.6f, c.Lod == 0 ? 4 : 3, 3);
                int n = columnar ? 4 : 3;
                for (int k = 0; k < n; k++)
                {
                    float t = 0.3f + 0.7f * (k + 0.5f) / n;
                    var p = FloraMeshBuilder.Catmull(stem, t);
                    float cr = (columnar ? R * 0.75f : R * 0.55f) * (1.1f - 0.4f * t);
                    Cluster(c, p, V(cr, cr * (columnar ? 1.3f : 0.8f), cr), cid++, 16, 0.42f, 0.5f + 0.4f * t);
                }
            }
        }

        // ───────── шиповник ─────────

        static void Rose(Ctx c)
        {
            float H = c.H, R = c.R;
            int lod = c.Lod;
            c.Bottom = 0.1f * H; c.Top = H; c.Centre = V(0, H * 0.55f, 0);
            int canes = lod == 0 ? 9 : lod == 1 ? 7 : 5;
            int cid = 0;
            var petal = FloraTextures.Uv(LeafTile.Petals);
            for (int s = 0; s < canes; s++)
            {
                float a = s * 2.39996f + c.R01(1, s) * 0.7f;
                var dir = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                float reach = R * (0.7f + 0.35f * c.R01(2, s));
                float h = H * (0.75f + 0.3f * c.R01(3, s));
                var cane = new List<Vector3> { dir * 0.08f, dir * reach * 0.25f + Vector3.up * h * 0.75f, dir * reach * 0.7f + Vector3.up * h, dir * reach * 1.05f + Vector3.up * h * 0.55f };
                if (lod < 2) Branch(c, cane, 0.018f, 0.006f, 0x5a4a30, BarkSmooth, 0.2f, 1f, 3, lod == 0 ? 5 : 3);
                for (int k = 0; k < 3; k++)
                {
                    float t = 0.35f + 0.3f * k;
                    var p = FloraMeshBuilder.Catmull(cane, t);
                    float cr = R * 0.38f;
                    Cluster(c, p, V(cr, cr * 0.75f, cr), cid++, 12, 0.32f, 0.6f + 0.35f * t);
                }
                if (lod < 2)
                {
                    // Цветки (part 2) и плоды-шипы (part 3) у концов дуг.
                    for (int k = 0; k < (lod == 0 ? 5 : 2); k++)
                    {
                        var p = FloraMeshBuilder.Catmull(cane, 0.45f + 0.5f * c.R01(4, s, k)) + V(c.Rs(5, s, k), c.R01(6, s, k), c.Rs(7, s, k)) * R * 0.25f;
                        var bc = c.P.Bloom * (0.9f + 0.2f * c.R01(8, s, k)); bc.a = 1;
                        c.B.Card(p, V(0.07f, 0, 0), V(0, 0.02f, 0.07f), Vector3.up, bc, bc, 0.9f, 1, c.R01(9, s, k), petal, FloraPart.Flower);
                        var fc = c.P.Fruit; fc.a = 1;
                        var q = p + V(0.03f, -0.05f, 0.02f);
                        c.B.Card(q, V(0.035f, 0, 0), V(0, 0.045f, 0), Vector3.up, fc * 0.8f, fc, 0.9f, 1, c.R01(10, s, k), petal, FloraPart.Fruit);
                        c.B.Card(q, V(0, 0, 0.035f), V(0, 0.045f, 0), Vector3.up, fc * 0.8f, fc, 0.9f, 1, c.R01(11, s, k), petal, FloraPart.Fruit);
                    }
                }
            }
        }
    }
}
