// Отклики вида на условия (src/sim/flora/suitability.ts) и функции размеров, света и вместимости
// (src/sim/flora/system.ts: woodyHeight, crownRadius, layerOf, lightAt, groundLight, herbShade, herbCapacity).
// Чистые статические функции: те же операции и порядок вычислений, что в TS; их же позже вызывает Burst.
using System;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    public static class Suitability
    {
        /// <summary>Трапеция: 0 вне [a, d], 1 на [b, c], линейно между.</summary>
        public static double Trapezoid(double v, double a, double b, double c, double d)
        {
            if (v <= a || v >= d) return 0;
            if (v < b) return (v - a) / (b - a);
            if (v <= c) return 1;
            return (d - v) / (d - c);
        }

        public static double TempResponse(SpeciesTable t, int s, double temperature) => Trapezoid(temperature, t.TMin[s], t.TOptMin[s], t.TOptMax[s], t.TMax[s]);

        /// <summary>Верхний край трапеции может лежать выше 1 — при полной влаге отклик 1.</summary>
        public static double MoistureResponse(SpeciesTable t, int s, double moistureRel) => Trapezoid(moistureRel, t.WMin[s], t.WOptMin[s], t.WOptMax[s], t.WMax[s] + 1e-9);

        public static double LightResponse(SpeciesTable t, int s, double light)
        {
            double need = t.LightNeed[s];
            return light >= need ? 1 : light / need;
        }

        public static double NutrientResponse(SpeciesTable t, int s, double available) => available / (available + t.NutrientHalf[s]);

        public static double SoilResponse(SpeciesTable t, int s, int soil) => t.Soil[s * Soils.All.Length + soil];

        /// <summary>Пригодность 0..1 при среднегодовых условиях вегетационного сезона.</summary>
        public static double Of(SpeciesTable t, int s, double growingTemp, double moistureRel, double light, double nutrient, int soil) =>
            TempResponse(t, s, growingTemp) * MoistureResponse(t, s, moistureRel) * LightResponse(t, s, light) * (0.4 + 0.6 * NutrientResponse(t, s, nutrient)) * SoilResponse(t, s, soil);
    }

    public static class FloraMath
    {
        /// <summary>Ярусы полога по высоте: &lt; 2, 2–6, 6–15, &gt; 15 м.</summary>
        public const int CanopyLayers = 4;
        public static readonly double[] CanopyBounds = { 2, 6, 15 };
        /// <summary>Высота, с которой дерево входит в «высокий» полог, м.</summary>
        public const double TallTree = 6;

        /// <summary>Высота древесного растения по аллометрии, м: H = Hmax·√(B/(B + B½)).</summary>
        public static double WoodyHeight(SpeciesTable t, int s, double biomass) => t.MaxHeight[s] * Math.Sqrt(biomass / (biomass + t.HalfBiomass[s]));

        /// <summary>Радиус кроны, м.</summary>
        public static double CrownRadius(SpeciesTable t, int s, double biomass) => t.MaxCrown[s] * Math.Sqrt(biomass / (biomass + t.HalfBiomass[s]));

        public static int LayerOf(double height) => height < CanopyBounds[0] ? 0 : height < CanopyBounds[1] ? 1 : height < CanopyBounds[2] ? 2 : 3;

        /// <summary>Свет, доходящий до высоты h в ячейке: затеняют ярусы выше и частично свой (canopy — затенение ярусов, float32).</summary>
        public static double LightAt(float[] canopy, int cell, double height)
        {
            int layer = LayerOf(height);
            double light = 1;
            for (int k = CanopyLayers - 1; k > layer; k--) light *= 1.0 - canopy[cell * CanopyLayers + k]; // 1.0: вычитание в double, как в JS (не во float)
            return light * (1 - 0.3 * canopy[cell * CanopyLayers + layer]);
        }

        /// <summary>Свет у земли (для трав и всходов).</summary>
        public static double GroundLight(float[] canopy, int cell)
        {
            double light = 1;
            for (int k = 0; k < CanopyLayers; k++) light *= 1.0 - canopy[cell * CanopyLayers + k]; // 1.0: вычитание в double, как в JS (не во float)
            return light;
        }

        /// <summary>Травостой затеняет низкие всходы: доля света сквозь траву при суммарной биомассе трав, г/м².</summary>
        public static double HerbShade(double herbTotal) => 1 - 0.4 * Math.Min(1, herbTotal / 400);

        /// <summary>То же для ячейки (herbShade(world, cell) в TS): сумма 4 слотов травяного яруса — в double, как herbTotal.</summary>
        public static double HerbShade(float[] slotBiomass, int cell)
        {
            double b = 0;
            for (int k = 0; k < 4; k++) b += slotBiomass[cell * 4 + k];
            return HerbShade(b);
        }

        /// <summary>Вместимость ячейки для вида травяного яруса, г/м²: предельная биомасса при условиях и питании.</summary>
        public static double HerbCapacity(SpeciesTable t, int s, double fit, double nutrient) => t.MaxBiomass[s] * Math.Sqrt(fit * (0.3 + 0.7 * Suitability.NutrientResponse(t, s, nutrient)));
    }
}
