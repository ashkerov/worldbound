// Точка входа Windows-прототипа WORLDBOUND на Unity.
// Режимы (аргументы командной строки):
//   без аргументов     — сцена A (диорама), свободная камера: WASD/QE, правая кнопка — обзор, колесо — скорость;
//                        1 — диорама, 2–5 — лес 10/50/100/300 тыс. деревьев, F1 — панель, F12 — снимок,
//                        P — режим при сворачивании (продолжать / приостанавливать).
//   -wbbench "сцена:деревья:камера,…" -wbsec N -wbout файл — серия замеров и выход;
//   -wbshots папка     — снимки сцен и выход; -wbport файл — сверка переноса симуляции в сборке;
//   -wbbg файл         — проверка свёрнутого режима (окно само сворачивается и восстанавливается).

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
    public sealed class AppMain : MonoBehaviour
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

        // Мир-заглушка: игровое время и пакетные шаги (часовой шаг воды Burst, как в Prototype C).
        public bool PauseWhenMinimized;
        double gameHours, simDebt;
        const double GameHoursPerSecond = 0.05; // ×1: игровой час за 20 с
        SimLoad sim;
        float autosaveTimer;
        bool minimized;

        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern IntPtr GetActiveWindow();
        static IntPtr window;

        void Awake()
        {
            Application.targetFrameRate = -1;
            QualitySettings.vSyncCount = 0;
            PauseWhenMinimized = PlayerPrefs.GetInt("wb.pauseMinimized", 0) == 1;
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
            sim = new SimLoad();
            Load();
        }

        IEnumerator Start()
        {
            yield return null;
            window = GetActiveWindow();
            var args = System.Environment.GetCommandLineArgs();
            string Arg(string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
            ApplyQuality(Arg("-wbquality") ?? "high");
            if (Array.IndexOf(args, "-wbpause") >= 0) PauseWhenMinimized = true; // проверка режима «приостанавливать»
            if (Arg("-wbport") != null || Arg("-wbbench") != null || Arg("-wbshots") != null || Arg("-wbbg") != null) showUi = false;
            if (Arg("-wbport") is { } port) { yield return RunPort(port); Application.Quit(); yield break; }
            if (Arg("-wbbench") is { } spec) { yield return RunBench(spec, float.Parse(Arg("-wbsec") ?? "20", Inv), Arg("-wbout") ?? "bench.json"); Application.Quit(); yield break; }
            if (Arg("-wbshots") is { } dir) { yield return RunShots(dir); Application.Quit(); yield break; }
            if (Arg("-wbbg") is { } bg) { yield return RunBackground(bg); Application.Quit(); yield break; }
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
            UpdateMinimized();
            if (!minimized) Controls();
            Simulate(Time.unscaledDeltaTime);
            if (cam.enabled)
            {
                diorama?.Draw();
                forest?.Update(cam);
            }
            autosaveTimer += Time.unscaledDeltaTime;
            if (autosaveTimer > 30) { autosaveTimer = 0; Save(); }
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
            if (kb.pKey.wasPressedThisFrame) { PauseWhenMinimized = !PauseWhenMinimized; PlayerPrefs.SetInt("wb.pauseMinimized", PauseWhenMinimized ? 1 : 0); }
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

        // ───────── свёрнутое окно ─────────

        void UpdateMinimized()
        {
            bool now = window != IntPtr.Zero && IsIconic(window);
            if (now == minimized) return;
            minimized = now;
            // Свёрнуто: рендер выключен, 2 обновления в секунду (пакетные шаги мира и автосохранение).
            cam.enabled = !minimized;
            Application.targetFrameRate = minimized ? 2 : -1;
            Debug.Log($"[WB] minimized={minimized} pauseOption={PauseWhenMinimized}");
        }

        void Simulate(float dt)
        {
            if (minimized && PauseWhenMinimized) return;
            // Игровое время — по реальному; шаги мира — целыми игровыми часами (в свёрнутом окне — реже и пакетами).
            simDebt += dt * GameHoursPerSecond;
            while (simDebt >= 1)
            {
                simDebt -= 1;
                gameHours += 1;
                sim.StepHour();
            }
        }

        // ───────── сохранение ─────────

        string SavePath => System.IO.Path.Combine(Application.persistentDataPath, "world.json");

        void Save() => File.WriteAllText(SavePath, $"{{ \"gameHours\": {(gameHours + simDebt).ToString("R", Inv)}, \"savedAt\": \"{DateTime.UtcNow:o}\", \"simHoursStepped\": {sim.Hours} }}\n");

        void Load()
        {
            if (!File.Exists(SavePath)) return;
            var s = File.ReadAllText(SavePath);
            int i = s.IndexOf("\"gameHours\":", StringComparison.Ordinal);
            if (i >= 0 && double.TryParse(s.Substring(i + 12).Split(',')[0].Trim(), NumberStyles.Float, Inv, out var h)) gameHours = Math.Floor(h);
        }

        void OnApplicationQuit()
        {
            Save();
            sim.Dispose();
        }

        // ───────── замеры ─────────

        sealed class Recorder : IDisposable
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

        IEnumerator RunPort(string outFile)
        {
            var json = Worldbound.Sim.PortBenchmark.Run(System.IO.Path.Combine(Application.streamingAssetsPath, "golden"), outFile);
            Debug.Log(json);
            yield return null;
        }

        /// <summary>
        /// Свёрнутый режим: 20 с активно, 40 с свёрнуто (окно сворачивается само), 20 с после восстановления.
        /// По фазам: обновления в секунду, рисуется ли кадр, игровые часы (ожидаемые и фактические), время CPU процесса.
        /// Загрузку видеокарты снимает внешний скрипт по счётчикам Windows.
        /// </summary>
        IEnumerator RunBackground(string outFile)
        {
            ShowDiorama();
            for (int k = 0; k < 60; k++) yield return null;
            var phases = new List<string>();
            var proc = Process.GetCurrentProcess();
            foreach (var (name, secs, action) in new[] { ("active", 20f, 0), ("minimized", 40f, 6), ("restored", 20f, 9) })
            {
                if (action != 0) { ShowWindow(window, action); yield return null; yield return null; }
                File.AppendAllText(outFile + ".phases.log", $"{name} {DateTime.Now:HH:mm:ss.fff}\n");
                proc.Refresh();
                var cpu0 = proc.TotalProcessorTime;
                double h0 = gameHours + simDebt;
                int frames = 0;
                float t0 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t0 < secs) { frames++; yield return null; }
                float dt = Time.realtimeSinceStartup - t0;
                proc.Refresh();
                double cpuMs = (proc.TotalProcessorTime - cpu0).TotalMilliseconds;
                double hours = gameHours + simDebt - h0;
                phases.Add($"{{ \"phase\": \"{name}\", \"seconds\": {dt.ToString("0.0", Inv)}, \"updatesPerSecond\": {(frames / dt).ToString("0.0", Inv)}, \"rendering\": {(cam.enabled ? "true" : "false")}, \"minimizedDetected\": {(minimized ? "true" : "false")}, \"gameHours\": {hours.ToString("0.###", Inv)}, \"gameHoursExpected\": {(dt * GameHoursPerSecond).ToString("0.###", Inv)}, \"cpuPercentOfOneCore\": {(cpuMs / (dt * 1000) * 100).ToString("0.0", Inv)}, \"cpuPercentOfMachine\": {(cpuMs / (dt * 1000) / SystemInfo.processorCount * 100).ToString("0.0", Inv)}, \"workingSetMB\": {proc.WorkingSet64 / 1048576} }}");
            }
            Save();
            File.WriteAllText(outFile, $"{{ \"pauseWhenMinimized\": {(PauseWhenMinimized ? "true" : "false")}, \"simHoursStepped\": {sim.Hours}, \"savedTo\": \"{SavePath.Replace("\\", "/")}\", \"phases\": [\n  {string.Join(",\n  ", phases)}\n ] }}\n");
        }

        void OnGUI()
        {
            if (!showUi) return;
            var sb = new StringBuilder();
            sb.Append($"WORLDBOUND — Unity-прототип (оценка, не игра)   {1f / Mathf.Max(1e-4f, Time.smoothDeltaTime):0} к/с\n");
            if (forest != null) { var s = forest.Stats(); sb.Append($"Лес: {forest.TreeCount:N0} деревьев · LOD0 {s.lod0} · LOD1 {s.lod1} · LOD2 {s.lod2} · треугольников {s.triangles / 1000:N0} тыс. · отсечение {forest.CullMs:0.00} мс\n"); }
            if (diorama != null) sb.Append($"Сцена A: растений {diorama.Plants:N0}\n");
            sb.Append($"Игровое время: {gameHours:0} ч · при сворачивании: {(PauseWhenMinimized ? "пауза" : "продолжать")} (P)\n");
            sb.Append("1 — сцена A, 2–5 — лес 10/50/100/300 тыс., ПКМ — обзор, WASD/QE — полёт, F1 — скрыть, F12 — снимок");
            GUI.Label(new Rect(12, 10, 1200, 100), sb.ToString());
        }
    }

    /// <summary>Нагрузка «мира»: часовой шаг воды (Burst) на поле 256 × 256 — как в Prototype C.</summary>
    public sealed class SimLoad : IDisposable
    {
        const int N = 256 * 256;
        NativeArray<byte> kind, accHours;
        NativeArray<float> cap, drain, dist, green, moist, snow, runoff, discharge, accT, accW, accR, accM;
        NativeArray<int> recv, order;
        NativeArray<double> precip, cloud, temp, sums, totals;
        public int Hours;

        public SimLoad()
        {
            var a = Allocator.Persistent;
            kind = new NativeArray<byte>(N, a); accHours = new NativeArray<byte>(N, a);
            cap = new NativeArray<float>(N, a); drain = new NativeArray<float>(N, a); dist = new NativeArray<float>(N, a); green = new NativeArray<float>(N, a);
            moist = new NativeArray<float>(N, a); snow = new NativeArray<float>(N, a); runoff = new NativeArray<float>(N, a); discharge = new NativeArray<float>(N, a);
            accT = new NativeArray<float>(N, a); accW = new NativeArray<float>(N, a); accR = new NativeArray<float>(N, a); accM = new NativeArray<float>(N, a);
            recv = new NativeArray<int>(N, a); order = new NativeArray<int>(N, a);
            precip = new NativeArray<double>(N, a); cloud = new NativeArray<double>(N, a); temp = new NativeArray<double>(N, a); sums = new NativeArray<double>(N * 4, a); totals = new NativeArray<double>(5, a);
            for (int i = 0; i < N; i++)
            {
                cap[i] = 120; drain[i] = 0.4f; dist[i] = 100; green[i] = 0.6f; moist[i] = 60;
                recv[i] = i + 1 < N ? i + 1 : -1; order[i] = i; temp[i] = 12; precip[i] = 0.2; cloud[i] = 0.4;
            }
        }

        public void StepHour()
        {
            var cells = new Worldbound.Sim.WaterCellJob { Kind = kind, Capacity = cap, DrainHour = drain, WaterDist = dist, Greenness = green, Precip = precip, Cloud = cloud, T = temp, Moisture = moist, Snow = snow, Runoff = runoff, AccT = accT, AccW = accW, AccRunoff = accR, AccMinT = accM, AccHours = accHours, Sums = sums, Compression = 18.25, MeltPerDegree = 2.43, SunFactor = 0.9 };
            var route = new Worldbound.Sim.WaterRouteJob { Kind = kind, Receiver = recv, Order = order, Runoff = runoff, Discharge = discharge, Sums = sums, Totals = totals, ToM3s = 64.0 / 1000 / 3600 };
            route.Schedule(cells.Schedule(N, 1024)).Complete();
            Hours++;
        }

        public void Dispose()
        {
            if (!kind.IsCreated) return;
            kind.Dispose(); accHours.Dispose(); cap.Dispose(); drain.Dispose(); dist.Dispose(); green.Dispose(); moist.Dispose(); snow.Dispose(); runoff.Dispose(); discharge.Dispose();
            accT.Dispose(); accW.Dispose(); accR.Dispose(); accM.Dispose(); recv.Dispose(); order.Dispose(); precip.Dispose(); cloud.Dispose(); temp.Dispose(); sums.Dispose(); totals.Dispose();
        }
    }
}
