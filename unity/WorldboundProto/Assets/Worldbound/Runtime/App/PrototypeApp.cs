// Сцены оценки Unity (docs/UNITY_EVALUATION_REPORT.md): диорама и лес-стенд — испытание рендера, НЕ мир игры.
// Растения и животные здесь декоративные (проверка производительности отрисовки), с симуляцией не связаны.
// Запускаются только явно: -wbproto (свободный просмотр), -wbbench …, -wbshots … — для воспроизведения замеров оценки.
//   -wbbench "сцена:деревья:камера,…" -wbsec N -wbout файл — серия замеров и выход;
//   -wbshots папка     — снимки сцен и выход.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Unity.Collections;
using Unity.Jobs;
using Unity.Profiling;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using Worldbound.Gfx;
using Worldbound.Scenes;
using Debug = UnityEngine.Debug;

namespace Worldbound.App
{
    public sealed class PrototypeApp : MonoBehaviour
    {
        Camera cam;
        Light sun;
        Material foliage, ground, water;
        Diorama diorama;
        ForestStand forest;
        List<GameObject> animals = new();
        bool showUi = true;
        Vector3 camPos;
        float yaw, pitch;
        float flySpeed = 12;
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;


        void Awake()
        {
            Application.targetFrameRate = -1;
            QualitySettings.vSyncCount = 0;
            Environment();
            foliage = Resources.Load<Material>("WB_Foliage");
            ground = Resources.Load<Material>("WB_Ground");
            water = Resources.Load<Material>("WB_Water");
            foliage.SetTexture("_MainTex", LeafAtlas.Build());
            Shader.SetGlobalVector("_WindDir", new Vector4(0.8f, 0.6f, 0, 0));
            Shader.SetGlobalFloat("_WindStrength", 0.45f);
            Shader.SetGlobalVector("_SeasonTint", Vector4.one);
            Shader.SetGlobalFloat("_LeafAmount", 1);
            Shader.SetGlobalFloat("_BloomAmount", 1);
        }

        IEnumerator Start()
        {
            yield return null;
            var args = System.Environment.GetCommandLineArgs();
            string Arg(string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
            ApplyQuality(Arg("-wbquality") ?? "high");
            if (Arg("-wbbench") != null || Arg("-wbshots") != null) showUi = false;
            if (Arg("-wbbench") is { } spec) { yield return RunBench(spec, float.Parse(Arg("-wbsec") ?? "20", Inv), Arg("-wbout") ?? "bench.json"); Application.Quit(); yield break; }
            if (Arg("-wbshots") is { } dir) { yield return RunShots(dir); Application.Quit(); yield break; }
            ShowDiorama();
        }

        // ───────── окружение ─────────

        void Environment()
        {
            var camGo = new GameObject("camera");
            cam = camGo.AddComponent<Camera>();
            cam.nearClipPlane = 0.2f;
            cam.farClipPlane = 4000;
            cam.fieldOfView = 55;
            var data = cam.GetUniversalAdditionalCameraData();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            sun = new GameObject("sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.93f, 0.82f);
            sun.intensity = 1.35f;
            sun.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(42, -35, 0);
            RenderSettings.sun = sun;
            RenderSettings.skybox = Resources.Load<Material>("WB_Sky");
            RenderSettings.ambientMode = AmbientMode.Skybox;
            RenderSettings.ambientIntensity = 1.05f;
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Exponential;
            RenderSettings.fogColor = new Color(0.72f, 0.8f, 0.86f);
            RenderSettings.fogDensity = 0.0024f;
            DynamicGI.UpdateEnvironment();
            // Постобработка: ACES, лёгкое свечение, тёплая цветокоррекция, виньетка.
            var vol = new GameObject("post").AddComponent<Volume>();
            vol.isGlobal = true;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.Add<Tonemapping>(true).mode.Override(TonemappingMode.ACES);
            var bloom = profile.Add<Bloom>(true);
            bloom.intensity.Override(0.35f);
            bloom.threshold.Override(1.05f);
            var color = profile.Add<ColorAdjustments>(true);
            color.saturation.Override(12);
            color.postExposure.Override(0.25f);
            color.colorFilter.Override(new Color(1f, 0.98f, 0.94f));
            profile.Add<Vignette>(true).intensity.Override(0.18f);
            vol.profile = profile;
        }

        string qualityName = "high";

        /// <summary>Пресеты: high — шаблон URP «PC» (MSAA ×2, SMAA, мягкие тени 120 м); medium — без MSAA, FXAA, тени 60 м, 2 каскада.</summary>
        void ApplyQuality(string name)
        {
            qualityName = name;
            var rp = (UniversalRenderPipelineAsset)GraphicsSettings.currentRenderPipeline;
            var data = cam.GetUniversalAdditionalCameraData();
            if (name == "medium")
            {
                rp.msaaSampleCount = 1;
                rp.shadowDistance = 60;
                rp.shadowCascadeCount = 2;
                rp.renderScale = 1;
                data.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
            }
            else if (name == "low")
            {
                rp.msaaSampleCount = 1;
                rp.shadowDistance = 40;
                rp.shadowCascadeCount = 1;
                rp.renderScale = 0.85f;
                data.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
            }
        }

        void Clear()
        {
            diorama?.Dispose();
            diorama = null;
            forest?.Dispose();
            forest = null;
            foreach (var a in animals) if (a) Destroy(a);
            animals.Clear();
        }

        void ShowDiorama()
        {
            Clear();
            diorama = new Diorama(foliage, ground, water, transform);
            animals = Animals.Spawn(diorama.Root);
            RenderSettings.fogDensity = 0.0045f;
            SetCam(new Vector3(-62, 34, -70), 38, 33);
        }

        void ShowForest(int trees)
        {
            Clear();
            forest = new ForestStand(trees, foliage, ground, transform);
            RenderSettings.fogDensity = 0.0011f;
            SetCam(new Vector3(ForestStand.Size / 2, 900, -200), 0, 42);
        }

        void SetCam(Vector3 p, float y, float x)
        {
            camPos = p;
            yaw = y;
            pitch = x;
            cam.transform.SetPositionAndRotation(camPos, Quaternion.Euler(pitch, yaw, 0));
        }

        // ───────── кадр ─────────

        void Update()
        {
            Controls();
            diorama?.Draw();
            forest?.Update(cam);
        }

        void Controls()
        {
            var kb = Keyboard.current;
            var mouse = Mouse.current;
            if (kb == null) return;
            if (kb.f1Key.wasPressedThisFrame) showUi = !showUi;
            if (kb.digit1Key.wasPressedThisFrame) ShowDiorama();
            if (kb.digit2Key.wasPressedThisFrame) ShowForest(10000);
            if (kb.digit3Key.wasPressedThisFrame) ShowForest(50000);
            if (kb.digit4Key.wasPressedThisFrame) ShowForest(100000);
            if (kb.digit5Key.wasPressedThisFrame) ShowForest(300000);
            if (kb.f12Key.wasPressedThisFrame) ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(Application.persistentDataPath, $"shot-{DateTime.Now:HHmmss}.png"));
            if (mouse != null && mouse.rightButton.isPressed)
            {
                var d = mouse.delta.ReadValue();
                yaw += d.x * 0.15f;
                pitch = Mathf.Clamp(pitch - d.y * 0.15f, -85, 85);
            }
            if (mouse != null) flySpeed = Mathf.Clamp(flySpeed * (1 + mouse.scroll.ReadValue().y * 0.001f), 2, 600);
            var rot = Quaternion.Euler(pitch, yaw, 0);
            var move = Vector3.zero;
            if (kb.wKey.isPressed) move += rot * Vector3.forward;
            if (kb.sKey.isPressed) move -= rot * Vector3.forward;
            if (kb.dKey.isPressed) move += rot * Vector3.right;
            if (kb.aKey.isPressed) move -= rot * Vector3.right;
            if (kb.eKey.isPressed) move += Vector3.up;
            if (kb.qKey.isPressed) move -= Vector3.up;
            camPos += move * flySpeed * (kb.leftShiftKey.isPressed ? 4 : 1) * Time.unscaledDeltaTime;
            cam.transform.SetPositionAndRotation(camPos, rot);
        }

        // ───────── замеры ─────────

        internal sealed class Recorder : IDisposable
        {
            readonly List<double> frame = new(), cpu = new(), gpu = new();
            readonly FrameTiming[] timings = new FrameTiming[1];
            ProfilerRecorder batches, draws, tris, setpass, total, sys, gfx;
            public long MaxBatches, MaxDraws, MaxTris, MaxSetPass;

            public Recorder()
            {
                batches = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Batches Count");
                draws = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Draw Calls Count");
                tris = ProfilerRecorder.StartNew(ProfilerCategory.Render, "Triangles Count");
                setpass = ProfilerRecorder.StartNew(ProfilerCategory.Render, "SetPass Calls Count");
                total = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Total Used Memory");
                sys = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "System Used Memory");
                gfx = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "Gfx Used Memory");
            }

            public void Frame()
            {
                frame.Add(Time.unscaledDeltaTime * 1000);
                FrameTimingManager.CaptureFrameTimings();
                if (FrameTimingManager.GetLatestTimings(1, timings) > 0)
                {
                    cpu.Add(timings[0].cpuFrameTime);
                    if (timings[0].gpuFrameTime > 0) gpu.Add(timings[0].gpuFrameTime);
                }
                MaxBatches = Math.Max(MaxBatches, batches.LastValue);
                MaxDraws = Math.Max(MaxDraws, draws.LastValue);
                MaxTris = Math.Max(MaxTris, tris.LastValue);
                MaxSetPass = Math.Max(MaxSetPass, setpass.LastValue);
            }

            static string Stat(List<double> l)
            {
                if (l.Count == 0) return "null";
                var s = new List<double>(l);
                s.Sort();
                double mean = 0;
                foreach (var v in s) mean += v;
                mean /= s.Count;
                string F(double v) => v.ToString("0.##", Inv);
                return $"{{ \"mean\": {F(mean)}, \"p50\": {F(s[s.Count / 2])}, \"p95\": {F(s[(int)(s.Count * 0.95)])}, \"p99\": {F(s[(int)(s.Count * 0.99)])}, \"max\": {F(s[^1])} }}";
            }

            public string Json(string extra)
            {
                double sum = 0;
                int over100 = 0;
                foreach (var v in frame) { sum += v; if (v > 100) over100++; }
                return $"{{ {extra}, \"frames\": {frame.Count}, \"fps\": {(frame.Count / (sum / 1000)).ToString("0.#", Inv)}, \"frameMs\": {Stat(frame)}, \"cpuMs\": {Stat(cpu)}, \"gpuMs\": {Stat(gpu)}, \"framesOver100ms\": {over100}, " +
                       $"\"batchesMax\": {MaxBatches}, \"drawCallsMax\": {MaxDraws}, \"setPassMax\": {MaxSetPass}, \"trianglesMax\": {MaxTris}, \"memoryMB\": {{ \"totalUsed\": {total.LastValue / 1048576}, \"system\": {sys.LastValue / 1048576}, \"gfx\": {gfx.LastValue / 1048576} }} }}";
            }

            public void Dispose() { batches.Dispose(); draws.Dispose(); tris.Dispose(); setpass.Dispose(); total.Dispose(); sys.Dispose(); gfx.Dispose(); }
        }

        IEnumerator RunBench(string spec, float seconds, string outFile)
        {
            var results = new List<string>();
            string shotDir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(outFile)) ?? ".";
            foreach (var item in spec.Split(','))
            {
                var p = item.Split(':');
                string scene = p[0], view = p[2];
                int trees = int.Parse(p[1]);
                var t0 = Time.realtimeSinceStartupAsDouble;
                if (scene == "forest") ShowForest(trees); else ShowDiorama();
                double buildMs = (Time.realtimeSinceStartupAsDouble - t0) * 1000;
                Vector3 focus = forest != null ? forest.DensestPoint() : Vector3.zero;
                for (int i = 0; i < 90; i++) { CamPath(view, focus, 0); yield return null; } // разогрев: шейдеры, буферы
                using var rec = new Recorder();
                float start = Time.realtimeSinceStartup;
                long lod0 = 0, lod1 = 0, lod2 = 0, triCpu = 0;
                int calls = 0, n = 0;
                float cullMax = 0, cullSum = 0;
                while (Time.realtimeSinceStartup - start < seconds)
                {
                    CamPath(view, focus, (Time.realtimeSinceStartup - start) / seconds);
                    yield return null;
                    rec.Frame();
                    if (forest == null) continue;
                    var s = forest.Stats();
                    lod0 = Math.Max(lod0, s.lod0); lod1 = Math.Max(lod1, s.lod1); lod2 = Math.Max(lod2, s.lod2); triCpu = Math.Max(triCpu, s.triangles); calls = Math.Max(calls, s.drawCalls);
                    cullMax = Mathf.Max(cullMax, forest.CullMs); cullSum += forest.CullMs; n++;
                }
                ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(shotDir, $"bench-{scene}-{trees}-{view}.png"));
                yield return null;
                results.Add(rec.Json($"\"scene\": \"{scene}\", \"trees\": {(forest?.TreeCount ?? 0)}, \"view\": \"{view}\", \"seconds\": {seconds}, \"buildMs\": {buildMs:0}, \"instances\": {{ \"lod0Max\": {lod0}, \"lod1Max\": {lod1}, \"lod2Max\": {lod2}, \"trianglesCpuMax\": {triCpu}, \"indirectCallsMax\": {calls}, \"cullJobMsMean\": {(n > 0 ? cullSum / n : 0).ToString("0.###", Inv)}, \"cullJobMsMax\": {cullMax.ToString("0.###", Inv)} }}"));
            }
            File.WriteAllText(outFile, $"{{ \"unity\": \"{Application.unityVersion}\", \"gpu\": \"{SystemInfo.graphicsDeviceName}\", \"api\": \"{SystemInfo.graphicsDeviceType}\", \"cpu\": \"{SystemInfo.processorType}\", \"ramMB\": {SystemInfo.systemMemorySize}, \"resolution\": \"{Screen.width}x{Screen.height}\", \"fullscreen\": \"{Screen.fullScreenMode}\", \"quality\": \"{qualityName}\", \"vsync\": {QualitySettings.vSyncCount},\n \"runs\": [\n  {string.Join(",\n  ", results)}\n ] }}\n");
        }

        /// <summary>Пути камеры: обзор с высоты, низкий облёт, у земли в лесу, облёт сцены A.</summary>
        void CamPath(string view, Vector3 focus, float t)
        {
            if (view == "strategic")
            {
                float a = t * 0.6f;
                var c = new Vector3(ForestStand.Size / 2, 0, ForestStand.Size / 2);
                SetCam(c + new Vector3(Mathf.Sin(a) * -1300, 950, Mathf.Cos(a) * -1300), a * Mathf.Rad2Deg, 38);
            }
            else if (view == "near")
            {
                var p = focus + new Vector3(-30 + t * 60, 0, -20 + t * 25);
                p.y = ForestStand.Height(p.x, p.z) + 2.2f;
                SetCam(p, 60 + t * 50, 4);
            }
            else if (view == "low")
            {
                var p = focus + new Vector3(-250 + t * 500, 0, -120);
                p.y = ForestStand.Height(p.x, p.z) + 45;
                SetCam(p, 70, 14);
            }
            else
            {
                float a = t * Mathf.PI * 2;
                SetCam(new Vector3(Mathf.Sin(a) * 70, 22 + Mathf.Sin(a * 2) * 6, Mathf.Cos(a) * 70), a * Mathf.Rad2Deg + 180, 18);
            }
        }

        IEnumerator RunShots(string dir)
        {
            Directory.CreateDirectory(dir);
            ShowDiorama();
            var views = new (string name, Vector3 pos, float yaw, float pitch)[]
            {
                ("a01-overview", new Vector3(-62, 34, -70), 38, 33),
                ("a02-house", new Vector3(5, 6.5f, -4), 35, 8),
                ("a03-river-pond", new Vector3(-12, 5, -60), -60, 10),
                ("a04-forest-plateau", new Vector3(20, 14, 28), 45, 6),
                ("a05-meadow-flowers", new Vector3(-3, 3.2f, 20), -100, 4),
                ("a06-deer", new Vector3(-36, 4.5f, -6), -60, 8),
                ("a07-birches-river", new Vector3(-30, 4, 30), 160, 5),
                ("a08-low-angle", new Vector3(10, 2.6f, -30), 0, -2),
            };
            for (int k = 0; k < 120; k++) yield return null;
            foreach (var v in views)
            {
                SetCam(v.pos, v.yaw, v.pitch);
                for (int k = 0; k < 30; k++) yield return null;
                ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(dir, v.name + ".png"));
                yield return null;
                yield return null;
            }
            ShowForest(300000);
            var f = forest.DensestPoint();
            foreach (var (name, view) in new[] { ("b-strategic", "strategic"), ("b-low", "low"), ("b-near", "near") })
            {
                for (int k = 0; k < 90; k++) { CamPath(view, f, 0.3f); yield return null; }
                ScreenCapture.CaptureScreenshot(System.IO.Path.Combine(dir, $"{name}-300000.png"));
                yield return null;
                yield return null;
            }
        }

        void OnGUI()
        {
            if (!showUi) return;
            var sb = new StringBuilder();
            sb.Append($"WORLDBOUND — сцены оценки рендера (декоративные, не мир игры)   {1f / Mathf.Max(1e-4f, Time.smoothDeltaTime):0} к/с\n");
            if (forest != null) { var s = forest.Stats(); sb.Append($"Лес: {forest.TreeCount:N0} деревьев · LOD0 {s.lod0} · LOD1 {s.lod1} · LOD2 {s.lod2} · треугольников {s.triangles / 1000:N0} тыс. · отсечение {forest.CullMs:0.00} мс\n"); }
            if (diorama != null) sb.Append($"Сцена A: растений {diorama.Plants:N0}\n");
            sb.Append("1 — сцена A, 2–5 — лес 10/50/100/300 тыс., ПКМ — обзор, WASD/QE — полёт, F1 — скрыть, F12 — снимок");
            GUI.Label(new Rect(12, 10, 1200, 100), sb.ToString());
        }
    }
}
