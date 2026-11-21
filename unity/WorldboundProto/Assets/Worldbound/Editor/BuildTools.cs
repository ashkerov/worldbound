// Инструменты редактора для batchmode: настройка проекта, сцена, сборка Windows x64, golden-проверки ядра C#.
// Unity.exe -batchmode -quit -projectPath <проект> -executeMethod Worldbound.EditorTools.BuildTools.<Метод>

using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Worldbound.EditorTools
{
    public static class BuildTools
    {
        const string ScenePath = "Assets/Scenes/Main.unity";
        static string ProjectDir => Directory.GetParent(Application.dataPath)!.FullName;
        static string ResultsDir => Path.GetFullPath(Path.Combine(ProjectDir, "..", "Results"));

        /// <summary>Настройки проигрывателя, URP, сцена с точкой входа, список сцен сборки.</summary>
        public static void Setup()
        {
            PlayerSettings.companyName = "WORLDBOUND";
            PlayerSettings.productName = "WORLDBOUND Unity Prototype";
            PlayerSettings.runInBackground = true; // свёрнутое окно: мир продолжает жить (режим задаёт AppMain)
            PlayerSettings.fullScreenMode = FullScreenMode.FullScreenWindow;
            PlayerSettings.defaultScreenWidth = 1920;
            PlayerSettings.defaultScreenHeight = 1080;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.enableFrameTimingStats = true; // FrameTimingManager: время CPU и GPU кадра в сборке
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.SetScriptingBackend(UnityEditor.Build.NamedBuildTarget.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.usePlayerLog = true;
            PlayerSettings.visibleInBackground = true;

            // URP: ассет качества для ПК из шаблона — во все уровни качества.
            var rp = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>("Assets/Settings/PC_RPAsset.asset");
            GraphicsSettings.defaultRenderPipeline = rp;
            for (int i = 0; i < QualitySettings.names.Length; i++)
            {
                QualitySettings.SetQualityLevel(i, false);
                QualitySettings.renderPipeline = rp;
            }
            rp.shadowDistance = 120;
            rp.supportsHDR = true;
            rp.msaaSampleCount = 2;

            // Материалы в Resources: так шейдеры гарантированно попадают в сборку.
            const string res = "Assets/Worldbound/Resources";
            Mat($"{res}/WB_Foliage.mat", "WB/Foliage", m => m.enableInstancing = true);
            Mat($"{res}/WB_Ground.mat", "WB/Ground", null);
            Mat($"{res}/WB_Water.mat", "WB/Water", null);
            Mat($"{res}/WB_WorldTerrain.mat", "WB/WorldTerrain", null);
            Mat($"{res}/WB_Sky.mat", "Skybox/Procedural", m =>
            {
                m.SetFloat("_SunSize", 0.035f);
                m.SetFloat("_AtmosphereThickness", 0.85f);
                m.SetColor("_SkyTint", new Color(0.52f, 0.62f, 0.78f));
                m.SetColor("_GroundColor", new Color(0.42f, 0.45f, 0.4f));
                m.SetFloat("_Exposure", 1.15f);
            });

            // Сцена: только точка входа; мир строится кодом (как в TS-проекте — процедурно).
            Directory.CreateDirectory(Path.Combine(ProjectDir, "Assets/Scenes"));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var go = new GameObject("WORLDBOUND");
            go.AddComponent<Worldbound.App.AppMain>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
            Debug.Log("[WB] Setup done");
        }

        static void Mat(string path, string shader, System.Action<Material> tune)
        {
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (!m)
            {
                m = new Material(Shader.Find(shader));
                AssetDatabase.CreateAsset(m, path);
            }
            m.shader = Shader.Find(shader);
            tune?.Invoke(m);
            EditorUtility.SetDirty(m);
        }

        public static void BuildWindows()
        {
            var dir = Path.Combine(ProjectDir, "Build", "Windows");
            Directory.CreateDirectory(dir);
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = Path.Combine(dir, "WorldboundProto.exe"),
                target = BuildTarget.StandaloneWindows64,
                options = BuildOptions.None,
            });
            var s = report.summary;
            Directory.CreateDirectory(ResultsDir);
            File.WriteAllText(Path.Combine(ResultsDir, "build-summary.json"), $"{{ \"result\": \"{s.result}\", \"seconds\": {s.totalTime.TotalSeconds.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture)}, \"bytes\": {s.totalSize}, \"errors\": {s.totalErrors}, \"warnings\": {s.totalWarnings}, \"unity\": \"{Application.unityVersion}\" }}\n");
            Debug.Log($"[WB] Build {s.result} in {s.totalTime.TotalSeconds:0}s, {s.totalSize / 1048576} MB");
            if (s.result != BuildResult.Succeeded) EditorApplication.Exit(1);
        }

        /// <summary>
        /// Golden-проверки ядра Worldbound.Sim в редакторе (Mono JIT + Burst редактора): генератор, среда (обычный C# и Burst),
        /// сохранение. Эталоны — unity/WorldboundProto/Golden (вне Assets: в сборку не попадают).
        /// </summary>
        public static void RunSimTests()
        {
            Directory.CreateDirectory(ResultsDir);
            string golden = Path.Combine(ProjectDir, "Golden");
            var log = new System.Text.StringBuilder();
            void L(string s) { log.AppendLine(s); Debug.Log("[WB] " + s); }
            bool ok = Worldbound.Sim.Golden.WorldgenGolden.Run(File.ReadAllText(Path.Combine(golden, "worldgen.json")), L, out var wg);
            string env = File.ReadAllText(Path.Combine(golden, "env.json"));
            ok &= Worldbound.Sim.Golden.EnvGolden.Run(env, L, out var envMono, new Worldbound.Sim.Golden.EnvGolden.Options { Label = "mono-editor" });
            var bursts = new System.Collections.Generic.Dictionary<Worldbound.Sim.Simulation, Worldbound.SimHost.BurstWater>();
            ok &= Worldbound.Sim.Golden.EnvGolden.Run(env, L, out var envBurst, new Worldbound.Sim.Golden.EnvGolden.Options
            {
                Label = "burst-editor",
                Configure = s => { var b = new Worldbound.SimHost.BurstWater(s.World); bursts[s] = b; s.WaterAccelerator = b; },
                Release = s => { if (bursts.TryGetValue(s, out var b)) { s.WaterAccelerator = null; b.Dispose(); bursts.Remove(s); } },
            });
            ok &= Worldbound.Sim.Golden.SaveCheck.Run(Path.Combine(ProjectDir, "Temp", "savecheck"), L, out var save);
            ok &= Worldbound.Sim.Golden.SaveCheck.Run(Path.Combine(ProjectDir, "Temp", "savecheck"), L, out var saveM, Worldbound.Sim.WorldSize.M, 100,
                s => { var b = new Worldbound.SimHost.BurstWater(s.World); bursts[s] = b; s.WaterAccelerator = b; },
                s => { if (bursts.TryGetValue(s, out var b)) { s.WaterAccelerator = null; b.Dispose(); bursts.Remove(s); } });
            ok &= Worldbound.Sim.Golden.SaveRobustness.Run(Path.Combine(ProjectDir, "Temp", "saverobust"), L, out var robust);
            ok &= Worldbound.Sim.Golden.PacerCheck.Run(L, out var pacer);
            ok &= Worldbound.SimHost.HostCheck.Run(L, out var hostCheck);
            bool burst = Worldbound.SimHost.BurstWater.IsBurstActive();
            File.WriteAllText(Path.Combine(ResultsDir, "sim-editor.json"), $"{{ \"ok\": {(ok ? "true" : "false")}, \"burstActive\": {(burst ? "true" : "false")}, \"unity\": \"{Application.unityVersion}\",\n \"worldgen\": {wg},\n \"envMono\": {envMono},\n \"envBurst\": {envBurst},\n \"save\": {save},\n \"saveM\": {saveM},\n \"saveRobustness\": {robust},\n \"pacer\": {pacer},\n \"host\": {hostCheck} }}\n");
            Debug.Log($"[WB] Sim tests: {(ok ? "OK" : "FAIL")}, burst {burst}");
            if (!ok) EditorApplication.Exit(1);
        }
    }
}
