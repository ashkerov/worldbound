// Начальная классификация биомов (src/sim/flora/biomeState.ts: herbsOf, waterBiome, classifyTracked, initBiomes).
// Биом — производная от настоящей растительности и условий ячейки. Суточное сглаживание и устойчивая смена
// (updateBiome) — этап 2.2; здесь — только начальное состояние: сглаженные показатели = текущие, биом = классификация.
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    public static class BiomeState
    {
        /// <summary>
        /// Входы классификатора — одно общее изменяемое значение, как модульный объект `input` в TS: waterBiome копирует
        /// его текущие поля (меняя только воду), а в этапе 2.2 confirmsChange читает его после classifyTracked.
        /// </summary>
        static BiomeInput input;
        static readonly double[] herbParts = new double[4];

        /// <summary>Биомасса трав ячейки: [всего, степные, болотные, пионерные], г/м² (накопление в double).</summary>
        static double[] HerbsOf(World world, int c)
        {
            var f = world.Flora;
            var t = f.Species;
            herbParts[0] = herbParts[1] = herbParts[2] = herbParts[3] = 0;
            for (int k = 0; k < FloraState.Slots; k++)
            {
                byte s = f.SlotSpecies[c * FloraState.Slots + k];
                if (s == SpeciesTable.NoSpecies) continue;
                double b = f.SlotBiomass[c * FloraState.Slots + k];
                herbParts[0] += b;
                byte g = t.CommunityOf[s];
                if (g == Community.Steppe) herbParts[1] += b;
                else if (g == Community.Wetland) herbParts[2] += b;
                else if (g == Community.Pioneer) herbParts[3] += b;
            }
            return herbParts;
        }

        static int WaterBiome(int kind)
        {
            var c = input;
            c.Water = kind;
            return Biomes.Classify(c);
        }

        /// <summary>Классификация ячейки по её сглаженным показателям (заполняет общий input).</summary>
        public static int ClassifyTracked(World world, int c)
        {
            var b = world.Flora.Biome;
            var geo = world.Geo;
            double herb = b.Herb[c];
            double tree = b.Tree[c];
            input.Water = geo.WaterKind[c];
            input.TreeCover = tree;
            input.ShrubCover = b.Shrub[c];
            input.TallShare = tree > 1e-6 ? b.Tall[c] / tree : 0;
            input.HerbBiomass = herb;
            input.ConiferShare = tree > 1e-6 ? b.Conifer[c] / tree : 0;
            input.TMean = geo.TMean[c];
            input.Moisture = b.Moisture[c];
            input.SteppeShare = herb > 1e-6 ? b.Steppe[c] / herb : 0;
            input.WetShare = herb > 1e-6 ? b.Wet[c] / herb : 0;
            input.PioneerShare = herb > 1e-6 ? b.Pioneer[c] / herb : 0;
            return Biomes.Classify(input);
        }

        /// <summary>Сглаженные показатели = текущие, биом = классификация (создание мира).</summary>
        public static void InitBiomes(World world)
        {
            var f = world.Flora;
            var b = f.Biome;
            var geo = world.Geo;
            int count = geo.N * geo.N;
            for (int c = 0; c < count; c++)
            {
                if (geo.WaterKind[c] != WaterKind.None)
                {
                    byte wid = (byte)WaterBiome(geo.WaterKind[c]);
                    b.Current[c] = wid;
                    b.Candidate[c] = wid;
                    b.Days[c] = 0;
                    continue;
                }
                var h = HerbsOf(world, c);
                b.Herb[c] = (float)h[0];
                b.Steppe[c] = (float)h[1];
                b.Wet[c] = (float)h[2];
                b.Pioneer[c] = (float)h[3];
                b.Moisture[c] = f.DayW[c];
                b.Tree[c] = f.TreeCover[c];
                b.Shrub[c] = f.ShrubCover[c];
                b.Conifer[c] = f.ConiferCover[c];
                b.Tall[c] = f.TallCover[c];
                byte id = (byte)ClassifyTracked(world, c);
                b.Current[c] = id;
                b.Candidate[c] = id;
                b.Days[c] = 0;
            }
        }

        /// <summary>Число ячеек по биомам (biomeCounts в TS) — для отчётов и проверок.</summary>
        public static int[] Counts(World world)
        {
            var cur = world.Flora.Biome.Current;
            var o = new int[BiomeCatalog.All.Length];
            for (int c = 0; c < cur.Length; c++) o[cur[c]]++;
            return o;
        }
    }
}
