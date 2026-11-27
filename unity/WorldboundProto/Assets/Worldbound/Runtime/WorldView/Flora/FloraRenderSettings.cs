// Профили качества рендера растительности. Все расстояния — «эффективные»: расстояние до растения, делённое
// на множитель его размера (крупное дерево переходит на упрощённую модель позже, всход — раньше).
// Средний профиль — цель Intel Iris Xe (35–45 к/с в 1920 × 1080, решение заказчика №15).

using System;
using UnityEngine;

namespace Worldbound.FloraView
{
    public enum FloraQuality { Low = 0, Medium = 1, High = 2, Ultra = 3 }

    [Serializable]
    public sealed class FloraRenderSettings
    {
        public FloraQuality Quality = FloraQuality.Medium;

        [Header("Деревья, м")]
        public float TreeLod0 = 26, TreeLod1 = 60, TreeLod2 = 150, TreeThin = 380, TreeMax = 1500;
        [Header("Кустарники, м")]
        public float ShrubLod0 = 18, ShrubLod1 = 45, ShrubMax = 160;
        [Tooltip("Доля ширины зоны плавного перехода от границы уровня")]
        public float FadeBand = 0.12f;
        [Tooltip("Множитель всех дальностей (настройка «дальность прорисовки»)")]
        public float DrawDistance = 1f;
        public bool CrossFade = true;

        [Header("Тени")]
        public bool TreeShadowsLod0 = true, TreeShadowsLod1 = true, TreeShadowsLod2 = false, ShrubShadows = true;

        [Header("Импосторы")]
        public int ImpostorFrame = 96;
        public bool ImpostorBlend = true;

        [Header("Трава, м")]
        public float GrassRadius = 50, GrassLod0 = 12, GrassLod1 = 28;
        [Tooltip("Множитель числа пучков")]
        public float GrassDensity = 0.7f;
        public int GrassMaxInstances = 60000;

        [Header("Обновления")]
        [Tooltip("Бюджет применения чанков за кадр, мс (остальные — в следующих кадрах)")]
        public float ApplyBudgetMs = 3f;
        public bool VerifyChecksums = true;

        public static FloraRenderSettings For(FloraQuality q)
        {
            var s = new FloraRenderSettings { Quality = q };
            switch (q)
            {
                case FloraQuality.Low:
                    s.TreeLod0 = 16; s.TreeLod1 = 40; s.TreeLod2 = 105; s.TreeThin = 260; s.TreeMax = 1100;
                    s.ShrubLod0 = 12; s.ShrubLod1 = 30; s.ShrubMax = 110;
                    s.TreeShadowsLod1 = false; s.ShrubShadows = false;
                    s.ImpostorFrame = 64; s.ImpostorBlend = false;
                    s.GrassRadius = 32; s.GrassLod0 = 8; s.GrassLod1 = 18; s.GrassDensity = 0.45f; s.GrassMaxInstances = 30000;
                    break;
                case FloraQuality.High:
                    s.TreeLod0 = 36; s.TreeLod1 = 85; s.TreeLod2 = 220; s.TreeThin = 550; s.TreeMax = 2100;
                    s.ShrubLod0 = 25; s.ShrubLod1 = 60; s.ShrubMax = 220;
                    s.TreeShadowsLod2 = true;
                    s.ImpostorFrame = 128;
                    s.GrassRadius = 70; s.GrassLod0 = 16; s.GrassLod1 = 38; s.GrassDensity = 1f; s.GrassMaxInstances = 110000;
                    break;
                case FloraQuality.Ultra:
                    s.TreeLod0 = 50; s.TreeLod1 = 120; s.TreeLod2 = 300; s.TreeThin = 800; s.TreeMax = 2600;
                    s.ShrubLod0 = 32; s.ShrubLod1 = 80; s.ShrubMax = 300;
                    s.TreeShadowsLod2 = true;
                    s.ImpostorFrame = 128;
                    s.GrassRadius = 90; s.GrassLod0 = 22; s.GrassLod1 = 50; s.GrassDensity = 1.2f; s.GrassMaxInstances = 180000;
                    break;
            }
            return s;
        }

        public FloraRenderSettings Clone() => (FloraRenderSettings)MemberwiseClone();
    }

    /// <summary>Детерминированный хеш (как rand() TS-рендера): вариации зависят только от номеров, не от камеры и порядка.</summary>
    public static class FloraHash
    {
        public static uint Hash(uint a, uint b = 0, uint c = 0, uint d = 0)
        {
            uint h = 2166136261u;
            h = (h ^ a) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h = (h ^ b) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h = (h ^ c) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h = (h ^ d) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h ^= h >> 13; h *= 3266489909u; h ^= h >> 16;
            return h;
        }

        public static float F(uint a, uint b = 0, uint c = 0, uint d = 0) => (Hash(a, b, c, d) >> 8) * (1f / 16777216f);
        public static float F(int a, int b = 0, int c = 0, int d = 0) => F((uint)a, (uint)b, (uint)c, (uint)d);

        /// <summary>Сглаженный шум значений 0..1.</summary>
        public static float Noise(int seed, float x, float y)
        {
            int xi = Mathf.FloorToInt(x), yi = Mathf.FloorToInt(y);
            float xf = x - xi, yf = y - yi;
            float u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
            float a = F(seed, xi, yi), b = F(seed, xi + 1, yi), c = F(seed, xi, yi + 1), d = F(seed, xi + 1, yi + 1);
            return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        }

        public static float Fbm(int seed, float x, float y, int oct = 4)
        {
            float s = 0, amp = 0.5f, norm = 0;
            for (int i = 0; i < oct; i++) { s += Noise(seed + i * 31, x, y) * amp; norm += amp; x *= 2.03f; y *= 2.03f; amp *= 0.5f; }
            return s / norm;
        }
    }
}
