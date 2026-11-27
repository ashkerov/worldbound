// Внутренние данные рендера: подготовленные экземпляры (по чанкам), структуры буферов GPU, высоты рельефа,
// хеш и шум для заданий Burst. Ничего из этого не возвращается в контракт или в мир.

using System;
using System.Runtime.InteropServices;
using Unity.Collections;
using Unity.Mathematics;

namespace Worldbound.FloraView
{
    /// <summary>Древесное растение, подготовленное к отрисовке (хранится в списке своего чанка и слоя).</summary>
    public struct WoodyInstance
    {
        public float3 Pos;
        public float Yaw;
        public float ScaleXZ, ScaleY;
        public float Seed, Leaf, Health;
        /// <summary>Высота растения, м.</summary>
        public float Height;
        /// <summary>1 / множитель размера для уровня детализации (считается один раз при загрузке чанка).</summary>
        public float LodScale;
        /// <summary>Радиус описанной сферы, м, и высота её центра над основанием.</summary>
        public float Radius, CentreY;
        public int Archetype;
        public int Visual;
        /// <summary>Строка атласа импосторов (−1 — нет).</summary>
        public int ImpostorRow;
        /// <summary>Уровень детализации в прошлом кадре (для счёта переключений), 255 — не рисовалось.</summary>
        public int LastLod;
    }

    /// <summary>Экземпляр древесного в буфере GPU (48 байт), читается шейдером WB/FloraWoody по SV_InstanceID.</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct WoodyGpu
    {
        public float4 PosYaw;   // xyz основания, поворот
        public float4 Scale;    // растяжение кроны, высоты; seed 0..1; облиственность 0..1
        public float4 Extra;    // здоровье; растворение (−1..1); номер профиля; строка импостора
    }

    /// <summary>Пучок травы в буфере GPU (48 байт).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct GrassGpu
    {
        public float4 PosYaw;
        public float4 Scale;    // xz, y, seed, растворение
        public float4 Extra;    // номер профиля травы; зелень; ветошь; полог над ячейкой
    }

    /// <summary>Как вид каталога отображается: слой, профиль, архетипы по возрасту (номера внутри слоя).</summary>
    public struct SpeciesMap
    {
        public int Layer;            // 0 — не древесный, 1 — деревья, 2 — кустарники
        public int Visual;
        public int Young, MatureA, MatureB, Old;
        public float4 RefH, RefR;    // эталонные высота и крона архетипов (young, matureA, matureB, old)
        public int ImpostorMature, ImpostorOld;
        public float MaxHeight;
    }

    /// <summary>Высоты рельефа для посадки растений (решётка samples² с шагом spacing от начала мира).</summary>
    public sealed class FloraTerrain : IDisposable
    {
        public NativeArray<float> Heights;
        public readonly int Samples;
        public readonly float Spacing;

        public FloraTerrain(int samples, float spacing, Func<float, float, float> height)
        {
            Samples = samples;
            Spacing = spacing;
            Heights = new NativeArray<float>(samples * samples, Allocator.Persistent);
            for (int z = 0; z < samples; z++)
                for (int x = 0; x < samples; x++) Heights[z * samples + x] = height(x * spacing, z * spacing);
        }

        public FloraTerrain(float[] heights, int samples, float spacing)
        {
            Samples = samples;
            Spacing = spacing;
            Heights = new NativeArray<float>(heights, Allocator.Persistent);
        }

        public float Sample(float x, float z) => FloraJobMath.Height(Heights, Samples, Spacing, x, z);

        public void Dispose() { if (Heights.IsCreated) Heights.Dispose(); }
    }

    public static class FloraJobMath
    {
        public static float Height(in NativeArray<float> h, int n, float spacing, float x, float z)
        {
            float fx = math.clamp(x / spacing, 0, n - 1.001f), fz = math.clamp(z / spacing, 0, n - 1.001f);
            int ix = (int)fx, iz = (int)fz;
            float u = fx - ix, v = fz - iz;
            int i = iz * n + ix;
            return math.lerp(math.lerp(h[i], h[i + 1], u), math.lerp(h[i + n], h[i + n + 1], u), v);
        }

        public static uint Hash(uint a, uint b, uint c)
        {
            uint h = 2166136261u;
            h = (h ^ a) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h = (h ^ b) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h = (h ^ c) * 16777619u; h = (h ^ (h >> 15)) * 2246822507u;
            h ^= h >> 13; h *= 3266489909u; h ^= h >> 16;
            return h;
        }

        public static float F(uint a, uint b, uint c) => (Hash(a, b, c) >> 8) * (1f / 16777216f);

        public static float Noise(uint seed, float x, float y)
        {
            float xf0 = math.floor(x), yf0 = math.floor(y);
            int xi = (int)xf0, yi = (int)yf0;
            float xf = x - xf0, yf = y - yf0;
            float u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
            float a = F(seed, (uint)xi, (uint)yi), b = F(seed, (uint)(xi + 1), (uint)yi), c = F(seed, (uint)xi, (uint)(yi + 1)), d = F(seed, (uint)(xi + 1), (uint)(yi + 1));
            return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        }

        /// <summary>Сфера в усечённой пирамиде (плоскости нормалями внутрь: dot(n, p) + d ≥ −r).</summary>
        public static bool SphereVisible(in NativeArray<float4> planes, float3 c, float r)
        {
            for (int p = 0; p < 6; p++)
            {
                float4 pl = planes[p];
                if (math.dot(pl.xyz, c) + pl.w < -r) return false;
            }
            return true;
        }

        public static bool BoxVisible(in NativeArray<float4> planes, float3 mn, float3 mx)
        {
            float3 c = (mn + mx) * 0.5f, e = (mx - mn) * 0.5f;
            for (int p = 0; p < 6; p++)
            {
                float4 pl = planes[p];
                if (math.dot(pl.xyz, c) + pl.w < -math.dot(e, math.abs(pl.xyz))) return false;
            }
            return true;
        }
    }
}
