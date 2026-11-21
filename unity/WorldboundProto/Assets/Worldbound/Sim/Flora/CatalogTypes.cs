// Типы записей каталогов флоры (src/sim/flora/species.ts, biomes.ts). Данные — в сгенерированных
// Catalog/PlantCatalog.g.cs и Catalog/BiomeCatalog.g.cs (tools/unity-catalog-export.ts); источник истины — content/*.json.
namespace Worldbound.Sim.Flora
{
    public enum PlantForm : byte { Herb, Shrub, Tree }
    public enum LeafHabit : byte { AnnualDieback, Deciduous, Evergreen }

    /// <summary>Тип сообщества травы (для классификатора биомов). Значения — как Community в TS.</summary>
    public enum HerbCommunity : byte { Meadow = 0, Steppe = 1, Wetland = 2, Forest = 3, Pioneer = 4 }

    public static class Community
    {
        public const byte Meadow = 0, Steppe = 1, Wetland = 2, Forest = 3, Pioneer = 4, None = 255;
    }

    public readonly struct Range4
    {
        public readonly double Min, OptMin, OptMax, Max;
        public Range4(double min, double optMin, double optMax, double max) { Min = min; OptMin = optMin; OptMax = optMax; Max = max; }
    }

    /// <summary>Запись каталога растений — как PlantSpecies в TS; необязательные поля — null.</summary>
    public sealed class PlantSpecies
    {
        public string Id, Name;
        public PlantForm Form;
        public LeafHabit LeafHabit;
        public HerbCommunity? Community;
        public Range4 Temperature;
        public double FrostKill;
        public Range4 Moisture;
        public double ShadeTolerance, NutrientDemand, GrowthRate, MaxBiomass;
        public double? HalfBiomass, MaxHeight, MaxCrownRadius;
        public double NutrientContent;
        public double? LeafFraction, CanopyTransmission, MaturityYears, LifespanYears;
        public double BaseMortality, SeedMass;
        public double? Fecundity, DispersalMean, DispersalMax;
        public double Establishment;
        public double? SeedAllocation, SeedBankYears, FixesNutrient;
        public double LitterQuality, ColonistWeight;
        /// <summary>Предпочтение почв (id почвы, 0..1) — только заданные; остальные — 0,6.</summary>
        public (string Soil, double Value)[] SoilPreference;
    }

    /// <summary>Правило биома: null — условия нет. Water — коды воды (1 река, 2 озеро, 3 море) или null (только суша).</summary>
    public sealed class BiomeRule
    {
        public byte[] Water;
        public double? TreeCoverMin, TreeCoverMax, ShrubCoverMin, TallShareMin, TallShareMax, HerbBiomassMin, HerbBiomassMax,
            ConiferShareMin, ConiferShareMax, TMeanMin, TMeanMax, MoistureMin, MoistureMax, SteppeShareMin, SteppeShareMax,
            WetShareMin, PioneerShareMin;
    }

    public sealed class Biome
    {
        public string Id, Name, Color;
        public BiomeRule Rule;
    }
}
