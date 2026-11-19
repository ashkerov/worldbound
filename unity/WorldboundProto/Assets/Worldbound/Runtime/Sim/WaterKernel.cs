// Prototype C: перенос часового шага воды TypeScript-ядра (src/sim/env/water.ts) на C#.
// Две реализации одного и того же: обычный C# (управляемые массивы) и задание Jobs, скомпилированное Burst.
// Арифметика — как в TS: вычисления в double, хранение в float (Float32Array ↔ float[]), тот же порядок операций,
// поэтому результат должен совпадать побитно. Входы ячейки (осадки, облачность, температура) приходят из эталона.

using System;
using Unity.Burst;
using Unity.Collections;
using Unity.Jobs;

namespace Worldbound.Sim
{
    /// <summary>Хеш и счётчиковый генератор (src/shared/rng.ts): mix32 — финализатор murmur3.</summary>
    public static class WbHash
    {
        public static uint Mix32(uint h)
        {
            h = (h ^ (h >> 16)) * 0x85ebca6bu;
            h = (h ^ (h >> 13)) * 0xc2b2ae35u;
            return h ^ (h >> 16);
        }

        public static uint Hash4(int a, int b, int c, int d)
        {
            uint h = Mix32((uint)a ^ 0x9e3779b9u);
            h = Mix32(h ^ (uint)(b * unchecked((int)0x85ebca6b)));
            h = Mix32(h ^ (uint)(c * unchecked((int)0xc2b2ae35)));
            h = Mix32(h ^ (uint)(d * 0x27d4eb2f));
            return h;
        }

        public static double CounterRandom(int seed, int system, int key, int tick) => Hash4(seed, system, key, tick) * (1.0 / 4294967296.0);
    }

    /// <summary>Неизменные данные мира для шага воды.</summary>
    public sealed class WaterStatic
    {
        public int Count;
        public double CellArea;
        public byte[] Kind;        // 0 суша, 1 река, 2 озеро, 3 море
        public float[] Capacity;
        public float[] DrainHour;
        public float[] WaterDist;
        public int[] Receiver;
        public int[] UpstreamOrder;
    }

    /// <summary>Изменяемое состояние (то, что шаг воды читает и пишет).</summary>
    public sealed class WaterState
    {
        public float[] Moisture, Snow, Runoff, Discharge, AccT, AccW, AccRunoff, AccMinT;
        public byte[] AccHours;
        public double PrecipTotal, Evaporated, ToSea, LocalTotal, Capillary;
    }

    public static class WaterKernel
    {
        public const double SnowThreshold = 0.5;
        public const double CapillaryRange = 40;
        const double CapillaryRate = 0.03;
        const double PetPerDegree = 0.0084;

        /// <summary>Один час: managed-версия, прямой перевод TS построчно.</summary>
        public static void Step(WaterStatic s, WaterState st, ReadOnlySpan<double> precipIn, ReadOnlySpan<double> cloudIn, ReadOnlySpan<double> tIn, ReadOnlySpan<float> greenness, double compression, double meltPerDegree, double sunFactor)
        {
            int count = s.Count;
            double evaporated = 0, precipTotal = 0, localTotal = 0, capillary = 0;
            for (int i = 0; i < count; i++)
            {
                byte kind = s.Kind[i];
                if (kind == 3) { st.Runoff[i] = 0; continue; }
                double cloud = cloudIn[i];
                double precip = precipIn[i];
                precipTotal += precip;
                if (kind != 0) { st.Runoff[i] = (float)precip; localTotal += precip; continue; }
                double t = tIn[i];
                double snow = st.Snow[i];
                double input = 0;
                if (t < SnowThreshold) snow += precip; else input += precip;
                if (t > 0 && snow > 0)
                {
                    double melt = Math.Min(snow, meltPerDegree * t);
                    snow -= melt;
                    input += melt;
                }
                double cap = s.Capacity[i];
                double m = st.Moisture[i] + input;
                double outv = 0;
                if (m > cap) { outv = m - cap; m = cap; }
                double wd = s.WaterDist[i];
                if (wd < CapillaryRange && m < cap)
                {
                    double add = Math.Min(cap - m, cap * CapillaryRate * (1 - wd / CapillaryRange));
                    m += add;
                    capillary += add;
                }
                double cover = greenness[i];
                double pet = t > -4 ? (t + 4) * PetPerDegree * compression * sunFactor * (1 - 0.5 * cloud) * (0.5 + 0.5 * (cover > 1 ? 1 : cover)) : 0;
                double et = Math.Min(m, pet * (m / cap) * (snow > 5 ? 0.2 : 1));
                m -= et;
                double drain = s.DrainHour[i] * m * (m / cap);
                m -= drain;
                outv += drain;
                st.Moisture[i] = (float)m;
                st.Snow[i] = (float)snow;
                st.Runoff[i] = (float)outv;
                evaporated += et;
                localTotal += outv;
                st.AccT[i] = (float)(st.AccT[i] + t);
                st.AccW[i] = (float)(st.AccW[i] + m / cap);
                st.AccRunoff[i] = (float)(st.AccRunoff[i] + outv);
                if (t < st.AccMinT[i]) st.AccMinT[i] = (float)t;
                if (st.AccHours[i] < 255) st.AccHours[i]++;
            }
            st.Capillary += capillary;
            Route(s, st.Runoff, st.Discharge, out double toSea);
            st.PrecipTotal += precipTotal;
            st.Evaporated += evaporated;
            double toM3s = s.CellArea / 1000 / 3600;
            st.ToSea += toSea / toM3s;
            st.LocalTotal += localTotal;
        }

        /// <summary>Сток по дереву: от истоков к устьям (порядок upstreamOrder).</summary>
        static void Route(WaterStatic s, float[] runoff, float[] discharge, out double toSea)
        {
            Array.Clear(discharge, 0, discharge.Length);
            toSea = 0;
            double toM3s = s.CellArea / 1000 / 3600;
            for (int k = 0; k < s.Count; k++)
            {
                int i = s.UpstreamOrder[k];
                if (s.Kind[i] == 3) continue;
                double q = discharge[i] + runoff[i] * toM3s;
                discharge[i] = (float)q;
                int r = s.Receiver[i];
                if (r < 0 || s.Kind[r] == 3) toSea += q;
                else discharge[r] = (float)(discharge[r] + q);
            }
        }
    }

    /// <summary>
    /// Та же логика заданием Jobs + Burst. FloatMode.Strict и FloatPrecision.Standard — без «быстрой» математики,
    /// которая переставляет операции: иначе результат перестаёт совпадать с TS побитно.
    /// Ячейки независимы → IJobParallelFor; суммы — по ячейкам в массив, потом в том же порядке, что в TS.
    /// </summary>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard, CompileSynchronously = true)]
    public struct WaterCellJob : IJobParallelFor
    {
        [ReadOnly] public NativeArray<byte> Kind;
        [ReadOnly] public NativeArray<float> Capacity, DrainHour, WaterDist, Greenness;
        [ReadOnly] public NativeArray<double> Precip, Cloud, T;
        public NativeArray<float> Moisture, Snow, Runoff, AccT, AccW, AccRunoff, AccMinT;
        public NativeArray<byte> AccHours;
        /// <summary>По ячейке: [осадки, испарение, сток в местный итог, подпитка].</summary>
        [NativeDisableParallelForRestriction] public NativeArray<double> Sums;
        public double Compression, MeltPerDegree, SunFactor;

        public void Execute(int i)
        {
            int o = i * 4;
            byte kind = Kind[i];
            if (kind == 3) { Runoff[i] = 0; Sums[o] = 0; Sums[o + 1] = 0; Sums[o + 2] = 0; Sums[o + 3] = 0; return; }
            double cloud = Cloud[i];
            double precip = Precip[i];
            Sums[o] = precip;
            if (kind != 0) { Runoff[i] = (float)precip; Sums[o + 1] = 0; Sums[o + 2] = precip; Sums[o + 3] = 0; return; }
            double t = T[i];
            double snow = Snow[i];
            double input = 0;
            if (t < WaterKernel.SnowThreshold) snow += precip; else input += precip;
            if (t > 0 && snow > 0)
            {
                double melt = Math.Min(snow, MeltPerDegree * t);
                snow -= melt;
                input += melt;
            }
            double cap = Capacity[i];
            double m = Moisture[i] + input;
            double outv = 0;
            if (m > cap) { outv = m - cap; m = cap; }
            double wd = WaterDist[i];
            double add = 0;
            if (wd < WaterKernel.CapillaryRange && m < cap)
            {
                add = Math.Min(cap - m, cap * 0.03 * (1 - wd / WaterKernel.CapillaryRange));
                m += add;
            }
            double cover = Greenness[i];
            double pet = t > -4 ? (t + 4) * 0.0084 * Compression * SunFactor * (1 - 0.5 * cloud) * (0.5 + 0.5 * (cover > 1 ? 1 : cover)) : 0;
            double et = Math.Min(m, pet * (m / cap) * (snow > 5 ? 0.2 : 1));
            m -= et;
            double drain = DrainHour[i] * m * (m / cap);
            m -= drain;
            outv += drain;
            Moisture[i] = (float)m;
            Snow[i] = (float)snow;
            Runoff[i] = (float)outv;
            AccT[i] = (float)(AccT[i] + t);
            AccW[i] = (float)(AccW[i] + m / cap);
            AccRunoff[i] = (float)(AccRunoff[i] + outv);
            if (t < AccMinT[i]) AccMinT[i] = (float)t;
            if (AccHours[i] < 255) AccHours[i] = (byte)(AccHours[i] + 1);
            Sums[o + 1] = et;
            Sums[o + 2] = outv;
            Sums[o + 3] = add;
        }
    }

    /// <summary>Маршрутизация стока — последовательная (порядок важен), одним заданием Burst.</summary>
    [BurstCompile(FloatMode = FloatMode.Strict, FloatPrecision = FloatPrecision.Standard, CompileSynchronously = true)]
    public struct WaterRouteJob : IJob
    {
        [ReadOnly] public NativeArray<byte> Kind;
        [ReadOnly] public NativeArray<int> Receiver, Order;
        [ReadOnly] public NativeArray<float> Runoff;
        public NativeArray<float> Discharge;
        [ReadOnly] public NativeArray<double> Sums;
        /// <summary>[осадки, испарение, в море (м³/с), местный итог, подпитка].</summary>
        public NativeArray<double> Totals;
        public double ToM3s;

        public void Execute()
        {
            // Суммы по ячейкам — в порядке индексов, как в TS-цикле: тот же результат сложения double.
            double precip = 0, evap = 0, local = 0, capillary = 0;
            for (int i = 0; i < Kind.Length; i++)
            {
                int o = i * 4;
                precip += Sums[o];
                evap += Sums[o + 1];
                local += Sums[o + 2];
                capillary += Sums[o + 3];
            }
            for (int i = 0; i < Discharge.Length; i++) Discharge[i] = 0;
            double toSea = 0;
            for (int k = 0; k < Order.Length; k++)
            {
                int i = Order[k];
                if (Kind[i] == 3) continue;
                double q = Discharge[i] + Runoff[i] * ToM3s;
                Discharge[i] = (float)q;
                int r = Receiver[i];
                if (r < 0 || Kind[r] == 3) toSea += q;
                else Discharge[r] = (float)(Discharge[r] + q);
            }
            Totals[0] += precip;
            Totals[1] += evap;
            Totals[2] += toSea / ToM3s;
            Totals[3] += local;
            Totals[4] += capillary;
        }
    }
}
