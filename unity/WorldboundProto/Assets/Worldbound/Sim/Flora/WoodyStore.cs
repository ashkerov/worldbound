// Хранилище древесных растений (src/sim/flora/woodyStore.ts): постоянные индивиды в столбцах (SoA).
// Свободные слоты переиспользуются стеком LIFO (как push/pop массива в TS) — от этого зависят индексы новых
// растений, порядок их обработки и ключи случайности. Поколение в идентификаторе защищает от ссылок на погибшие.
using System;

namespace Worldbound.Sim.Flora
{
    public static class WoodyStage
    {
        public const byte Seedling = 0, Sapling = 1, Mature = 2, Old = 3;
        public static readonly string[] Names = { "всход", "подрост", "взрослое", "старое" };
    }

    public sealed class WoodyStore
    {
        public readonly int Capacity;
        public readonly float[] X, Z;
        public readonly byte[] Species;
        /// <summary>Возраст, игровые годы.</summary>
        public readonly float[] Age;
        /// <summary>Сухая биомасса, кг (древесина + листва).</summary>
        public readonly float[] Biomass;
        /// <summary>Облиственность 0..1.</summary>
        public readonly float[] Leaf;
        public readonly float[] Health;
        public readonly byte[] Stage;
        /// <summary>Скользящие индексы стресса 0..1: вода и свет.</summary>
        public readonly float[] StressW, StressL;
        /// <summary>Индекс эко-ячейки под растением (кэш по координатам; в сохранение не входит).</summary>
        public readonly int[] Cell;
        public readonly byte[] Alive;
        public readonly byte[] Generation;
        public int HighWater;
        public int Count;
        readonly int[] free;
        int freeCount;

        public WoodyStore(int capacity)
        {
            if (capacity > EntityId.MaxIndex + 1) throw new ArgumentOutOfRangeException(nameof(capacity), "Ёмкость хранилища превышает адресуемую идентификатором");
            Capacity = capacity;
            X = new float[capacity];
            Z = new float[capacity];
            Species = new byte[capacity];
            Age = new float[capacity];
            Biomass = new float[capacity];
            Leaf = new float[capacity];
            Health = new float[capacity];
            Stage = new byte[capacity];
            StressW = new float[capacity];
            StressL = new float[capacity];
            Cell = new int[capacity];
            Alive = new byte[capacity];
            Generation = new byte[capacity];
            free = new int[capacity];
        }

        public int FreeCount => freeCount;

        /// <summary>Индекс нового растения или −1, если хранилище заполнено.</summary>
        public int Spawn(int species, double x, double z, int cell, double biomass, double age)
        {
            int i;
            if (freeCount > 0) i = free[--freeCount];
            else if (HighWater < Capacity) i = HighWater++;
            else return -1;
            X[i] = (float)x;
            Z[i] = (float)z;
            Species[i] = (byte)species;
            Age[i] = (float)age;
            Biomass[i] = (float)biomass;
            Leaf[i] = 0;
            Health[i] = 1;
            Stage[i] = WoodyStage.Seedling;
            StressW[i] = 0;
            StressL[i] = 0;
            Cell[i] = cell;
            Alive[i] = 1;
            Count++;
            return i;
        }

        public void Remove(int i)
        {
            if (Alive[i] != 1) return;
            Alive[i] = 0;
            Biomass[i] = 0;
            Generation[i] = (byte)((Generation[i] + 1) & EntityId.MaxGeneration);
            free[freeCount++] = i;
            Count--;
        }

        public uint IdOf(int i) => EntityId.Make(EntityKind.Tree, Generation[i], i);

        /// <summary>Свободные слоты в порядке стека (как freeSlots() в TS — копия массива).</summary>
        public int[] FreeSlots()
        {
            var a = new int[freeCount];
            Array.Copy(free, a, freeCount);
            return a;
        }

        /// <summary>Восстановление после загрузки: столбцы уже записаны, задаются граница, число и стек свободных.</summary>
        public void Restore(int highWater, int count, int[] freeSlots)
        {
            if (highWater > Capacity || count > highWater || highWater < 0 || count < 0 || freeSlots.Length > Capacity) throw new InvalidOperationException("Сохранение растений повреждено");
            HighWater = highWater;
            Count = count;
            Array.Copy(freeSlots, free, freeSlots.Length);
            freeCount = freeSlots.Length;
        }
    }
}
