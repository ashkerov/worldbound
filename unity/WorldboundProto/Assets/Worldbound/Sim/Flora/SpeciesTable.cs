// Плоская таблица видов для горячих циклов (src/sim/flora/species.ts, speciesTable): индекс — номер вида.
// Построение повторяет TS побитно: те же формулы производных полей и те же значения по умолчанию.
using System.Collections.Generic;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    public sealed class SpeciesTable
    {
        /// <summary>Слот травяного яруса без вида.</summary>
        public const byte NoSpecies = 255;

        public int Count;
        public byte[] Woody, Tree, Evergreen, Dieback;
        public double[] TMin, TOptMin, TOptMax, TMax, FrostKill, WMin, WOptMin, WOptMax, WMax;
        public double[] LightNeed, NutrientHalf, Growth, MaxBiomass, HalfBiomass, MaxHeight, MaxCrown, Nutrient, LeafFraction;
        public double[] Transmission, MaturityYears, LifespanYears, Mortality, SeedMass, Fecundity, DispersalMean, DispersalMax;
        public double[] Establishment, SeedAlloc, SeedBankYears;
        /// <summary>Индекс вида в банке семян трав (−1 — не трава).</summary>
        public short[] HerbSlot;
        /// <summary>Виды травяного яруса по порядку каталога — порядок банков семян.</summary>
        public int[] Herbs;
        public double[] Fixes, LitterQuality, Colonist;
        /// <summary>Травы: тип сообщества; древесные — Community.None.</summary>
        public byte[] CommunityOf;
        public byte[] Conifer;
        /// <summary>Soil[вид × число почв + почва] — предпочтение почвы.</summary>
        public double[] Soil;

        static SpeciesTable defaultTable;

        /// <summary>Таблица текущего каталога (как SPECIES в TS).</summary>
        public static SpeciesTable Default => defaultTable ??= Build(PlantCatalog.All);

        public static SpeciesTable Build(PlantSpecies[] plants)
        {
            int n = plants.Length;
            int soils = Soils.All.Length;
            var t = new SpeciesTable
            {
                Count = n,
                Woody = new byte[n], Tree = new byte[n], Evergreen = new byte[n], Dieback = new byte[n],
                TMin = new double[n], TOptMin = new double[n], TOptMax = new double[n], TMax = new double[n], FrostKill = new double[n],
                WMin = new double[n], WOptMin = new double[n], WOptMax = new double[n], WMax = new double[n],
                LightNeed = new double[n], NutrientHalf = new double[n], Growth = new double[n], MaxBiomass = new double[n], HalfBiomass = new double[n],
                MaxHeight = new double[n], MaxCrown = new double[n], Nutrient = new double[n], LeafFraction = new double[n], Transmission = new double[n],
                MaturityYears = new double[n], LifespanYears = new double[n], Mortality = new double[n], SeedMass = new double[n], Fecundity = new double[n],
                DispersalMean = new double[n], DispersalMax = new double[n], Establishment = new double[n], SeedAlloc = new double[n], SeedBankYears = new double[n],
                HerbSlot = new short[n], Fixes = new double[n], LitterQuality = new double[n], Colonist = new double[n],
                CommunityOf = new byte[n], Conifer = new byte[n], Soil = new double[n * soils],
            };
            var herbs = new List<int>();
            for (int i = 0; i < n; i++)
            {
                var p = plants[i];
                t.HerbSlot[i] = -1;
                t.CommunityOf[i] = Community.None;
                t.Woody[i] = (byte)(p.Form == PlantForm.Herb ? 0 : 1);
                t.Tree[i] = (byte)(p.Form == PlantForm.Tree ? 1 : 0);
                t.Evergreen[i] = (byte)(p.LeafHabit == LeafHabit.Evergreen ? 1 : 0);
                t.Dieback[i] = (byte)(p.LeafHabit == LeafHabit.AnnualDieback ? 1 : 0);
                t.TMin[i] = p.Temperature.Min;
                t.TOptMin[i] = p.Temperature.OptMin;
                t.TOptMax[i] = p.Temperature.OptMax;
                t.TMax[i] = p.Temperature.Max;
                t.FrostKill[i] = p.FrostKill;
                t.WMin[i] = p.Moisture.Min;
                t.WOptMin[i] = p.Moisture.OptMin;
                t.WOptMax[i] = p.Moisture.OptMax;
                t.WMax[i] = p.Moisture.Max;
                t.LightNeed[i] = 1 - 0.92 * p.ShadeTolerance;
                t.NutrientHalf[i] = 0.2 + 1.2 * p.NutrientDemand;
                t.Growth[i] = p.GrowthRate;
                t.MaxBiomass[i] = p.MaxBiomass;
                t.HalfBiomass[i] = p.HalfBiomass ?? 0;
                t.MaxHeight[i] = p.MaxHeight ?? 0.5;
                t.MaxCrown[i] = p.MaxCrownRadius ?? 0;
                t.Nutrient[i] = p.NutrientContent;
                t.LeafFraction[i] = p.LeafFraction ?? 0;
                t.Transmission[i] = p.CanopyTransmission ?? 1;
                t.MaturityYears[i] = p.MaturityYears ?? 0;
                t.LifespanYears[i] = p.LifespanYears ?? 0;
                t.Mortality[i] = p.BaseMortality;
                t.SeedMass[i] = p.SeedMass;
                t.Fecundity[i] = p.Fecundity ?? 0;
                t.DispersalMean[i] = p.DispersalMean ?? 0;
                t.DispersalMax[i] = p.DispersalMax ?? 0;
                t.Establishment[i] = p.Establishment;
                t.SeedAlloc[i] = p.SeedAllocation ?? 0;
                t.SeedBankYears[i] = p.SeedBankYears ?? 1;
                if (p.Form == PlantForm.Herb)
                {
                    t.HerbSlot[i] = (short)herbs.Count;
                    herbs.Add(i);
                }
                t.Fixes[i] = p.FixesNutrient ?? 0;
                t.LitterQuality[i] = p.LitterQuality;
                t.Colonist[i] = p.ColonistWeight;
                if (p.Community.HasValue) t.CommunityOf[i] = (byte)p.Community.Value;
                t.Conifer[i] = (byte)(p.Form == PlantForm.Tree && p.LeafHabit == LeafHabit.Evergreen ? 1 : 0);
                for (int k = 0; k < soils; k++)
                {
                    double v = 0.6;
                    if (p.SoilPreference != null)
                        foreach (var (soil, value) in p.SoilPreference)
                            if (soil == Soils.All[k].Id) v = value;
                    t.Soil[i * soils + k] = v;
                }
            }
            t.Herbs = herbs.ToArray();
            return t;
        }

        public int IndexOf(string id)
        {
            for (int i = 0; i < PlantCatalog.All.Length; i++) if (PlantCatalog.All[i].Id == id) return i;
            throw new KeyNotFoundException($"Нет вида {id}");
        }
    }
}
