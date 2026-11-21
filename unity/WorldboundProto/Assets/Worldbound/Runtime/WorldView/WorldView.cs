// Рендер реального мира из ядра C#: рельеф (отсчёты 2 м генератора, сетка 4 м, чанки 128 м), реки и озёра на
// уровнях воды генератора, море, горизонт за границей, слой состояния ячеек из снимков (снег, температура, влага,
// облачность, расход). Рендер только читает: Geo (статика) и WorldSnapshot (копия состояния); в мир не пишет.
// Флоры и фауны здесь нет — они ещё не перенесены в ядро C#.
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using Worldbound.Sim;
using Worldbound.Sim.WorldGen;
using Worldbound.SimHost;

namespace Worldbound.WorldView
{
    public enum Overlay { Nature = 0, Temperature = 1, Moisture = 2, Snow = 3, Cloud = 4, Discharge = 5 }

    public sealed class WorldRenderer : IDisposable
    {
        public static readonly string[] OverlayNames = { "природа", "температура", "влага почвы", "снег", "облачность", "расход рек" };
        readonly GameObject root;
        readonly List<Mesh> meshes = new();
        readonly Material terrainMat, waterMat;
        readonly Texture2D state;
        readonly Color32[] pixels;
        readonly Geo geo;
        readonly int worldSize;
        int shownVersion = -1;
        Overlay overlay = Overlay.Nature;
        public int TerrainVertices, WaterQuads, Chunks;
        public double BuildMs;

        public Overlay Overlay
        {
            get => overlay;
            set { overlay = value; shownVersion = -1; terrainMat.SetFloat("_Overlay", (float)value); }
        }

        public WorldRenderer(Geo geo, Material terrain, Material water, Transform parent)
        {
            var sw = System.Diagnostics.Stopwatch.StartNew();
            this.geo = geo;
            worldSize = geo.N * geo.CellSize;
            root = new GameObject("world");
            root.transform.SetParent(parent, false);
            terrainMat = new Material(terrain);
            waterMat = water;
            state = new Texture2D(geo.N, geo.N, TextureFormat.RGBA32, false, true) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
            pixels = new Color32[geo.N * geo.N];
            terrainMat.SetTexture("_StateTex", state);
            terrainMat.SetFloat("_WorldSize", worldSize);
            terrainMat.SetFloat("_Overlay", 0);
            BuildTerrain();
            BuildHorizon();
            BuildWater();
            BuildMs = sw.Elapsed.TotalMilliseconds;
        }

        static readonly Color[] SoilColor =
        {
            new(0.47f, 0.45f, 0.42f), // скала
            new(0.78f, 0.71f, 0.52f), // песок
            new(0.42f, 0.5f, 0.27f),  // суглинок
            new(0.55f, 0.48f, 0.32f), // глина
            new(0.33f, 0.45f, 0.24f), // аллювий
            new(0.3f, 0.3f, 0.2f),    // торф
        };

        /// <summary>Цвет поверхности из статики генератора: почва и уклон (растительности нет — она не перенесена).</summary>
        Color CellColor(double x, double z, float h)
        {
            int n = geo.N;
            int cx = Mathf.Clamp((int)(x / geo.CellSize), 0, n - 1);
            int cz = Mathf.Clamp((int)(z / geo.CellSize), 0, n - 1);
            int i = cz * n + cx;
            var c = SoilColor[geo.Soil[i]];
            float slope = geo.Slope[i];
            c = Color.Lerp(c, SoilColor[0], Smooth(0.35f, 0.75f, slope));
            if (geo.WaterKind[i] != WaterKind.None) c = Color.Lerp(c, new Color(0.35f, 0.33f, 0.27f), 0.6f);
            c *= 0.9f + 0.2f * geo.Fertility[i];
            if (h > 380) c = Color.Lerp(c, new Color(0.55f, 0.55f, 0.55f), Mathf.Clamp01((h - 380) / 120));
            c.a = 1;
            return c;
        }

        void BuildTerrain()
        {
            var t = geo.Terrain;
            const int step = 2; // 2 отсчёта по 2 м = сетка 4 м
            const int chunkSamples = 32; // 32 × 4 м = 128 м
            int last = t.Samples - 1;
            int chunks = last / (step * chunkSamples);
            var verts = new Vector3[(chunkSamples + 1) * (chunkSamples + 1)];
            var norms = new Vector3[verts.Length];
            var cols = new Color[verts.Length];
            var idx = new int[chunkSamples * chunkSamples * 6];
            int k = 0;
            for (int z = 0; z < chunkSamples; z++)
                for (int x = 0; x < chunkSamples; x++)
                {
                    int a = z * (chunkSamples + 1) + x;
                    idx[k++] = a; idx[k++] = a + chunkSamples + 1; idx[k++] = a + 1;
                    idx[k++] = a + 1; idx[k++] = a + chunkSamples + 1; idx[k++] = a + chunkSamples + 2;
                }
            float H(int sx, int sz) => t.Data[Mathf.Clamp(sz, 0, last) * t.Samples + Mathf.Clamp(sx, 0, last)];
            float sp = (float)t.Spacing;
            for (int cz = 0; cz < chunks; cz++)
                for (int cx = 0; cx < chunks; cx++)
                {
                    int v = 0;
                    for (int z = 0; z <= chunkSamples; z++)
                        for (int x = 0; x <= chunkSamples; x++)
                        {
                            int sx = (cx * chunkSamples + x) * step, sz = (cz * chunkSamples + z) * step;
                            float h = H(sx, sz);
                            verts[v] = new Vector3(sx * sp, h, sz * sp);
                            float dx = H(sx + step, sz) - H(sx - step, sz);
                            float dz = H(sx, sz + step) - H(sx, sz - step);
                            norms[v] = new Vector3(-dx, 2 * step * sp, -dz).normalized;
                            cols[v] = CellColor(sx * sp, sz * sp, h);
                            v++;
                        }
                    var m = new Mesh { name = $"terrain {cx},{cz}" };
                    m.SetVertices(verts);
                    m.SetNormals(norms);
                    m.SetColors(cols);
                    m.SetTriangles(idx, 0);
                    m.RecalculateBounds();
                    m.UploadMeshData(true);
                    Add(m, terrainMat, true);
                    TerrainVertices += verts.Length;
                }
            Chunks = chunks * chunks;
        }

        void BuildHorizon()
        {
            var h = geo.Horizon;
            int s = h.Samples;
            var verts = new List<Vector3>(s * s);
            var cols = new List<Color>(s * s);
            var norms = new List<Vector3>(s * s);
            float sp = (float)h.Spacing;
            for (int z = 0; z < s; z++)
                for (int x = 0; x < s; x++)
                {
                    float wx = (float)h.OriginX + x * sp, wz = (float)h.OriginZ + z * sp;
                    float y = h.Data[z * s + x];
                    verts.Add(new Vector3(wx, y, wz));
                    float dx = h.Data[z * s + Mathf.Min(s - 1, x + 1)] - h.Data[z * s + Mathf.Max(0, x - 1)];
                    float dz = h.Data[Mathf.Min(s - 1, z + 1) * s + x] - h.Data[Mathf.Max(0, z - 1) * s + x];
                    norms.Add(new Vector3(-dx, 4 * sp, -dz).normalized);
                    var c = y < 0 ? new Color(0.62f, 0.58f, 0.45f) : y > 300 ? new Color(0.5f, 0.5f, 0.5f) : new Color(0.4f, 0.47f, 0.28f);
                    cols.Add(c);
                }
            var idx = new List<int>();
            for (int z = 0; z < s - 1; z++)
                for (int x = 0; x < s - 1; x++)
                {
                    // Внутри мира рисует рельеф 4 м — горизонт там не нужен (и не спорит с ним по глубине).
                    float x0 = (float)h.OriginX + x * sp, z0 = (float)h.OriginZ + z * sp;
                    if (x0 >= 0 && z0 >= 0 && x0 + sp <= worldSize && z0 + sp <= worldSize) continue;
                    int a = z * s + x;
                    idx.Add(a); idx.Add(a + s); idx.Add(a + 1);
                    idx.Add(a + 1); idx.Add(a + s); idx.Add(a + s + 1);
                }
            var m = new Mesh { name = "horizon", indexFormat = IndexFormat.UInt32 };
            m.SetVertices(verts);
            m.SetNormals(norms);
            m.SetColors(cols);
            m.SetTriangles(idx, 0);
            m.RecalculateBounds();
            m.UploadMeshData(true);
            Add(m, terrainMat, false);
        }

        void BuildWater()
        {
            int n = geo.N;
            float cs = geo.CellSize;
            var verts = new List<Vector3>();
            var cols = new List<Color>();
            var idx = new List<int>();
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    int i = z * n + x;
                    byte kind = geo.WaterKind[i];
                    if (kind != WaterKind.River && kind != WaterKind.Lake) continue;
                    float y = geo.WaterLevel[i];
                    float depth = Mathf.Clamp01((y - geo.Height[i]) / 4f);
                    int a = verts.Count;
                    // Квадрат ровно по ячейке: соседи одного уровня смыкаются без перекрытия (перекрытие прозрачных
                    // квадратов даёт полосы двойного смешивания).
                    float x0 = x * cs, z0 = z * cs, x1 = (x + 1) * cs, z1 = (z + 1) * cs;
                    verts.Add(new Vector3(x0, y, z0)); verts.Add(new Vector3(x1, y, z0)); verts.Add(new Vector3(x0, y, z1)); verts.Add(new Vector3(x1, y, z1));
                    var c = new Color(depth, 0, 0, 1);
                    cols.Add(c); cols.Add(c); cols.Add(c); cols.Add(c);
                    idx.Add(a); idx.Add(a + 2); idx.Add(a + 1); idx.Add(a + 1); idx.Add(a + 2); idx.Add(a + 3);
                    WaterQuads++;
                }
            if (idx.Count > 0)
            {
                var m = new Mesh { name = "rivers-lakes", indexFormat = IndexFormat.UInt32 };
                m.SetVertices(verts);
                m.SetColors(cols);
                m.SetTriangles(idx, 0);
                m.RecalculateBounds();
                m.UploadMeshData(true);
                Add(m, waterMat, false);
            }
            // Море: одна плоскость на нулевой отметке до края горизонта; суша выше неё закрывает её сама.
            float e = (float)-geo.Horizon.OriginX;
            var sea = new Mesh { name = "sea" };
            sea.SetVertices(new[] { new Vector3(-e, 0, -e), new Vector3(worldSize + e, 0, -e), new Vector3(-e, 0, worldSize + e), new Vector3(worldSize + e, 0, worldSize + e) });
            var deep = new Color(1, 0, 0, 1);
            sea.SetColors(new[] { deep, deep, deep, deep });
            sea.SetTriangles(new[] { 0, 2, 1, 1, 2, 3 }, 0);
            sea.RecalculateBounds();
            Add(sea, waterMat, false);
        }

        void Add(Mesh m, Material mat, bool shadows)
        {
            meshes.Add(m);
            var go = new GameObject(m.name);
            go.transform.SetParent(root.transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = m;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = mat;
            r.shadowCastingMode = shadows ? ShadowCastingMode.On : ShadowCastingMode.Off;
            r.receiveShadows = true;
        }

        /// <summary>Подпись шкалы текущего слоя (фактический диапазон по суше).</summary>
        public string Legend { get; private set; } = "";

        /// <summary>Переносит поля последнего часа в текстуру состояния (только если снимок новее показанного).</summary>
        public void Apply(WorldSnapshot snap, Light sun)
        {
            var f = snap.Fields;
            if (f != null && f.Version != shownVersion)
            {
                shownVersion = f.Version;
                int count = pixels.Length;
                float[] src = overlay switch
                {
                    Overlay.Temperature => f.Temperature,
                    Overlay.Moisture => f.MoistureRel,
                    Overlay.Snow => f.Snow,
                    Overlay.Cloud => f.Cloud,
                    Overlay.Discharge => f.Discharge,
                    _ => null,
                };
                // Шкала слоя — по фактическому диапазону суши в этот час (расход — логарифм, снег — от нуля).
                float lo = float.MaxValue, hi = float.MinValue;
                if (src != null)
                {
                    for (int i = 0; i < count; i++)
                    {
                        if (geo.WaterKind[i] == WaterKind.Sea) continue;
                        float v = Value(src[i]);
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                    if (overlay == Overlay.Snow || overlay == Overlay.Discharge) lo = 0;
                    if (hi - lo < 1e-6f) hi = lo + 1;
                    Legend = overlay switch
                    {
                        Overlay.Temperature => $"{lo:0.0}…{hi:0.0} °C (синий → красный)",
                        Overlay.Moisture => $"влага/влагоёмкость {lo:0.00}…{hi:0.00} (охра → синий)",
                        Overlay.Snow => $"снег 0…{hi:0} мм в.э.",
                        Overlay.Cloud => $"облачность {lo:0.00}…{hi:0.00}",
                        Overlay.Discharge => $"расход 0…{Mathf.Pow(10, hi) - 1:0.0} м³/с (лог. шкала)",
                        _ => "",
                    };
                }
                else Legend = "";
                for (int i = 0; i < count; i++)
                {
                    float snow = Mathf.Clamp01(f.Snow[i] / 25f);
                    float v = src == null ? 0 : Mathf.Clamp01((Value(src[i]) - lo) / (hi - lo));
                    pixels[i] = new Color32((byte)(snow * 255), (byte)(v * 255), 0, 255);
                }
                state.SetPixels32(pixels);
                state.Apply(false);
            }
            if (sun)
            {
                // Солнце ядра: X — восток, Y — вверх, Z — юг (то же, что в мире Unity: Z — юг, Y — вверх).
                var d = new Vector3((float)snap.Sun.X, (float)snap.Sun.Y, (float)snap.Sun.Z);
                if (d.y < 0.03f) d.y = 0.03f; // ночью свет не уходит под землю — гасится интенсивностью
                sun.transform.rotation = Quaternion.LookRotation(-d.normalized);
                sun.intensity = Mathf.Lerp(0.05f, 1.35f, Smooth(-0.05f, 0.35f, (float)snap.Sun.Y));
            }
        }

        float Value(float v) => overlay == Overlay.Discharge ? Mathf.Log10(1 + v) : v;

        static float Smooth(float e0, float e1, float x)
        {
            float t = Mathf.Clamp01((x - e0) / (e1 - e0));
            return t * t * (3 - 2 * t);
        }

        public float HeightAt(float x, float z) => (float)geo.Terrain.At(x, z);

        public void Dispose()
        {
            foreach (var m in meshes) UnityEngine.Object.Destroy(m);
            meshes.Clear();
            UnityEngine.Object.Destroy(state);
            UnityEngine.Object.Destroy(terrainMat);
            UnityEngine.Object.Destroy(root);
        }
    }
}
