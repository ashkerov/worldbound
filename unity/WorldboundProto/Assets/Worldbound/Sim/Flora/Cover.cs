// Полог и живой покров (src/sim/flora/system.ts: refreshCover, greennessOf) — построчный перенос.
// refreshCover считает затенение ярусов, покрытия кронами и число древесных по ячейкам из настоящих растений;
// greennessOf — живой зелёный покров ячейки (вход испарения в часовом шаге воды и цвет рельефа).
using System;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Flora
{
    public static class Cover
    {
        /// <summary>Вклад голых ветвей лиственных зимой в затенение относительно облиственной кроны.</summary>
        public const double BareCrown = 0.3;
        const double PI = 3.141592653589793;

        /// <summary>
        /// Полог по ячейкам из древесных: затенение ярусов, покрытия деревьями, кустарниками, хвойными, высокими; число древесных.
        /// setGreenness — пересчитать и покров суши для воды и рендера (при создании мира).
        /// </summary>
        public static void Refresh(World world, bool setGreenness)
        {
            var f = world.Flora;
            var t = f.Species;
            var w = f.Woody;
            double area = world.Geo.CellSize * world.Geo.CellSize;
            Array.Clear(f.Canopy, 0, f.Canopy.Length);
            Array.Clear(f.TreeCover, 0, f.TreeCover.Length);
            Array.Clear(f.ShrubCover, 0, f.ShrubCover.Length);
            Array.Clear(f.ConiferCover, 0, f.ConiferCover.Length);
            Array.Clear(f.TallCover, 0, f.TallCover.Length);
            Array.Clear(f.WoodyCount, 0, f.WoodyCount.Length);
            for (int i = 0; i < w.HighWater; i++)
            {
                if (w.Alive[i] != 1) continue;
                int s = w.Species[i];
                double b = w.Biomass[i];
                double r = FloraMath.CrownRadius(t, s, b);
                double leafy = t.Evergreen[s] == 1 ? 1 : BareCrown + (1 - BareCrown) * w.Leaf[i];
                double cover = PI * r * r * leafy / area;
                int c = w.Cell[i];
                if (f.WoodyCount[c] < 255) f.WoodyCount[c] = (byte)(f.WoodyCount[c] + 1);
                double h = FloraMath.WoodyHeight(t, s, b);
                int k = c * FloraMath.CanopyLayers + FloraMath.LayerOf(h);
                f.Canopy[k] = (float)Math.Min(0.97, f.Canopy[k] + cover * (1 - t.Transmission[s]));
                if (t.Tree[s] == 1)
                {
                    f.TreeCover[c] = (float)Math.Min(1, f.TreeCover[c] + cover);
                    if (h >= FloraMath.TallTree) f.TallCover[c] = (float)Math.Min(1, f.TallCover[c] + cover);
                    if (t.Conifer[s] == 1) f.ConiferCover[c] = (float)Math.Min(1, f.ConiferCover[c] + cover);
                }
                else f.ShrubCover[c] = (float)Math.Min(1, f.ShrubCover[c] + cover);
            }
            if (setGreenness)
            {
                int n = world.Geo.N;
                for (int c = 0; c < n * n; c++)
                    if (world.Geo.WaterKind[c] == WaterKind.None) world.Env.Greenness[c] = (float)GreennessOf(world, c);
            }
        }

        /// <summary>
        /// Живой зелёный покров ячейки 0..1: травы в активном состоянии и полог. В холод травы в покое
        /// (не испаряют и не зеленеют), вечнозелёные (мох) — зеленеют.
        /// </summary>
        public static double GreennessOf(World world, int cell)
        {
            var f = world.Flora;
            var t = f.Species;
            double activity = DMath.Smoothstep(1, 8, f.DayT[cell]);
            double herbs = 0;
            for (int k = 0; k < FloraState.Slots; k++)
            {
                byte s = f.SlotSpecies[cell * FloraState.Slots + k];
                if (s == SpeciesTable.NoSpecies) continue;
                herbs += f.SlotBiomass[cell * FloraState.Slots + k] * (t.Evergreen[s] == 1 ? 1 : activity);
            }
            return DMath.Clamp(herbs / 400 + 0.9 * f.TreeCover[cell] + 0.6 * f.ShrubCover[cell], 0, 1);
        }
    }
}
