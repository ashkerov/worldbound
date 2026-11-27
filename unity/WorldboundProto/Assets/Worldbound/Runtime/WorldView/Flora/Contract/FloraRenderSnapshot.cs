// Контракт данных «мир → рендер растительности» (Worldbound.FloraView.Contract). Чистый C# без UnityEngine:
// его может заполнять ядро симуляции, SimHost, синтетический стенд или инструмент вне Unity.
// Рендер только читает эти данные; ничего из них не возвращается в мир.
//
// Пространство: мировые метры, начало (0, 0) — угол мира, x — восток, z — север (как WoodyStore.X/Z ядра).
// Сетка: эко-ячейки 8 м; чанк — 16 × 16 ячеек (128 м), как FLORA_CHUNK_CELLS в TS-протоколе.
// Подробное описание и схема интеграции — docs/FLORA_RENDERER_INTEGRATION.md.

using System;
using System.Runtime.InteropServices;

namespace Worldbound.FloraView
{
    public static class FloraContract
    {
        /// <summary>Версия формата контракта. Меняется при несовместимом изменении полей.</summary>
        public const int Version = 1;
        public const float CellSize = 8f;
        public const int ChunkCells = 16;
        /// <summary>Байт плотности травы v означает (v/255)² · HerbFieldMax г/м² (как HERB_FIELD_MAX в TS).</summary>
        public const float HerbFieldMax = 1020f;
        /// <summary>Байтов на ячейку в HerbCell (покрытие, высота, зелень, ветошь).</summary>
        public const int HerbCellStride = 4;
        /// <summary>Байтов на ячейку в Canopy (полог деревьев, доля хвойных, кустарники, облиственность).</summary>
        public const int CanopyStride = 4;
        /// <summary>Байтов на ячейку в Surface (снег, влажность поверхности).</summary>
        public const int SurfaceStride = 2;
        /// <summary>Стадия древесного растения неизвестна.</summary>
        public const byte StageUnknown = 255;

        public static float HerbGrams(byte v) { float f = v / 255f; return f * f * HerbFieldMax; }
        public static byte HerbByte(float gramsPerM2) => (byte)Math.Round(Math.Sqrt(Math.Min(1.0, Math.Max(0.0, gramsPerM2 / HerbFieldMax))) * 255);
        public static byte Unit(float v) => (byte)Math.Round(Math.Min(1f, Math.Max(0f, v)) * 255f);
    }

    public enum FloraForm : byte { Herb = 0, Shrub = 1, Tree = 2 }

    public enum FloraLeafHabit : byte { AnnualDieback = 0, Deciduous = 1, Evergreen = 2 }

    /// <summary>Вид каталога для рендера: только то, что нужно для выбора визуального профиля.</summary>
    public sealed class FloraSpeciesInfo
    {
        /// <summary>Номер вида в каталоге симуляции (тот же, что WoodyStore.Species / слоты трав).</summary>
        public int Id;
        /// <summary>Ключ каталога ("birch", "meadow-grass"…). Рендер выбирает профиль по ключу, не по номеру.</summary>
        public string Key;
        public FloraForm Form;
        public FloraLeafHabit Habit;
        /// <summary>Предельные высота и радиус кроны вида, м (для древесных; 0 у трав).</summary>
        public float MaxHeight, MaxCrownRadius;
    }

    public sealed class FloraCatalogInfo
    {
        public FloraSpeciesInfo[] Species = Array.Empty<FloraSpeciesInfo>();
        /// <summary>Номера видов трав в порядке столбцов FieldChunk.Herbs.</summary>
        public int[] HerbOrder = Array.Empty<int>();

        public FloraSpeciesInfo Find(int id)
        {
            foreach (var s in Species) if (s.Id == id) return s;
            return null;
        }
    }

    /// <summary>Сетка мира: эко-ячейки и чанки.</summary>
    public readonly struct FloraGrid : IEquatable<FloraGrid>
    {
        /// <summary>Ячеек по стороне (мир S — 256, M — 512).</summary>
        public readonly int Cells;
        public readonly float CellSize;
        public readonly int ChunkCells;

        public FloraGrid(int cells, float cellSize = FloraContract.CellSize, int chunkCells = FloraContract.ChunkCells)
        {
            Cells = cells;
            CellSize = cellSize;
            ChunkCells = chunkCells;
        }

        public int ChunksPerSide => (Cells + ChunkCells - 1) / ChunkCells;
        public int ChunkCount => ChunksPerSide * ChunksPerSide;
        public int CellCount => Cells * Cells;
        public float WorldSize => Cells * CellSize;
        public float ChunkSize => ChunkCells * CellSize;
        public int CellsPerChunk => ChunkCells * ChunkCells;

        public int CellAt(float x, float z)
        {
            int cx = Clamp((int)Math.Floor(x / CellSize), 0, Cells - 1), cz = Clamp((int)Math.Floor(z / CellSize), 0, Cells - 1);
            return cz * Cells + cx;
        }

        public int ChunkOfCell(int cell)
        {
            int cx = cell % Cells, cz = cell / Cells;
            return cz / ChunkCells * ChunksPerSide + cx / ChunkCells;
        }

        public int ChunkAt(float x, float z) => ChunkOfCell(CellAt(x, z));

        /// <summary>Ячейка мира по чанку и локальному номеру ячейки в нём (−1 — за краем мира).</summary>
        public int CellOfChunk(int chunk, int local)
        {
            int cx = chunk % ChunksPerSide * ChunkCells + local % ChunkCells, cz = chunk / ChunksPerSide * ChunkCells + local / ChunkCells;
            return cx < Cells && cz < Cells ? cz * Cells + cx : -1;
        }

        static int Clamp(int v, int a, int b) => v < a ? a : v > b ? b : v;
        public bool Equals(FloraGrid o) => Cells == o.Cells && CellSize == o.CellSize && ChunkCells == o.ChunkCells;
        public override bool Equals(object obj) => obj is FloraGrid g && Equals(g);
        public override int GetHashCode() => (Cells * 397) ^ ChunkCells ^ CellSize.GetHashCode();
    }

    /// <summary>
    /// Древесное растение (дерево или кустарник) — 32 байта. Значения — как в симуляции: высота и крона — аллометрия
    /// от биомассы вида (FloraMath.WoodyHeight / CrownRadius), облиственность — фенология растения.
    /// </summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct WoodyPlant
    {
        /// <summary>Устойчивый номер растения (EntityId: поколение + индекс). Определяет вариант модели и поворот.</summary>
        public uint Id;
        public float X, Z;
        /// <summary>Высота, м.</summary>
        public float Height;
        /// <summary>Радиус кроны, м.</summary>
        public float CrownRadius;
        /// <summary>Биомасса, кг сухого вещества (необязательно; 0 — неизвестно).</summary>
        public float Biomass;
        public ushort Species;
        /// <summary>Облиственность 0..255 (0 — голые ветви, 255 — полная крона).</summary>
        public byte Leaf;
        /// <summary>Здоровье 0..255.</summary>
        public byte Health;
        /// <summary>Стадия: 0 всход, 1 подрост, 2 взрослое, 3 старое (WoodyStage), 255 — неизвестно.</summary>
        public byte Stage;
        public byte Flags;
        public ushort Reserved;
    }

    /// <summary>Древесные растения одного чанка. Растения внутри чанка упорядочены по Id (устойчивая контрольная сумма).</summary>
    public sealed class WoodyChunk
    {
        public int Chunk;
        public WoodyPlant[] Plants = Array.Empty<WoodyPlant>();
        public int Count;
        /// <summary>FNV-1a по квантованным значениям (FloraChecksum.Woody). Пустой чанк — FloraChecksum.Empty.</summary>
        public uint Checksum;
    }

    /// <summary>
    /// Поля одного чанка (ChunkCells² ячеек, построчно по z, затем x; ячейки за краем мира — нули).
    /// Herbs — плотности видов трав (столбцы в порядке FloraCatalogInfo.HerbOrder; байт → г/м² через FloraContract.HerbGrams).
    /// HerbCell — [покрытие травостоем 0..1, высота травостоя в см (0..255), зелень 0..1 (1 — вегетирует, 0 — сухая/покой),
    ///            доля ветоши (сухой стоящей травы) 0..1].
    /// Canopy — [покрытие кронами деревьев 0..1, доля хвойных в нём 0..1, покрытие кустарниками 0..1, средняя облиственность 0..1].
    /// Surface — [снег 0..1 (0 — нет, 1 — сплошной покров ≥ 30 см), влажность поверхности 0..1] — необязательно (null — нет).
    /// </summary>
    public sealed class FieldChunk
    {
        public int Chunk;
        public byte[] Herbs;
        public byte[] HerbCell;
        public byte[] Canopy;
        public byte[] Surface;
        public uint Checksum;
    }

    public enum FloraUpdateKind : byte { Full = 0, Incremental = 1 }

    /// <summary>
    /// Пакет изменений снимка. Full — состояние целиком: все непустые чанки (отсутствующий чанк — пустой).
    /// Incremental — только чанки, изменившиеся после BaseVersion; пустой WoodyChunk (Count 0) — все растения чанка исчезли.
    /// После применения рендер сверяет свою свёртку контрольных сумм с WoodyStateChecksum / FieldStateChecksum.
    /// </summary>
    public sealed class FloraUpdate
    {
        public FloraUpdateKind Kind;
        /// <summary>Идентификатор мира: при смене (новый мир, загрузка) рендер сбрасывает всё.</summary>
        public long WorldId;
        /// <summary>Версия снимка после применения пакета (монотонно растёт).</summary>
        public long Version;
        /// <summary>Для Incremental — версия, к которой пакет применяется.</summary>
        public long BaseVersion;
        /// <summary>Такт симуляции, на котором снят снимок (только для журнала и отладки).</summary>
        public long SimTick;
        public FloraGrid Grid;
        public WoodyChunk[] Woody = Array.Empty<WoodyChunk>();
        public FieldChunk[] Fields = Array.Empty<FieldChunk>();
        public uint WoodyStateChecksum, FieldStateChecksum;
        /// <summary>Всего древесных в мире после применения.</summary>
        public int WoodyTotal;
    }

    /// <summary>
    /// Внешние условия для отрисовки (каждый кадр). Рендер их не вычисляет: время года, ветер, снег и влажность
    /// приходят из симуляции (календарь, погода, поле снега) или из стенда.
    /// </summary>
    public struct FloraEnvironment
    {
        /// <summary>Доля года 0..1: 0 — начало весны, 0,25 — лета, 0,5 — осени, 0,75 — зимы (календарь симуляции).</summary>
        public float YearPhase;
        /// <summary>Доля суток 0..1 (0 — полночь). Рендеру растительности не нужна; передаётся для освещения стенда.</summary>
        public float DayPhase;
        /// <summary>Направление, куда дует ветер, радианы в плоскости XZ (0 — +x, π/2 — +z).</summary>
        public float WindDirection;
        /// <summary>Скорость ветра, м/с.</summary>
        public float WindSpeed;
        /// <summary>Порывистость 0..1.</summary>
        public float Gustiness;
        /// <summary>Снег 0..1 — общий, если в чанках нет поля Surface (иначе — множитель к полю).</summary>
        public float Snow;
        /// <summary>Намокание растений и поверхности 0..1 (дождь, роса).</summary>
        public float Wetness;
        /// <summary>Засушливость 0..1 — визуальная «выгоревшая» трава, если поле зелени не передаётся.</summary>
        public float Dryness;

        public static FloraEnvironment Default => new() { YearPhase = 0.35f, DayPhase = 0.5f, WindDirection = 0.6f, WindSpeed = 3.5f, Gustiness = 0.4f };
    }
}
