// Визуальные профили древесных видов: палитра по сезонам, гибкость на ветру, цветение и плоды, архетипы моделей.
// Профиль выбирается по ключу каталога ("birch"…); неизвестный вид получает общий профиль по форме и типу листвы —
// новый вид каталога отрисуется без правки рендера. Цвета заданы в sRGB и переводятся в линейное пространство.

using System.Collections.Generic;
using UnityEngine;

namespace Worldbound.FloraView
{
    public enum WoodyKind { Spruce, Pine, Birch, Oak, Linden, Alder, Hazel, WildRose, WillowShrub, Juniper }

    public enum WoodyForm : byte { Young = 0, Mature = 1, Old = 2 }

    public sealed class WoodyArchetype
    {
        public WoodyForm Form;
        public int Seed;
        /// <summary>Высота и радиус кроны эталонной модели, м: экземпляр растягивается до значений симуляции.</summary>
        public float RefHeight, RefCrown;
        /// <summary>Номер в общем списке архетипов слоя (заполняет рендер).</summary>
        public int Index;
        public Mesh[] Lods;
        public Bounds Bounds;
        public int[] Triangles;
    }

    public sealed class WoodyProfile
    {
        public string Key;
        public WoodyKind Kind;
        public bool Shrub, Evergreen, Conifer;
        public LeafTile Tile;
        public Color LeafBase, LeafLit, Spring, AutumnA, AutumnB;
        public Color Bloom = Color.clear, Fruit = Color.clear;
        /// <summary>Окно цветения и плодов (доля года).</summary>
        public Vector2 BloomWindow, FruitWindow;
        /// <summary>Гибкость ствола, ветвей и трепет листвы (берёза и ива — гибкие, дуб — жёсткий).</summary>
        public float TrunkFlex = 1, BranchFlex = 1, Flutter = 1;
        /// <summary>Просвечивание листвы на контровом свете.</summary>
        public float Translucency = 0.5f;
        /// <summary>Сколько снега удерживает крона (ель — много).</summary>
        public float SnowCatch = 0.5f;
        /// <summary>Порядковый номер профиля в буфере параметров видов (заполняет рендер).</summary>
        public int VisualIndex;
        public readonly List<WoodyArchetype> Archetypes = new();

        static Color C(int hex) => new Color(((hex >> 16) & 255) / 255f, ((hex >> 8) & 255) / 255f, (hex & 255) / 255f).linear;

        static WoodyProfile Tree(string key, WoodyKind kind, bool evergreen, bool conifer, LeafTile tile, int baseC, int lit, int spring, int autA, int autB)
            => new() { Key = key, Kind = kind, Evergreen = evergreen, Conifer = conifer, Tile = tile, LeafBase = C(baseC), LeafLit = C(lit), Spring = C(spring), AutumnA = C(autA), AutumnB = C(autB) };

        void Arch(WoodyForm f, int seed, float h, float r) => Archetypes.Add(new WoodyArchetype { Form = f, Seed = seed, RefHeight = h, RefCrown = r });

        public static WoodyProfile Create(WoodyKind kind, string key)
        {
            WoodyProfile p;
            switch (kind)
            {
                case WoodyKind.Spruce:
                    p = Tree(key, kind, true, true, LeafTile.Spruce, 0x1d3b2b, 0x4c7449, 0x6f9a52, 0x1d3b2b, 0x1d3b2b);
                    p.TrunkFlex = 0.55f; p.BranchFlex = 0.7f; p.Flutter = 0.25f; p.Translucency = 0.15f; p.SnowCatch = 1f;
                    p.Arch(WoodyForm.Young, 11, 5, 1.7f); p.Arch(WoodyForm.Mature, 12, 20, 3.3f); p.Arch(WoodyForm.Mature, 13, 24, 3.6f); p.Arch(WoodyForm.Old, 14, 29, 4.3f);
                    break;
                case WoodyKind.Pine:
                    p = Tree(key, kind, true, true, LeafTile.Pine, 0x2c4c33, 0x7f9b5a, 0x8fae60, 0x2c4c33, 0x2c4c33);
                    p.TrunkFlex = 0.6f; p.BranchFlex = 0.8f; p.Flutter = 0.3f; p.Translucency = 0.2f; p.SnowCatch = 0.8f;
                    p.Arch(WoodyForm.Young, 21, 6, 1.9f); p.Arch(WoodyForm.Mature, 22, 20, 3.2f); p.Arch(WoodyForm.Mature, 23, 24, 3.6f); p.Arch(WoodyForm.Old, 24, 27, 4.6f);
                    break;
                case WoodyKind.Birch:
                    p = Tree(key, kind, false, false, LeafTile.Birch, 0x587d31, 0xa8c15a, 0xbbd872, 0xe0b23a, 0xc68922);
                    p.TrunkFlex = 1.25f; p.BranchFlex = 1.5f; p.Flutter = 1.5f; p.Translucency = 0.75f; p.SnowCatch = 0.35f;
                    p.Arch(WoodyForm.Young, 31, 5, 1.4f); p.Arch(WoodyForm.Mature, 32, 16, 3.2f); p.Arch(WoodyForm.Mature, 33, 19, 3.6f); p.Arch(WoodyForm.Old, 34, 21, 4.3f);
                    break;
                case WoodyKind.Oak:
                    p = Tree(key, kind, false, false, LeafTile.Oak, 0x3b5d29, 0x7e9944, 0xa6bf5e, 0xa0662c, 0x7a4c24);
                    p.TrunkFlex = 0.45f; p.BranchFlex = 0.7f; p.Flutter = 0.8f; p.Translucency = 0.4f; p.SnowCatch = 0.45f;
                    p.Arch(WoodyForm.Young, 41, 5, 2.0f); p.Arch(WoodyForm.Mature, 42, 16, 5.5f); p.Arch(WoodyForm.Mature, 43, 19, 6.2f); p.Arch(WoodyForm.Old, 44, 24, 7.6f);
                    break;
                case WoodyKind.Linden:
                    p = Tree(key, kind, false, false, LeafTile.Linden, 0x48702e, 0x99b14c, 0xb6cd66, 0xd8a83a, 0xb07a28);
                    p.TrunkFlex = 0.7f; p.BranchFlex = 0.9f; p.Flutter = 1f; p.Translucency = 0.6f; p.SnowCatch = 0.45f;
                    p.Bloom = C(0xe8dc8a); p.BloomWindow = new Vector2(0.34f, 0.42f);
                    p.Arch(WoodyForm.Young, 51, 5, 1.8f); p.Arch(WoodyForm.Mature, 52, 18, 4.8f); p.Arch(WoodyForm.Mature, 53, 22, 5.3f); p.Arch(WoodyForm.Old, 54, 26, 6.3f);
                    break;
                case WoodyKind.Alder:
                    p = Tree(key, kind, false, false, LeafTile.Alder, 0x32502a, 0x6f8b3f, 0x8fae56, 0x6a6f30, 0x6e5a2a);
                    p.TrunkFlex = 0.9f; p.BranchFlex = 1.1f; p.Flutter = 1.1f; p.Translucency = 0.45f; p.SnowCatch = 0.4f;
                    p.Arch(WoodyForm.Young, 61, 4.5f, 1.5f); p.Arch(WoodyForm.Mature, 62, 14, 3.4f); p.Arch(WoodyForm.Mature, 63, 17, 3.8f); p.Arch(WoodyForm.Old, 64, 19, 4.3f);
                    break;
                case WoodyKind.Hazel:
                    p = Tree(key, kind, false, false, LeafTile.Hazel, 0x4a6a2f, 0x93aa4e, 0xadc463, 0xd2b244, 0xb88a30);
                    p.Shrub = true; p.TrunkFlex = 1.1f; p.BranchFlex = 1.2f; p.Flutter = 1.1f; p.Translucency = 0.55f;
                    p.Arch(WoodyForm.Mature, 71, 4, 2.2f); p.Arch(WoodyForm.Mature, 72, 3, 1.8f);
                    break;
                case WoodyKind.WildRose:
                    p = Tree(key, kind, false, false, LeafTile.Rose, 0x45652e, 0x86a24c, 0x9fbb5c, 0xb24c2a, 0xc97c32);
                    p.Shrub = true; p.TrunkFlex = 1.3f; p.BranchFlex = 1.3f; p.Flutter = 1.2f; p.Translucency = 0.5f;
                    p.Bloom = C(0xec8fae); p.BloomWindow = new Vector2(0.22f, 0.36f);
                    p.Fruit = C(0xb3261c); p.FruitWindow = new Vector2(0.5f, 0.8f);
                    p.Arch(WoodyForm.Mature, 81, 1.8f, 1.25f); p.Arch(WoodyForm.Mature, 82, 1.35f, 1.0f);
                    break;
                case WoodyKind.WillowShrub:
                    p = Tree(key, kind, false, false, LeafTile.Willow, 0x5a7848, 0xa6ba88, 0xb5cc80, 0xc8b24a, 0x9a8a3a);
                    p.Shrub = true; p.TrunkFlex = 1.4f; p.BranchFlex = 1.6f; p.Flutter = 1.6f; p.Translucency = 0.6f;
                    p.Arch(WoodyForm.Mature, 91, 3.6f, 2.0f); p.Arch(WoodyForm.Mature, 92, 2.6f, 1.7f);
                    break;
                default: // Juniper
                    p = Tree(key, WoodyKind.Juniper, true, true, LeafTile.Juniper, 0x2a4839, 0x6b896a, 0x7a9a72, 0x2a4839, 0x2a4839);
                    p.Shrub = true; p.TrunkFlex = 0.6f; p.BranchFlex = 0.7f; p.Flutter = 0.3f; p.Translucency = 0.15f; p.SnowCatch = 0.9f;
                    p.Arch(WoodyForm.Mature, 101, 3.0f, 0.95f); p.Arch(WoodyForm.Mature, 102, 1.8f, 1.4f);
                    break;
            }
            return p;
        }

        /// <summary>Вид каталога → профиль: по ключу, иначе по форме и типу листвы.</summary>
        public static WoodyKind KindFor(FloraSpeciesInfo s)
        {
            switch (s.Key)
            {
                case "spruce": return WoodyKind.Spruce;
                case "pine": return WoodyKind.Pine;
                case "birch": return WoodyKind.Birch;
                case "oak": return WoodyKind.Oak;
                case "linden": return WoodyKind.Linden;
                case "alder": return WoodyKind.Alder;
                case "hazel": return WoodyKind.Hazel;
                case "wild-rose": return WoodyKind.WildRose;
                case "willow-shrub": return WoodyKind.WillowShrub;
                case "juniper": return WoodyKind.Juniper;
            }
            if (s.Form == FloraForm.Shrub) return s.Habit == FloraLeafHabit.Evergreen ? WoodyKind.Juniper : WoodyKind.Hazel;
            return s.Habit == FloraLeafHabit.Evergreen ? WoodyKind.Spruce : WoodyKind.Linden;
        }
    }
}
