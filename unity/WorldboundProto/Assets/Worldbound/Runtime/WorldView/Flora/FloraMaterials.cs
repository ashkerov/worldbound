// Шейдеры и материалы растительности. Шейдеры держит ScriptableObject FloraRenderAssets — он лежит в ассетах
// и упомянут сценой, поэтому шейдеры гарантированно попадают в сборку (без Shader.Find и Resources).

using System;
using UnityEngine;

namespace Worldbound.FloraView
{
    public sealed class FloraMaterials : IDisposable
    {
        public readonly Material Woody, Grass;
        public readonly Texture2D LeafAtlas, Gust;
        public readonly Shader ImpostorShader;
        public float BuildMs { get; }
        static readonly int AtlasId = Shader.PropertyToID("_FloraLeafAtlas"), GustId = Shader.PropertyToID("_FloraGust"), DebugId = Shader.PropertyToID("_FloraDebug"), BakeId = Shader.PropertyToID("_FloraBake");

        public FloraMaterials(FloraRenderAssets assets)
        {
            var t0 = Time.realtimeSinceStartupAsDouble;
            if (assets == null || !assets.Woody || !assets.Grass || !assets.Impostor) throw new ArgumentException("FloraRenderAssets: не заданы шейдеры");
            Woody = new Material(assets.Woody) { name = "FloraWoody", enableInstancing = true };
            Grass = new Material(assets.Grass) { name = "FloraGrass", enableInstancing = true };
            ImpostorShader = assets.Impostor;
            LeafAtlas = FloraTextures.BuildLeafAtlas();
            Gust = FloraTextures.BuildGustNoise();
            Shader.SetGlobalTexture(AtlasId, LeafAtlas);
            Shader.SetGlobalTexture(GustId, Gust);
            Shader.SetGlobalFloat(BakeId, 0);
            BuildMs = (float)((Time.realtimeSinceStartupAsDouble - t0) * 1000);
        }

        public void SetDebugLod(bool on) => Shader.SetGlobalVector(DebugId, new Vector4(on ? 1 : 0, 0, 0, 0));

        /// <summary>Объём текстур растительности в видеопамяти (оценка по форматам), байт.</summary>
        public long TextureBytes => (long)(LeafAtlas.width * LeafAtlas.height * 1.333f) + Gust.width * Gust.height * 4;

        public void Dispose()
        {
            UnityEngine.Object.Destroy(Woody);
            UnityEngine.Object.Destroy(Grass);
            UnityEngine.Object.Destroy(LeafAtlas);
            UnityEngine.Object.Destroy(Gust);
        }
    }
}
