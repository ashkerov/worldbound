// Сезон для шейдеров растительности — чисто визуальный: из внешней доли года (календарь симуляции) и снега/
// влажности условий кадра. Климат здесь не считается. Облиственность каждого дерева приходит из снимка
// (фенология симуляции); контроллер задаёт только палитру: свежесть весенней листвы, ход осенней окраски,
// окна цветения и плодов видов, ход осеннего увядания трав, снег и намокание.

using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Worldbound.FloraView
{
    [StructLayout(LayoutKind.Sequential)]
    struct WoodySpeciesGpu { public Vector4 Flex, Spring, AutumnA, AutumnB, Bloom, Fruit, Misc; }

    [StructLayout(LayoutKind.Sequential)]
    struct HerbSpeciesGpu { public Vector4 Base, Tip, Dry, Autumn, Bloom, Bloom2; }

    public sealed class FloraSeasonController : System.IDisposable
    {
        readonly List<WoodyProfile> woody;
        readonly List<HerbProfile> herbs;
        readonly WoodySpeciesGpu[] w;
        readonly HerbSpeciesGpu[] h;
        readonly GraphicsBuffer wBuf, hBuf;
        static readonly int WoodyId = Shader.PropertyToID("_FloraWoodySpecies"), HerbId = Shader.PropertyToID("_FloraHerbSpecies"),
            SeasonId = Shader.PropertyToID("_FloraSeason"), SnowColorId = Shader.PropertyToID("_FloraSnowColor");
        public float SpringFresh, Autumn, HerbAutumn;

        public FloraSeasonController(List<WoodyProfile> woody, List<HerbProfile> herbs)
        {
            this.woody = woody;
            this.herbs = herbs;
            w = new WoodySpeciesGpu[Mathf.Max(1, woody.Count)];
            h = new HerbSpeciesGpu[Mathf.Max(1, herbs.Count)];
            wBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, w.Length, Marshal.SizeOf<WoodySpeciesGpu>());
            hBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, h.Length, Marshal.SizeOf<HerbSpeciesGpu>());
        }

        static float Window(float p, Vector2 win, float ramp = 0.025f)
        {
            if (win.y <= win.x) return 0;
            return Mathf.SmoothStep(0, 1, Mathf.InverseLerp(win.x - ramp, win.x + ramp, p)) * (1 - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(win.y - ramp, win.y + ramp, p)));
        }

        static Vector4 V(Color c, float a) => new(c.r, c.g, c.b, a);

        public void Apply(in FloraEnvironment env)
        {
            float p = Mathf.Repeat(env.YearPhase, 1);
            SpringFresh = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0, 0.04f, p)) * (1 - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.1f, 0.24f, p)));
            Autumn = p >= 0.82f ? 1 : Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.46f, 0.64f, p));
            HerbAutumn = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.5f, 0.68f, p)) * (1 - Mathf.SmoothStep(0, 1, Mathf.InverseLerp(0.94f, 1f, p)));
            for (int i = 0; i < woody.Count; i++)
            {
                var s = woody[i];
                w[i] = new WoodySpeciesGpu
                {
                    Flex = new Vector4(s.TrunkFlex, s.BranchFlex, s.Flutter, s.Evergreen ? 1 : 0),
                    Spring = V(s.Spring, s.Evergreen ? SpringFresh * 0.35f : SpringFresh),
                    AutumnA = V(s.AutumnA, s.Evergreen ? 0 : Autumn),
                    AutumnB = V(s.AutumnB, s.Translucency),
                    Bloom = V(s.Bloom, s.Bloom.a > 0 ? Window(p, s.BloomWindow) : 0),
                    Fruit = V(s.Fruit, s.Fruit.a > 0 ? Window(p, s.FruitWindow) : 0),
                    Misc = new Vector4(s.SnowCatch, s.Conifer ? 1 : 0, 0, 0),
                };
            }
            for (int i = 0; i < herbs.Count; i++)
            {
                var s = herbs[i];
                bool berries = s.Kind == HerbKind.Bilberry;
                float bloom = Window(p, s.BloomWindow, 0.03f);
                h[i] = new HerbSpeciesGpu
                {
                    Base = V(s.Base, 1f / Mathf.Max(0.2f, s.Stiffness)),
                    Tip = V(s.Tip, berries ? 0 : bloom),
                    Dry = V(s.Dry, HerbAutumn),
                    Autumn = V(s.Autumn, SpringFresh),
                    Bloom = V(s.Bloom, s.Kind == HerbKind.MeadowFlowers ? 4 : 0),
                    Bloom2 = berries ? V(s.Bloom, bloom) : V(s.Bloom2.a > 0 ? s.Bloom2 : s.Bloom, 0),
                };
            }
            wBuf.SetData(w);
            hBuf.SetData(h);
            Shader.SetGlobalBuffer(WoodyId, wBuf);
            Shader.SetGlobalBuffer(HerbId, hBuf);
            Shader.SetGlobalVector(SeasonId, new Vector4(p, Mathf.Clamp01(env.Snow), Mathf.Clamp01(env.Wetness), Mathf.Clamp01(env.Dryness)));
            Shader.SetGlobalVector(SnowColorId, new Vector4(0.86f, 0.89f, 0.94f, 1));
        }

        public void Dispose() { wBuf?.Release(); hBuf?.Release(); }
    }
}
