// Освещение стенда: солнце/луна, полусферический амбиент (свой SH — без запекания), туман, процедурное небо,
// лёгкая постобработка (ACES, слабое свечение, мягкая цветокоррекция, виньетка). Четыре условия проверки
// растительности: ясный день, закат, ночь, пасмурно. В игре это делает освещение мира, не рендер флоры.

using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Worldbound.FloraView.Stand
{
    public enum StandLight { Day = 0, Sunset, Night, Overcast }

    public sealed class StandLighting
    {
        public static readonly string[] Names = { "День", "Закат", "Ночь", "Пасмурно" };
        readonly Light sun;
        readonly Material sky;
        readonly ColorAdjustments color;
        readonly Bloom bloom;
        public StandLight Current { get; private set; }

        public StandLighting(Material skyMaterial)
        {
            sun = new GameObject("sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.shadows = LightShadows.Soft;
            sun.shadowBias = 0.06f;
            sun.shadowNormalBias = 0.5f;
            RenderSettings.sun = sun;
            sky = skyMaterial ? new Material(skyMaterial) : null;
            RenderSettings.skybox = sky;
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            var vol = new GameObject("post").AddComponent<Volume>();
            vol.isGlobal = true;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.Add<Tonemapping>(true).mode.Override(TonemappingMode.ACES);
            bloom = profile.Add<Bloom>(true);
            bloom.intensity.Override(0.22f);
            bloom.threshold.Override(1.1f);
            color = profile.Add<ColorAdjustments>(true);
            profile.Add<Vignette>(true).intensity.Override(0.14f);
            vol.profile = profile;
        }

        public void Apply(StandLight l, float snow)
        {
            Current = l;
            Color skyC, eq, gr, fog;
            float density, exposure, thickness = 0.9f;
            Color tint;
            switch (l)
            {
                case StandLight.Sunset:
                    sun.transform.rotation = Quaternion.Euler(7, 250, 0);
                    sun.color = new Color(1f, 0.6f, 0.34f); sun.intensity = 1.15f; sun.shadowStrength = 0.85f;
                    skyC = new Color(0.42f, 0.4f, 0.52f); eq = new Color(0.5f, 0.36f, 0.3f); gr = new Color(0.14f, 0.1f, 0.08f);
                    fog = new Color(0.8f, 0.58f, 0.45f); density = 0.0011f; exposure = 1.05f; tint = new Color(0.62f, 0.52f, 0.48f);
                    color.postExposure.Override(0.1f); color.saturation.Override(6); color.colorFilter.Override(new Color(1f, 0.95f, 0.9f));
                    break;
                case StandLight.Night:
                    sun.transform.rotation = Quaternion.Euler(36, 120, 0);
                    sun.color = new Color(0.55f, 0.66f, 1f); sun.intensity = 0.22f; sun.shadowStrength = 0.7f;
                    skyC = new Color(0.05f, 0.07f, 0.13f); eq = new Color(0.035f, 0.045f, 0.07f); gr = new Color(0.015f, 0.016f, 0.02f);
                    fog = new Color(0.035f, 0.045f, 0.075f); density = 0.0012f; exposure = 0.08f; tint = new Color(0.25f, 0.3f, 0.45f);
                    color.postExposure.Override(0.55f); color.saturation.Override(-15); color.colorFilter.Override(new Color(0.88f, 0.93f, 1f));
                    break;
                case StandLight.Overcast:
                    sun.transform.rotation = Quaternion.Euler(55, -20, 0);
                    sun.color = new Color(0.86f, 0.89f, 0.93f); sun.intensity = 0.42f; sun.shadowStrength = 0.3f;
                    skyC = new Color(0.62f, 0.65f, 0.7f); eq = new Color(0.56f, 0.58f, 0.59f); gr = new Color(0.3f, 0.3f, 0.28f);
                    fog = new Color(0.66f, 0.68f, 0.7f); density = 0.0022f; exposure = 0.75f; tint = new Color(0.6f, 0.6f, 0.6f); thickness = 2.2f;
                    color.postExposure.Override(0.15f); color.saturation.Override(-4); color.colorFilter.Override(Color.white);
                    break;
                default:
                    sun.transform.rotation = Quaternion.Euler(47, -35, 0);
                    sun.color = new Color(1f, 0.95f, 0.86f); sun.intensity = 1.4f; sun.shadowStrength = 0.92f;
                    skyC = new Color(0.66f, 0.78f, 0.98f); eq = new Color(0.58f, 0.63f, 0.6f); gr = new Color(0.26f, 0.24f, 0.19f);
                    fog = new Color(0.72f, 0.79f, 0.86f); density = 0.0009f; exposure = 1.12f; tint = new Color(0.52f, 0.6f, 0.75f);
                    color.postExposure.Override(0.05f); color.saturation.Override(0); color.contrast.Override(6); color.colorFilter.Override(new Color(1f, 0.985f, 0.96f));
                    break;
            }
            if (snow > 0.3f) { gr = Color.Lerp(gr, new Color(0.55f, 0.58f, 0.62f), snow * 0.6f); color.postExposure.Override(color.postExposure.value - 0.25f * snow); }
            // Трёхцветный амбиент Unity (небо / горизонт / земля): зонд считается движком без отрицательных лепестков.
            // Небо даёт и рассеянный свет в тени крон: амбиент чуть сильнее «физического», чтобы тень читалась.
            float k = l == StandLight.Night ? 1.2f : 1.3f;
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = skyC * k;
            RenderSettings.ambientEquatorColor = eq * k;
            RenderSettings.ambientGroundColor = gr * k;
            DynamicGI.UpdateEnvironment();
            RenderSettings.fogColor = fog;
            RenderSettings.fogDensity = density;
            if (sky)
            {
                sky.SetFloat("_Exposure", exposure);
                sky.SetColor("_SkyTint", tint);
                sky.SetFloat("_AtmosphereThickness", thickness);
                sky.SetFloat("_SunSize", l == StandLight.Night ? 0.015f : 0.035f);
            }
        }
    }
}
