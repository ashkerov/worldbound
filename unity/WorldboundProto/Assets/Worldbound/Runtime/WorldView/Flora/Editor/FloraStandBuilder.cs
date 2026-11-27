// Инструменты редактора рендера растительности (batchmode, без ручных действий):
//   CreateStand — ассет шейдеров FloraRenderAssets, материал неба, сцена FloraRendererStand.unity со стендом;
//   BuildStand  — отдельная Windows-сборка стенда (Build/FloraStand/FloraStand.exe; сцена Main и BuildTools не меняются);
//   RunChecks   — проверки контракта, издателя, синтетического источника, применения пакетов рендером и того,
//                 что адаптер симуляции только читает мир (хеш состояния Simulation до и после снимка совпадает).
// Unity.exe -batchmode -quit -projectPath <проект> -executeMethod Worldbound.FloraView.EditorTools.FloraStandBuilder.<Метод>

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using Worldbound.FloraView.Stand;

namespace Worldbound.FloraView.EditorTools
{
    public static class FloraStandBuilder
    {
        const string Root = "Assets/Worldbound/Runtime/WorldView/Flora";
        const string AssetsPath = Root + "/FloraRenderAssets.asset";
        const string SkyPath = Root + "/Stand/FloraStandSky.mat";
        public const string ScenePath = "Assets/Worldbound/Scenes/FloraRendererStand.unity";
        static string ProjectDir => Directory.GetParent(Application.dataPath)!.FullName;
        static string ResultsDir => Path.GetFullPath(Path.Combine(ProjectDir, "..", "Results", "flora"));

        [MenuItem("WORLDBOUND/Flora/Create stand scene")]
        public static void CreateStand()
        {
            var assets = AssetDatabase.LoadAssetAtPath<FloraRenderAssets>(AssetsPath);
            if (!assets)
            {
                assets = ScriptableObject.CreateInstance<FloraRenderAssets>();
                AssetDatabase.CreateAsset(assets, AssetsPath);
            }
            assets.Woody = AssetDatabase.LoadAssetAtPath<Shader>(Root + "/Shaders/FloraWoody.shader");
            assets.Impostor = AssetDatabase.LoadAssetAtPath<Shader>(Root + "/Shaders/FloraImpostor.shader");
            assets.Grass = AssetDatabase.LoadAssetAtPath<Shader>(Root + "/Shaders/FloraGrass.shader");
            if (!assets.Woody || !assets.Impostor || !assets.Grass) throw new Exception("Шейдеры растительности не найдены");
            EditorUtility.SetDirty(assets);

            var sky = AssetDatabase.LoadAssetAtPath<Material>(SkyPath);
            if (!sky)
            {
                sky = new Material(Shader.Find("Skybox/Procedural"));
                AssetDatabase.CreateAsset(sky, SkyPath);
            }
            sky.shader = Shader.Find("Skybox/Procedural");
            sky.SetFloat("_SunSize", 0.035f);
            sky.SetFloat("_SunSizeConvergence", 6);
            sky.SetFloat("_AtmosphereThickness", 0.9f);
            sky.SetColor("_SkyTint", new Color(0.52f, 0.6f, 0.75f));
            sky.SetColor("_GroundColor", new Color(0.4f, 0.42f, 0.38f));
            sky.SetFloat("_Exposure", 1.12f);
            EditorUtility.SetDirty(sky);

            Directory.CreateDirectory(Path.Combine(ProjectDir, "Assets/Worldbound/Scenes"));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = new GameObject("FloraRendererStand");
            var stand = go.AddComponent<FloraRendererStand>();
            stand.FloraAssets = assets;
            stand.GroundShader = AssetDatabase.LoadAssetAtPath<Shader>(Root + "/Stand/StandGround.shader");
            stand.SkyMaterial = sky;
            if (!stand.GroundShader) throw new Exception("StandGround.shader не найден");
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log("[Flora] стенд создан: " + ScenePath);
        }

        [MenuItem("WORLDBOUND/Flora/Build stand (Windows)")]
        public static void BuildStand()
        {
            if (!File.Exists(Path.Combine(ProjectDir, ScenePath))) CreateStand();
            var dir = Path.Combine(ProjectDir, "Build", "FloraStand");
            Directory.CreateDirectory(dir);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = Path.Combine(dir, "FloraStand.exe"),
                target = BuildTarget.StandaloneWindows64,
                options = BuildOptions.None,
            });
            var s = report.summary;
            Directory.CreateDirectory(ResultsDir);
            File.WriteAllText(Path.Combine(ResultsDir, "build-summary.json"),
                $"{{ \"result\": \"{s.result}\", \"seconds\": {s.totalTime.TotalSeconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)}, \"bytes\": {s.totalSize}, \"errors\": {s.totalErrors}, \"warnings\": {s.totalWarnings}, \"unity\": \"{Application.unityVersion}\" }}\n");
            Debug.Log($"[Flora] сборка стенда: {s.result}, {s.totalTime.TotalSeconds:0} с, {s.totalSize / 1048576} МБ");
            if (s.result != BuildResult.Succeeded) EditorApplication.Exit(1);
        }

        /// <summary>Создать стенд, прогнать проверки и собрать Windows-плеер (одним запуском редактора).</summary>
        public static void All()
        {
            CreateStand();
            RunChecks();
            BuildStand();
        }

        public static void SetupAndCheck()
        {
            CreateStand();
            RunChecks();
        }

        // ───────── проверки ─────────

        [MenuItem("WORLDBOUND/Flora/Run checks")]
        public static void RunChecks()
        {
            var log = new StringBuilder();
            var results = new List<string>();
            bool ok = true;
            void Check(string name, bool pass, string detail = "")
            {
                ok &= pass;
                results.Add($"{{ \"name\": \"{name}\", \"ok\": {(pass ? "true" : "false")}, \"detail\": \"{detail.Replace("\"", "'")}\" }}");
                string line = $"{(pass ? "OK  " : "FAIL")} {name} {detail}";
                log.AppendLine(line);
                Debug.Log("[FloraCheck] " + line);
            }

            try
            {
                // 1. Издатель: полный пакет, инкремент только изменившихся чанков, «нет изменений».
                var grid = new FloraGrid(64);
                var pub = new FloraSnapshotPublisher(grid, 7);
                for (int k = 0; k < grid.ChunkCount; k++) pub.StageWoody(new WoodyChunk { Chunk = k, Plants = new[] { Plant(k, 1) }, Count = 1 });
                long v1 = pub.Commit(1);
                Check("publisher.full", pub.TryGetUpdate(-1, -1, out var full) && full.Kind == FloraUpdateKind.Full && full.Woody.Length == grid.ChunkCount && full.WoodyTotal == grid.ChunkCount, $"chunks {full?.Woody.Length}");
                Check("publisher.noChange", !pub.TryGetUpdate(7, v1, out _));
                for (int k = 0; k < grid.ChunkCount; k++) pub.StageWoody(new WoodyChunk { Chunk = k, Plants = new[] { Plant(k, 1) }, Count = 1 }); // те же данные
                long v1b = pub.Commit(2);
                Check("publisher.sameDataNoVersion", v1b == v1, $"v {v1} → {v1b}");
                pub.StageWoody(new WoodyChunk { Chunk = 3, Plants = new[] { Plant(3, 2) }, Count = 1 });
                pub.StageWoody(new WoodyChunk { Chunk = 5, Count = 0 });
                long v2 = pub.Commit(3);
                Check("publisher.incremental", pub.TryGetUpdate(7, v1, out var inc) && inc.Kind == FloraUpdateKind.Incremental && inc.Woody.Length == 2 && inc.WoodyTotal == grid.ChunkCount - 1, $"chunks {inc?.Woody.Length}, total {inc?.WoodyTotal}");
                Check("publisher.otherWorldFull", pub.TryGetUpdate(8, v2, out var other) && other.Kind == FloraUpdateKind.Full);
                // 2. Контрольные суммы ловят порчу данных.
                var c = new WoodyChunk { Chunk = 1, Plants = new[] { Plant(1, 1), Plant(1, 2) }, Count = 2 };
                uint sum = FloraChecksum.Woody(c);
                c.Plants[1].Height += 0.05f;
                Check("checksum.detectsChange", FloraChecksum.Woody(c) != sum);

                // 3. Синтетический источник детерминирован.
                var terrain = StandTerrain.BuildHeights();
                var a = new SyntheticFloraSource(20000, terrain, 1); a.PublishAll();
                var b = new SyntheticFloraSource(20000, terrain, 1); b.PublishAll();
                Check("synthetic.deterministic", a.StateHash() == b.StateHash() && a.TreeCount == b.TreeCount, $"trees {a.TreeCount}, shrubs {a.ShrubCount}, build {a.BuildMs:0} ms");
                var d = new SyntheticFloraSource(30000, terrain, 1); d.PublishAll();
                Check("synthetic.countMatters", d.StateHash() != a.StateHash());
                int changed = a.LivingStep();
                Check("synthetic.livingIncremental", changed > 0 && changed <= 12, $"changed chunks {changed} of {a.Grid.ChunkCount}");

                // 4. Профили: все виды каталога распознаны (не общий запасной профиль).
                var cat = SyntheticFloraSource.CatalogInfo();
                int woodyKnown = 0, herbKnown = 0;
                foreach (var s in cat.Species)
                {
                    if (s.Form == FloraForm.Herb) { if (HerbProfile.KindFor(s) != HerbKind.MeadowGrass || s.Key == "meadow-grass") herbKnown++; }
                    else if (s.Key is "spruce" or "pine" or "birch" or "oak" or "linden" or "alder" or "hazel" or "wild-rose" or "willow-shrub" or "juniper") woodyKnown++;
                }
                Check("profiles.allSpecies", woodyKnown == 10 && herbKnown == 8, $"woody {woodyKnown}/10, herbs {herbKnown}/8");

                // 5. Модели: число треугольников по уровням убывает.
                bool lodsOk = true;
                var tri = new StringBuilder();
                foreach (WoodyKind k in Enum.GetValues(typeof(WoodyKind)))
                {
                    var p = WoodyProfile.Create(k, k.ToString());
                    foreach (var arch in p.Archetypes)
                    {
                        int m0 = Tris(WoodyModels.Build(p, arch, 0)), m1 = Tris(WoodyModels.Build(p, arch, 1)), m2 = Tris(WoodyModels.Build(p, arch, 2));
                        lodsOk &= m0 > m1 && m1 > m2 && m2 > 0;
                        tri.Append($"{k}/{arch.Form}:{m0}/{m1}/{m2} ");
                    }
                }
                Check("models.lodTriangles", lodsOk, tri.ToString().Trim());

                // 6. Адаптер настоящей симуляции только читает мир (хеш состояния Simulation не меняется).
                var sim = new Worldbound.Sim.Simulation(new Worldbound.Sim.WorldConfig { Seed = 42, Size = Worldbound.Sim.WorldSize.S, Scenario = Worldbound.Sim.Scenario.Genesis, Isolated = true });
                string h0 = sim.StateHash();
                var adapter = new SimFloraSnapshotSource(sim.World);
                adapter.CaptureAll();
                adapter.UpdateEnvironment(0, 0);
                string h1 = sim.StateHash();
                bool got = adapter.TryGetUpdate(-1, -1, out var su);
                Check("adapter.readOnly", h0 == h1, $"hash {h0.Substring(0, Math.Min(12, h0.Length))}");
                Check("adapter.contract", got && su.Grid.Cells == sim.World.Geo.N && su.Fields.Length == su.Grid.ChunkCount && adapter.Catalog.Species.Length == Worldbound.Sim.Flora.PlantCatalog.All.Length && adapter.Catalog.HerbOrder.Length == 8,
                    $"grid {su?.Grid.Cells}, field chunks {su?.Fields.Length}, species {adapter.Catalog.Species.Length}, yearPhase {adapter.Environment.YearPhase:0.###}");
                terrain.Dispose();

                // 7. Рендер: инкрементальные пакеты дают то же состояние, что полный; источник не меняется.
                var assetsR = AssetDatabase.LoadAssetAtPath<FloraRenderAssets>(AssetsPath);
                if (!assetsR) { CreateStand(); assetsR = AssetDatabase.LoadAssetAtPath<FloraRenderAssets>(AssetsPath); }
                var t2 = StandTerrain.BuildHeights();
                var src = new SyntheticFloraSource(50000, t2, 5);
                src.PublishAll();
                var r1 = new FloraRenderer(assetsR, SyntheticFloraSource.CatalogInfo(), src.Grid, t2, FloraRenderSettings.For(FloraQuality.Medium));
                Pump(r1, src);
                uint before = src.StateHash();
                for (int i = 0; i < 6; i++) { src.LivingStep(); Pump(r1, src); }
                var r2 = new FloraRenderer(assetsR, SyntheticFloraSource.CatalogInfo(), src.Grid, t2, FloraRenderSettings.For(FloraQuality.Medium));
                Pump(r2, src);
                bool same = r1.Trees.Total == r2.Trees.Total && r1.Shrubs.Total == r2.Shrubs.Total && r1.Chunks.Version == r2.Chunks.Version;
                for (int k = 0; k < src.Grid.ChunkCount && same; k++) same &= r1.Trees.ChunkCount[k] == r2.Trees.ChunkCount[k] && r1.Shrubs.ChunkCount[k] == r2.Shrubs.ChunkCount[k];
                Check("renderer.incrementalEqualsFull", same && r1.Chunks.FullUpdates == 1 && r1.Chunks.UpdatesApplied == 7, $"trees {r1.Trees.Total}/{r2.Trees.Total}, shrubs {r1.Shrubs.Total}/{r2.Shrubs.Total}, updates {r1.Chunks.UpdatesApplied} (full {r1.Chunks.FullUpdates}), v {r1.Chunks.Version}");
                Check("renderer.integrity", r1.Chunks.ChecksumFailures == 0 && r1.Chunks.StateMismatches == 0 && r2.Chunks.StateMismatches == 0, $"checksum failures {r1.Chunks.ChecksumFailures}, mismatches {r1.Chunks.StateMismatches}");
                uint after = src.StateHash();
                Pump(r1, src);
                Check("renderer.sourceUnchanged", src.StateHash() == after && before != after, "рендер только читает снимки");
                Check("renderer.init", r1.InitMs > 0, $"init {r1.InitMs:0} ms, impostor bake {r1.ImpostorBakeMs:0} ms, mesh triangles {r1.MeshTriangles}, mesh {r1.MeshBytes / 1048576.0:0.0} MB, textures {r1.TextureBytes / 1048576.0:0.0} MB, full apply {r2.Chunks.LastUpdateMs:0} ms");
                r1.Dispose(); r2.Dispose(); t2.Dispose();
            }
            catch (Exception e)
            {
                Check("exception", false, e.GetType().Name + ": " + e.Message);
                Debug.LogException(e);
            }

            Directory.CreateDirectory(ResultsDir);
            File.WriteAllText(Path.Combine(ResultsDir, "flora-checks.json"), $"{{ \"ok\": {(ok ? "true" : "false")}, \"unity\": \"{Application.unityVersion}\",\n \"checks\": [\n  {string.Join(",\n  ", results)}\n ] }}\n");
            Debug.Log($"[FloraCheck] {(ok ? "OK" : "FAIL")}\n{log}");
            if (!ok && Application.isBatchMode) EditorApplication.Exit(1);
        }

        static void Pump(FloraRenderer r, IFloraSnapshotSource s)
        {
            for (int guard = 0; guard < 8 && s.TryGetUpdate(r.Chunks.WorldId, r.Chunks.Version, out var u); guard++)
            {
                if (!r.Chunks.Begin(u)) continue;
                while (!r.Chunks.Step(10000)) { }
            }
        }

        static int Tris(Mesh m) { int t = (int)(m.GetIndexCount(0) / 3); UnityEngine.Object.DestroyImmediate(m); return t; }

        static WoodyPlant Plant(int chunk, int k) => new() { Id = (uint)(chunk * 100 + k), X = 4 + k, Z = 4, Height = 10 + k, CrownRadius = 3, Species = 12, Leaf = 255, Health = 255, Stage = 2 };
    }
}
