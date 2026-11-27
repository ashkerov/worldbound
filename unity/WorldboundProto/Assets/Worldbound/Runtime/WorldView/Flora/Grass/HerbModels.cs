// Профили и геометрия трав (собственная работа проекта). У каждого вида своя форма пучка: мятлик — изогнутые
// листья и метёлки; ковыль — тонкие листья и серебристые перистые ости; осока — жёсткие прямые листья;
// клевер — низкие тройчатые листья и шаровидные головки; луговые цветы — розетка и стебли с цветками пяти окрасок;
// иван-чай — высокие стебли с узкими листьями и малиновой кистью; черника — кустики с ягодами; мох — подушки.
// Модель — эталонной высоты 1 м (экземпляр растягивается). Уровни: 0 — геометрия листьев; 1 — вдвое меньше
// листьев, они шире; 2 — две перекрещенные карточки из атласа (плитка «пучок травы» и др.).

using System.Collections.Generic;
using UnityEngine;

namespace Worldbound.FloraView
{
    public enum HerbKind { MeadowGrass, FeatherGrass, Sedge, Clover, MeadowFlowers, Fireweed, Bilberry, Moss }

    public sealed class HerbProfile
    {
        public string Key;
        public HerbKind Kind;
        public Color Base, Tip, Dry, Autumn, Bloom, Bloom2;
        public Vector2 BloomWindow;
        /// <summary>Граммов биомассы на пучок и предел пучков на м² (густота по реальному травостою).</summary>
        public float GramsPerTuft, MaxPerM2;
        public float HeightLow, HeightHigh;
        /// <summary>Жёсткость: меньше — сильнее клонится на ветру.</summary>
        public float Stiffness = 1;
        /// <summary>Пятнистость 0..1 (клевер и цветы растут куртинами) и размер пятен, м.</summary>
        public float Patch, PatchScale = 6;
        public float Width = 1;
        public int VisualIndex;
        public Mesh[] Lods = new Mesh[3];

        static Color C(int hex) => new Color(((hex >> 16) & 255) / 255f, ((hex >> 8) & 255) / 255f, (hex & 255) / 255f).linear;

        public static HerbProfile Create(HerbKind k, string key)
        {
            HerbProfile p = k switch
            {
                HerbKind.MeadowGrass => new() { Base = C(0x4b6a2d), Tip = C(0x8fa556), Dry = C(0xbba66a), Autumn = C(0x9c8c4c), Bloom = C(0xb9a97c), BloomWindow = new Vector2(0.3f, 0.62f), GramsPerTuft = 55, MaxPerM2 = 8, HeightLow = 0.22f, HeightHigh = 0.65f, Stiffness = 1, Patch = 0.15f },
                HerbKind.FeatherGrass => new() { Base = C(0x76875a), Tip = C(0xb2b68c), Dry = C(0xd2c69a), Autumn = C(0xc6b47e), Bloom = C(0xe8e4d6), BloomWindow = new Vector2(0.2f, 0.52f), GramsPerTuft = 45, MaxPerM2 = 6, HeightLow = 0.35f, HeightHigh = 0.85f, Stiffness = 0.55f, Patch = 0.2f },
                HerbKind.Sedge => new() { Base = C(0x395836), Tip = C(0x6d8850), Dry = C(0x9a9058), Autumn = C(0x8c8048), Bloom = C(0x5c4c32), BloomWindow = new Vector2(0.15f, 0.42f), GramsPerTuft = 60, MaxPerM2 = 7, HeightLow = 0.3f, HeightHigh = 0.62f, Stiffness = 1.6f, Patch = 0.3f },
                HerbKind.Clover => new() { Base = C(0x3e692e), Tip = C(0x5e893e), Dry = C(0x8a8a4a), Autumn = C(0x6a7a3a), Bloom = C(0xf2ece6), Bloom2 = C(0xd98aa6), BloomWindow = new Vector2(0.24f, 0.56f), GramsPerTuft = 16, MaxPerM2 = 14, HeightLow = 0.08f, HeightHigh = 0.2f, Stiffness = 2, Patch = 0.65f, PatchScale = 4 },
                HerbKind.MeadowFlowers => new() { Base = C(0x4e7131), Tip = C(0x789945), Dry = C(0xa89a5a), Autumn = C(0x8c7c42), Bloom = C(0xf4f1e8), BloomWindow = new Vector2(0.14f, 0.56f), GramsPerTuft = 28, MaxPerM2 = 6, HeightLow = 0.28f, HeightHigh = 0.7f, Stiffness = 0.9f, Patch = 0.55f, PatchScale = 7 },
                HerbKind.Fireweed => new() { Base = C(0x49693a), Tip = C(0x6e8a44), Dry = C(0x9a7a4a), Autumn = C(0xa24a30), Bloom = C(0xc8509a), BloomWindow = new Vector2(0.34f, 0.56f), GramsPerTuft = 90, MaxPerM2 = 3, HeightLow = 0.7f, HeightHigh = 1.5f, Stiffness = 1.2f, Patch = 0.5f, PatchScale = 9 },
                HerbKind.Bilberry => new() { Base = C(0x3c6932), Tip = C(0x5e8944), Dry = C(0x7a6a3a), Autumn = C(0xa83c2a), Bloom = C(0x2c3b6c), BloomWindow = new Vector2(0.38f, 0.56f), GramsPerTuft = 40, MaxPerM2 = 8, HeightLow = 0.15f, HeightHigh = 0.35f, Stiffness = 2.2f, Patch = 0.3f },
                _ => new() { Base = C(0x4a6a2a), Tip = C(0x7a9a3a), Dry = C(0x7a7a4a), Autumn = C(0x5a6a2a), Bloom = C(0x8a8a3a), BloomWindow = new Vector2(0.1f, 0.25f), GramsPerTuft = 30, MaxPerM2 = 6, HeightLow = 0.04f, HeightHigh = 0.09f, Stiffness = 5, Patch = 0.4f },
            };
            p.Kind = k;
            p.Key = key;
            for (int l = 0; l < 3; l++) p.Lods[l] = HerbModels.Build(p, l);
            return p;
        }

        public static HerbKind KindFor(FloraSpeciesInfo s) => s.Key switch
        {
            "meadow-grass" => HerbKind.MeadowGrass,
            "feather-grass" => HerbKind.FeatherGrass,
            "sedge" => HerbKind.Sedge,
            "clover" => HerbKind.Clover,
            "meadow-flowers" => HerbKind.MeadowFlowers,
            "fireweed" => HerbKind.Fireweed,
            "bilberry" => HerbKind.Bilberry,
            "moss" => HerbKind.Moss,
            _ => HerbKind.MeadowGrass,
        };
    }

    public static class HerbModels
    {
        static readonly Vector2 NoTex = new(-1, -1);
        static Vector3 V(float x, float y, float z) => new(x, y, z);

        /// <summary>Изогнутый сужающийся лист из segs сегментов. Нормаль — к небу с наклоном по листу (мягкий травостой).</summary>
        static void Blade(FloraMeshBuilder b, Vector3 o, float dir, float h, float w, float lean, Color baseC, Color tip, float rnd, int segs, float part = 1)
        {
            float fx = Mathf.Cos(dir), fz = Mathf.Sin(dir);
            var side = V(-fz, 0, fx);
            int start = b.Vertices;
            for (int k = 0; k <= segs; k++)
            {
                float t = k / (float)segs;
                float bend = lean * t * t;
                var p = o + V(fx * bend * h, h * t * (1 - 0.22f * lean * t), fz * bend * h);
                float wt = w * (1 - t * 0.88f);
                var n = (Vector3.up * 0.75f + V(fx, 0, fz) * 0.25f + side * 0.0f).normalized;
                var c = Color.Lerp(baseC, tip, t);
                c.a = Mathf.Lerp(0.38f, 1f, Mathf.Sqrt(t)); // затенение у корня
                if (k < segs)
                {
                    b.Vertex(p - side * wt, n, c, NoTex, t * t, part, rnd);
                    b.Vertex(p + side * wt, n, c, NoTex, t * t, part, rnd);
                }
                else b.Vertex(p, n, c, NoTex, 1, part, rnd);
            }
            for (int k = 0; k < segs; k++)
            {
                int a = start + k * 2;
                if (k < segs - 1) { b.Tri(a, a + 2, a + 1); b.Tri(a + 1, a + 2, a + 3); }
                else b.Tri(a, a + 2, a + 1);
            }
        }

        /// <summary>Две перекрещенные вертикальные карточки (дальний уровень) или горизонтальная (клевер).</summary>
        static void Cross(FloraMeshBuilder b, LeafTile tile, float h, float w, Color lo, Color hi, int cards = 2, float part = 1)
        {
            var uv = FloraTextures.Uv(tile);
            lo.a = 0.5f; hi.a = 1;
            for (int i = 0; i < cards; i++)
            {
                float a = i * Mathf.PI / cards + 0.3f;
                var right = V(Mathf.Cos(a), 0, Mathf.Sin(a)) * w;
                var n = Vector3.up;
                int s = b.Vertices;
                b.Vertex(-right, n, lo, new Vector2(uv.xMin, uv.yMin), 0, part, 0.3f * i);
                b.Vertex(right, n, lo, new Vector2(uv.xMax, uv.yMin), 0, part, 0.3f * i);
                b.Vertex(right + V(0, h, 0), n, hi, new Vector2(uv.xMax, uv.yMax), 1, part, 0.3f * i);
                b.Vertex(-right + V(0, h, 0), n, hi, new Vector2(uv.xMin, uv.yMax), 1, part, 0.3f * i);
                b.Tri(s, s + 2, s + 1); b.Tri(s, s + 3, s + 2);
            }
        }

        static void FlatCard(FloraMeshBuilder b, Vector3 c, float size, float rot, float tilt, LeafTile tile, Color col, float sway, float part, float rnd)
        {
            var uv = FloraTextures.Uv(tile);
            var right = V(Mathf.Cos(rot), 0, Mathf.Sin(rot)) * size;
            var fwd = V(-Mathf.Sin(rot), Mathf.Sin(tilt), Mathf.Cos(rot)).normalized * size;
            col.a = 0.9f;
            b.Card(c, right, fwd, Vector3.up, col * 0.92f, col, sway, sway, rnd, uv, part);
        }

        public static Mesh Build(HerbProfile p, int lod)
        {
            var b = new FloraMeshBuilder { RefHeight = 1 };
            int seed = 500 + (int)p.Kind * 37;
            float R(int a, int c = 0) => FloraHash.F(seed, a, c, lod);
            Color white = Color.white;
            switch (p.Kind)
            {
                case HerbKind.MeadowGrass:
                case HerbKind.Sedge:
                case HerbKind.FeatherGrass:
                {
                    if (lod == 2) { Cross(b, p.Kind == HerbKind.FeatherGrass ? LeafTile.Feather : LeafTile.GrassClump, 1, 0.42f, white, white); break; }
                    bool sedge = p.Kind == HerbKind.Sedge, feather = p.Kind == HerbKind.FeatherGrass;
                    int blades = lod == 0 ? (feather ? 14 : sedge ? 9 : 11) : (feather ? 6 : 5);
                    float width = (sedge ? 0.022f : feather ? 0.008f : 0.016f) * (lod == 0 ? 1 : 1.7f);
                    for (int i = 0; i < blades; i++)
                    {
                        float a = i * 2.39996f + R(i, 1), r = 0.02f + R(i, 2) * 0.09f;
                        float lean = sedge ? 0.15f + R(i, 3) * 0.2f : 0.35f + R(i, 3) * 0.45f;
                        Blade(b, V(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r), a + R(i, 4) * 0.8f, 0.55f + R(i, 5) * 0.45f, width, lean, white, white, R(i, 6), lod == 0 ? 3 : 2);
                    }
                    // Соцветия: метёлки мятлика, колоски осоки, ости ковыля (видны в своё окно сезона).
                    int heads = lod == 0 ? 3 : 1;
                    for (int i = 0; i < heads; i++)
                    {
                        float a = i * 2.1f + 0.5f, r = 0.03f;
                        var root = V(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r);
                        var top = root + V(Mathf.Cos(a) * 0.12f, 1.05f + R(20 + i) * 0.15f, Mathf.Sin(a) * 0.12f);
                        Blade(b, root, a, top.y, 0.005f, 0.12f, white, white, R(30 + i), 2, FloraPart.Flower);
                        if (feather)
                        {
                            var uv = FloraTextures.Uv(LeafTile.Feather);
                            var rr = V(Mathf.Cos(a + 1.2f), 0, Mathf.Sin(a + 1.2f)) * 0.07f;
                            var c = Color.white; c.a = 1;
                            b.Card(top + V(Mathf.Cos(a) * 0.12f, 0.12f, Mathf.Sin(a) * 0.12f), rr, V(Mathf.Cos(a) * 0.1f, 0.22f, Mathf.Sin(a) * 0.1f), Vector3.up, c, c, 0.9f, 1, R(40 + i), uv, FloraPart.Flower);
                        }
                        else
                        {
                            var uv = FloraTextures.Uv(LeafTile.GrassClump);
                            var c = Color.white; c.a = 1;
                            b.Card(top + V(0, 0.05f, 0), V(0.035f, 0, 0.02f), V(0, 0.09f, 0), Vector3.up, c, c, 1, 1, R(50 + i), uv, FloraPart.Flower);
                        }
                    }
                    break;
                }
                case HerbKind.Clover:
                {
                    if (lod == 2) { FlatCard(b, V(0, 0.45f, 0), 0.28f, 0.4f, 0.1f, LeafTile.Clover, white, 0.3f, FloraPart.Leaf, 0.5f); break; }
                    int leaves = lod == 0 ? 7 : 3;
                    for (int i = 0; i < leaves; i++)
                    {
                        float a = i * 2.39996f, r = 0.03f + R(i, 1) * 0.12f;
                        var c = V(Mathf.Cos(a) * r, 0.35f + R(i, 2) * 0.55f, Mathf.Sin(a) * r);
                        Blade(b, V(c.x * 0.5f, 0, c.z * 0.5f), a, c.y, 0.004f, 0.1f, white, white, R(i, 3), 2);
                        FlatCard(b, c, 0.09f * (lod == 0 ? 1 : 1.6f), a, 0.25f, LeafTile.Clover, white, 0.4f + 0.5f * c.y, FloraPart.Leaf, R(i, 4));
                    }
                    int heads = lod == 0 ? 3 : 1;
                    for (int i = 0; i < heads; i++)
                    {
                        float a = i * 2.2f + 1;
                        var top = V(Mathf.Cos(a) * 0.08f, 1.0f, Mathf.Sin(a) * 0.08f);
                        Blade(b, V(Mathf.Cos(a) * 0.03f, 0, Mathf.Sin(a) * 0.03f), a, 1.0f, 0.004f, 0.05f, white, white, R(10 + i), 2);
                        var uv = FloraTextures.Uv(LeafTile.Petals);
                        var col = Color.white; col.a = 1;
                        b.Card(top, V(0.05f, 0, 0), V(0, 0.05f, 0.02f), Vector3.up, col, col, 1, 1, R(20 + i), uv, FloraPart.Flower);
                        b.Card(top, V(0, 0, 0.05f), V(0.02f, 0.05f, 0), Vector3.up, col, col, 1, 1, R(30 + i), uv, FloraPart.Flower);
                    }
                    break;
                }
                case HerbKind.MeadowFlowers:
                {
                    int rosette = lod == 0 ? 5 : 3;
                    for (int i = 0; i < rosette; i++) { float a = i * 2.39996f; Blade(b, V(Mathf.Cos(a) * 0.03f, 0, Mathf.Sin(a) * 0.03f), a, 0.32f + R(i) * 0.12f, 0.018f, 0.7f, white, white, R(i, 2), lod == 2 ? 1 : 2); }
                    int stems = lod == 0 ? 3 : 1;
                    var petals = FloraTextures.Uv(LeafTile.Petals);
                    for (int i = 0; i < stems; i++)
                    {
                        float a = i * 2.2f + 0.3f, h = 0.75f + R(10 + i) * 0.3f;
                        var top = V(Mathf.Cos(a) * 0.1f, h, Mathf.Sin(a) * 0.1f);
                        if (lod < 2) Blade(b, V(Mathf.Cos(a) * 0.03f, 0, Mathf.Sin(a) * 0.03f), a, h, 0.005f, 0.15f, white, white, R(20 + i), 2);
                        var col = Color.white; col.a = 1;
                        float s = lod == 2 ? 0.09f : 0.055f;
                        b.Card(top, V(s, 0, 0), V(0, 0.015f, s), Vector3.up, col, col, 1, 1, 0.2f + 0.25f * i, petals, FloraPart.Flower);
                        if (lod == 0) b.Card(top + V(0, -0.01f, 0), V(0, s * 0.6f, 0), V(0, 0, s * 0.6f), Vector3.up, col, col, 1, 1, 0.2f + 0.25f * i, petals, FloraPart.Flower);
                    }
                    break;
                }
                case HerbKind.Fireweed:
                {
                    if (lod == 2) { Cross(b, LeafTile.Fireweed, 0.85f, 0.2f, white, white); AddSpike(b, 0.82f, 0.35f, 0.06f, 1); break; }
                    int stems = lod == 0 ? 3 : 1;
                    var uv = FloraTextures.Uv(LeafTile.Fireweed);
                    for (int i = 0; i < stems; i++)
                    {
                        float a = i * 2.39996f;
                        var o = V(Mathf.Cos(a) * 0.08f * i, 0, Mathf.Sin(a) * 0.08f * i);
                        float h = 0.82f - i * 0.1f;
                        Blade(b, o, a, h, 0.008f, 0.06f, white, white, R(i), 2);
                        var c = Color.white; c.a = 1;
                        var lo = Color.white * 0.85f; lo.a = 0.55f;
                        b.Card(o + V(0, h * 0.45f, 0), V(Mathf.Cos(a), 0, Mathf.Sin(a)) * 0.13f, V(0, h * 0.42f, 0), Vector3.up, lo, c, 0.1f, 0.6f, R(i, 2), uv);
                        if (lod == 0) b.Card(o + V(0, h * 0.45f, 0), V(-Mathf.Sin(a), 0, Mathf.Cos(a)) * 0.13f, V(0, h * 0.42f, 0), Vector3.up, lo, c, 0.1f, 0.6f, R(i, 3), uv);
                        AddSpike(b, h, 0.3f, 0.05f, lod == 0 ? 2 : 1, o);
                    }
                    break;
                }
                case HerbKind.Bilberry:
                {
                    int cards = lod == 0 ? 6 : lod == 1 ? 3 : 2;
                    var uv = FloraTextures.Uv(LeafTile.Bilberry);
                    for (int i = 0; i < cards; i++)
                    {
                        float a = i * 2.39996f + R(i) * 0.5f;
                        var c = V(Mathf.Cos(a) * 0.12f, 0.5f + R(i, 1) * 0.3f, Mathf.Sin(a) * 0.12f);
                        var right = V(Mathf.Cos(a + 1.57f), 0, Mathf.Sin(a + 1.57f)) * 0.3f * (lod == 0 ? 1 : 1.3f);
                        var up = (V(Mathf.Cos(a), 0, Mathf.Sin(a)) * 0.35f + V(0, 0.55f, 0)) * (lod == 0 ? 1 : 1.3f);
                        var lo = Color.white * 0.8f; lo.a = 0.5f;
                        var hi = Color.white; hi.a = 1;
                        b.Card(c, right, up, (V(Mathf.Cos(a), 0, Mathf.Sin(a)) + Vector3.up).normalized, lo, hi, 0.1f, 0.6f, R(i, 2), uv);
                    }
                    if (lod < 2)
                    {
                        var petals = FloraTextures.Uv(LeafTile.Petals);
                        for (int i = 0; i < (lod == 0 ? 6 : 2); i++)
                        {
                            float a = i * 1.7f;
                            var c = V(Mathf.Cos(a) * 0.15f, 0.35f + R(60 + i) * 0.3f, Mathf.Sin(a) * 0.15f);
                            var col = Color.white; col.a = 1;
                            b.Card(c, V(0.025f, 0, 0), V(0, 0.025f, 0), Vector3.up, col, col, 0.5f, 0.5f, R(70 + i), petals, FloraPart.Fruit);
                        }
                    }
                    break;
                }
                default: // мох: невысокие подушки
                {
                    int bumps = lod == 0 ? 5 : lod == 1 ? 3 : 0;
                    for (int i = 0; i < bumps; i++)
                    {
                        float a = i * 2.39996f, r = 0.15f + R(i) * 0.2f;
                        Cushion(b, V(Mathf.Cos(a) * r, 0, Mathf.Sin(a) * r), 0.12f + R(i, 1) * 0.1f, 0.6f + R(i, 2) * 0.4f, R(i, 3));
                    }
                    if (bumps == 0) FlatCard(b, V(0, 0.2f, 0), 0.25f, 0, 0, LeafTile.GrassClump, Color.white, 0, FloraPart.Leaf, 0.5f);
                    break;
                }
            }
            return b.Build($"herb-{p.Key}-lod{lod}");
        }

        /// <summary>Соцветие-кисть иван-чая: стопка мелких карточек-лепестков вдоль верхушки.</summary>
        static void AddSpike(FloraMeshBuilder b, float baseY, float len, float w, int detail, Vector3 o = default)
        {
            var uv = FloraTextures.Uv(LeafTile.Petals);
            int n = 3 * detail + 2;
            for (int k = 0; k < n; k++)
            {
                float t = k / (float)(n - 1);
                float a = k * 2.4f;
                var c = o + V(0, baseY + t * len, 0);
                float s = w * (1 - 0.6f * t);
                var col = Color.white; col.a = 1;
                b.Card(c, V(Mathf.Cos(a), 0, Mathf.Sin(a)) * s, V(0, s * 0.9f, 0), Vector3.up, col, col, 0.8f + 0.2f * t, 1, 0.1f + 0.8f * t, uv, FloraPart.Flower);
            }
        }

        /// <summary>Подушка мха: приплюснутая полусфера (12 треугольников).</summary>
        static void Cushion(FloraMeshBuilder b, Vector3 c, float r, float h, float rnd)
        {
            int ring = 6;
            int top = b.Vertex(c + V(0, h * r * 2, 0), Vector3.up, Color.white, NoTex, 0.1f, 1, rnd);
            int start = b.Vertices;
            for (int i = 0; i < ring; i++)
            {
                float a = i * Mathf.PI * 2 / ring;
                var d = V(Mathf.Cos(a), 0, Mathf.Sin(a));
                var col = Color.white * 0.75f; col.a = 0.5f;
                b.Vertex(c + d * r + V(0, -0.01f, 0), (d + Vector3.up).normalized, col, NoTex, 0, 1, rnd);
            }
            for (int i = 0; i < ring; i++) b.Tri(start + i, top, start + (i + 1) % ring);
        }
    }
}
