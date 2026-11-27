// Графический стенд рендера растительности (сцена FloraRendererStand.unity). Настоящую симуляцию не запускает:
// данные — детерминированный SyntheticFloraSource в контракте снимков, ровно как их будет давать адаптер симуляции.
//
// Управление: ПКМ — обзор, WASD/QE — полёт, Shift — быстрее, колесо — скорость; F1 — панель; F12 — снимок;
// 1–4 — 10/50/100/300 тыс. деревьев; V — вид камеры; F2 — качество; [ ] — дальность; - = — LOD; L — окраска LOD;
// G — трава; B — густота травы; T — освещение; Y — сезон; U — ветер; P — «живые» обновления чанков.
// Аргументы сборки: -flbench "300000:overview,…" -flquality medium -flsec 20 -flout файл.json;
//                   -flshots папка — серия снимков; -fltrees N — начальное число деревьев.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Worldbound.FloraView.Stand
{
    public sealed class FloraRendererStand : MonoBehaviour
    {
        public FloraRenderAssets FloraAssets;
        public Shader GroundShader;
        public Material SkyMaterial;

        public static readonly int[] TreeCounts = { 10000, 50000, 100000, 300000 };
        public static readonly string[] SeasonNames = { "Весна", "Лето", "Осень", "Поздняя осень", "Зима" };
        static readonly float[] SeasonPhase = { 0.1f, 0.36f, 0.62f, 0.71f, 0.86f };
        static readonly float[] SeasonSnow = { 0, 0, 0, 0, 1 };
        public static readonly string[] WindNames = { "Штиль", "Ветерок", "Ветрено", "Буря" };
        static readonly float[] WindSpeed = { 0.6f, 3.5f, 8.5f, 15f };
        static readonly float[] GrassDensity = { 0.5f, 1f, 1.5f };
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        Camera cam;
        StandLighting lighting;
        FloraTerrain terrain;
        GameObject ground;
        Material groundMat;
        SyntheticFloraSource source;
        FloraRenderer flora;
        UniversalRenderPipelineAsset rp;

        FloraQuality quality = FloraQuality.Medium;
        int treeCount = 100000, seasonIdx = 1, windIdx = 1, grassIdx = 1, viewIdx = 4;
        StandLight lightIdx = StandLight.Day;
        float drawDistance = 1, lodBias = 1;
        bool living, showUi = true, bench;
        float livingTimer, windTime;
        Vector3 camPos;
        float yaw, pitch, flySpeed = 25;
        float fpsSmooth;
        readonly FrameTiming[] timing = new FrameTiming[1];
        double cpuMs, gpuMs;
        readonly StringBuilder sb = new(1024);
        long groundTris;
        string status = "";

        void Awake()
        {
            Application.targetFrameRate = -1;
            QualitySettings.vSyncCount = 0;
            // Копия ассета URP: настройки качества стенда не меняют ассеты проекта.
            var baseRp = (UniversalRenderPipelineAsset)(QualitySettings.renderPipeline ?? GraphicsSettings.defaultRenderPipeline);
            rp = Instantiate(baseRp);
            QualitySettings.renderPipeline = rp;
            var camGo = new GameObject("stand-camera");
            cam = camGo.AddComponent<Camera>();
            cam.nearClipPlane = 0.25f;
            cam.farClipPlane = 4200;
            cam.fieldOfView = 55;
            var data = cam.GetUniversalAdditionalCameraData();
            data.renderPostProcessing = true;
            data.renderShadows = true;
            lighting = new StandLighting(SkyMaterial);
            terrain = StandTerrain.BuildHeights();
            ground = new GameObject("stand-ground");
            var mesh = StandTerrain.BuildMesh(terrain);
            groundTris = mesh.GetIndexCount(0) / 3;
            ground.AddComponent<MeshFilter>().sharedMesh = mesh;
            groundMat = new Material(GroundShader);
            var mr = ground.AddComponent<MeshRenderer>();
            mr.sharedMaterial = groundMat;
            mr.shadowCastingMode = ShadowCastingMode.Off;
        }

        IEnumerator Start()
        {
            var args = Environment.GetCommandLineArgs();
            string Arg(string n) { int i = Array.IndexOf(args, n); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
            if (Arg("-flquality") is { } q) quality = (FloraQuality)Math.Max(0, Array.IndexOf(new[] { "low", "medium", "high", "ultra" }, q.ToLowerInvariant()));
            if (Arg("-fltrees") is { } tc) treeCount = int.Parse(tc, Inv);
            ApplyUrpQuality();
            try
            {
                flora = new FloraRenderer(FloraAssets, SyntheticFloraSource.CatalogInfo(), new FloraGrid(StandTerrain.Cells), terrain, Settings());
            }
            catch (Exception e)
            {
                // Без рендера стенду делать нечего: в режимах замеров и снимков — выход, а не зависание.
                Debug.LogException(e);
                status = "ошибка инициализации: " + e.Message;
                if (Arg("-flbench") != null || Arg("-flshots") != null) Application.Quit(1);
                yield break;
            }
            Debug.Log($"[FloraStand] init {flora.InitMs:0} ms (impostor bake {flora.ImpostorBakeMs:0} ms), mesh triangles {flora.MeshTriangles}, quality {quality}");
            BuildWorld(treeCount);
            ApplyLight();
            SetView(viewIdx);
            yield return null;
            if (Arg("-flbench") is { } spec) { bench = true; showUi = false; yield return RunBench(spec, float.Parse(Arg("-flsec") ?? "20", Inv), Arg("-flout") ?? "flora-bench.json"); Application.Quit(); yield break; }
            if (Arg("-flshots") is { } dir) { bench = true; showUi = false; yield return RunShots(dir); Application.Quit(); }
        }

        FloraRenderSettings Settings()
        {
            var s = FloraRenderSettings.For(quality);
            s.DrawDistance = drawDistance;
            s.GrassDensity *= GrassDensity[grassIdx];
            s.GrassMaxInstances = (int)(s.GrassMaxInstances * Mathf.Max(1, GrassDensity[grassIdx]));
            return s;
        }

        /// <summary>
        /// Пресеты URP: low — 0,75 разрешения, тени 40 м, без SSAO; medium — 0,85 разрешения, тени 60 м, 2 каскада, без SSAO;
        /// high — полное разрешение, 100 м, 3 каскада, SSAO; ultra — 150 м, 4 каскада, SSAO.
        /// </summary>
        void ApplyUrpQuality()
        {
            var data = cam.GetUniversalAdditionalCameraData();
            rp.msaaSampleCount = 1;
            SetSsao(quality >= FloraQuality.High);
            switch (quality)
            {
                case FloraQuality.Low: rp.renderScale = 0.75f; rp.shadowDistance = 40; rp.shadowCascadeCount = 1; rp.mainLightShadowmapResolution = 1024; data.antialiasing = AntialiasingMode.FastApproximateAntialiasing; break;
                case FloraQuality.Medium: rp.renderScale = 0.85f; rp.shadowDistance = 60; rp.shadowCascadeCount = 2; rp.mainLightShadowmapResolution = 2048; data.antialiasing = AntialiasingMode.FastApproximateAntialiasing; break;
                case FloraQuality.High: rp.renderScale = 1f; rp.shadowDistance = 100; rp.shadowCascadeCount = 3; rp.mainLightShadowmapResolution = 2048; data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing; break;
                default: rp.renderScale = 1f; rp.shadowDistance = 150; rp.shadowCascadeCount = 4; rp.mainLightShadowmapResolution = 4096; data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing; break;
            }
            if (flora != null) flora.ApplyQuality(Settings());
        }

        /// <summary>
        /// SSAO рендерера проекта включается/выключается только в сборке стенда (в редакторе ассет рендерера общий —
        /// его не трогаем). Ассет рендерера — внутреннее поле URP, читается отражением.
        /// </summary>
        void SetSsao(bool on)
        {
            if (Application.isEditor) return;
            var f = typeof(UniversalRenderPipelineAsset).GetField("m_RendererDataList", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);
            if (f?.GetValue(rp) is not ScriptableRendererData[] list) return;
            foreach (var d in list)
                if (d != null)
                    foreach (var feature in d.rendererFeatures)
                        if (feature != null && feature.GetType().Name.Contains("ScreenSpaceAmbientOcclusion")) feature.SetActive(on);
            ssao = on;
        }

        bool ssao = true;
        string SsaoJson => ssao ? "true" : "false";

        void BuildWorld(int trees)
        {
            treeCount = trees;
            source = new SyntheticFloraSource(trees, terrain, trees);
            source.SetEnvironment(Env(), false);
            source.PublishAll();
            flora.SetSource(source);
            status = $"мир: {source.TreeCount:N0} деревьев, {source.ShrubCount:N0} кустов, построен за {source.BuildMs:0} мс";
            Debug.Log("[FloraStand] " + status);
        }

        FloraEnvironment Env() => new()
        {
            YearPhase = SeasonPhase[seasonIdx],
            DayPhase = 0.5f,
            WindDirection = 0.7f + Mathf.Sin(windTime * 0.013f) * 0.6f,
            WindSpeed = WindSpeed[windIdx],
            Gustiness = windIdx >= 2 ? 0.7f : 0.45f,
            Snow = SeasonSnow[seasonIdx],
            Wetness = lightIdx == StandLight.Overcast ? 0.35f : 0,
        };

        void ApplyLight() => lighting.Apply(lightIdx, SeasonSnow[seasonIdx]);

        // ───────── кадр ─────────

        void Update()
        {
            float dt = Time.unscaledDeltaTime;
            windTime += dt;
            if (!bench) Controls(dt);
            source?.SetEnvironment(Env());
            if (living && source != null)
            {
                livingTimer += dt;
                if (livingTimer > 1.0f) { livingTimer = 0; source.LivingStep(); }
            }
            fpsSmooth = Mathf.Lerp(fpsSmooth <= 0 ? 60 : fpsSmooth, 1f / Mathf.Max(1e-4f, dt), 0.05f);
            if (!bench)
            {
                FrameTimingManager.CaptureFrameTimings();
                if (FrameTimingManager.GetLatestTimings(1, timing) > 0) { cpuMs = timing[0].cpuFrameTime; gpuMs = timing[0].gpuFrameTime; }
            }
        }

        void LateUpdate()
        {
            if (flora == null) return;
            flora.LodBias = lodBias;
            flora.Update(cam, Time.unscaledDeltaTime);
        }

        void SetCam(Vector3 p, Quaternion r)
        {
            camPos = p;
            var e = r.eulerAngles;
            yaw = e.y;
            pitch = e.x > 180 ? e.x - 360 : e.x;
            cam.transform.SetPositionAndRotation(p, r);
        }

        void SetView(int i)
        {
            viewIdx = (i % StandViews.Names.Length + StandViews.Names.Length) % StandViews.Names.Length;
            StandViews.Pose(StandViews.Names[viewIdx], 0.35f, terrain.Sample, out var p, out var r);
            SetCam(p, r);
        }

        void Controls(float dt)
        {
            var kb = Keyboard.current;
            var mouse = Mouse.current;
            if (kb == null) return;
            if (kb.f1Key.wasPressedThisFrame) showUi = !showUi;
            if (kb.f12Key.wasPressedThisFrame) ScreenCapture.CaptureScreenshot(Path.Combine(Application.persistentDataPath, $"flora-{DateTime.Now:HHmmss}.png"));
            for (int k = 0; k < 4; k++) if (kb[(Key)((int)Key.Digit1 + k)].wasPressedThisFrame) BuildWorld(TreeCounts[k]);
            if (kb.vKey.wasPressedThisFrame) SetView(viewIdx + 1);
            if (kb.f2Key.wasPressedThisFrame) { quality = (FloraQuality)(((int)quality + 1) % 4); ApplyUrpQuality(); }
            if (kb.leftBracketKey.wasPressedThisFrame) { drawDistance = Mathf.Max(0.4f, drawDistance - 0.2f); flora.ApplyQuality(Settings()); }
            if (kb.rightBracketKey.wasPressedThisFrame) { drawDistance = Mathf.Min(2f, drawDistance + 0.2f); flora.ApplyQuality(Settings()); }
            if (kb.minusKey.wasPressedThisFrame) lodBias = Mathf.Max(0.4f, lodBias - 0.2f);
            if (kb.equalsKey.wasPressedThisFrame) lodBias = Mathf.Min(2.5f, lodBias + 0.2f);
            if (kb.lKey.wasPressedThisFrame) flora.DebugLod = !flora.DebugLod;
            if (kb.gKey.wasPressedThisFrame) flora.DrawGrass = !flora.DrawGrass;
            if (kb.bKey.wasPressedThisFrame) { grassIdx = (grassIdx + 1) % GrassDensity.Length; flora.ApplyQuality(Settings()); }
            if (kb.tKey.wasPressedThisFrame) { lightIdx = (StandLight)(((int)lightIdx + 1) % 4); ApplyLight(); }
            if (kb.yKey.wasPressedThisFrame) { seasonIdx = (seasonIdx + 1) % SeasonPhase.Length; ApplyLight(); }
            if (kb.uKey.wasPressedThisFrame) windIdx = (windIdx + 1) % WindSpeed.Length;
            if (kb.pKey.wasPressedThisFrame) living = !living;
            if (mouse != null && mouse.rightButton.isPressed)
            {
                var d = mouse.delta.ReadValue();
                yaw += d.x * 0.12f;
                pitch = Mathf.Clamp(pitch - d.y * 0.12f, -85, 85);
            }
            if (mouse != null) flySpeed = Mathf.Clamp(flySpeed * (1 + mouse.scroll.ReadValue().y * 0.001f), 1, 600);
            var rot = Quaternion.Euler(pitch, yaw, 0);
            var move = Vector3.zero;
            if (kb.wKey.isPressed) move += rot * Vector3.forward;
            if (kb.sKey.isPressed) move -= rot * Vector3.forward;
            if (kb.dKey.isPressed) move += rot * Vector3.right;
            if (kb.aKey.isPressed) move -= rot * Vector3.right;
            if (kb.eKey.isPressed) move += Vector3.up;
            if (kb.qKey.isPressed) move -= Vector3.up;
            camPos += move * flySpeed * (kb.leftShiftKey.isPressed ? 4 : 1) * dt;
            camPos.y = Mathf.Max(camPos.y, terrain.Sample(camPos.x, camPos.z) + 0.6f);
            cam.transform.SetPositionAndRotation(camPos, rot);
        }

        // ───────── замеры ─────────

        IEnumerator WaitApplied()
        {
            int guard = 0;
            yield return null;
            while ((flora.Chunks.Busy || flora.Chunks.Version < 0) && guard++ < 2000) yield return null;
        }

        IEnumerator RunBench(string spec, float seconds, string outFile)
        {
            var runs = new List<string>();
            string shotDir = Path.GetDirectoryName(Path.GetFullPath(outFile)) ?? ".";
            uint hashBefore = 0;
            bool sourceUnchanged = true;
            foreach (var item in spec.Split(','))
            {
                var p = item.Split(':');
                int trees = int.Parse(p[0], Inv);
                string view = p[1];
                bool live = view == "live";
                if (live) view = "mixed";
                double buildMs = 0, loadMs = 0;
                if (trees != treeCount || source == null)
                {
                    var t0 = Time.realtimeSinceStartupAsDouble;
                    BuildWorld(trees);
                    buildMs = (Time.realtimeSinceStartupAsDouble - t0) * 1000;
                    var t1 = Time.realtimeSinceStartupAsDouble;
                    yield return WaitApplied();
                    loadMs = (Time.realtimeSinceStartupAsDouble - t1) * 1000;
                }
                living = live;
                hashBefore = source.StateHash();
                for (int i = 0; i < 120; i++) { StandViews.Pose(view, 0, terrain.Sample, out var pp, out var rr); SetCam(pp, rr); yield return null; }
                using var rec = new StandRecorder();
                float start = Time.realtimeSinceStartup;
                float maxApply = 0, updateMs = 0;
                int updates0 = flora.Chunks.UpdatesApplied;
                while (Time.realtimeSinceStartup - start < seconds)
                {
                    StandViews.Pose(view, (Time.realtimeSinceStartup - start) / seconds, terrain.Sample, out var pp, out var rr);
                    SetCam(pp, rr);
                    yield return null;
                    rec.Frame(flora.Stats, groundTris);
                    maxApply = Mathf.Max(maxApply, flora.Stats.ApplyMs);
                    updateMs = Mathf.Max(updateMs, flora.Chunks.LastUpdateMs);
                }
                living = false;
                ScreenCapture.CaptureScreenshot(Path.Combine(shotDir, $"bench-{quality.ToString().ToLowerInvariant()}-{trees}-{p[1]}.png"));
                yield return null;
                // Рендер только читает источник: свёртка опубликованного состояния без «живых» шагов не меняется.
                if (!live && source.StateHash() != hashBefore) sourceUnchanged = false;
                var s = flora.Stats;
                runs.Add(rec.Json($"\"trees\": {source.TreeCount}, \"shrubs\": {source.ShrubCount}, \"view\": \"{p[1]}\", \"seconds\": {seconds.ToString(Inv)}, \"worldBuildMs\": {buildMs:0}, \"initialLoadMs\": {loadMs:0}, " +
                                  $"\"chunkUpdates\": {flora.Chunks.UpdatesApplied - updates0}, \"chunkUpdateMsMax\": {updateMs.ToString("0.##", Inv)}, \"chunkApplyFrameMsMax\": {maxApply.ToString("0.##", Inv)}, \"chunksChangedPerUpdate\": {source.LastChangedChunks}, " +
                                  $"\"lastFrame\": {{ \"treesVisible\": {s.TreesVisible}, \"lod0\": {s.TreeLod0}, \"lod1\": {s.TreeLod1}, \"lod2\": {s.TreeLod2}, \"impostors\": {s.Impostors}, \"shrubsVisible\": {s.ShrubsVisible}, \"grass\": {s.GrassVisible}, \"triangles\": {s.Triangles + groundTris}, \"drawCalls\": {s.DrawCalls} }}"));
                Debug.Log($"[FloraStand] bench {item}: {rec.Frames} frames");
            }
            File.WriteAllText(outFile,
                $"{{ \"unity\": \"{Application.unityVersion}\", \"gpu\": \"{SystemInfo.graphicsDeviceName}\", \"api\": \"{SystemInfo.graphicsDeviceType}\", \"cpu\": \"{SystemInfo.processorType}\", \"ramMB\": {SystemInfo.systemMemorySize}, " +
                $"\"resolution\": \"{Screen.width}x{Screen.height}\", \"renderScale\": {rp.renderScale.ToString(Inv)}, \"ssao\": {SsaoJson}, \"shadowDistance\": {rp.shadowDistance.ToString(Inv)}, \"cascades\": {rp.shadowCascadeCount}, \"fullscreen\": \"{Screen.fullScreenMode}\", \"quality\": \"{quality}\", \"vsync\": {QualitySettings.vSyncCount}, " +
                $"\"floraInitMs\": {flora.InitMs:0}, \"impostorBakeMs\": {flora.ImpostorBakeMs:0}, \"meshTriangles\": {flora.MeshTriangles}, \"meshMB\": {(flora.MeshBytes / 1048576.0).ToString("0.0", Inv)}, \"textureMB\": {(flora.TextureBytes / 1048576.0).ToString("0.0", Inv)}, " +
                $"\"checksumFailures\": {flora.Chunks.ChecksumFailures}, \"stateMismatches\": {flora.Chunks.StateMismatches}, \"sourceUnchangedByRenderer\": {(sourceUnchanged ? "true" : "false")},\n \"runs\": [\n  {string.Join(",\n  ", runs)}\n ] }}\n");
        }

        IEnumerator Shot(string dir, string name, int frames = 40)
        {
            for (int k = 0; k < frames; k++) yield return null;
            ScreenCapture.CaptureScreenshot(Path.Combine(dir, name + ".png"));
            yield return null;
            yield return null;
        }

        IEnumerator Pose(string view, float t)
        {
            StandViews.Pose(view, t, terrain.Sample, out var p, out var r);
            SetCam(p, r);
            yield return null;
        }

        IEnumerator RunShots(string dir)
        {
            Directory.CreateDirectory(dir);
            yield return WaitApplied();
            for (int k = 0; k < 90; k++) yield return null;
            // Сценарии камеры летом днём.
            for (int v = 0; v < StandViews.Names.Length; v++) { yield return Pose(StandViews.Names[v], 0.4f); yield return Shot(dir, $"{v + 1:00}-{StandViews.Names[v]}-summer-day"); }
            // Крупные планы видов и травы.
            yield return ShotAt(dir, "06-closeup-mixed", SyntheticFloraSource.Biome.Mixed, 26, 1.7f, 4, 35);
            yield return ShotAt(dir, "07-closeup-conifer", SyntheticFloraSource.Biome.Conifer, -10, 1.7f, 6, 70);
            yield return ShotAt(dir, "08-closeup-birch", SyntheticFloraSource.Biome.Birch, 5, 1.7f, 6, 200);
            yield return ShotAt(dir, "09-meadow-groves", SyntheticFloraSource.Biome.Meadow, 0, 6, 6, 60);
            yield return ShotAt(dir, "10-forest-edge", SyntheticFloraSource.Biome.Edge, 0, 8, 6, 0);
            // Сезоны.
            for (int s = 0; s < SeasonPhase.Length; s++)
            {
                seasonIdx = s; ApplyLight();
                yield return WaitApplied();
                yield return ShotAt(dir, $"11-season-{s}-{new[] { "spring", "summer", "autumn", "late-autumn", "winter" }[s]}", SyntheticFloraSource.Biome.Mixed, 40, 2.2f, 5, 35, 60);
                yield return Pose("mixed", 0.5f);
                yield return Shot(dir, $"12-season-{s}-mixed-view", 30);
            }
            seasonIdx = 1; ApplyLight();
            yield return WaitApplied();
            // Освещение.
            for (int l = 1; l < 4; l++)
            {
                lightIdx = (StandLight)l; ApplyLight();
                yield return ShotAt(dir, $"13-light-{l}-{new[] { "day", "sunset", "night", "overcast" }[l]}", SyntheticFloraSource.Biome.Mixed, 40, 2.2f, 5, 35, 30);
                yield return Pose("grass", 0.3f);
                yield return Shot(dir, $"14-light-{l}-grass", 30);
            }
            lightIdx = StandLight.Day; ApplyLight();
            // Окраска уровней детализации и густота леса.
            flora.DebugLod = true;
            yield return Pose("mixed", 0.4f); yield return Shot(dir, "15-lod-debug-mixed");
            yield return Pose("overview", 0.4f); yield return Shot(dir, "16-lod-debug-overview");
            flora.DebugLod = false;
            for (int k = 0; k < TreeCounts.Length; k++)
            {
                BuildWorld(TreeCounts[k]);
                yield return WaitApplied();
                yield return Pose("overview", 0.4f); yield return Shot(dir, $"17-density-{TreeCounts[k]}-overview", 60);
                yield return Pose("flight", 0.5f); yield return Shot(dir, $"18-density-{TreeCounts[k]}-flight", 40);
            }
        }

        IEnumerator ShotAt(string dir, string name, SyntheticFloraSource.Biome biome, float dx, float h, float pitchDeg, float yawDeg, int frames = 40)
        {
            var c = SyntheticFloraSource.BiomeCentre[(int)biome];
            var p = new Vector3(c.x + dx, 0, c.y);
            // Камера не должна оказаться в стволе или в кроне: ищем свободное место по спирали.
            for (int i = 0; i < 60 && source.NearestPlant(p.x, p.z) < (h < 4 ? 3.5f : 6f); i++)
                p = new Vector3(c.x + dx + Mathf.Cos(i * 2.4f) * i * 1.5f, 0, c.y + Mathf.Sin(i * 2.4f) * i * 1.5f);
            p.y = terrain.Sample(p.x, p.z) + h;
            SetCam(p, Quaternion.Euler(pitchDeg, yawDeg, 0));
            yield return Shot(dir, name, frames);
        }

        // ───────── панель ─────────

        void OnGUI()
        {
            if (!showUi || flora == null) return;
            var s = flora.Stats;
            sb.Clear();
            sb.Append("WORLDBOUND — стенд рендера растительности (синтетические данные, не мир игры)\n");
            sb.Append($"{fpsSmooth:0} к/с   CPU {cpuMs:0.0} мс   GPU {gpuMs:0.0} мс   качество {quality}   дальность ×{drawDistance:0.0}   LOD ×{lodBias:0.0}\n");
            sb.Append($"Деревьев {s.Trees:N0} (видно {s.TreesVisible:N0}: LOD0 {s.TreeLod0} · LOD1 {s.TreeLod1} · LOD2 {s.TreeLod2} · импосторы {s.Impostors})\n");
            sb.Append($"Кустов {s.Shrubs:N0} (видно {s.ShrubsVisible})   Трава: пучков {s.GrassVisible:N0}\n");
            sb.Append($"Треугольников {(s.Triangles + groundTris) / 1000:N0} тыс.   вызовов {s.DrawCalls}   смен LOD {s.LodChanges}/кадр   отсечение {s.CullMs:0.00} мс   трава {s.GrassMs:0.00} мс\n");
            sb.Append($"Снимок v{flora.Chunks.Version} ({flora.Chunks.LastKind}, {flora.Chunks.LastUpdateChunks} чанков, {flora.Chunks.LastUpdateMs:0} мс)   ошибок сумм {flora.Chunks.ChecksumFailures}   «живые» обновления: {(living ? "вкл" : "выкл")}\n");
            sb.Append($"{SeasonNames[seasonIdx]} · {StandLighting.Names[(int)lightIdx]} · ветер: {WindNames[windIdx]} · вид: {StandViews.Titles[viewIdx]} · {status}\n");
            sb.Append("1–4 деревья · V вид · F2 качество · [ ] дальность · - = LOD · L окраска LOD · G трава · B густота травы · T свет · Y сезон · U ветер · P обновления · F1 панель");
            var style = GUI.skin.label;
            GUI.color = new Color(0, 0, 0, 0.55f);
            GUI.DrawTexture(new Rect(6, 6, 900, 168), Texture2D.whiteTexture);
            GUI.color = Color.white;
            GUI.Label(new Rect(12, 10, 890, 165), sb.ToString(), style);
        }

        void OnDestroy()
        {
            flora?.Dispose();
            terrain?.Dispose();
        }
    }
}
