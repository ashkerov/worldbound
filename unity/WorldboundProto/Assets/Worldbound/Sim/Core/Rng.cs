// Генераторы случайных чисел (src/shared/rng.ts): счётчиковый (хеш аргументов) и потоковый sfc32.
namespace Worldbound.Sim
{
    public static class Hash
    {
        public static uint Mix32(uint h)
        {
            unchecked
            {
                h = (h ^ (h >> 16)) * 0x85ebca6bu;
                h = (h ^ (h >> 13)) * 0xc2b2ae35u;
                return h ^ (h >> 16);
            }
        }

        public static uint Hash4(int a, int b, int c, int d)
        {
            unchecked
            {
                uint h = Mix32((uint)a ^ 0x9e3779b9u);
                h = Mix32(h ^ (uint)(b * (int)0x85ebca6b));
                h = Mix32(h ^ (uint)(c * (int)0xc2b2ae35));
                h = Mix32(h ^ (uint)(d * 0x27d4eb2f));
                return h;
            }
        }

        const double Inv32 = 1.0 / 4294967296.0;

        /// <summary>Значение в [0, 1), зависящее только от аргументов (не от порядка обхода).</summary>
        public static double CounterRandom(int seed, int system, int key, int tick) => Hash4(seed, system, key, tick) * Inv32;

        /// <summary>Строковый seed → 32-битное число (FNV-1a по кодам UTF-16, как charCodeAt).</summary>
        public static uint SeedFromString(string text)
        {
            unchecked
            {
                int h = (int)0x811c9dc5;
                foreach (char ch in text) h = (h ^ ch) * 0x01000193;
                return (uint)h;
            }
        }
    }

    /// <summary>Потоковый генератор sfc32 (генерация мира).</summary>
    public sealed class Rng
    {
        uint a, b, c, d;

        public Rng(uint seed, int stream = 0)
        {
            a = Hash.Hash4(unchecked((int)seed), stream, 1, 0);
            b = Hash.Hash4(unchecked((int)seed), stream, 2, 0);
            c = Hash.Hash4(unchecked((int)seed), stream, 3, 0);
            d = 1;
            for (int i = 0; i < 12; i++) NextU32();
        }

        public uint NextU32()
        {
            unchecked
            {
                uint t = a + b + d;
                d = d + 1;
                a = b ^ (b >> 9);
                b = c + (c << 3);
                c = (c << 21) | (c >> 11);
                c = c + t;
                return t;
            }
        }

        public double Next() => NextU32() * (1.0 / 4294967296.0);
        public double Range(double min, double max) => min + (max - min) * Next();
        public int Int(int n) => (int)System.Math.Floor(Next() * n);
    }
}
