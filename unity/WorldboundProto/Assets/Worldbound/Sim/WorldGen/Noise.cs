// Детерминированный градиентный шум (src/sim/worldgen/noise.ts): таблица перестановок из seed,
// дальше только + − × и floor — побитно как в TS.
using System;
using System.Collections.Generic;

namespace Worldbound.Sim.WorldGen
{
    static class Grad
    {
        public static readonly double[] GX = { 1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834, 0, 0.3826834, 0.7071068, 0.9238795 };
        public static readonly double[] GY = { 0, 0.3826834, 0.7071068, 0.9238795, 1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834 };
        public static double Fade(double t) => t * t * t * (t * (t * 6 - 15) + 10);
    }

    public sealed class Noise2
    {
        const int Size = 1024, Mask = Size - 1;
        readonly ushort[] perm = new ushort[Size * 2];

        public Noise2(uint seed, int layer)
        {
            var rng = new Rng(seed, 0x51ed + layer);
            var p = new ushort[Size];
            for (int i = 0; i < Size; i++) p[i] = (ushort)i;
            for (int i = Size - 1; i > 0; i--)
            {
                int j = rng.Int(i + 1);
                (p[i], p[j]) = (p[j], p[i]);
            }
            for (int i = 0; i < Size * 2; i++) perm[i] = p[i & Mask];
        }

        public double At(double x, double z)
        {
            double fx0 = Math.Floor(x), fz0 = Math.Floor(z);
            double fx = x - fx0, fz = z - fz0;
            int ix = JsMath.ToInt32(fx0) & Mask, iz = JsMath.ToInt32(fz0) & Mask;
            int a = perm[ix], b = perm[ix + 1];
            int g00 = perm[a + iz] & 15, g10 = perm[b + iz] & 15, g01 = perm[a + iz + 1] & 15, g11 = perm[b + iz + 1] & 15;
            double u = Grad.Fade(fx), v = Grad.Fade(fz);
            var GX = Grad.GX;
            var GY = Grad.GY;
            double n00 = GX[g00] * fx + GY[g00] * fz;
            double n10 = GX[g10] * (fx - 1) + GY[g10] * fz;
            double n01 = GX[g01] * fx + GY[g01] * (fz - 1);
            double n11 = GX[g11] * (fx - 1) + GY[g11] * (fz - 1);
            double ab = n00 + (n10 - n00) * u;
            double cd = n01 + (n11 - n01) * u;
            return ab + (cd - ab) * v;
        }
    }

    public sealed class Fbm
    {
        readonly List<Noise2> layers = new();
        readonly double norm, gain;
        readonly int octaves;

        public Fbm(uint seed, int layer, int octaves, double gain = 0.5)
        {
            this.octaves = octaves;
            this.gain = gain;
            double nrm = 0, amp = 1;
            for (int o = 0; o < octaves; o++)
            {
                layers.Add(new Noise2(seed, layer * 31 + o));
                nrm += amp;
                amp *= gain;
            }
            norm = nrm;
        }

        public double At(double x, double z)
        {
            double sum = 0, amp = 1, fx = x, fz = z;
            for (int o = 0; o < octaves; o++)
            {
                sum += layers[o].At(fx, fz) * amp;
                amp *= gain;
                double nx = fx * 1.6 + fz * 1.2;
                double nz = -fx * 1.2 + fz * 1.6;
                fx = nx + 17.3;
                fz = nz - 9.1;
            }
            return sum / norm * 1.45;
        }
    }

    public sealed class Ridged
    {
        readonly List<Noise2> layers = new();
        readonly int octaves;

        public Ridged(uint seed, int layer, int octaves)
        {
            this.octaves = octaves;
            for (int o = 0; o < octaves; o++) layers.Add(new Noise2(seed, layer * 37 + o + 5000));
        }

        public double At(double x, double z)
        {
            double sum = 0, amp = 0.5, weight = 1, norm = 0, fx = x, fz = z;
            for (int o = 0; o < octaves; o++)
            {
                double n = layers[o].At(fx, fz) * 1.4;
                n = 1 - (n < 0 ? -n : n);
                n *= n;
                n *= weight;
                weight = n * 2 > 1 ? 1 : n * 2;
                sum += n * amp;
                norm += amp;
                amp *= 0.5;
                double nx = fx * 1.6 + fz * 1.2;
                double nz = -fx * 1.2 + fz * 1.6;
                fx = nx + 5.7;
                fz = nz + 11.9;
            }
            return sum / norm;
        }
    }

    public static class HashNoise
    {
        public static double At(uint seed, int layer, double x, double z)
        {
            double ixd = Math.Floor(x), izd = Math.Floor(z);
            double fx = x - ixd, fz = z - izd;
            int ix = JsMath.ToInt32(ixd), iz = JsMath.ToInt32(izd);
            double G(int cx, int cz, double dx, double dz)
            {
                int h = (int)(Hash.Hash4(unchecked((int)seed), layer, cx, cz) & 15);
                return Grad.GX[h] * dx + Grad.GY[h] * dz;
            }
            double u = Grad.Fade(fx), v = Grad.Fade(fz);
            double ab = G(ix, iz, fx, fz) + (G(ix + 1, iz, fx - 1, fz) - G(ix, iz, fx, fz)) * u;
            double cd = G(ix, iz + 1, fx, fz - 1) + (G(ix + 1, iz + 1, fx - 1, fz - 1) - G(ix, iz + 1, fx, fz - 1)) * u;
            return ab + (cd - ab) * v;
        }
    }
}
