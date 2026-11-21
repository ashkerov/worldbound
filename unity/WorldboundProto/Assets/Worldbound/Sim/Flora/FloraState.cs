// Состояние растительности (src/sim/flora/state.ts) — только данные, без поведения (Stage 2.0).
// Травяной ярус — поле слотов видов, древесные — индивиды (WoodyStore), опад и запас элемента питания по ячейкам,
// банк семян, полог, биомы, колонисты, ведомость потоков вещества. Типы хранения — как в TS (float32, float64, целые).
// Накопители условий (accT, accW, accRunoff, accMinT, accHours, capillary) — те же массивы, что пишет часовой шаг
// воды (Env.FloraInputs): одно состояние, а не копия.
using System;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    /// <summary>Индексы ведомости потоков (float64, накопительно с создания мира). Элемент питания — г; сухое вещество — кг.</summary>
    public static class Ledger
    {
        public const int Weathering = 0, Fixation = 1, Leaching = 2, Creator = 3, External = 4, Exported = 5;
        public const int Photosynthesis = 6, Litterfall = 7, Decomposition = 8, InitialStock = 9;
        public const int Size = 10;
    }

    /// <summary>Сглаженные по вегетационному сезону показатели ячейки и устойчивый биом (BiomeTrack в TS).</summary>
    public sealed class BiomeTrack
    {
        /// <summary>Биомасса трав всего и по типам сообществ (степные, болотные, пионерные), г/м².</summary>
        public readonly float[] Herb, Steppe, Wet, Pioneer;
        public readonly float[] Moisture;
        /// <summary>Покрытие кронами: деревья, кустарники, хвойные, высокие деревья.</summary>
        public readonly float[] Tree, Shrub, Conifer, Tall;
        /// <summary>Текущий биом (индекс каталога), кандидат на смену и сколько суток кандидат держится.</summary>
        public readonly byte[] Current, Candidate, Days;

        public BiomeTrack(int count)
        {
            Herb = new float[count];
            Steppe = new float[count];
            Wet = new float[count];
            Pioneer = new float[count];
            Moisture = new float[count];
            Tree = new float[count];
            Shrub = new float[count];
            Conifer = new float[count];
            Tall = new float[count];
            Current = new byte[count];
            Candidate = new byte[count];
            Days = new byte[count];
        }
    }

    public sealed class FloraState
    {
        /// <summary>Слотов видов травяного яруса на ячейку.</summary>
        public const int Slots = 4;
        /// <summary>Не больше древесных в одной ячейке 8 × 8 м.</summary>
        public const int MaxWoodyPerCell = 12;
        /// <summary>Среднее древесных на ячейку для предела мира.</summary>
        public const int WoodyPerCellMean = 4;

        public SpeciesTable Species;
        public byte[] SlotSpecies;
        /// <summary>Биомасса слота, г/м².</summary>
        public float[] SlotBiomass;
        /// <summary>Опад листьев и трав, г/м², элемент питания в нём и Σ (масса × качество опада).</summary>
        public float[] LitterFast, LitterFastN, LitterFastQ;
        /// <summary>Опад древесины, г/м², и элемент питания в нём.</summary>
        public float[] LitterWood, LitterWoodN;
        /// <summary>Доступный растениям запас элемента питания, г/м².</summary>
        public float[] Nutrient;
        /// <summary>Суточные накопители — общие с шагом воды (FloraInputs).</summary>
        public float[] AccT, AccW, AccRunoff, AccMinT;
        public byte[] AccHours;
        /// <summary>Средние за последние завершённые сутки ячейки: температура, °C, и относительная влага.</summary>
        public float[] DayT, DayW;
        /// <summary>Вода капиллярной подпитки, мм·ячейка (float64[1]) — общая с шагом воды.</summary>
        public double[] Capillary;
        public WoodyStore Woody;
        /// <summary>Почвенный банк семян трав: [трава × ячейка], г/м². Порядок трав — SpeciesTable.Herbs.</summary>
        public float[] SeedBank;
        public byte[] WoodyCount;
        /// <summary>Полог: затенение по ярусам [ячейка × 4] и покрытия кронами.</summary>
        public float[] Canopy, TreeCover, ShrubCover, ConiferCover, TallCover;
        public BiomeTrack Biome;
        /// <summary>Колонизация извне по видам: принесено семян, г; такт первого прихода (−1 — не было).</summary>
        public double[] ColonistMass, ColonistFirst;
        public double[] Ledger;
        /// <summary>Номер последней обработанной часовой части суток (абсолютный номер часа), −1 — не было.</summary>
        public long LastSliceHour = -1;
        /// <summary>Сколько игровых лет мир готовился (Wildlands), 0 — не готовился.</summary>
        public double PreparedYears;
        /// <summary>Идёт подготовка Wildlands (семена региона на всю сушу). В сохранение не попадает.</summary>
        public bool RegionalSeedRain;

        public static int WoodyCapacity(Geo geo) => Math.Min(EntityId.MaxIndex + 1, geo.N * geo.N * WoodyPerCellMean);

        /// <summary>Начальный запас доступного элемента питания по плодородию почвы, г/м².</summary>
        public static double InitialNutrient(double fertility) => 1.5 + 8 * fertility;

        /// <summary>Пустое состояние (createFlora в TS). inputs — накопители, которые пишет шаг воды этого мира.</summary>
        public static FloraState Create(Geo geo, FloraInputs inputs = null, SpeciesTable species = null)
        {
            species ??= SpeciesTable.Default;
            int count = geo.N * geo.N;
            inputs ??= new FloraInputs(count);
            var nutrient = new float[count];
            for (int i = 0; i < count; i++)
                if (geo.WaterKind[i] == WaterKind.None) nutrient[i] = (float)InitialNutrient(geo.Fertility[i]);
            var slotSpecies = new byte[count * Slots];
            for (int k = 0; k < slotSpecies.Length; k++) slotSpecies[k] = SpeciesTable.NoSpecies;
            var first = new double[species.Count];
            for (int k = 0; k < first.Length; k++) first[k] = -1;
            return new FloraState
            {
                Species = species,
                SlotSpecies = slotSpecies,
                SlotBiomass = new float[count * Slots],
                LitterFast = new float[count],
                LitterFastN = new float[count],
                LitterFastQ = new float[count],
                LitterWood = new float[count],
                LitterWoodN = new float[count],
                Nutrient = nutrient,
                AccT = inputs.AccT,
                AccW = inputs.AccW,
                AccRunoff = inputs.AccRunoff,
                AccMinT = inputs.AccMinT,
                AccHours = inputs.AccHours,
                DayT = new float[count],
                DayW = new float[count],
                Capillary = inputs.Capillary,
                Woody = new WoodyStore(WoodyCapacity(geo)),
                SeedBank = new float[species.Herbs.Length * count],
                WoodyCount = new byte[count],
                Canopy = new float[count * FloraMath.CanopyLayers],
                TreeCover = new float[count],
                ShrubCover = new float[count],
                ConiferCover = new float[count],
                TallCover = new float[count],
                Biome = new BiomeTrack(count),
                ColonistMass = new double[species.Count],
                ColonistFirst = first,
                Ledger = new double[Flora.Ledger.Size],
            };
        }

        /// <summary>Полный запас элемента питания в мире, г: почва + опад + травы (и банк семян) + древесные.</summary>
        public static double NutrientStock(FloraState f, Geo geo)
        {
            var t = f.Species;
            double area = geo.CellSize * geo.CellSize;
            int count = geo.N * geo.N;
            double cells = 0;
            // Сложение в double, как в JS: float + float в C# считалось бы во float.
            for (int i = 0; i < count; i++) cells += (double)f.Nutrient[i] + f.LitterFastN[i] + f.LitterWoodN[i];
            double herbs = 0;
            for (int h = 0; h < t.Herbs.Length; h++)
            {
                double c = t.Nutrient[t.Herbs[h]];
                for (int i = 0; i < count; i++) herbs += f.SeedBank[h * count + i] * c;
            }
            for (int k = 0; k < count * Slots; k++)
            {
                byte s = f.SlotSpecies[k];
                if (s != SpeciesTable.NoSpecies) herbs += f.SlotBiomass[k] * t.Nutrient[s];
            }
            var w = f.Woody;
            double woody = 0;
            for (int i = 0; i < w.HighWater; i++)
                if (w.Alive[i] == 1) woody += (double)w.Biomass[i] * 1000 * t.Nutrient[w.Species[i]];
            return (cells + herbs) * area + woody;
        }

        /// <summary>Ожидаемое изменение запаса по ведомости: приходы минус расходы.</summary>
        public static double NutrientBudget(FloraState f)
        {
            var l = f.Ledger;
            return l[Flora.Ledger.Weathering] + l[Flora.Ledger.Fixation] + l[Flora.Ledger.Creator] + l[Flora.Ledger.External] - l[Flora.Ledger.Leaching] - l[Flora.Ledger.Exported];
        }

        /// <summary>Суммарная биомасса трав ячейки, г/м².</summary>
        public static double HerbBiomass(FloraState f, int cell)
        {
            double b = 0;
            for (int k = 0; k < Slots; k++) b += f.SlotBiomass[cell * Slots + k];
            return b;
        }
    }
}
