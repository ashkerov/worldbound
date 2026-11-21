// Семантика чисел JavaScript, нужная для побитной совместимости с TS-ядром (эталон).
// В TS: все вычисления — double; Float32Array хранит float (округление к ближайшему при записи);
// Math.round округляет половины вверх (к +∞), а не к чётному, как Math.Round в .NET.

using System;

namespace Worldbound.Sim
{
    public static class JsMath
    {
        /// <summary>Math.round из JS: ближайшее целое, половины — к +∞ (Math.round(−2.5) = −2).</summary>
        public static double Round(double x)
        {
            double r = Math.Floor(x);
            return x - r >= 0.5 ? r + 1 : r;
        }

        /// <summary>ToInt32 из JS (x | 0) для конечных значений в пределах ±2⁵³.</summary>
        public static int ToInt32(double x) => unchecked((int)(long)x);

        public static int Imul(int a, int b) => unchecked(a * b);
    }

    /// <summary>
    /// Детерминированная математика (src/shared/dmath.ts): только + − × /, floor и sqrt — побитно одинаково
    /// в любом движке JS и в .NET. Math.sin/cos/exp/pow в ядре не применяются (ARCHITECTURE.md, раздел 6.4).
    /// </summary>
    public static class DMath
    {
        public const double PI = 3.141592653589793;
        public const double TWO_PI = 6.283185307179586;
        const double HALF_PI = 1.5707963267948966;

        public static double DSin(double x)
        {
            double r = x - TWO_PI * Math.Floor((x + PI) / TWO_PI);
            if (r > HALF_PI) r = PI - r;
            else if (r < -HALF_PI) r = -PI - r;
            double r2 = r * r;
            return r * (1 + r2 * (-1.0 / 6 + r2 * (1.0 / 120 + r2 * (-1.0 / 5040 + r2 * (1.0 / 362880 + r2 * (-1.0 / 39916800 + r2 * (1.0 / 6227020800)))))));
        }

        public static double DCos(double x) => DSin(x + HALF_PI);
        public static double Clamp(double x, double min, double max) => x < min ? min : x > max ? max : x;
        public static double Clamp01(double x) => x < 0 ? 0 : x > 1 ? 1 : x;
        public static double Lerp(double a, double b, double t) => a + (b - a) * t;

        public static double Smoothstep(double e0, double e1, double x)
        {
            double t = Clamp01((x - e0) / (e1 - e0));
            return t * t * (3 - 2 * t);
        }

        public static double Decay(double x) => 1 / (1 + x + 0.5 * x * x);
    }
}
