// Динамическое состояние среды (src/sim/env/envState.ts) и входы будущей флоры.
// Всё, что меняется во времени и должно сохраняться; статика — в Geo.
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Env
{
    public sealed class WeatherState
    {
        public const int MaxCells = 24;
        /// <summary>Поля погодной ячейки: x, z, радиус (м), интенсивность, возраст (шаги), срок жизни (шаги).</summary>
        public const int Stride = 6;

        public readonly float[] Cells = new float[MaxCells * Stride];
        public readonly int Chunks;
        public readonly float[] ChunkRate, ChunkCloud, ChunkAccum;
        /// <summary>[0] — норма осадков (средний слой по суше, мм), [1] — фактически выпавшее.</summary>
        public readonly double[] Balance = new double[2];

        public WeatherState(int chunks)
        {
            Chunks = chunks;
            ChunkRate = new float[chunks * chunks];
            ChunkCloud = new float[chunks * chunks];
            ChunkAccum = new float[chunks * chunks];
        }
    }

    public sealed class EnvState
    {
        /// <summary>Влага корнеобитаемого слоя, мм.</summary>
        public float[] Moisture;
        /// <summary>Снег, мм водного эквивалента.</summary>
        public float[] Snow;
        /// <summary>Индекс зелени 0..1. Пока флора не перенесена — начальное значение (0.25 на суше).</summary>
        public float[] Greenness;
        /// <summary>Текущий расход воды, м³/с.</summary>
        public float[] Discharge;
        /// <summary>Сток ячейки за последний час, мм.</summary>
        public float[] Runoff;
        /// <summary>Накопленный водный баланс, мм·ячейка: [0] осадки, [1] испарение, [2] сток в море, [3] сток из ячеек.</summary>
        public readonly double[] WaterTotals = new double[4];
        public WeatherState Weather;
        public int LastHourStep = -1;
    }

    /// <summary>
    /// Накопители условий для растений (часть FloraState в TS): их пишет часовой шаг воды, читает и обнуляет
    /// суточный шаг флоры. Флора в Stage 1 не перенесена — накопители только копятся (как в эталоне TS).
    /// </summary>
    public sealed class FloraInputs
    {
        public float[] AccT, AccW, AccRunoff, AccMinT;
        public byte[] AccHours;
        public readonly double[] Capillary = new double[1];

        public FloraInputs(int count)
        {
            AccT = new float[count];
            AccW = new float[count];
            AccRunoff = new float[count];
            AccMinT = new float[count];
            for (int i = 0; i < count; i++) AccMinT[i] = 99;
            AccHours = new byte[count];
        }
    }

    /// <summary>Величины, однозначно выводимые из статики мира (не сохраняются).</summary>
    public sealed class WorldDerived
    {
        public float[] PFactor;
        public double LandMeanPrecip;
        public int LandCells;
        public float[] Capacity;
        public float[] DrainHour;

        public static WorldDerived From(Geo geo)
        {
            int count = geo.N * geo.N;
            double sum = 0;
            int land = 0;
            for (int i = 0; i < count; i++)
            {
                if (geo.WaterKind[i] == WaterKind.Sea) continue;
                sum += geo.Precip[i];
                land++;
            }
            double mean = land > 0 ? sum / land : 1;
            var d = new WorldDerived { PFactor = new float[count], LandMeanPrecip = mean, LandCells = land, Capacity = new float[count], DrainHour = new float[count] };
            for (int i = 0; i < count; i++)
            {
                d.PFactor[i] = (float)(geo.Precip[i] / mean);
                var soil = Soils.All[geo.Soil[i]];
                d.Capacity[i] = (float)soil.FieldCapacityMm;
                d.DrainHour[i] = (float)(soil.DrainagePerDay / 24);
            }
            return d;
        }
    }

    public static class EnvFactory
    {
        /// <summary>Типичная относительная влага почвы по годовой норме осадков (0..1).</summary>
        public static double ClimateMoisture(double precipMm)
        {
            double w = 0.15 + 0.75 * (precipMm - 200) / 700;
            return w < 0.1 ? 0.1 : w > 0.95 ? 0.95 : w;
        }

        public static EnvState Create(Geo geo, int worldSize)
        {
            int count = geo.N * geo.N;
            var moisture = new float[count];
            var greenness = new float[count];
            for (int i = 0; i < count; i++)
            {
                if (geo.WaterKind[i] != WaterKind.None) continue;
                double cap = Soils.All[geo.Soil[i]].FieldCapacityMm;
                moisture[i] = (float)(cap * ClimateMoisture(geo.Precip[i]));
                greenness[i] = 0.25f;
            }
            int chunks = worldSize / WorldConfig.ChunkSize;
            return new EnvState
            {
                Moisture = moisture,
                Snow = new float[count],
                Greenness = greenness,
                Discharge = new float[count],
                Runoff = new float[count],
                Weather = new WeatherState(chunks),
            };
        }
    }
}
