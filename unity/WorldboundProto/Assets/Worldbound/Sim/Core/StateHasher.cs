// Хеш состояния (src/sim/core/hash.ts): два 32-битных FNV-подобных потока по байтам массивов.
using System;
using System.Runtime.InteropServices;

namespace Worldbound.Sim
{
    public sealed class StateHasher
    {
        int h1 = unchecked((int)0x811c9dc5);
        int h2 = unchecked((int)0x9e3779b9);

        public StateHasher AddInt(int v)
        {
            unchecked
            {
                h1 = (h1 ^ v) * 0x01000193;
                h2 = ((h2 ^ v) * (int)0x85ebca6b) ^ (int)((uint)h2 >> 15);
            }
            return this;
        }

        public StateHasher AddArray<T>(T[] array, int length = -1) where T : struct
        {
            if (length < 0) length = array.Length;
            var bytes = MemoryMarshal.AsBytes(new ReadOnlySpan<T>(array, 0, length));
            int a = h1, b = h2;
            unchecked
            {
                foreach (byte x in bytes)
                {
                    a = (a ^ x) * 0x01000193;
                    b = ((b ^ x) * (int)0x85ebca6b) ^ (int)((uint)b >> 15);
                }
            }
            h1 = a;
            h2 = b;
            return AddInt(length);
        }

        public string Digest() => ((uint)h1).ToString("x8") + ((uint)h2).ToString("x8");

        /// <summary>FNV-1a по байтам массива — для сверки отдельных массивов с эталоном TS.</summary>
        public static string Fnv<T>(T[] array) where T : struct
        {
            uint h = 2166136261;
            foreach (byte x in MemoryMarshal.AsBytes(new ReadOnlySpan<T>(array))) h = unchecked((h ^ x) * 16777619);
            return h.ToString("x8");
        }
    }
}
