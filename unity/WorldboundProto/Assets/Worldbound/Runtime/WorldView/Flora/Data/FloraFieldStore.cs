// Поля травяного яруса, полога и поверхности (копия из снимка) для задания травы и шейдеров.
// Текстуры по ячейкам (bilinear): _FloraHerbA/B — плотности 8 видов трав, _FloraHerbCell — покрытие, высота,
// зелень, ветошь; _FloraCanopy — полог деревьев, доля хвойных, кустарники, облиственность; _FloraSurface — снег,
// влажность. Глобальные — их может читать любой материал рельефа (стенд сейчас, WorldTerrain после интеграции).

using System;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;
using UnityEngine;

namespace Worldbound.FloraView
{
    public sealed class FloraFieldStore : IDisposable
    {
        public readonly FloraGrid Grid;
        public readonly int HerbCount;
        public NativeArray<byte> Herbs, HerbCell, Canopy, Surface;
        /// <summary>Растёт при каждом изменении полей (трава пересчитывается только тогда).</summary>
        public long Version { get; private set; }
        public bool HasSurface { get; private set; }
        Texture2D herbA, herbB, herbCell, canopy, surface;
        NativeArray<Color32> packA, packB;
        bool dirty;

        public static readonly int HerbAId = Shader.PropertyToID("_FloraHerbA"), HerbBId = Shader.PropertyToID("_FloraHerbB"), HerbCellId = Shader.PropertyToID("_FloraHerbCell"),
            CanopyId = Shader.PropertyToID("_FloraCanopy"), SurfaceId = Shader.PropertyToID("_FloraSurface"), ParamsId = Shader.PropertyToID("_FloraFieldParams");

        public FloraFieldStore(FloraGrid grid, int herbCount)
        {
            Grid = grid;
            HerbCount = herbCount;
            int n = grid.CellCount;
            Herbs = new NativeArray<byte>(n * herbCount, Allocator.Persistent);
            HerbCell = new NativeArray<byte>(n * 4, Allocator.Persistent);
            Canopy = new NativeArray<byte>(n * 4, Allocator.Persistent);
            Surface = new NativeArray<byte>(n * 2, Allocator.Persistent);
            packA = new NativeArray<Color32>(n, Allocator.Persistent);
            packB = new NativeArray<Color32>(n, Allocator.Persistent);
            herbA = Tex("FloraHerbA", TextureFormat.RGBA32);
            herbB = Tex("FloraHerbB", TextureFormat.RGBA32);
            herbCell = Tex("FloraHerbCell", TextureFormat.RGBA32);
            canopy = Tex("FloraCanopy", TextureFormat.RGBA32);
            surface = Tex("FloraSurface", TextureFormat.RG16);
            dirty = true;
        }

        Texture2D Tex(string name, TextureFormat f) => new(Grid.Cells, Grid.Cells, f, false, true) { name = name, wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };

        public void Clear()
        {
            Fill(Herbs); Fill(HerbCell); Fill(Canopy); Fill(Surface);
            HasSurface = false;
            dirty = true;
            Version++;
        }

        static void Fill(NativeArray<byte> a) { unsafe { Unity.Collections.LowLevel.Unsafe.UnsafeUtility.MemClear(Unity.Collections.LowLevel.Unsafe.NativeArrayUnsafeUtility.GetUnsafePtr(a), a.Length); } }

        public void Apply(FieldChunk c)
        {
            int cpc = Grid.CellsPerChunk;
            for (int local = 0; local < cpc; local++)
            {
                int cell = Grid.CellOfChunk(c.Chunk, local);
                if (cell < 0) continue;
                if (c.Herbs != null) for (int h = 0; h < HerbCount; h++) Herbs[cell * HerbCount + h] = c.Herbs[local * HerbCount + h];
                if (c.HerbCell != null) for (int k = 0; k < 4; k++) HerbCell[cell * 4 + k] = c.HerbCell[local * 4 + k];
                if (c.Canopy != null) for (int k = 0; k < 4; k++) Canopy[cell * 4 + k] = c.Canopy[local * 4 + k];
                if (c.Surface != null) { Surface[cell * 2] = c.Surface[local * 2]; Surface[cell * 2 + 1] = c.Surface[local * 2 + 1]; }
            }
            if (c.Surface != null) HasSurface = true;
            dirty = true;
            Version++;
        }

        [BurstCompile]
        struct PackJob : IJobParallelFor
        {
            [ReadOnly] public NativeArray<byte> Herbs;
            public NativeArray<Color32> A, B;
            public int H;
            public void Execute(int c)
            {
                int o = c * H;
                A[c] = new Color32(G(o, 0), G(o, 1), G(o, 2), G(o, 3));
                B[c] = new Color32(G(o, 4), G(o, 5), G(o, 6), G(o, 7));
            }

            byte G(int o, int h) => h < H ? Herbs[o + h] : (byte)0;
        }

        /// <summary>Обновить текстуры, если поля менялись, и выставить глобальные параметры шейдеров.</summary>
        public void Upload()
        {
            if (dirty)
            {
                new PackJob { Herbs = Herbs, A = packA, B = packB, H = HerbCount }.Schedule(Grid.CellCount, 1024).Complete();
                herbA.SetPixelData(packA, 0); herbA.Apply(false, false);
                herbB.SetPixelData(packB, 0); herbB.Apply(false, false);
                herbCell.SetPixelData(HerbCell, 0); herbCell.Apply(false, false);
                canopy.SetPixelData(Canopy, 0); canopy.Apply(false, false);
                surface.SetPixelData(Surface, 0); surface.Apply(false, false);
                dirty = false;
            }
            Shader.SetGlobalTexture(HerbAId, herbA);
            Shader.SetGlobalTexture(HerbBId, herbB);
            Shader.SetGlobalTexture(HerbCellId, herbCell);
            Shader.SetGlobalTexture(CanopyId, canopy);
            Shader.SetGlobalTexture(SurfaceId, surface);
            Shader.SetGlobalVector(ParamsId, new Vector4(1f / Grid.WorldSize, Grid.Cells, Grid.CellSize, HasSurface ? 1 : 0));
        }

        public long TextureBytes => (long)Grid.CellCount * (4 * 4 + 2);

        public void Dispose()
        {
            Herbs.Dispose(); HerbCell.Dispose(); Canopy.Dispose(); Surface.Dispose(); packA.Dispose(); packB.Dispose();
            foreach (var t in new[] { herbA, herbB, herbCell, canopy, surface }) if (t) UnityEngine.Object.Destroy(t);
        }
    }
}
