// Классификатор биомов (src/sim/flora/biomes.ts): правила каталога по порядку, запас и допуск порогов (триггер Шмитта).
// Только чистые функции; суточное сглаживание и смена биома ячейки (biomeState.ts) — этап 2.1–2.2.
using System;

namespace Worldbound.Sim.Flora
{
    /// <summary>Показатели ячейки, по которым определяется биом.</summary>
    public struct BiomeInput
    {
        /// <summary>0 — суша, 1 — река, 2 — озеро, 3 — море.</summary>
        public int Water;
        public double TreeCover, ShrubCover, TallShare, HerbBiomass, ConiferShare, TMean, Moisture, SteppeShare, WetShare, PioneerShare;
    }

    public static class Biomes
    {
        /// <summary>
        /// Совпадение с правилом. mode: 0 — точные пороги; +1 — с запасом (войти в биом); −1 — с допуском (остаться).
        /// Запас — 10 % порога, но не меньше 0,02 для долей, 2 г/м² для биомассы, 0,5 °C.
        /// </summary>
        public static bool RuleMatches(BiomeRule r, in BiomeInput c, int mode = 0)
        {
            if (r.Water != null)
            {
                bool found = false;
                for (int k = 0; k < r.Water.Length; k++) if (r.Water[k] == c.Water) found = true;
                if (!found) return false;
            }
            else if (c.Water != 0) return false;
            return AtLeast(c.TreeCover, r.TreeCoverMin, 0.02, mode)
                && AtMost(c.TreeCover, r.TreeCoverMax, 0.02, mode)
                && AtLeast(c.ShrubCover, r.ShrubCoverMin, 0.02, mode)
                && AtLeast(c.TallShare, r.TallShareMin, 0.02, mode)
                && AtMost(c.TallShare, r.TallShareMax, 0.02, mode)
                && AtLeast(c.HerbBiomass, r.HerbBiomassMin, 2, mode)
                && AtMost(c.HerbBiomass, r.HerbBiomassMax, 2, mode)
                && AtLeast(c.ConiferShare, r.ConiferShareMin, 0.02, mode)
                && AtMost(c.ConiferShare, r.ConiferShareMax, 0.02, mode)
                && AtLeast(c.TMean, r.TMeanMin, 0.5, mode)
                && AtMost(c.TMean, r.TMeanMax, 0.5, mode)
                && AtLeast(c.Moisture, r.MoistureMin, 0.02, mode)
                && AtMost(c.Moisture, r.MoistureMax, 0.02, mode)
                && AtLeast(c.SteppeShare, r.SteppeShareMin, 0.02, mode)
                && AtMost(c.SteppeShare, r.SteppeShareMax, 0.02, mode)
                && AtLeast(c.WetShare, r.WetShareMin, 0.02, mode)
                && AtLeast(c.PioneerShare, r.PioneerShareMin, 0.02, mode);
        }

        static bool AtLeast(double v, double? t, double abs, int mode) => !t.HasValue || v >= t.Value + mode * Math.Max(0.1 * Math.Abs(t.Value), abs);

        static bool AtMost(double v, double? t, double abs, int mode) => !t.HasValue || v <= t.Value - mode * Math.Max(0.1 * Math.Abs(t.Value), abs);

        public static int Classify(in BiomeInput c, Biome[] biomes = null)
        {
            biomes ??= BiomeCatalog.All;
            for (int i = 0; i < biomes.Length; i++) if (RuleMatches(biomes[i].Rule, c)) return i;
            return biomes.Length - 1;
        }

        /// <summary>Устойчивая смена биома current → next (триггер Шмитта).</summary>
        public static bool ConfirmsChange(int current, int next, in BiomeInput c, Biome[] biomes = null)
        {
            biomes ??= BiomeCatalog.All;
            if (next < current) return RuleMatches(biomes[next].Rule, c, 1);
            return !RuleMatches(biomes[current].Rule, c, -1);
        }

        public static int IndexOf(string id)
        {
            for (int i = 0; i < BiomeCatalog.All.Length; i++) if (BiomeCatalog.All[i].Id == id) return i;
            throw new ArgumentException($"Нет биома {id}");
        }
    }
}
