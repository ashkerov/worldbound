// Местность стенда (2 × 2 км, как мир S): пологие холмы, хвойная гряда на севере, сырая низина у ольшаника.
// Только для стенда; в игре высоты даёт генератор мира (Geo.Terrain).

using UnityEngine;
using UnityEngine.Rendering;

namespace Worldbound.FloraView.Stand
{
    public static class StandTerrain
    {
        public const float Size = 2048;
        public const int Cells = 256;

        public static float Height(float x, float z)
        {
            float broad = FloraHash.Fbm(3, x * 0.0016f, z * 0.0016f, 3) * 70;
            float mid = FloraHash.Fbm(7, x * 0.006f, z * 0.006f, 3) * 14;
            float fine = FloraHash.Noise(11, x * 0.03f, z * 0.03f) * 1.6f;
            float ridge = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(1100, 1900, z)) * 35; // гряда на севере
            float hollow = -Mathf.Exp(-Sq((x - 1350) / 260f) - Sq((z - 520) / 200f)) * 18; // низина
            return broad + mid + fine + ridge + hollow;
        }

        static float Sq(float v) => v * v;

        public static FloraTerrain BuildHeights() => new(513, Size / 512, Height);

        /// <summary>
        /// Сетка земли: мир 2 × 2 км с шагом 8 м и кольцо местности за краем мира шириной 2 км с шагом 64 м
        /// (прямоугольная сетка с переменным шагом — без трещин на стыке). За краем растений нет: это горизонт стенда.
        /// </summary>
        public static Mesh BuildMesh(FloraTerrain t)
        {
            var xs = new System.Collections.Generic.List<float>();
            for (float v = -Size; v < 0; v += 64) xs.Add(v);
            for (int i = 0; i <= 256; i++) xs.Add(i * 8f);
            for (float v = Size + 64; v <= Size * 2 + 0.1f; v += 64) xs.Add(v);
            int N = xs.Count;
            var v3 = new Vector3[N * N];
            var n = new Vector3[N * N];
            for (int z = 0; z < N; z++)
                for (int x = 0; x < N; x++)
                {
                    float px = xs[x], pz = xs[z];
                    bool inside = px >= 0 && px <= Size && pz >= 0 && pz <= Size;
                    float h = inside ? t.Sample(px, pz) : Height(px, pz);
                    v3[z * N + x] = new Vector3(px, h, pz);
                    float e = inside ? 2 : 16;
                    float hx = Height(px + e, pz) - Height(px - e, pz), hz = Height(px, pz + e) - Height(px, pz - e);
                    n[z * N + x] = new Vector3(-hx, 2 * e, -hz).normalized;
                }
            var idx = new int[(N - 1) * (N - 1) * 6];
            int k = 0;
            for (int z = 0; z < N - 1; z++)
                for (int x = 0; x < N - 1; x++)
                {
                    int i = z * N + x;
                    idx[k++] = i; idx[k++] = i + N; idx[k++] = i + 1;
                    idx[k++] = i + 1; idx[k++] = i + N; idx[k++] = i + N + 1;
                }
            var m = new Mesh { name = "stand-ground", indexFormat = IndexFormat.UInt32, vertices = v3, normals = n, triangles = idx };
            m.RecalculateBounds();
            m.UploadMeshData(true);
            return m;
        }
    }
}
