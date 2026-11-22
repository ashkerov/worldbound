// Приложение реального мира (Unity Migration Stage 1): мир из seed, генерация и такты — в ядре Worldbound.Sim,
// здесь только хост (SimHost), рендер по снимкам (WorldRenderer), камера (своё состояние, не часть мира),
// ограничение частоты кадров, свёрнутый режим, сохранение. Флоры и фауны нет — они не перенесены в C#.
//
// Управление: ПКМ — обзор, WASD/QE — полёт (Shift ×4), колесо — скорость полёта; Пробел — пауза;
// 1–4 — скорость ×1/×2/×4/×8; O — слой данных; F3 — ограничение кадров (VSync/30/60/90/120);
// P — при сворачивании: продолжать / пауза; F5 — сохранить, F9 — загрузить; G — новый мир (следующий seed);
// F1 — панель; F12 — снимок экрана.
// Аргументы: -wbseed N -wbsize S|M -wbclimate cold|temperate|warm -wbfps vsync|30|60|90|120 -wbmanaged (без Burst);
//   -wbsimtest папкаЭталонов файл — golden-проверки ядра в сборке (Mono и Burst) и выход;
//   -wbsimbench файл              — замеры производительности симуляции (без рендера и с рендером) и выход;
//   -wbbg файл                    — проверка свёрнутого режима и выход;
//   -wbworldshots папка           — снимки мира и слоёв данных и выход.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Profiling;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using Worldbound.Sim;
using Worldbound.Sim.Golden;
using Worldbound.Sim.Persistence;
using Worldbound.SimHost;
using Worldbound.WorldView;
using Debug = UnityEngine.Debug;

namespace Worldbound.App
{
    /// <summary>Состояние камеры — отдельно от мира: не сохраняется в мир и не влияет на симуляцию.</summary>
    public struct CameraState
    {
        public Vector3 Position;
        public float Yaw, Pitch, FlySpeed;
    }

    public sealed class WorldApp : MonoBehaviour
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
        public static readonly string[] FpsCaps = { "vsync", "30", "60", "90", "120" };

        Camera cam;
        Light sun;
        Material terrainMat, waterMat;
        SimHost.SimHost host;
        WorldRenderer view;
        CameraState camState;
        bool showUi = true;
        int fpsCap;
        bool useBurst = true;
        public bool PauseWhenMinimized;
        bool minimized;
        float autosaveTimer;
        Task saveTask;
        string status = "";
        double simBudgetMs = 6;
        /// <summary>Замер сам ведёт такты — обычный ход мира в Update выключен (иначе мир шёл бы дважды).</summary>
        bool manualSim;

        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] static extern IntPtr GetActiveWindow();
        static IntPtr window;

        string[] args;
        string Arg(string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        bool Flag(string name) => Array.IndexOf(args, name) >= 0;
        string SaveDir => Path.Combine(Application.persistentDataPath, "saves");
        string QuickSavePath => Path.Combine(SaveDir, "quicksave.wbsave");
        string AutoSavePath => Path.Combine(SaveDir, "autosave.wbsave");

        void Awake()
        {
            args = System.Environment.GetCommandLineArgs();
            PauseWhenMinimized = PlayerPrefs.GetInt("wb.pauseMinimized", 0) == 1;
            string cap = Arg("-wbfps") ?? PlayerPrefs.GetString("wb.fpsCap", "vsync");
            fpsCap = Math.Max(0, Array.IndexOf(FpsCaps, cap));
            ApplyFrameCap();
            useBurst = !Flag("-wbmanaged");
            SetupEnvironment();
            terrainMat = Resources.Load<Material>("WB_WorldTerrain");
            waterMat = Resources.Load<Material>("WB_Water");
        }

        IEnumerator Start()
        {
            yield return null;
            window = GetActiveWindow();
            bool automated = Arg("-wbsimtest") != null || Arg("-wbsimbench") != null || Arg("-wbbg") != null || Arg("-wbworldshots") != null || Arg("-wbfpstest") != null || Arg("-wbrendercheck") != null;
            if (automated) showUi = false;
            if (Flag("-wbpause")) PauseWhenMinimized = true;
            if (Arg("-wbsimtest") is { } golden) { yield return RunSimTest(golden, args[Array.IndexOf(args, "-wbsimtest") + 2]); Application.Quit(); yield break; }
            if (Arg("-wbsimbench") is { } bench) { yield return RunSimBench(bench); Application.Quit(); yield break; }
            NewWorld(ConfigFromArgs());
            if (Arg("-wbbg") is { } bg) { yield return RunBackground(bg); Application.Quit(); yield break; }
            if (Arg("-wbworldshots") is { } shots) { yield return RunWorldShots(shots); Application.Quit(); yield break; }
            if (Arg("-wbfpstest") is { } fpsOut) { yield return RunFpsTest(fpsOut); Application.Quit(); yield break; }
            if (Arg("-wbrendercheck") is { } rcOut) { yield return RunRenderCheck(rcOut, Arg("-wbgolden")); Application.Quit(); yield break; }
        }

        WorldConfig ConfigFromArgs()
        {
            var c = new WorldConfig
            {
                Seed = uint.Parse(Arg("-wbseed") ?? PlayerPrefs.GetString("wb.seed", "42"), Inv),
                Size = (Arg("-wbsize") ?? "M") == "S" ? WorldSize.S : WorldSize.M,
            };
            // Stage 2.2: по умолчанию — Genesis с изоляцией (голая земля): единственный мир, который перенесённая часть
            // флоры ведёт эквивалентно TS. Wildlands и открытый мир создаются, но такты не идут до этапов 2.3–2.5.
            c.Scenario = (Arg("-wbscenario") ?? "genesis") == "genesis" ? Scenario.Genesis : Scenario.Wild;
            c.Isolated = (Arg("-wbisolated") ?? "1") != "0";
            string climate = Arg("-wbclimate") ?? "temperate";
            c.Climate = climate == "cold" ? Climate.Cold : climate == "warm" ? Climate.Warm : Climate.Temperate;
            return c;
        }

        // ───────── окружение и кадр ─────────

        void SetupEnvironment()
        {
            cam = new GameObject("camera").AddComponent<Camera>();
            cam.nearClipPlane = 0.5f;
            cam.farClipPlane = 12000;
            cam.fieldOfView = 55;
            var data = cam.GetUniversalAdditionalCameraData();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.FastApproximateAntialiasing;
            sun = new GameObject("sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.color = new Color(1f, 0.95f, 0.86f);
            sun.shadows = LightShadows.Soft;
            RenderSettings.sun = sun;
            RenderSettings.skybox = Resources.Load<Material>("WB_Sky");
            RenderSettings.ambientMode = AmbientMode.Skybox;
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.Exponential;
            RenderSettings.fogColor = new Color(0.72f, 0.8f, 0.86f);
            RenderSettings.fogDensity = 0.00028f;
            var vol = new GameObject("post").AddComponent<Volume>();
            vol.isGlobal = true;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.Add<Tonemapping>(true).mode.Override(TonemappingMode.ACES);
            profile.Add<ColorAdjustments>(true).postExposure.Override(0.2f);
            vol.profile = profile;
            var rp = (UniversalRenderPipelineAsset)GraphicsSettings.currentRenderPipeline;
            rp.shadowDistance = 400;
            rp.msaaSampleCount = 1;
        }

        void ApplyFrameCap()
        {
            if (minimized) return;
            if (fpsCap == 0)
            {
                QualitySettings.vSyncCount = 1;
                Application.targetFrameRate = -1;
            }
            else
            {
                QualitySettings.vSyncCount = 0;
                Application.targetFrameRate = int.Parse(FpsCaps[fpsCap], Inv);
            }
        }

        void NewWorld(WorldConfig config)
        {
            DisposeWorld();
            host = new SimHost.SimHost { UseBurst = useBurst };
            host.Begin(config);
            status = $"Создание мира: seed {config.Seed}, {config.Size}, {config.ClimateId}";
        }

        void DisposeWorld()
        {
            view?.Dispose();
            view = null;
            host?.Dispose();
            host = null;
        }

        void OnWorldReady()
        {
            var geo = host.Sim.World.Geo;
            view = new WorldRenderer(geo, terrainMat, waterMat, transform);
            float size = geo.N * geo.CellSize;
            camState = new CameraState { Position = new Vector3(size * 0.5f, 0, -size * 0.12f), Yaw = 0, Pitch = 32, FlySpeed = 120 };
            camState.Position.y = view.HeightAt(camState.Position.x, Mathf.Max(0, camState.Position.z)) + size * 0.22f;
            status = $"Мир готов: генерация {host.GenerateMs:0} мс, сцена {view.BuildMs:0} мс";
        }

        void Update()
        {
            UpdateMinimized();
            if (host != null)
            {
                bool wasGenerating = host.Status == SimHost.SimHost.State.Generating;
                host.Poll();
                if (wasGenerating && host.Status == SimHost.SimHost.State.Running) OnWorldReady();
                if (!manualSim && !(minimized && PauseWhenMinimized)) host.Advance(Time.unscaledDeltaTime, minimized ? 250 : simBudgetMs);
            }
            if (!minimized) Controls();
            if (view != null && cam.enabled) view.Apply(host.Snapshot, sun);
            ApplyCamera();
            autosaveTimer += Time.unscaledDeltaTime;
            if (autosaveTimer > 120 && host?.Status == SimHost.SimHost.State.Running)
            {
                autosaveTimer = 0;
                SaveAsync(AutoSavePath);
            }
        }

        void Controls()
        {
            var kb = Keyboard.current;
            var mouse = Mouse.current;
            if (kb == null) return;
            if (kb.f1Key.wasPressedThisFrame) showUi = !showUi;
            if (kb.f3Key.wasPressedThisFrame)
            {
                fpsCap = (fpsCap + 1) % FpsCaps.Length;
                PlayerPrefs.SetString("wb.fpsCap", FpsCaps[fpsCap]);
                ApplyFrameCap();
            }
            if (kb.pKey.wasPressedThisFrame) { PauseWhenMinimized = !PauseWhenMinimized; PlayerPrefs.SetInt("wb.pauseMinimized", PauseWhenMinimized ? 1 : 0); }
            if (kb.f12Key.wasPressedThisFrame) ScreenCapture.CaptureScreenshot(Path.Combine(Application.persistentDataPath, $"shot-{DateTime.Now:HHmmss}.png"));
            if (host?.Status == SimHost.SimHost.State.Running)
            {
                if (kb.spaceKey.wasPressedThisFrame) host.SetSpeed(host.Speed == 0 ? 1 : 0);
                if (kb.digit1Key.wasPressedThisFrame) host.SetSpeed(1);
                if (kb.digit2Key.wasPressedThisFrame) host.SetSpeed(2);
                if (kb.digit3Key.wasPressedThisFrame) host.SetSpeed(4);
                if (kb.digit4Key.wasPressedThisFrame) host.SetSpeed(8);
                if (kb.oKey.wasPressedThisFrame && view != null) view.Overlay = (Overlay)(((int)view.Overlay + 1) % WorldRenderer.OverlayNames.Length);
                if (kb.f5Key.wasPressedThisFrame) SaveAsync(QuickSavePath);
                if (kb.f9Key.wasPressedThisFrame) LoadFrom(QuickSavePath);
                if (kb.gKey.wasPressedThisFrame)
                {
                    var c = host.Config;
                    var next = new WorldConfig { Seed = c.Seed + 1, Size = c.Size, Climate = c.Climate, Scenario = c.Scenario, Isolated = c.Isolated };
                    PlayerPrefs.SetString("wb.seed", next.Seed.ToString(Inv));
                    NewWorld(next);
                    return;
                }
            }
            if (mouse != null && mouse.rightButton.isPressed)
            {
                var d = mouse.delta.ReadValue();
                camState.Yaw += d.x * 0.15f;
                camState.Pitch = Mathf.Clamp(camState.Pitch - d.y * 0.15f, -85, 85);
            }
            if (mouse != null) camState.FlySpeed = Mathf.Clamp(camState.FlySpeed * (1 + mouse.scroll.ReadValue().y * 0.001f), 5, 1500);
            var rot = Quaternion.Euler(camState.Pitch, camState.Yaw, 0);
            var move = Vector3.zero;
            if (kb.wKey.isPressed) move += rot * Vector3.forward;
            if (kb.sKey.isPressed) move -= rot * Vector3.forward;
            if (kb.dKey.isPressed) move += rot * Vector3.right;
            if (kb.aKey.isPressed) move -= rot * Vector3.right;
            if (kb.eKey.isPressed) move += Vector3.up;
            if (kb.qKey.isPressed) move -= Vector3.up;
            camState.Position += move * camState.FlySpeed * (kb.leftShiftKey.isPressed ? 4 : 1) * Time.unscaledDeltaTime;
        }

        void ApplyCamera()
        {
            if (view != null)
            {
                float ground = view.HeightAt(camState.Position.x, camState.Position.z);
                if (camState.Position.y < ground + 2) camState.Position.y = ground + 2;
            }
            cam.transform.SetPositionAndRotation(camState.Position, Quaternion.Euler(camState.Pitch, camState.Yaw, 0));
        }

        void SetCam(Vector3 p, float yaw, float pitch)
        {
            camState.Position = p;
            camState.Yaw = yaw;
            camState.Pitch = pitch;
            ApplyCamera();
        }

        // ───────── свёрнутое окно ─────────

        void UpdateMinimized()
        {
            bool now = window != IntPtr.Zero && IsIconic(window);
            if (now == minimized) return;
            minimized = now;
            // Свёрнуто: рендер выключен, 2 обновления в секунду; мир продолжает идти (или стоит — по настройке P).
            cam.enabled = !minimized;
            if (minimized)
            {
                QualitySettings.vSyncCount = 0;
                Application.targetFrameRate = 2;
            }
            else ApplyFrameCap();
            Debug.Log($"[WB] minimized={minimized} pauseOption={PauseWhenMinimized}");
        }

        // ───────── сохранение ─────────

        void SaveAsync(string path)
        {
            if (host?.Status != SimHost.SimHost.State.Running) return;
            if (saveTask != null && !saveTask.IsCompleted) return;
            var sw = Stopwatch.StartNew();
            var cap = SaveFile.Take(host.Sim);
            double takeMs = sw.Elapsed.TotalMilliseconds;
            saveTask = Task.Run(() =>
            {
                long bytes = SaveFile.Write(cap, path);
                status = $"Сохранено: {Path.GetFileName(path)}, {bytes / 1048576.0:0.0} МБ (снимок {takeMs:0.0} мс на главном потоке, запись в фоне {sw.Elapsed.TotalMilliseconds:0} мс)";
            });
        }

        void LoadFrom(string path)
        {
            try
            {
                saveTask?.Wait();
                var sim = SaveFile.Load(path, out var info);
                DisposeWorld();
                host = new SimHost.SimHost { UseBurst = useBurst };
                host.Adopt(sim);
                OnWorldReady();
                status = $"Загружено: {Path.GetFileName(info.UsedFile)}, такт {info.Tick}{(info.Warnings.Count > 0 ? " — " + string.Join("; ", info.Warnings) : "")}";
            }
            catch (Exception ex)
            {
                status = "Загрузка не удалась: " + ex.Message;
            }
        }

        void OnApplicationQuit()
        {
            saveTask?.Wait();
            if (host?.Status == SimHost.SimHost.State.Running && args != null && Arg("-wbsimbench") == null && Arg("-wbsimtest") == null) SaveFile.Save(host.Sim, AutoSavePath);
            DisposeWorld();
        }

        void OnDestroy() => DisposeWorld();

        // ───────── панель ─────────

        void OnGUI()
        {
            if (!showUi) return;
            var sb = new StringBuilder();
            sb.Append($"WORLDBOUND — Unity, ядро C# (Stage 1: рельеф, климат, погода, вода; флоры и фауны ещё нет)   {1f / Mathf.Max(1e-4f, Time.smoothDeltaTime):0} к/с, ограничение {FpsCaps[fpsCap]} (F3)\n");
            if (host == null) sb.Append("Нет мира\n");
            else if (host.Status == SimHost.SimHost.State.Generating) sb.Append($"Генерация: {host.Stage} {host.StageFraction * 100:0}%\n");
            else if (host.Status == SimHost.SimHost.State.Failed) sb.Append($"Ошибка: {host.Error}\n");
            else if (host.Status == SimHost.SimHost.State.Running)
            {
                var s = host.Snapshot;
                var c = s.Calendar;
                string[] seasons = { "весна", "лето", "осень", "зима" };
                var w = host.Sim.World;
                sb.Append($"Мир: seed {w.Seed}, {w.Config.Size} ({w.WorldSize} м), климат {w.Config.ClimateId}, провинций {w.Geo.Provinces.Length}, озёр {w.Geo.Lakes.Length} · geoHash {w.GeoHash}\n");
                var sim = host.Sim;
                sb.Append(w.Config.Scenario == Scenario.Genesis
                    ? $"Сценарий Genesis{(w.Config.Isolated ? " (изоляция)" : "")}: голая земля; флора идёт по суткам — средние, почва, покров, биомы (рост растений — этап 2.3)\n"
                    : $"Сценарий Wildlands: банк семян трав заложен, подготовка 20 лет ожидает (этап 2.5), готово {sim.PreparationFraction() * 100:0}%\n");
                if (host.Blocked != null) sb.Append($"Такты не идут: флора этого мира требует ещё не перенесённой части модели — {host.Blocked}\n");
                sb.Append($"Год {c.Year + 1}, {seasons[c.Season]}, день {c.DayOfSeason + 1}, {c.Hour:00}:{c.Minute:00} · скорость {(s.Speed == 0 ? "пауза" : "×" + s.Speed)} (Пробел, 1–4){(host.Behind ? " · НЕ УСПЕВАЕТ" : "")}\n");
                sb.Append($"Ядро: шаг воды {(host.BurstActive ? "Burst" : "C# без Burst")}, последний час {host.LastHourMs:0.00} мс, такты за кадр {host.TicksLastAdvance}, время ядра за кадр {host.LastAdvanceMs:0.00} мс\n");
                sb.Append($"Ветер {s.Wind.Speed:0.0} м/с · аномалия {s.Anomaly:+0.0;-0.0} °C · слой: {WorldRenderer.OverlayNames[(int)(view?.Overlay ?? 0)]} {view?.Legend} (O) · при сворачивании: {(PauseWhenMinimized ? "пауза" : "продолжать")} (P)\n");
            }
            sb.Append(status).Append('\n');
            sb.Append("ПКМ — обзор, WASD/QE — полёт, колесо — скорость полёта, F5/F9 — сохранить/загрузить, G — новый мир, F1 — скрыть, F12 — снимок");
            GUI.Label(new Rect(12, 10, 1600, 160), sb.ToString());
        }

        // ───────── проверки и замеры ─────────

        static string Q(string s) => MiniJson.Q(s);
        static string N(double v) => MiniJson.N(v);

        string SystemJson() =>
            $"\"unity\": {Q(Application.unityVersion)}, \"build\": {(Application.isEditor ? "\"editor\"" : "\"player\"")}, \"scripting\": \"Mono\", \"cpu\": {Q(SystemInfo.processorType)}, \"cores\": {SystemInfo.processorCount}, \"ramMB\": {SystemInfo.systemMemorySize}, \"gpu\": {Q(SystemInfo.graphicsDeviceName)}, \"api\": {Q(SystemInfo.graphicsDeviceType.ToString())}, \"burstActive\": {(BurstWater.IsBurstActive() ? "true" : "false")}";

        /// <summary>Golden-проверки в сборке: генератор (все случаи), среда — обычный C# (Mono) и Burst, сохранение.</summary>
        IEnumerator RunSimTest(string goldenDir, string outFile)
        {
            yield return null;
            var log = new StringBuilder();
            void L(string s) { log.AppendLine(s); Debug.Log("[WB] " + s); }
            bool ok = WorldgenGolden.Run(File.ReadAllText(Path.Combine(goldenDir, "worldgen.json")), L, out var wg);
            yield return null;
            string env = File.ReadAllText(Path.Combine(goldenDir, "env.json"));
            ok &= EnvGolden.Run(env, L, out var envManaged, new EnvGolden.Options { Label = "mono" });
            yield return null;
            var bursts = new Dictionary<Simulation, BurstWater>();
            ok &= EnvGolden.Run(env, L, out var envBurst, new EnvGolden.Options
            {
                Label = "burst",
                Configure = s => { var b = new BurstWater(s.World); bursts[s] = b; s.WaterAccelerator = b; },
                Release = s => { if (bursts.TryGetValue(s, out var b)) { s.WaterAccelerator = null; b.Dispose(); bursts.Remove(s); } },
            });
            yield return null;
            ok &= SaveCheck.Run(Path.Combine(Application.temporaryCachePath, "savecheck"), L, out var save);
            yield return null;
            // Мир M: сохранение → загрузка в новую симуляцию → 100 ч; шаг воды на Burst (как в игре).
            ok &= SaveCheck.Run(Path.Combine(Application.temporaryCachePath, "savecheck"), L, out var saveM, WorldSize.M, 100,
                s => { var b = new BurstWater(s.World); bursts[s] = b; s.WaterAccelerator = b; },
                s => { if (bursts.TryGetValue(s, out var b)) { s.WaterAccelerator = null; b.Dispose(); bursts.Remove(s); } });
            yield return null;
            ok &= SaveRobustness.Run(Path.Combine(Application.temporaryCachePath, "saverobust"), L, out var robust);
            ok &= PacerCheck.Run(L, out var pacer);
            ok &= HostCheck.Run(L, out var hostCheck);
            ok &= WoodyRestoreCheck.Run(L, out var woodyRestore);
            yield return null;
            // Флора, Stage 2.1 (G2): начальное состояние Genesis/Wildlands и стенд — против конструктора TS Simulation.
            ok &= FloraG2Golden.Run(File.ReadAllText(Path.Combine(goldenDir, "flora-g2.json")), L, out var g2);
            yield return null;
            // G3 (Stage 2.2): 20 лет голой земли — вода на Burst (флора — Mono); и 25 суток целиком на Mono.
            string g3json = File.ReadAllText(Path.Combine(goldenDir, "flora-g3.json"));
            var g3bursts = new Dictionary<Simulation, BurstWater>();
            ok &= FloraG3Golden.Run(g3json, L, out var g3burst, new FloraG3Golden.Options
            {
                Label = "burst-water",
                Configure = s => { var b = new BurstWater(s.World); g3bursts[s] = b; s.WaterAccelerator = b; },
                Release = s => { if (g3bursts.TryGetValue(s, out var b)) { s.WaterAccelerator = null; b.Dispose(); g3bursts.Remove(s); } },
            });
            yield return null;
            ok &= FloraG3Golden.Run(g3json, L, out var g3mono, new FloraG3Golden.Options { Label = "mono", Days = 25 });
            yield return null;
            // Флора, Stage 2.0 (G0/G1): каталоги, функции, WoodyStore, FloraState. content/ — рядом с папкой эталонов в репозитории.
            ok &= FloraGolden.Run(File.ReadAllText(Path.Combine(goldenDir, "flora-g0g1.json")), Path.GetFullPath(Path.Combine(goldenDir, "..", "..", "..", "content")), L, out var flora);
            File.WriteAllText(outFile, $"{{ {SystemJson()}, \"ok\": {(ok ? "true" : "false")},\n \"worldgen\": {wg},\n \"envMono\": {envManaged},\n \"envBurst\": {envBurst},\n \"save\": {save},\n \"saveM\": {saveM},\n \"saveRobustness\": {robust},\n \"pacer\": {pacer},\n \"host\": {hostCheck},\n \"flora\": {flora},\n \"woodyRestore\": {woodyRestore},\n \"g2\": {g2},\n \"g3BurstWater\": {g3burst},\n \"g3Mono\": {g3mono},\n \"log\": {Q(log.ToString())} }}\n");
        }

        /// <summary>
        /// Замеры симуляции: (1) без рендера — S и M, обычный C# и Burst: время часа и суток (среднее, p95, p99), GC, память;
        /// (2) с рендером — M, Burst: максимальная скорость в бюджете кадра и реальное время ×8; влияние рендера на ядро.
        /// </summary>
        IEnumerator RunSimBench(string outFile)
        {
            cam.enabled = false;
            yield return null;
            var parts = new List<string>();
            int hoursPerRun = int.Parse(Arg("-wbhours") ?? "240", Inv);
            foreach (var size in new[] { WorldSize.S, WorldSize.M })
            {
                var config = new WorldConfig { Seed = 42, Size = size, Scenario = Scenario.Genesis, Isolated = true };
                var sw = Stopwatch.StartNew();
                var gen = Sim.WorldGen.Generate.World(config);
                double genMs = sw.Elapsed.TotalMilliseconds;
                yield return null;
                foreach (bool burst in new[] { false, true })
                {
                    var r = MeasureHeadless(config, gen, burst, hoursPerRun);
                    parts.Add($"{{ \"size\": \"{size}\", \"backend\": \"{(burst ? "burst" : "mono")}\", \"rendering\": false, \"worldgenMs\": {N(Math.Round(genMs))}, {r} }}");
                    Debug.Log("[WB] " + parts[^1]);
                    yield return null;
                }
            }
            // С рендером: мир M, Burst, сцена построена, камера над миром.
            manualSim = true;
            cam.enabled = true;
            NewWorld(new WorldConfig { Seed = 42, Size = WorldSize.M, Scenario = Scenario.Genesis, Isolated = true });
            while (host.Status == SimHost.SimHost.State.Generating) { host.Poll(); yield return null; }
            host.Poll();
            OnWorldReady();
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            for (int k = 0; k < 120; k++) { view.Apply(host.Snapshot, sun); yield return null; }
            yield return MeasureRendered(0);
            yield return MeasureRendered(8);
            parts.AddRange(renderedResults);
            File.WriteAllText(outFile, $"{{ {SystemJson()}, \"hoursPerHeadlessRun\": {hoursPerRun}, \"resolution\": \"{Screen.width}x{Screen.height}\",\n \"runs\": [\n  {string.Join(",\n  ", parts)}\n ] }}\n");
        }

        readonly List<string> renderedResults = new();

        static double Pct(List<double> sorted, double p) => sorted.Count == 0 ? 0 : sorted[Math.Min(sorted.Count - 1, (int)Math.Floor(p * sorted.Count))];

        static string Stats(List<double> l)
        {
            var s = new List<double>(l);
            s.Sort();
            double mean = 0;
            foreach (var v in s) mean += v;
            mean /= Math.Max(1, s.Count);
            return $"{{ \"n\": {s.Count}, \"mean\": {N(Math.Round(mean, 3))}, \"p50\": {N(Math.Round(Pct(s, 0.5), 3))}, \"p95\": {N(Math.Round(Pct(s, 0.95), 3))}, \"p99\": {N(Math.Round(Pct(s, 0.99), 3))}, \"max\": {N(Math.Round(s.Count > 0 ? s[^1] : 0, 3))} }}";
        }

        string MeasureHeadless(WorldConfig config, Sim.WorldGen.Generate.Result gen, bool burst, int hours)
        {
            long monoBefore = Profiler.GetMonoUsedSizeLong();
            var sim = new Simulation(config, gen);
            BurstWater b = null;
            if (burst)
            {
                b = new BurstWater(sim.World);
                sim.WaterAccelerator = b;
            }
            var hourMs = new List<double>(hours);
            var waterMs = new List<double>(hours);
            var dayMs = new List<double>();
            var clock = Stopwatch.StartNew();
            sim.Clock = () => clock.Elapsed.TotalMilliseconds;
            for (int h = 0; h < 24; h++) sim.StepHour(); // прогрев: JIT, Burst, кэши
            GC.Collect();
            long gc0 = GC.CollectionCount(0);
            long heap0 = GC.GetTotalMemory(false);
            long monoUsed0 = Profiler.GetMonoUsedSizeLong();
            double day = 0;
            var sw = new Stopwatch();
            for (int h = 0; h < hours; h++)
            {
                double w0 = sim.WaterTiming.TotalMs;
                sw.Restart();
                sim.StepHour();
                double ms = sw.Elapsed.TotalMilliseconds;
                hourMs.Add(ms);
                waterMs.Add(sim.WaterTiming.TotalMs - w0);
                day += ms;
                if (h % 24 == 23) { dayMs.Add(day); day = 0; }
            }
            long gcs = GC.CollectionCount(0) - gc0;
            long heapDelta = GC.GetTotalMemory(false) - heap0;
            long simMono = Profiler.GetMonoUsedSizeLong() - monoBefore;
            double weatherPerHour = sim.WeatherTiming.TotalMs / Math.Max(1, sim.WaterTiming.Runs);
            string hash = sim.EnvHash();
            if (b != null) { sim.WaterAccelerator = null; b.Dispose(); }
            return $"\"cells\": {sim.World.Geo.N * sim.World.Geo.N}, \"hours\": {hours}, \"hourMs\": {Stats(hourMs)}, \"waterMs\": {Stats(waterMs)}, \"dayMs\": {Stats(dayMs)}, \"weatherMsPerHour\": {N(Math.Round(weatherPerHour, 3))}, " +
                   $"\"gcGen0Collections\": {gcs}, \"managedHeapDeltaBytes\": {heapDelta}, \"monoUsedByWorldMB\": {N(Math.Round(simMono / 1048576.0, 1))}, \"monoUsedMB\": {N(Math.Round(Profiler.GetMonoUsedSizeLong() / 1048576.0, 1))}, \"totalAllocatedMB\": {N(Math.Round(Profiler.GetTotalAllocatedMemoryLong() / 1048576.0, 1))}, \"finalEnvHash\": {Q(hash)}";
        }

        /// <summary>
        /// С рендером. realtimeSpeed = 0: ядро идёт так быстро, как позволяет бюджет 12 мс в кадре (рендер и ядро делят кадр);
        /// иначе — обычная игра со скоростью ×N (такты по реальному времени), бюджет как в игре.
        /// </summary>
        IEnumerator MeasureRendered(int realtimeSpeed)
        {
            var rec = new PrototypeApp.Recorder();
            var waterMs = new List<double>();
            var advMs = new List<double>();
            var sim = host.Sim;
            int runs0 = sim.WaterTiming.Runs;
            double total0 = sim.WaterTiming.TotalMs;
            long ticks0 = host.Sim.World.Tick;
            float seconds = 30;
            float start = Time.realtimeSinceStartup;
            float size = host.Sim.World.WorldSize;
            host.SetSpeed(realtimeSpeed == 0 ? 8 : realtimeSpeed);
            long gc0 = GC.CollectionCount(0);
            while (Time.realtimeSinceStartup - start < seconds)
            {
                float t = (Time.realtimeSinceStartup - start) / seconds;
                float a = t * Mathf.PI;
                SetCam(new Vector3(size * 0.5f + Mathf.Sin(a) * size * 0.45f, 0, size * 0.5f - Mathf.Cos(a) * size * 0.45f), -a * Mathf.Rad2Deg, 30);
                camState.Position.y = view.HeightAt(camState.Position.x, camState.Position.z) + 350;
                ApplyCamera();
                if (realtimeSpeed == 0)
                {
                    var sw = Stopwatch.StartNew();
                    host.Sim.ApplyCommands();
                    while (sw.Elapsed.TotalMilliseconds < 12) sim.Step();
                    advMs.Add(sw.Elapsed.TotalMilliseconds);
                    host.RefreshSnapshot();
                }
                else
                {
                    host.Advance(Time.unscaledDeltaTime, simBudgetMs);
                    advMs.Add(host.LastAdvanceMs);
                }
                if (sim.WaterTiming.Runs != runs0)
                {
                    // Шагов воды за кадр не больше одного при ×8; в режиме максимума — среднее по кадру.
                    int k = sim.WaterTiming.Runs - runs0;
                    double per = (sim.WaterTiming.TotalMs - total0) / k;
                    for (int j = 0; j < k; j++) waterMs.Add(per);
                    runs0 = sim.WaterTiming.Runs;
                    total0 = sim.WaterTiming.TotalMs;
                }
                view.Apply(host.Snapshot, sun);
                yield return null;
                rec.Frame();
            }
            float elapsed = Time.realtimeSinceStartup - start;
            double gameHours = (host.Sim.World.Tick - ticks0) / (double)SimTime.TicksPerHour;
            string mode = realtimeSpeed == 0 ? "max-speed-12ms-budget" : $"realtime-x{realtimeSpeed}";
            renderedResults.Add(rec.Json($"\"size\": \"M\", \"backend\": \"{(host.BurstActive ? "burst" : "mono")}\", \"rendering\": true, \"mode\": \"{mode}\", \"seconds\": {N(Math.Round(elapsed, 1))}, \"gameHours\": {N(Math.Round(gameHours, 2))}, \"gameHoursPerRealSecond\": {N(Math.Round(gameHours / elapsed, 3))}, \"waterMs\": {Stats(waterMs)}, \"simMsPerFrame\": {Stats(advMs)}, \"gcGen0Collections\": {GC.CollectionCount(0) - gc0}, \"terrainVertices\": {view.TerrainVertices}, \"waterQuads\": {view.WaterQuads}"));
            rec.Dispose();
        }

        /// <summary>Свёрнутый режим: 20 с активно, 40 с свёрнуто (окно сворачивается само), 20 с после восстановления.</summary>
        IEnumerator RunBackground(string outFile)
        {
            while (host.Status == SimHost.SimHost.State.Generating) yield return null;
            for (int k = 0; k < 60; k++) yield return null;
            host.SetSpeed(8);
            var phases = new List<string>();
            var proc = Process.GetCurrentProcess();
            foreach (var (name, secs, action) in new[] { ("active", 20f, 0), ("minimized", 40f, 6), ("restored", 20f, 9) })
            {
                if (action != 0) { ShowWindow(window, action); yield return null; yield return null; }
                proc.Refresh();
                var cpu0 = proc.TotalProcessorTime;
                long tick0 = host.Sim.World.Tick;
                int frames = 0;
                float t0 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t0 < secs) { frames++; yield return null; }
                float dt = Time.realtimeSinceStartup - t0;
                proc.Refresh();
                double cpuMs = (proc.TotalProcessorTime - cpu0).TotalMilliseconds;
                double ticks = host.Sim.World.Tick - tick0;
                double expected = dt * SimHost.SimHost.TicksPerSecondAtSpeed1 * 8;
                phases.Add($"{{ \"phase\": \"{name}\", \"seconds\": {dt.ToString("0.0", Inv)}, \"updatesPerSecond\": {(frames / dt).ToString("0.0", Inv)}, \"rendering\": {(cam.enabled ? "true" : "false")}, \"minimizedDetected\": {(minimized ? "true" : "false")}, \"ticks\": {ticks}, \"ticksExpected\": {Math.Round(expected)}, \"gameHours\": {(ticks / SimTime.TicksPerHour).ToString("0.##", Inv)}, \"cpuPercentOfOneCore\": {(cpuMs / (dt * 1000) * 100).ToString("0.0", Inv)}, \"unityAllocatedMB\": {Profiler.GetTotalAllocatedMemoryLong() / 1048576}, \"monoUsedMB\": {Profiler.GetMonoUsedSizeLong() / 1048576} }}");
            }
            var sw = Stopwatch.StartNew();
            long bytes = SaveFile.Save(host.Sim, AutoSavePath);
            File.WriteAllText(outFile, $"{{ \"pauseWhenMinimized\": {(PauseWhenMinimized ? "true" : "false")}, \"speed\": 8, \"burst\": {(host.BurstActive ? "true" : "false")}, \"saved\": {{ \"path\": {Q(AutoSavePath.Replace("\\", "/"))}, \"bytes\": {bytes}, \"ms\": {sw.ElapsedMilliseconds} }}, \"phases\": [\n  {string.Join(",\n  ", phases)}\n ] }}\n");
        }

        /// <summary>Ограничение кадров: для каждого режима — фактическая частота и время кадра (мир M идёт ×8).</summary>
        IEnumerator RunFpsTest(string outFile)
        {
            while (host.Status == SimHost.SimHost.State.Generating) yield return null;
            for (int k = 0; k < 60; k++) yield return null;
            host.SetSpeed(8);
            var rows = new List<string>();
            for (int c = 0; c < FpsCaps.Length; c++)
            {
                fpsCap = c;
                ApplyFrameCap();
                float t0 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t0 < 1.5f) yield return null;
                var frames = new List<double>();
                t0 = Time.realtimeSinceStartup;
                while (Time.realtimeSinceStartup - t0 < 6f) { yield return null; frames.Add(Time.unscaledDeltaTime * 1000); }
                float dt = Time.realtimeSinceStartup - t0;
                rows.Add($"{{ \"cap\": {Q(FpsCaps[c])}, \"vSyncCount\": {QualitySettings.vSyncCount}, \"targetFrameRate\": {Application.targetFrameRate}, \"fps\": {N(Math.Round(frames.Count / dt, 1))}, \"frameMs\": {Stats(frames)} }}");
            }
            File.WriteAllText(outFile, $"{{ \"refreshRate\": {N(Math.Round(Screen.currentResolution.refreshRateRatio.value, 2))}, \"resolution\": \"{Screen.width}x{Screen.height}\", \"runs\": [\n  {string.Join(",\n  ", rows)}\n ] }}\n");
        }

        /// <summary>
        /// Симуляция не зависит от рендера: мир Genesis (изоляция) S/42 идёт двое суток под рендером (120 кадров по 120 тактов) — камера облетает
        /// мир, качество (MSAA, масштаб рендера, тени), слой данных и ограничение кадров меняются каждые несколько
        /// кадров; шаг воды — Burst. Затем тот же мир без рендера (управляемая вода) до того же такта: хеши обязаны
        /// совпасть друг с другом и с эталоном TS (сутки 2 из Golden/flora-g3.json, если передан -wbgolden).
        /// </summary>
        IEnumerator RunRenderCheck(string outFile, string goldenDir)
        {
            var config = new WorldConfig { Seed = 42, Size = WorldSize.S, Scenario = Scenario.Genesis, Isolated = true };
            manualSim = true;
            NewWorld(config);
            while (host.Status == SimHost.SimHost.State.Generating) { host.Poll(); yield return null; }
            host.Poll();
            OnWorldReady();
            var sim = host.Sim;
            long start = sim.World.Tick;
            long target = start + 2L * SimTime.TicksPerDay;
            var rp = (UniversalRenderPipelineAsset)GraphicsSettings.currentRenderPipeline;
            int[] msaa = { 1, 2, 4 };
            float[] scales = { 0.6f, 1f, 0.8f };
            float[] shadows = { 60, 400, 150 };
            int frames = 0;
            float size = sim.World.WorldSize;
            while (sim.World.Tick < target)
            {
                int k = frames++;
                if (k % 5 == 0)
                {
                    rp.msaaSampleCount = msaa[(k / 5) % 3];
                    rp.renderScale = scales[(k / 5) % 3];
                    rp.shadowDistance = shadows[(k / 5) % 3];
                    view.Overlay = (Overlay)((k / 5) % WorldRenderer.OverlayNames.Length);
                    fpsCap = (k / 5) % FpsCaps.Length;
                    ApplyFrameCap();
                }
                float a = k * 0.05f;
                SetCam(new Vector3(size * 0.5f + Mathf.Sin(a) * size * 0.4f, 300 + 200 * Mathf.Sin(a * 0.7f), size * 0.5f + Mathf.Cos(a) * size * 0.4f), a * Mathf.Rad2Deg, 25 + 20 * Mathf.Sin(a));
                for (int t = 0; t < 120 && sim.World.Tick < target; t++) sim.Step();
                host.RefreshSnapshot();
                view.Apply(host.Snapshot, sun);
                yield return null;
            }
            string rendered = sim.StateHash();
            var headless = new Simulation(config);
            while (headless.World.Tick < target) headless.Step();
            string plain = headless.StateHash();
            string golden = null;
            if (goldenDir != null)
            {
                var g = MiniJson.Obj(MiniJson.Parse(File.ReadAllText(Path.Combine(goldenDir, "flora-g3.json"))));
                golden = (string)MiniJson.Obj(MiniJson.Arr(MiniJson.Obj(g["scenarioA"])["days"])[1])["stateHash"];
            }
            bool ok = rendered == plain && (golden == null || golden == rendered);
            File.WriteAllText(outFile, $"{{ \"ok\": {(ok ? "true" : "false")}, \"frames\": {frames}, \"ticks\": {target - start}, \"renderedBurstWater\": {Q(rendered)}, \"headlessManagedWater\": {Q(plain)}, \"tsGoldenDay2\": {(golden == null ? "null" : Q(golden))}, \"burstActive\": {(host.BurstActive ? "true" : "false")} }}\n");
            Debug.Log($"[WB] render-check: {(ok ? "OK" : "FAIL")} рендер {rendered}, без рендера {plain}, TS {golden}");
        }

        /// <summary>Снимки: общий вид, низкий ракурс, слои данных ядра.</summary>
        IEnumerator RunWorldShots(string dir)
        {
            Directory.CreateDirectory(dir);
            while (host.Status == SimHost.SimHost.State.Generating) yield return null;
            for (int k = 0; k < 30; k++) yield return null;
            // Полдень следующего дня, чтобы освещение было дневным: прогоняем такты ядра (настоящее время мира).
            var w = host.Sim.World;
            while (SimTime.FromTick(w.Tick, w.Config.DaysPerSeason).Hour != 12) host.Sim.Step();
            host.RefreshSnapshot();
            float size = w.WorldSize;
            var views = new (string name, Vector3 pos, float yaw, float pitch, Overlay ov)[]
            {
                ("w01-overview", new Vector3(size * 0.5f, size * 0.32f, -size * 0.18f), 0, 38, Overlay.Nature),
                ("w02-low", new Vector3(size * 0.3f, 0, size * 0.35f), 45, 8, Overlay.Nature),
                ("w03-temperature", new Vector3(size * 0.5f, size * 0.55f, size * 0.05f), 0, 62, Overlay.Temperature),
                ("w04-moisture", new Vector3(size * 0.5f, size * 0.55f, size * 0.05f), 0, 62, Overlay.Moisture),
                ("w05-discharge", new Vector3(size * 0.5f, size * 0.55f, size * 0.05f), 0, 62, Overlay.Discharge),
                ("w06-cloud", new Vector3(size * 0.5f, size * 0.55f, size * 0.05f), 0, 62, Overlay.Cloud),
            };
            var legends = new List<string>();
            foreach (var v in views)
            {
                view.Overlay = v.ov;
                var p = v.pos;
                if (v.name == "w02-low") p.y = view.HeightAt(p.x, p.z) + 60;
                SetCam(p, v.yaw, v.pitch);
                for (int k = 0; k < 20; k++) { view.Apply(host.Snapshot, sun); yield return null; }
                ScreenCapture.CaptureScreenshot(Path.Combine(dir, v.name + ".png"));
                legends.Add($"{Q(v.name)}: {Q(view.Legend)}");
                yield return null;
                yield return null;
            }
            view.Overlay = Overlay.Nature;
            // Зима: прогон ядра до середины зимы (снег — результат шага воды, а не декорация).
            int dps = w.Config.DaysPerSeason;
            long winter = (w.Tick / (SimTime.TicksPerDay * dps * 4) * 4 + 3) * SimTime.TicksPerDay * dps + SimTime.TicksPerDay * (dps / 2) + 12 * SimTime.TicksPerHour;
            while (w.Tick < winter) host.Sim.StepHour();
            while (SimTime.FromTick(w.Tick, dps).Hour != 12) host.Sim.Step();
            host.RefreshSnapshot();
            foreach (var v in new[] { ("w07-winter-overview", views[0]), ("w08-winter-snow", views[0]) })
            {
                view.Overlay = v.Item1.EndsWith("snow") ? Overlay.Snow : Overlay.Nature;
                SetCam(v.Item2.pos, v.Item2.yaw, v.Item2.pitch);
                for (int k = 0; k < 20; k++) { view.Apply(host.Snapshot, sun); yield return null; }
                ScreenCapture.CaptureScreenshot(Path.Combine(dir, v.Item1 + ".png"));
                legends.Add($"{Q(v.Item1)}: {Q(view.Legend)}");
                yield return null;
                yield return null;
            }
            var cal = SimTime.FromTick(w.Tick, dps);
            File.WriteAllText(Path.Combine(dir, "shots.json"), $"{{ \"seed\": {w.Seed}, \"size\": \"{w.Config.Size}\", \"geoHash\": {Q(w.GeoHash)}, \"winterTick\": {w.Tick}, \"winterSeason\": {cal.Season}, \"winterDay\": {cal.DayOfSeason + 1}, \"envHash\": {Q(host.Sim.EnvHash())}, \"legends\": {{ {string.Join(", ", legends)} }} }}\n");
        }
    }
}
