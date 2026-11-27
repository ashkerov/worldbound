// Детерминированный синтетический источник снимков — ТОЛЬКО для графического стенда. Настоящую симуляцию
// не запускает и в неё ничего не пишет. Выдаёт данные строго в контракте (FloraUpdate через
// FloraSnapshotPublisher): шесть биомов (хвойный, смешанный, березняк, луг с рощами, густой лес, опушка),
// заданное число деревьев, травяной ярус по биому, пологу и влажности, полог по ячейкам, снег.
// Каталог видов повторяет content/plants/plants.json (номера и ключи), чтобы рендер выбирал профили так же,
// как с настоящей симуляцией. «Живые» обновления — рост, гибель и появление растений в нескольких чанках —
// проверяют инкрементальную передачу.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Worldbound.FloraView.Stand
{
    public sealed class SyntheticFloraSource : IFloraSnapshotSource
    {
        public enum Biome { Conifer = 0, Mixed, Birch, Meadow, Dense, Edge }
        public static readonly string[] BiomeNames = { "Хвойный лес", "Смешанный лес", "Березняк", "Луг с рощами", "Густой лес", "Опушка" };
        /// <summary>Центры биомов на местности 2 × 2 км (для камер стенда).</summary>
        public static readonly Vector2[] BiomeCentre = { new(420, 1640), new(1050, 1380), new(1680, 1560), new(430, 520), new(1100, 760), new(1720, 430) };
        const int B = 6;

        // Каталог (порядок и ключи — как в content/plants/plants.json).
        static readonly (string key, FloraForm form, FloraLeafHabit habit, float h, float r)[] Plants =
        {
            ("meadow-grass", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0), ("feather-grass", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0),
            ("sedge", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0), ("clover", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0),
            ("meadow-flowers", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0), ("fireweed", FloraForm.Herb, FloraLeafHabit.AnnualDieback, 0, 0),
            ("bilberry", FloraForm.Herb, FloraLeafHabit.Deciduous, 0, 0), ("moss", FloraForm.Herb, FloraLeafHabit.Evergreen, 0, 0),
            ("hazel", FloraForm.Shrub, FloraLeafHabit.Deciduous, 5, 2.5f), ("wild-rose", FloraForm.Shrub, FloraLeafHabit.Deciduous, 2.5f, 1.5f),
            ("willow-shrub", FloraForm.Shrub, FloraLeafHabit.Deciduous, 4, 2.2f), ("juniper", FloraForm.Shrub, FloraLeafHabit.Evergreen, 3, 1.5f),
            ("birch", FloraForm.Tree, FloraLeafHabit.Deciduous, 22, 4), ("pine", FloraForm.Tree, FloraLeafHabit.Evergreen, 28, 3.5f),
            ("spruce", FloraForm.Tree, FloraLeafHabit.Evergreen, 30, 3.5f), ("oak", FloraForm.Tree, FloraLeafHabit.Deciduous, 26, 7),
            ("linden", FloraForm.Tree, FloraLeafHabit.Deciduous, 28, 6), ("alder", FloraForm.Tree, FloraLeafHabit.Deciduous, 20, 4),
        };
        const int Hazel = 8, Rose = 9, Willow = 10, Juniper = 11, BirchS = 12, Pine = 13, Spruce = 14, Oak = 15, Linden = 16, Alder = 17;

        // Доли видов древесных по биомам.
        static readonly (int s, float p)[][] Mix =
        {
            new[] { (Spruce, 0.55f), (Pine, 0.33f), (BirchS, 0.06f), (Juniper, 0.06f) },
            new[] { (Spruce, 0.2f), (Pine, 0.12f), (BirchS, 0.18f), (Oak, 0.14f), (Linden, 0.14f), (Alder, 0.06f), (Hazel, 0.1f), (Rose, 0.03f), (Juniper, 0.03f) },
            new[] { (BirchS, 0.72f), (Pine, 0.08f), (Alder, 0.05f), (Spruce, 0.05f), (Hazel, 0.06f), (Willow, 0.04f) },
            new[] { (Oak, 0.3f), (BirchS, 0.2f), (Linden, 0.14f), (Pine, 0.05f), (Hazel, 0.12f), (Rose, 0.11f), (Willow, 0.05f), (Juniper, 0.03f) },
            new[] { (Spruce, 0.2f), (Linden, 0.18f), (Oak, 0.13f), (BirchS, 0.12f), (Alder, 0.14f), (Hazel, 0.13f), (Willow, 0.05f), (Rose, 0.05f) },
            new[] { (BirchS, 0.2f), (Pine, 0.1f), (Oak, 0.1f), (Hazel, 0.2f), (Rose, 0.15f), (Willow, 0.1f), (Juniper, 0.1f), (Alder, 0.05f) },
        };
        static readonly float[] BiomeDensity = { 1.1f, 1f, 0.9f, 0.09f, 1.7f, 0.55f };

        struct Plant
        {
            public uint Id;
            public float X, Z, Size, Jitter, Health;
            public ushort Species;
        }

        readonly FloraTerrain terrain;
        public readonly FloraGrid Grid = new(StandTerrain.Cells);
        public readonly FloraSnapshotPublisher Publisher;
        readonly FloraCatalogInfo catalog;
        readonly List<Plant>[] chunks;
        readonly float[] biomeW;   // ячейка × биом
        readonly float[] wetCell, dryCell, clearing;
        uint nextId = 1;
        int livingStep;
        FloraEnvironment env = FloraEnvironment.Default;
        float publishedPhase = -1, publishedSnow = -1, publishedWet = -1;
        public int TreeCount { get; private set; }
        public int ShrubCount { get; private set; }
        public float BuildMs { get; private set; }
        public float LastPublishMs { get; private set; }
        public int LastChangedChunks => Publisher.LastChangedWoody;

        public FloraCatalogInfo Catalog => catalog;
        public FloraEnvironment Environment => env;

        public SyntheticFloraSource(int targetTrees, FloraTerrain terrain, long worldId)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            this.terrain = terrain;
            Publisher = new FloraSnapshotPublisher(Grid, worldId);
            catalog = CatalogInfo();
            int cells = Grid.CellCount;
            biomeW = new float[cells * B];
            wetCell = new float[cells];
            dryCell = new float[cells];
            clearing = new float[cells];
            chunks = new List<Plant>[Grid.ChunkCount];
            for (int k = 0; k < chunks.Length; k++) chunks[k] = new List<Plant>();
            ComputeBiomes();
            Populate(targetTrees);
            BuildMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        /// <summary>Каталог видов стенда (номера и ключи как в content/plants/plants.json).</summary>
        public static FloraCatalogInfo CatalogInfo()
        {
            var c = new FloraCatalogInfo { HerbOrder = new[] { 0, 1, 2, 3, 4, 5, 6, 7 }, Species = new FloraSpeciesInfo[Plants.Length] };
            for (int i = 0; i < Plants.Length; i++)
                c.Species[i] = new FloraSpeciesInfo { Id = i, Key = Plants[i].key, Form = Plants[i].form, Habit = Plants[i].habit, MaxHeight = Plants[i].h, MaxCrownRadius = Plants[i].r };
            return c;
        }

        public static Biome BiomeAt(float x, float z)
        {
            float best = -1; int bi = 0;
            var w = new float[B];
            Weights(x, z, w);
            for (int b = 0; b < B; b++) if (w[b] > best) { best = w[b]; bi = b; }
            return (Biome)bi;
        }

        static void Weights(float x, float z, float[] w)
        {
            // Изрезанные границы: координаты искажены шумом.
            float wx = x + (FloraHash.Fbm(41, x * 0.004f, z * 0.004f, 3) - 0.5f) * 320;
            float wz = z + (FloraHash.Fbm(43, x * 0.004f, z * 0.004f, 3) - 0.5f) * 320;
            float sum = 0;
            for (int b = 0; b < B; b++)
            {
                float d = Vector2.Distance(new Vector2(wx, wz), BiomeCentre[b]) / 430f;
                w[b] = Mathf.Exp(-d * d * 2.2f);
                sum += w[b];
            }
            for (int b = 0; b < B; b++) w[b] /= Mathf.Max(1e-5f, sum);
        }

        void ComputeBiomes()
        {
            var w = new float[B];
            float cs = Grid.CellSize;
            for (int c = 0; c < Grid.CellCount; c++)
            {
                float x = (c % Grid.Cells + 0.5f) * cs, z = (c / Grid.Cells + 0.5f) * cs;
                Weights(x, z, w);
                for (int b = 0; b < B; b++) biomeW[c * B + b] = w[b];
                float h = terrain.Sample(x, z);
                wetCell[c] = Mathf.Clamp01(Mathf.Exp(-Sq((x - 1350) / 230f) - Sq((z - 520) / 180f)) * 1.3f + (h < 18 ? (18 - h) / 30f : 0));
                dryCell[c] = Mathf.Clamp01((h - 55) / 40f);
                clearing[c] = Mathf.Clamp01(1 - FloraHash.Fbm(57, x * 0.009f, z * 0.009f, 3) * 2.6f + 0.55f) * (1 - w[(int)Biome.Meadow]);
            }
        }

        static float Sq(float v) => v * v;

        float W(int c, Biome b) => biomeW[c * B + (int)b];
        readonly float[] gBuf = new float[8];

        float DensityAt(int c, float x, float z)
        {
            float d = 0;
            for (int b = 0; b < B; b++) d += biomeW[c * B + b] * BiomeDensity[b];
            // Рощи на лугу: высокочастотный шум собирает деревья в группы.
            float grove = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.58f, 0.75f, FloraHash.Fbm(61, x * 0.012f, z * 0.012f, 2)));
            d += biomeW[c * B + (int)Biome.Meadow] * grove * 1.4f;
            // Опушка: лес сходит на нет к юго-востоку.
            d *= Mathf.Lerp(1, Mathf.Clamp01((z - 250) / 380f) * 1.2f + 0.08f, biomeW[c * B + (int)Biome.Edge]);
            d *= 1 - clearing[c] * 0.85f;
            return d;
        }

        void Populate(int target)
        {
            int cells = Grid.CellCount;
            float cs = Grid.CellSize;
            var lam = new float[cells];
            double sum = 0;
            for (int c = 0; c < cells; c++)
            {
                float x = (c % Grid.Cells + 0.5f) * cs, z = (c / Grid.Cells + 0.5f) * cs;
                lam[c] = DensityAt(c, x, z);
                sum += lam[c];
            }
            // Число задаётся для деревьев: кусты биома добавляются сверх него (доля деревьев ячейки — по долям видов биомов).
            var share = new float[cells];
            double treesExpected = 0;
            for (int c = 0; c < cells; c++)
            {
                float sh = 0;
                for (int b = 0; b < B; b++) sh += biomeW[c * B + b] * TreeShare(b);
                share[c] = Mathf.Max(0.2f, sh);
                treesExpected += lam[c];
            }
            float scale = (float)(target / Math.Max(1e-6, treesExpected));
            TreeCount = ShrubCount = 0;
            for (int c = 0; c < cells; c++)
            {
                float l = lam[c] * scale / share[c];
                int n = Mathf.Min(12, (int)l + (FloraHash.F(91, c, 0) < l - (int)l ? 1 : 0));
                int cx = c % Grid.Cells, cz = c / Grid.Cells;
                for (int k = 0; k < n; k++)
                {
                    float x = (cx + FloraHash.F(92, c, k)) * cs, z = (cz + FloraHash.F(93, c, k)) * cs;
                    int s = PickSpecies(c, FloraHash.F(94, c, k));
                    AddPlant(s, x, z, FloraHash.F(95, c, k), c, k);
                }
            }
        }

        static float TreeShare(int biome)
        {
            float t = 0, all = 0;
            foreach (var m in Mix[biome]) { all += m.p; if (Plants[m.s].form == FloraForm.Tree) t += m.p; }
            return t / all;
        }

        int PickSpecies(int c, float r)
        {
            // Биом ячейки выбирается по весам, вид — по долям биома; в сырой низине — ольха и ива.
            float acc = 0;
            int biome = 0;
            float rb = FloraHash.F(96, c, (int)(r * 1000));
            for (int b = 0; b < B; b++) { acc += biomeW[c * B + b]; if (rb <= acc) { biome = b; break; } biome = b; }
            if (wetCell[c] > 0.4f && r < wetCell[c] * 0.7f) return r < wetCell[c] * 0.45f ? Alder : Willow;
            var mix = Mix[biome];
            float t = 0, total = 0;
            foreach (var m in mix) total += m.p;
            float pick = r * total;
            foreach (var m in mix) { t += m.p; if (pick <= t) return m.s; }
            return mix[mix.Length - 1].s;
        }

        void AddPlant(int s, float x, float z, float r, int c, int k)
        {
            bool shrub = Plants[s].form == FloraForm.Shrub;
            float size = shrub ? 0.45f + 0.55f * FloraHash.F(97, c, k) : 0.16f + 0.84f * Mathf.Pow(FloraHash.F(97, c, k), 0.55f);
            var p = new Plant { Id = nextId++, X = x, Z = z, Size = size, Species = (ushort)s, Jitter = (FloraHash.F(98, c, k) - 0.5f) * 0.06f, Health = FloraHash.F(99, c, k) < 0.03f ? 0.35f : 0.78f + 0.22f * FloraHash.F(100, c, k) };
            chunks[Grid.ChunkAt(x, z)].Add(p);
            if (shrub) ShrubCount++; else TreeCount++;
        }

        static float Leaf(FloraLeafHabit habit, float phase, float jitter)
        {
            if (habit == FloraLeafHabit.Evergreen) return 1;
            float p = Mathf.Repeat(phase - jitter, 1);
            if (p < 0.03f) return 0;
            if (p < 0.15f) return Mathf.SmoothStep(0, 1, (p - 0.03f) / 0.12f);
            if (p < 0.57f) return 1;
            if (p < 0.76f) return 1 - Mathf.SmoothStep(0, 1, (p - 0.57f) / 0.19f);
            return 0;
        }

        WoodyPlant ToContract(in Plant p)
        {
            var info = Plants[p.Species];
            float h = info.h * p.Size * (0.92f + 0.16f * FloraHash.F(110, (int)p.Id)), r = info.r * Mathf.Pow(p.Size, 0.9f) * (0.85f + 0.3f * FloraHash.F(111, (int)p.Id));
            byte stage = (byte)(p.Size < 0.12f ? 0 : p.Size < 0.3f ? 1 : p.Size > 0.88f && FloraHash.F(112, (int)p.Id) < 0.55f ? 3 : 2);
            return new WoodyPlant
            {
                Id = p.Id, X = p.X, Z = p.Z,
                Height = Mathf.Round(h * 20) / 20, CrownRadius = Mathf.Round(r * 20) / 20, Biomass = Mathf.Round(p.Size * 1000),
                Species = p.Species, Leaf = FloraContract.Unit(Leaf(info.habit, env.YearPhase, p.Jitter)), Health = FloraContract.Unit(p.Health), Stage = stage,
            };
        }

        // ───────── публикация ─────────

        /// <summary>Условия кадра (стенд управляет сезоном, ветром, снегом). Смена сезона/снега переиздаёт чанки.</summary>
        public void SetEnvironment(FloraEnvironment e, bool republishIfNeeded = true)
        {
            env = e;
            if (!republishIfNeeded) return;
            if (Mathf.Abs(e.YearPhase - publishedPhase) > 0.004f || Mathf.Abs(e.Snow - publishedSnow) > 0.02f || Mathf.Abs(e.Wetness - publishedWet) > 0.05f) PublishAll();
        }

        public void PublishAll()
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            for (int k = 0; k < chunks.Length; k++) StageChunk(k);
            Publisher.Commit(0);
            publishedPhase = env.YearPhase; publishedSnow = env.Snow; publishedWet = env.Wetness;
            LastPublishMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        void StageChunk(int k)
        {
            var list = chunks[k];
            var arr = new WoodyPlant[list.Count];
            for (int i = 0; i < list.Count; i++) arr[i] = ToContract(list[i]);
            Array.Sort(arr, (a, b) => a.Id.CompareTo(b.Id));
            Publisher.StageWoody(new WoodyChunk { Chunk = k, Plants = arr, Count = arr.Length });
            Publisher.StageField(BuildField(k, arr));
        }

        float SeasonHerb(FloraLeafHabit habit, float p)
        {
            if (habit == FloraLeafHabit.Evergreen) return 1;
            if (habit == FloraLeafHabit.Deciduous) return 0.75f + 0.25f * Leaf(FloraLeafHabit.Deciduous, p, 0);
            if (p < 0.2f) return 0.3f + 0.7f * p / 0.2f;
            if (p < 0.55f) return 1;
            if (p < 0.78f) return 1 - 0.65f * (p - 0.55f) / 0.23f;
            return 0.22f;
        }

        FieldChunk BuildField(int k, WoodyPlant[] plants)
        {
            int cpc = Grid.CellsPerChunk, H = 8;
            var fc = new FieldChunk { Chunk = k, Herbs = new byte[cpc * H], HerbCell = new byte[cpc * 4], Canopy = new byte[cpc * 4], Surface = new byte[cpc * 2] };
            // Полог из растений чанка (как Cover симуляции, упрощённо): площадь крон / площадь ячейки.
            var tree = new float[cpc]; var con = new float[cpc]; var shrub = new float[cpc]; var leafS = new float[cpc]; var leafN = new int[cpc];
            int cps = Grid.ChunksPerSide, ox = k % cps * Grid.ChunkCells, oz = k / cps * Grid.ChunkCells;
            foreach (var p in plants)
            {
                int lx = Mathf.Clamp((int)(p.X / Grid.CellSize) - ox, 0, Grid.ChunkCells - 1), lz = Mathf.Clamp((int)(p.Z / Grid.CellSize) - oz, 0, Grid.ChunkCells - 1);
                int l = lz * Grid.ChunkCells + lx;
                var info = Plants[p.Species];
                float area = Mathf.PI * p.CrownRadius * p.CrownRadius / (Grid.CellSize * Grid.CellSize) * 0.75f * (0.3f + 0.7f * p.Leaf / 255f);
                if (info.form == FloraForm.Tree) { tree[l] += area; if (info.habit == FloraLeafHabit.Evergreen) con[l] += area; }
                else shrub[l] += area;
                leafS[l] += p.Leaf / 255f; leafN[l]++;
            }
            float phase = env.YearPhase;
            for (int l = 0; l < cpc; l++)
            {
                int c = Grid.CellOfChunk(k, l);
                if (c < 0) continue;
                float x = (c % Grid.Cells + 0.5f) * Grid.CellSize, z = (c / Grid.Cells + 0.5f) * Grid.CellSize;
                float u = Mathf.Clamp01(tree[l] + shrub[l] * 0.5f);
                float wet = wetCell[c], dry = dryCell[c], clear = clearing[c];
                float patch = FloraHash.Noise(71, x * 0.08f, z * 0.08f);
                float open = 1 - u * 0.85f;
                var g = gBuf;
                g[0] = (W(c, Biome.Meadow) * 380 + W(c, Biome.Edge) * 260 + W(c, Biome.Mixed) * 70 + W(c, Biome.Birch) * 140 + W(c, Biome.Dense) * 40 + clear * 160) * open * (1 - wet * 0.6f) * (1 - dry * 0.6f);
                g[1] = (dry * 320 + W(c, Biome.Edge) * 40) * open * (W(c, Biome.Meadow) + W(c, Biome.Edge) + W(c, Biome.Conifer) * 0.4f);
                g[2] = (wet * 420 + W(c, Biome.Birch) * 30) * (1 - u * 0.5f);
                g[3] = (W(c, Biome.Meadow) * W(c, Biome.Meadow) * 260 + W(c, Biome.Edge) * 70) * open * open * Mathf.SmoothStep(0, 1, (patch - 0.35f) * 3);
                g[4] = (W(c, Biome.Meadow) * 150 + W(c, Biome.Edge) * 130 + W(c, Biome.Birch) * 35 + clear * 50) * open * (1 - wet * 0.7f);
                g[5] = (clear * 300 + W(c, Biome.Edge) * 70) * open * (1 - wet);
                g[6] = (W(c, Biome.Conifer) * 260 + W(c, Biome.Mixed) * 90 + W(c, Biome.Birch) * 90) * u;
                g[7] = (W(c, Biome.Conifer) * 250 + W(c, Biome.Dense) * 160 + W(c, Biome.Mixed) * 90 + wet * 60) * Mathf.Clamp01(u * 1.3f);
                float total = 0;
                for (int h = 0; h < H; h++)
                {
                    float grams = g[h] * SeasonHerb(Plants[h].habit, phase) * (0.75f + 0.5f * FloraHash.Noise(80 + h, x * 0.05f, z * 0.05f));
                    total += grams;
                    fc.Herbs[l * H + h] = FloraContract.HerbByte(grams);
                }
                float green = phase < 0.08f ? 0.55f : phase < 0.52f ? 1 - dry * 0.35f * Mathf.Clamp01((phase - 0.3f) * 5) : phase < 0.78f ? Mathf.Lerp(0.85f, 0.15f, (phase - 0.52f) / 0.26f) : 0.08f;
                float straw = phase < 0.1f ? 0.35f * (1 - phase / 0.1f) : phase > 0.6f ? Mathf.Clamp01((phase - 0.6f) * 3) * 0.55f : 0.03f + dry * 0.1f;
                fc.HerbCell[l * 4] = FloraContract.Unit(1 - Mathf.Exp(-total / 120f));
                fc.HerbCell[l * 4 + 1] = 0;
                fc.HerbCell[l * 4 + 2] = FloraContract.Unit(green);
                fc.HerbCell[l * 4 + 3] = FloraContract.Unit(straw);
                fc.Canopy[l * 4] = FloraContract.Unit(tree[l]);
                fc.Canopy[l * 4 + 1] = tree[l] > 1e-4f ? FloraContract.Unit(con[l] / tree[l]) : (byte)0;
                fc.Canopy[l * 4 + 2] = FloraContract.Unit(shrub[l]);
                fc.Canopy[l * 4 + 3] = leafN[l] > 0 ? FloraContract.Unit(leafS[l] / leafN[l]) : (byte)255;
                float snow = env.Snow * (0.85f + 0.15f * FloraHash.Noise(72, x * 0.02f, z * 0.02f)) * (1 - 0.45f * Mathf.Clamp01(tree[l] * (con[l] > 0 ? 1 : 0.4f)));
                fc.Surface[l * 2] = FloraContract.Unit(snow);
                fc.Surface[l * 2 + 1] = FloraContract.Unit(Mathf.Clamp01(wet * 0.7f + env.Wetness * 0.6f));
            }
            return fc;
        }

        /// <summary>
        /// «Живое» обновление нескольких чанков (как суточный шаг симуляции): рост, гибель, всходы. Возвращает
        /// число изменённых чанков. Детерминированно по номеру шага.
        /// </summary>
        public int LivingStep(float share = 0.03f)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            livingStep++;
            int n = Mathf.Max(1, Mathf.RoundToInt(chunks.Length * share));
            for (int j = 0; j < n; j++)
            {
                int k = (int)(FloraHash.F(120, livingStep, j) * chunks.Length) % chunks.Length;
                var list = chunks[k];
                if (list.Count == 0) continue;
                for (int i = 0; i < list.Count; i++)
                {
                    var p = list[i];
                    if (FloraHash.F(121, livingStep, (int)p.Id) < 0.3f) { p.Size = Mathf.Min(1, p.Size + 0.02f); list[i] = p; }
                }
                // Гибель одного растения и всходы.
                int dead = (int)(FloraHash.F(122, livingStep, j) * list.Count);
                var d = list[dead];
                list.RemoveAt(dead);
                int born = 1 + (int)(FloraHash.F(123, livingStep, j) * 2);
                for (int b = 0; b < born; b++)
                {
                    float x = Mathf.Clamp(d.X + (FloraHash.F(124, livingStep, j * 4 + b) - 0.5f) * 14, 0, StandTerrain.Size - 0.1f);
                    float z = Mathf.Clamp(d.Z + (FloraHash.F(125, livingStep, j * 4 + b) - 0.5f) * 14, 0, StandTerrain.Size - 0.1f);
                    if (Grid.ChunkAt(x, z) != k) continue;
                    list.Add(new Plant { Id = nextId++, X = x, Z = z, Size = 0.14f, Species = d.Species, Jitter = d.Jitter, Health = 0.9f });
                }
                StageChunk(k);
            }
            Publisher.Commit(livingStep);
            LastPublishMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
            return Publisher.LastChangedWoody;
        }

        /// <summary>Расстояние до ближайшего растения (для камер стенда: не ставить камеру в ствол).</summary>
        public float NearestPlant(float x, float z)
        {
            float best = float.MaxValue;
            int k0 = Grid.ChunkAt(x, z), cps = Grid.ChunksPerSide;
            for (int dz = -1; dz <= 1; dz++)
                for (int dx = -1; dx <= 1; dx++)
                {
                    int cx = k0 % cps + dx, cz = k0 / cps + dz;
                    if (cx < 0 || cz < 0 || cx >= cps || cz >= cps) continue;
                    foreach (var p in chunks[cz * cps + cx]) best = Mathf.Min(best, (p.X - x) * (p.X - x) + (p.Z - z) * (p.Z - z));
                }
            return Mathf.Sqrt(best);
        }

        public bool TryGetUpdate(long appliedWorldId, long appliedVersion, out FloraUpdate update) => Publisher.TryGetUpdate(appliedWorldId, appliedVersion, out update);

        /// <summary>Свёртка всего опубликованного состояния — для проверки, что рендер ничего не меняет в источнике.</summary>
        public uint StateHash()
        {
            Publisher.TryGetUpdate(-1, -1, out var u);
            return FloraChecksum.Mix(u.WoodyStateChecksum, u.FieldStateChecksum);
        }
    }
}
