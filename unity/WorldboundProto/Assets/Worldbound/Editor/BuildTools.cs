// Инструменты редактора для batchmode: настройка проекта, сцена, сборка Windows x64, сверка переноса симуляции.
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

        /// <summary>Prototype C в редакторе (Mono JIT + Burst редактора).</summary>
        public static void RunPortTest()
        {
            Directory.CreateDirectory(ResultsDir);
            var golden = Path.Combine(Application.streamingAssetsPath, "golden");
            var json = Worldbound.Sim.PortBenchmark.Run(golden, Path.Combine(ResultsDir, "port-editor.json"));
            Debug.Log("[WB] Port test:\n" + json);
        }
    }
}
