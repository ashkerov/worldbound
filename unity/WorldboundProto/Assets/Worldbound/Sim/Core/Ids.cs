// Идентификатор сущности (src/shared/ids.ts): 32 бита = тип (4) | поколение (8) | индекс (20).
// Семантика 32-битных операций JS: поколение и тип берутся по маске (256 → 0, −1 → 255), результат — беззнаковый.
using System;

namespace Worldbound.Sim
{
    public static class EntityKind
    {
        public const int None = 0, Tree = 1, Animal = 2, Person = 3, Building = 4, TestAgent = 15;
    }

    public static class EntityId
    {
        public const int MaxIndex = (1 << 20) - 1;
        public const int MaxGeneration = (1 << 8) - 1;

        public static uint Make(int kind, int generation, int index)
        {
            if (index < 0 || index > MaxIndex) throw new ArgumentOutOfRangeException(nameof(index), $"Индекс сущности вне диапазона: {index}");
            return unchecked(((uint)(kind & 0xf) << 28) | ((uint)(generation & 0xff) << 20) | (uint)index);
        }

        public static int Kind(uint id) => (int)((id >> 28) & 0xf);
        public static int Generation(uint id) => (int)((id >> 20) & 0xff);
        public static int Index(uint id) => (int)(id & MaxIndex);

        /// <summary>Ключ для Hash.CounterRandom: как JS-аргумент `id` после `| 0` в hash4.</summary>
        public static int Key(uint id) => unchecked((int)id);
    }
}
