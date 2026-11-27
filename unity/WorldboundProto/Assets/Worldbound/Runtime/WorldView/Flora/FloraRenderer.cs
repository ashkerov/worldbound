// Рендер растительности WORLDBOUND — точка входа модуля. Не часть симуляции: читает снимки источника
// (IFloraSnapshotSource) и условия кадра, строит визуальное представление. Не создаёт и не удаляет растения
// мира, не меняет биомассу, почву и численность, не вызывает RNG симуляции; камера влияет только на видимость
// и качество отрисовки.
//
// Кадр: 1) запрос пакета у источника и применение в бюджете времени (FloraChunkManager);
//       2) сезон и ветер из условий кадра (FloraSeasonController, FloraWindController), поля → текстуры;
//       3) отсечение и уровни детализации деревьев и кустарников (FloraWoodyLayer + FloraCulling, Burst);
//       4) трава вокруг камеры (FloraGrassRenderer); 5) вызовы RenderMeshIndirect.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Worldbound.FloraView
{
    public struct FloraFrameStats
    {
        public int Trees, Shrubs, TreesVisible, ShrubsVisible, GrassVisible, Impostors;
        public int TreeLod0, TreeLod1, TreeLod2, ShrubLod0, ShrubLod1, ShrubLod2;
        public int DrawCalls, LodChanges;
        public long Triangles, GrassTriangles;
        public float CullMs, GrassMs, ApplyMs;
        public bool GrassRegenerated;
    }

    public sealed class FloraRenderer : IDisposable
    {
        public FloraRenderSettings Settings;
        public readonly FloraCatalogInfo Catalog;
        public readonly FloraGrid Grid;
        public readonly FloraTerrain Terrain;
        readonly FloraMaterials materials;
        readonly FloraImpostors impostors;
        public readonly FloraWoodyLayer Trees, Shrubs;
        public readonly FloraGrassRenderer Grass;
        public readonly FloraFieldStore Fields;
        public readonly FloraChunkManager Chunks;
        readonly FloraSeasonController season;
        readonly FloraWindController wind = new();
        readonly List<WoodyProfile> woodyProfiles = new();
        IFloraSnapshotSource source;
        int impostorFrame;

        public bool DrawTrees = true, DrawShrubs = true, DrawGrass = true, DebugLod;
        /// <summary>Множитель дальностей уровней детализации (настройка «LOD»).</summary>
        public float LodBias = 1;
        public int Layer;
        public FloraFrameStats Stats;
        public FloraEnvironment Environment { get; private set; } = FloraEnvironment.Default;
        public FloraSeasonController Season => season;
        public FloraWindController Wind => wind;
        public float InitMs { get; }
        public float ImpostorBakeMs => impostors.BakeMs;
        public int MeshTriangles { get; private set; }
        public long MeshBytes { get; private set; }

        public FloraRenderer(FloraRenderAssets assets, FloraCatalogInfo catalog, FloraGrid grid, FloraTerrain terrain, FloraRenderSettings settings)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            Catalog = catalog;
            Grid = grid;
            Terrain = terrain;
            Settings = settings;
            materials = new FloraMaterials(assets);

            // Профили древесных: один на визуальный тип; вид каталога → профиль по ключу.
            var byKind = new Dictionary<WoodyKind, WoodyProfile>();
            var treeP = new List<WoodyProfile>();
            var shrubP = new List<WoodyProfile>();
            int maxId = 0;
            foreach (var s in catalog.Species) maxId = Math.Max(maxId, s.Id);
            var speciesKind = new Dictionary<int, WoodyKind>();
            foreach (var s in catalog.Species)
            {
                if (s.Form == FloraForm.Herb) continue;
                var k = WoodyProfile.KindFor(s);
                speciesKind[s.Id] = k;
                if (byKind.ContainsKey(k)) continue;
                var p = WoodyProfile.Create(k, s.Key);
                byKind[k] = p;
                (p.Shrub ? shrubP : treeP).Add(p);
            }
            int tris = 0;
            long bytes = 0;
            foreach (var p in treeP) woodyProfiles.Add(p);
            foreach (var p in shrubP) woodyProfiles.Add(p);
            for (int i = 0; i < woodyProfiles.Count; i++)
            {
                var p = woodyProfiles[i];
                p.VisualIndex = i;
                foreach (var a in p.Archetypes)
                {
                    a.Lods = new Mesh[3];
                    a.Triangles = new int[3];
                    for (int l = 0; l < 3; l++)
                    {
                        a.Lods[l] = WoodyModels.Build(p, a, l);
                        a.Triangles[l] = (int)(a.Lods[l].GetIndexCount(0) / 3);
                        tris += a.Triangles[l];
                        bytes += a.Lods[l].vertexCount * 64L + a.Lods[l].GetIndexCount(0) * 4L;
                    }
                    a.Bounds = a.Lods[0].bounds;
                }
            }

            // Импосторы деревьев: взрослый и старый архетипы; у лиственных — ещё «голые» строки.
            impostors = new FloraImpostors(materials.ImpostorShader);
            var rows = new List<FloraImpostors.Row>();
            var rowOf = new Dictionary<WoodyArchetype, int>();
            foreach (var p in treeP)
                foreach (var a in p.Archetypes)
                {
                    if (a != Mature(p) && a.Form != WoodyForm.Old) continue;
                    int leafy = rows.Count;
                    rows.Add(new FloraImpostors.Row { Mesh = a.Lods[0], Bounds = a.Bounds, Bare = false, BareRow = -1 });
                    if (!p.Evergreen)
                    {
                        var r = rows[leafy];
                        r.BareRow = rows.Count;
                        rows[leafy] = r;
                        rows.Add(new FloraImpostors.Row { Mesh = a.Lods[0], Bounds = a.Bounds, Bare = true, BareRow = -1 });
                    }
                    rowOf[a] = leafy;
                }
            impostorFrame = settings.ImpostorFrame;
            impostors.Bake(rows, materials.Woody, impostorFrame);
            impostors.Material.SetFloat("_ImpBlend", settings.ImpostorBlend ? 1 : 0);

            Trees = new FloraWoodyLayer("trees", false, treeP, materials.Woody, impostors, grid.ChunkCount);
            Shrubs = new FloraWoodyLayer("shrubs", true, shrubP, materials.Woody, null, grid.ChunkCount);

            // Карта видов каталога → слой, профиль, архетипы по возрасту (номера внутри слоя).
            var maps = new SpeciesMap[maxId + 1];
            foreach (var kv in speciesKind)
            {
                var p = byKind[kv.Value];
                var info = catalog.Find(kv.Key);
                WoodyArchetype young = null, ma = null, mb = null, old = null;
                foreach (var a in p.Archetypes)
                {
                    if (a.Form == WoodyForm.Young) young ??= a;
                    else if (a.Form == WoodyForm.Old) old ??= a;
                    else if (ma == null) ma = a; else mb ??= a;
                }
                float RH(WoodyArchetype a) => a?.RefHeight ?? ma.RefHeight;
                float RR(WoodyArchetype a) => a?.RefCrown ?? ma.RefCrown;
                maps[kv.Key] = new SpeciesMap
                {
                    Layer = p.Shrub ? 2 : 1,
                    Visual = p.VisualIndex,
                    Young = young?.Index ?? -1, MatureA = ma.Index, MatureB = mb?.Index ?? -1, Old = old?.Index ?? -1,
                    RefH = new Unity.Mathematics.float4(RH(young), RH(ma), RH(mb), RH(old)),
                    RefR = new Unity.Mathematics.float4(RR(young), RR(ma), RR(mb), RR(old)),
                    ImpostorMature = rowOf.TryGetValue(ma, out int im) ? im : -1,
                    ImpostorOld = old != null && rowOf.TryGetValue(old, out int io) ? io : (rowOf.TryGetValue(ma, out int im2) ? im2 : -1),
                    MaxHeight = info != null && info.MaxHeight > 0 ? info.MaxHeight : (old ?? ma).RefHeight,
                };
            }

            // Травы — по столбцам поля трав.
            var herbP = new List<HerbProfile>();
            for (int hcol = 0; hcol < catalog.HerbOrder.Length; hcol++)
            {
                var info = catalog.Find(catalog.HerbOrder[hcol]);
                var hp = HerbProfile.Create(info != null ? HerbProfile.KindFor(info) : HerbKind.MeadowGrass, info?.Key ?? "herb" + hcol);
                hp.VisualIndex = hcol;
                herbP.Add(hp);
                foreach (var m in hp.Lods) if (m) { tris += (int)(m.GetIndexCount(0) / 3); bytes += m.vertexCount * 64L + m.GetIndexCount(0) * 2L; }
            }
            MeshTriangles = tris;
            MeshBytes = bytes;
            Fields = new FloraFieldStore(grid, catalog.HerbOrder.Length);
            Grass = new FloraGrassRenderer(herbP, materials.Grass);
            Chunks = new FloraChunkManager(grid, terrain, Trees, Shrubs, Fields, maps) { VerifyChecksums = settings.VerifyChecksums };
            season = new FloraSeasonController(woodyProfiles, herbP);
            InitMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        static WoodyArchetype Mature(WoodyProfile p)
        {
            foreach (var a in p.Archetypes) if (a.Form == WoodyForm.Mature) return a;
            return p.Archetypes[0];
        }

        public void SetSource(IFloraSnapshotSource s) => source = s;

        public IReadOnlyList<WoodyProfile> WoodyProfiles => woodyProfiles;

        /// <summary>Кадр рендера растительности для камеры. dt — реальное время кадра (анимация ветра).</summary>
        public void Update(Camera cam, float dt)
        {
            var st = new FloraFrameStats();
            if (source != null)
            {
                if (!Chunks.Busy && source.TryGetUpdate(Chunks.WorldId, Chunks.Version, out var u)) Chunks.Begin(u);
                Chunks.VerifyChecksums = Settings.VerifyChecksums;
                if (Chunks.Busy) Chunks.Step(Settings.ApplyBudgetMs);
                st.ApplyMs = Chunks.Busy || Chunks.LastFrameApplyMs > 0 ? Chunks.LastFrameApplyMs : 0;
                Chunks.LastFrameApplyMs = 0;
                Environment = source.Environment;
            }
            var env = Environment;
            season.Apply(env);
            wind.Update(env, dt);
            Fields.Upload();
            materials.SetDebugLod(DebugLod);
            impostors.Material.SetFloat("_ImpBlend", Settings.ImpostorBlend ? 1 : 0);

            st.Trees = Trees.Total;
            st.Shrubs = Shrubs.Total;
            if (DrawTrees && Trees.Total > 0)
            {
                var lod = FloraTreeRenderer.Lod(Settings, LodBias);
                Trees.Cull(cam, lod, true);
                Trees.Draw(cam, lod, FloraTreeRenderer.Shadows(Settings), Layer);
                st.TreesVisible = Trees.Visible; st.TreeLod0 = Trees.PerLevel[0]; st.TreeLod1 = Trees.PerLevel[1]; st.TreeLod2 = Trees.PerLevel[2]; st.Impostors = Trees.PerLevel[3];
                st.DrawCalls += Trees.DrawCalls; st.Triangles += Trees.Triangles; st.CullMs += Trees.CullMs; st.LodChanges += Trees.LodChanges;
            }
            if (DrawShrubs && Shrubs.Total > 0)
            {
                var lod = FloraShrubRenderer.Lod(Settings, LodBias);
                Shrubs.Cull(cam, lod, false);
                Shrubs.Draw(cam, lod, FloraShrubRenderer.Shadows(Settings), Layer);
                st.ShrubsVisible = Shrubs.Visible; st.ShrubLod0 = Shrubs.PerLevel[0]; st.ShrubLod1 = Shrubs.PerLevel[1]; st.ShrubLod2 = Shrubs.PerLevel[2];
                st.DrawCalls += Shrubs.DrawCalls; st.Triangles += Shrubs.Triangles; st.CullMs += Shrubs.CullMs; st.LodChanges += Shrubs.LodChanges;
            }
            if (DrawGrass)
            {
                Grass.Update(cam, Fields, Terrain, Settings);
                Grass.Draw(cam, Settings.GrassRadius * Settings.DrawDistance, Layer);
                st.GrassVisible = Grass.Visible; st.GrassTriangles = Grass.Triangles; st.GrassMs = Grass.Regenerated ? Grass.GenMs : 0; st.GrassRegenerated = Grass.Regenerated;
                st.DrawCalls += Grass.DrawCalls; st.Triangles += Grass.Triangles;
            }
            Stats = st;
        }

        /// <summary>Пересобрать импосторы под новое разрешение кадра (смена профиля качества).</summary>
        public void ApplyQuality(FloraRenderSettings s)
        {
            Settings = s;
            Grass.Invalidate();
        }

        public long TextureBytes => materials.TextureBytes + impostors.Bytes + Fields.TextureBytes;

        public void Dispose()
        {
            Trees.Dispose();
            Shrubs.Dispose();
            Grass.Dispose();
            Chunks.Dispose();
            Fields.Dispose();
            season.Dispose();
            impostors.Dispose();
            materials.Dispose();
        }
    }
}
