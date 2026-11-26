// Golden-проверка G3 C (Stage 2.4): древесные вместе с травами — побитно против настоящего TS `Simulation`
// (tools/unity-flora-g3c-golden.ts → Golden/flora-g3c.json) и проверки свойств модели по состоянию C#.
//  • C1 — нагрузочный стенд S/42 (10 000 древесных и луг), 40 суток, хеш после каждой из 144 порций первых суток;
//  • C2 — сукцессия WET, seed 1, 2, 3, 50 лет: хеш каждые сутки, выборки середины лета каждого года, критерии
//    tests/sim/flora-succession.test.ts;
//  • исходные тесты TS о древесных (Опыты B, C, E; тест C flora-worlds; заполнение хранилища; берёза, сосна и баланс
//    flora-dynamics в изолированном варианте) — те же критерии;
//  • свойства после каждой порции: целостность WoodyStore, счётчик ячеек ≤ 12, смерть и повторное использование
//    индексов, граница highWater порции, листва ±0,35 в сутки, хвоя вечнозелёных;
//  • нагрузка S/M: время порции и суток, части шага (полог, древесные, рассев, приживание), смерти, память, GC.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraG3CGolden
    {
        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static string Bits(double v) => MiniJson.Bits(v);
        static double D(object o) => MiniJson.FromBits(o);
        static int I(object o) => (int)MiniJson.Num(o);

        sealed class Part
        {
            public string Name;
            public int Checked, Failed;
            public readonly List<string> Examples = new();
            public readonly Dictionary<string, double> Notes = new();

            public void Eq(bool ok, Func<string> what)
            {
                Checked++;
                if (ok) return;
                Failed++;
                if (Examples.Count < 10) Examples.Add(what());
            }

            public void Add(string key, double v) => Notes[key] = Notes.GetValueOrDefault(key) + v;
        }

        public sealed class Options
        {
            public Action<Simulation> Configure;
            public Action<Simulation> Release;
            /// <summary>Только эти прогоны (null — все); для быстрых проверок.</summary>
            public HashSet<string> Only;
            /// <summary>Ограничить сутки прогона (null — все из эталона).</summary>
            public int? Days;
            public string Label = "managed";
            public Func<long> AllocatedBytes;
        }

        // ───────── Создание миров (как create() в инструменте TS) ─────────

        static Simulation Plot(PlotOptions o, uint seed, string geoHash) =>
            new(new WorldConfig { Seed = seed, Size = WorldSize.S, DaysPerSeason = 5, Scenario = Scenario.Genesis, Isolated = true }, new Generate.Result { Geo = PlotGeo.Build(o), Hash = geoHash });

        static void ResetLedger(Simulation sim)
        {
            var f = sim.World.Flora;
            Array.Clear(f.Ledger, 0, f.Ledger.Length);
            f.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(f, sim.World.Geo);
        }

        static void HerbsEverywhere(Simulation sim)
        {
            var f = sim.World.Flora;
            var geo = sim.World.Geo;
            var t = f.Species;
            int count = geo.N * geo.N, m = 0;
            var herbs = t.Herbs;
            for (int c = 0; c < count; c++)
            {
                if (geo.WaterKind[c] != WaterKind.None) continue;
                foreach (int s in herbs) f.SeedBank[t.HerbSlot[s] * count + c] = 1;
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    f.SlotSpecies[c * FloraState.Slots + k] = (byte)herbs[m++ % herbs.Length];
                    f.SlotBiomass[c * FloraState.Slots + k] = 40;
                }
            }
        }

        /// <summary>plantSourceStrip (tests/support/experiments.ts): опушка — лес всех древесных и луг всех трав, банк семян.</summary>
        public static void PlantSourceStrip(Simulation sim, int columns)
        {
            var f = sim.World.Flora;
            var t = f.Species;
            int n = sim.World.Geo.N, cs = sim.World.Geo.CellSize;
            var woody = new List<int>();
            for (int s = 0; s < t.Count; s++) if (t.Woody[s] == 1) woody.Add(s);
            var herbs = t.Herbs;
            int k = 0, m = 0;
            for (int z = 0; z < n; z++)
                for (int x = 0; x < columns; x++)
                {
                    int c = z * n + x;
                    foreach (int h in herbs) f.SeedBank[t.HerbSlot[h] * n * n + c] = 1;
                    if (x < columns >> 1)
                    {
                        int s = woody[k++ % woody.Count];
                        double mature = t.MaturityYears[s] + 5;
                        f.Woody.Spawn(s, (x + 0.5) * cs, (z + 0.5) * cs, c, 0.35 * t.MaxBiomass[s], mature);
                        f.WoodyCount[c] = (byte)(f.WoodyCount[c] + 1);
                    }
                    else
                        for (int slot = 0; slot < FloraState.Slots; slot++)
                        {
                            f.SlotSpecies[c * FloraState.Slots + slot] = (byte)herbs[m++ % herbs.Length];
                            f.SlotBiomass[c * FloraState.Slots + slot] = 40;
                        }
                }
            Cover.Refresh(sim.World, true);
            ResetLedger(sim);
        }

        static Simulation Create(Dictionary<string, object> s, string geoHash)
        {
            var t = SpeciesTable.Default;
            uint seed = (uint)MiniJson.Num(s["seed"]);
            switch ((string)s["kind"])
            {
                case "loadStand":
                {
                    var sim = new Simulation(new WorldConfig { Seed = seed, Size = (string)s["size"] == "M" ? WorldSize.M : WorldSize.S, Scenario = Scenario.Genesis, Isolated = true });
                    HerbsEverywhere(sim);
                    Populate.LoadStand(sim.World, I(s["target"]));
                    ResetLedger(sim);
                    return sim;
                }
                case "sourceStrip":
                {
                    var sim = Plot(PlotOptions.From(O(s["plot"])), seed, geoHash);
                    PlantSourceStrip(sim, I(s["columns"]));
                    return sim;
                }
                case "shade":
                {
                    var sim = Plot(new PlotOptions { Precip = 750, Soil = Soils.Loam, Fertility = 0.8, N = 32 }, seed, geoHash);
                    var f = sim.World.Flora;
                    const int n = 32;
                    int spruce = t.IndexOf("spruce");
                    var mix = new (string, double)[] { ("meadow-grass", 120), ("clover", 40), ("bilberry", 30), ("moss", 20) };
                    bool shaded = (bool)s["shaded"];
                    for (int c = 0; c < n * n; c++)
                    {
                        foreach (int h in t.Herbs) f.SeedBank[t.HerbSlot[h] * n * n + c] = 1;
                        for (int k = 0; k < mix.Length; k++)
                        {
                            f.SlotSpecies[c * FloraState.Slots + k] = (byte)t.IndexOf(mix[k].Item1);
                            f.SlotBiomass[c * FloraState.Slots + k] = (float)mix[k].Item2;
                        }
                        if (shaded)
                        {
                            int x = c % n, z = c / n;
                            foreach (var (dx, dz) in new[] { (2, 2), (6, 6) })
                            {
                                f.Woody.Spawn(spruce, x * 8 + dx, z * 8 + dz, c, 900, 60);
                                f.WoodyCount[c] = (byte)(f.WoodyCount[c] + 1);
                            }
                        }
                    }
                    Cover.Refresh(sim.World, true);
                    ResetLedger(sim);
                    return sim;
                }
                case "spawn":
                {
                    var sim = Plot(PlotOptions.From(O(s["plot"])), seed, geoHash);
                    foreach (var po in A(s["plants"]))
                    {
                        var p = A(po);
                        sim.World.Flora.Woody.Spawn(t.IndexOf((string)p[0]), MiniJson.Num(p[1]), MiniJson.Num(p[2]), I(p[3]), MiniJson.Num(p[4]), MiniJson.Num(p[5]));
                    }
                    if ((bool)s["resetStock"]) sim.World.Flora.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(sim.World.Flora, sim.World.Geo);
                    return sim;
                }
                case "storeFill":
                {
                    var sim = Plot(PlotOptions.From(O(s["plot"])), seed, geoHash);
                    var f = sim.World.Flora;
                    var store = f.Woody;
                    int birch = t.IndexOf("birch");
                    for (int k = 0; k < 64; k++)
                    {
                        int cc = (4 + (k >> 3) * 3) * 32 + 4 + (k & 7) * 3;
                        store.Spawn(birch, (cc % 32 + 0.5) * 8, (cc / 32 + 0.5) * 8, cc, 300, 30);
                    }
                    int c = 0;
                    while (store.Spawn(birch, (c % 32 + 0.5) * 8, (c / 32 + 0.5) * 8, c, 0.002, 0) >= 0) c = (c + 1) % (32 * 32);
                    Cover.Refresh(sim.World, false);
                    f.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(f, sim.World.Geo);
                    return sim;
                }
                case "plantSource":
                {
                    var sim = Plot(PlotOptions.From(O(s["plot"])), seed, geoHash);
                    var f = sim.World.Flora;
                    int n = sim.World.Geo.N, count = n * n, width = I(s["width"]);
                    for (int z = 0; z < n; z++)
                        for (int x = 0; x < width; x++)
                        {
                            int c = z * n + x;
                            foreach (var id in new[] { "meadow-grass", "clover", "fireweed" }) f.SeedBank[t.HerbSlot[t.IndexOf(id)] * count + c] = 1;
                            if ((x + z) % 2 == 0)
                            {
                                int sp = t.IndexOf(z % 4 == 0 ? "birch" : "alder");
                                f.Woody.Spawn(sp, (x + 0.5) * 8, (z + 0.5) * 8, c, 300, 30);
                                f.WoodyCount[c] = (byte)(f.WoodyCount[c] + 1);
                            }
                        }
                    Cover.Refresh(sim.World, true);
                    f.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(f, sim.World.Geo);
                    return sim;
                }
            }
            throw new ArgumentException("неизвестная настройка " + s["kind"]);
        }

        // ───────── Сводки (те же, что compact()/full()/zoneRaw() в инструменте TS) ─────────

        static string FnvPrefix<T>(T[] a, int n) where T : struct
        {
            uint h = 2166136261;
            foreach (byte x in MemoryMarshal.AsBytes(new ReadOnlySpan<T>(a, 0, n))) h = unchecked((h ^ x) * 16777619);
            return h.ToString("x8");
        }

        static double BalanceError(Simulation sim)
        {
            var f = sim.World.Flora;
            double init = f.Ledger[Ledger.InitialStock];
            return Math.Abs(FloraState.NutrientStock(f, sim.World.Geo) - init - FloraState.NutrientBudget(f)) / init;
        }

        static void Compact(Part p, Simulation sim, Dictionary<string, object> e, string where)
        {
            var f = sim.World.Flora;
            var w = f.Woody;
            string hash = sim.StateHash();
            p.Eq(hash == (string)e["stateHash"], () => $"{where}: stateHash {hash} ≠ {e["stateHash"]}");
            p.Eq(sim.World.Tick == (long)MiniJson.Num(e["tick"]), () => $"{where}: такт {sim.World.Tick} ≠ {e["tick"]}");
            var ledger = A(e["ledger"]);
            for (int j = 0; j < ledger.Count; j++) { int jj = j; p.Eq(Bits(f.Ledger[j]) == (string)ledger[j], () => $"{where}: ledger[{jj}] {Bits(f.Ledger[jj])} ≠ {ledger[jj]}"); }
            p.Eq(Bits(BalanceError(sim)) == (string)e["balanceError"], () => $"{where}: ошибка баланса");
            var st = A(e["store"]);
            p.Eq(w.Count == I(st[0]) && w.HighWater == I(st[1]) && w.FreeCount == I(st[2]), () => $"{where}: хранилище {w.Count}/{w.HighWater}/{w.FreeCount} ≠ {st[0]}/{st[1]}/{st[2]}");
        }

        static void Full(Part p, Simulation sim, Dictionary<string, object> e, string where)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            var t = f.Species;
            var wd = f.Woody;
            int n = geo.N, count = n * n, H = t.Herbs.Length;
            var herbBio = new double[H];
            var herbSlots = new int[H];
            var bank = new double[H];
            int occupied = 0, negatives = 0, wcSum = 0, wcMax = 0;
            double green = 0, litterFast = 0, litterWood = 0, nutrient = 0;
            var cover = new double[4];
            for (int c = 0; c < count; c++)
            {
                double hb = 0;
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    int s = f.SlotSpecies[c * FloraState.Slots + k];
                    if (s == SpeciesTable.NoSpecies) continue;
                    double b = f.SlotBiomass[c * FloraState.Slots + k];
                    herbBio[t.HerbSlot[s]] += b;
                    herbSlots[t.HerbSlot[s]]++;
                    hb += b;
                }
                if (hb > 1) occupied++;
                green += w.Env.Greenness[c];
                litterFast += f.LitterFast[c];
                litterWood += f.LitterWood[c];
                nutrient += f.Nutrient[c];
                if (f.Nutrient[c] < 0 || f.LitterFast[c] < 0 || f.LitterWood[c] < 0) negatives++;
                cover[0] += f.TreeCover[c];
                cover[1] += f.ShrubCover[c];
                cover[2] += f.ConiferCover[c];
                cover[3] += f.TallCover[c];
                wcSum += f.WoodyCount[c];
                if (f.WoodyCount[c] > wcMax) wcMax = f.WoodyCount[c];
            }
            for (int h = 0; h < H; h++) for (int c = 0; c < count; c++) bank[h] += f.SeedBank[h * count + c];
            var bySpecies = new int[t.Count];
            var bySpeciesBiomass = new double[t.Count];
            var stages = new int[4];
            for (int i = 0; i < wd.HighWater; i++)
            {
                if (wd.Alive[i] != 1) continue;
                bySpecies[wd.Species[i]]++;
                bySpeciesBiomass[wd.Species[i]] += wd.Biomass[i];
                stages[wd.Stage[i]]++;
            }
            var bc = A(e["biomeCounts"]);
            var mine = BiomeState.Counts(w);
            for (int j = 0; j < bc.Count; j++) { int jj = j; p.Eq(mine[j] == I(bc[j]), () => $"{where}: биом {BiomeCatalog.All[jj].Id} {mine[jj]} ≠ {bc[jj]}"); }
            var he = O(e["herbs"]);
            for (int h = 0; h < H; h++)
            {
                int hh = h;
                p.Eq(Bits(herbBio[h]) == (string)A(he["biomass"])[h] && herbSlots[h] == I(A(he["slots"])[h]) && Bits(bank[h]) == (string)A(he["bank"])[h], () => $"{where}: трава {hh}");
            }
            p.Eq(occupied == I(he["occupied"]) && Bits(green) == (string)he["green"], () => $"{where}: занятые ячейки/покров");
            var so = O(e["soil"]);
            p.Eq(Bits(litterFast) == (string)so["litterFast"] && Bits(litterWood) == (string)so["litterWood"] && Bits(nutrient) == (string)so["nutrient"] && negatives == I(so["negatives"]), () => $"{where}: опад/питание");
            var we = O(e["woody"]);
            for (int s = 0; s < t.Count; s++)
            {
                int ss = s;
                p.Eq(bySpecies[s] == I(A(we["bySpecies"])[s]) && Bits(bySpeciesBiomass[s]) == (string)A(we["bySpeciesBiomass"])[s], () => $"{where}: вид {PlantCatalog.All[ss].Id}: {bySpecies[ss]} ≠ {A(we["bySpecies"])[ss]}");
            }
            for (int k = 0; k < 4; k++) { int kk = k; p.Eq(stages[k] == I(A(we["stages"])[k]) && Bits(cover[k]) == (string)A(we["cover"])[k], () => $"{where}: стадия/покров {kk}"); }
            p.Eq(wcSum == I(we["woodyCountSum"]) && wcMax == I(we["woodyCountMax"]) && StateHasher.Fnv(wd.FreeSlots()) == (string)we["free"], () => $"{where}: счётчики ячеек/стек свободных");
            int hw = wd.HighWater;
            string H2<T>(T[] a) where T : struct => StateHasher.Fnv(a);
            var arr = new Dictionary<string, string>
            {
                ["slotSpecies"] = H2(f.SlotSpecies), ["slotBiomass"] = H2(f.SlotBiomass), ["seedBank"] = H2(f.SeedBank), ["nutrient"] = H2(f.Nutrient), ["litterFast"] = H2(f.LitterFast),
                ["litterWood"] = H2(f.LitterWood), ["litterWoodN"] = H2(f.LitterWoodN), ["canopy"] = H2(f.Canopy), ["treeCover"] = H2(f.TreeCover), ["shrubCover"] = H2(f.ShrubCover),
                ["coniferCover"] = H2(f.ConiferCover), ["tallCover"] = H2(f.TallCover), ["woodyCount"] = H2(f.WoodyCount), ["greenness"] = H2(w.Env.Greenness), ["biome.current"] = H2(f.Biome.Current),
                ["woody.x"] = FnvPrefix(wd.X, hw), ["woody.z"] = FnvPrefix(wd.Z, hw), ["woody.species"] = FnvPrefix(wd.Species, hw), ["woody.age"] = FnvPrefix(wd.Age, hw), ["woody.biomass"] = FnvPrefix(wd.Biomass, hw),
                ["woody.leaf"] = FnvPrefix(wd.Leaf, hw), ["woody.health"] = FnvPrefix(wd.Health, hw), ["woody.stage"] = FnvPrefix(wd.Stage, hw), ["woody.stressW"] = FnvPrefix(wd.StressW, hw), ["woody.stressL"] = FnvPrefix(wd.StressL, hw),
                ["woody.cell"] = FnvPrefix(wd.Cell, hw), ["woody.alive"] = FnvPrefix(wd.Alive, hw), ["woody.generation"] = FnvPrefix(wd.Generation, hw),
            };
            foreach (var kv in O(e["arrays"])) { var key = kv.Key; p.Eq(arr[key] == (string)kv.Value, () => $"{where}: {key} {arr[key]} ≠ {kv.Value}"); }
        }

        /// <summary>Выборка зоны без округления (zoneRaw в инструменте TS).</summary>
        sealed class Zone
        {
            public double Herbs, HerbOccupancy, TreeCover, ShrubCover, TopHeight, SeedBank, Nutrient, Balance;
            public double[] HerbBySpecies;
            public int Shrubs, Trees;
            public int[] TreeStages, WoodyBySpecies, Biomes;
        }

        static Zone ZoneOf(Simulation sim, int from, int to)
        {
            var f = sim.World.Flora;
            var geo = sim.World.Geo;
            var t = f.Species;
            int n = geo.N;
            var z0 = new Zone { HerbBySpecies = new double[t.Herbs.Length], TreeStages = new int[4], WoodyBySpecies = new int[t.Count], Biomes = new int[BiomeCatalog.All.Length] };
            int cells = 0, occupied = 0;
            double herbs = 0, tree = 0, shrub = 0, bank = 0, nut = 0;
            for (int z = 0; z < n; z++)
                for (int x = from; x < to; x++)
                {
                    int c = z * n + x;
                    cells++;
                    double hb = 0;
                    for (int k = 0; k < FloraState.Slots; k++)
                    {
                        int s = f.SlotSpecies[c * FloraState.Slots + k];
                        if (s == SpeciesTable.NoSpecies) continue;
                        double b = f.SlotBiomass[c * FloraState.Slots + k];
                        hb += b;
                        z0.HerbBySpecies[t.HerbSlot[s]] += b;
                    }
                    herbs += hb;
                    if (hb > 1) occupied++;
                    tree += f.TreeCover[c];
                    nut += f.Nutrient[c];
                    shrub += f.ShrubCover[c];
                    for (int h = 0; h < t.Herbs.Length; h++) bank += f.SeedBank[h * n * n + c];
                    z0.Biomes[f.Biome.Current[c]]++;
                }
            var w = f.Woody;
            var heights = new List<double>();
            for (int i = 0; i < w.HighWater; i++)
            {
                if (w.Alive[i] != 1 || w.X[i] < from * geo.CellSize || w.X[i] >= to * geo.CellSize) continue;
                int s = w.Species[i];
                z0.WoodyBySpecies[s]++;
                if (t.Tree[s] == 1)
                {
                    z0.Trees++;
                    z0.TreeStages[w.Stage[i]]++;
                    heights.Add(FloraMath.WoodyHeight(t, s, w.Biomass[i]));
                }
                else z0.Shrubs++;
            }
            heights.Sort((a, b) => b.CompareTo(a));
            int topN = Math.Min(5, heights.Count);
            double top = 0;
            for (int k = 0; k < topN; k++) top += heights[k];
            z0.Herbs = herbs / cells;
            for (int h = 0; h < z0.HerbBySpecies.Length; h++) z0.HerbBySpecies[h] /= cells;
            z0.HerbOccupancy = occupied / (double)cells;
            z0.TreeCover = tree / cells;
            z0.ShrubCover = shrub / cells;
            z0.TopHeight = topN > 0 ? top / topN : 0;
            z0.SeedBank = bank / cells;
            z0.Nutrient = nut / cells;
            z0.Balance = BalanceError(sim);
            return z0;
        }

        static void ZoneEq(Part p, Zone z, Dictionary<string, object> e, string where)
        {
            bool ok = Bits(z.Herbs) == (string)e["herbs"] && Bits(z.HerbOccupancy) == (string)e["herbOccupancy"] && z.Shrubs == I(e["shrubs"]) && z.Trees == I(e["trees"])
                && Bits(z.TreeCover) == (string)e["treeCover"] && Bits(z.ShrubCover) == (string)e["shrubCover"] && Bits(z.TopHeight) == (string)e["topHeight"]
                && Bits(z.SeedBank) == (string)e["seedBank"] && Bits(z.Nutrient) == (string)e["nutrient"] && Bits(z.Balance) == (string)e["balanceError"];
            var hb = A(e["herbBySpecies"]);
            for (int h = 0; h < z.HerbBySpecies.Length; h++) ok &= Bits(z.HerbBySpecies[h]) == (string)hb[h];
            for (int k = 0; k < 4; k++) ok &= z.TreeStages[k] == I(A(e["treeStages"])[k]);
            for (int s = 0; s < z.WoodyBySpecies.Length; s++) ok &= z.WoodyBySpecies[s] == I(A(e["woodyBySpecies"])[s]);
            for (int b = 0; b < z.Biomes.Length; b++) ok &= z.Biomes[b] == I(A(e["biomes"])[b]);
            p.Eq(ok, () => $"{where}: выборка зоны [{e["from"]}, {e["to"]}) — деревьев {z.Trees}/{e["trees"]}, кустарников {z.Shrubs}/{e["shrubs"]}");
        }

        // ───────── Свойства после порции и после суток ─────────

        sealed class WoodySnap
        {
            public byte[] Alive, Gen, Species;
            public float[] Leaf;
            public int HighWater;

            public void Take(WoodyStore w)
            {
                int n = w.Capacity;
                Alive ??= new byte[n];
                Gen ??= new byte[n];
                Species ??= new byte[n];
                Leaf ??= new float[n];
                int hw = w.HighWater;
                Array.Copy(w.Alive, Alive, hw);
                Array.Copy(w.Generation, Gen, hw);
                Array.Copy(w.Species, Species, hw);
                Array.Copy(w.Leaf, Leaf, hw);
                if (hw < HighWater) Array.Clear(Alive, hw, HighWater - hw);
                HighWater = hw;
            }
        }

        sealed class Checks
        {
            public Part Store, Cells, Deaths, Phenology;
            public readonly WoodySnap Portion0 = new(), Day0 = new();
            public double LitterfallBefore;
            public bool CountsTrusted;
            public long Births, DeathsCount, Reused;
        }

        /// <summary>После порции: смерти (поколение +1, индекс в стеке, опад), рождения (за границей highWater порции — не обработаны).</summary>
        static void AfterPortion(Simulation sim, Checks ck, string where)
        {
            var f = sim.World.Flora;
            var w = f.Woody;
            var b = ck.Portion0;
            double dt = 1.0 / (sim.World.Config.DaysPerSeason * SimTime.SeasonsPerYear);
            HashSet<int> free = null;
            int bad = 0;
            string ex = null;
            void Bad(string s) { bad++; ex ??= s; }
            for (int i = 0; i < w.HighWater; i++)
            {
                bool was = i < b.HighWater && b.Alive[i] == 1;
                bool same = i < b.HighWater && b.Gen[i] == w.Generation[i];
                bool now = w.Alive[i] == 1;
                if (was && !(now && same))
                {
                    ck.DeathsCount++;
                    // Удаление — поколение +1 (если индекс тут же занят заново — поколение уже сменилось, живое снова).
                    if (!now && w.Generation[i] != (byte)((b.Gen[i] + 1) & EntityId.MaxGeneration)) Bad($"{where}: растение {i}: поколение {b.Gen[i]} → {w.Generation[i]}");
                    if (!now)
                    {
                        free ??= new HashSet<int>(w.FreeSlots());
                        if (!free.Contains(i) || w.Biomass[i] != 0) Bad($"{where}: умершее {i} не в стеке свободных или с биомассой");
                    }
                }
                if (now && !(was && same))
                {
                    ck.Births++;
                    if (i < b.HighWater) ck.Reused++;
                    // Новое за границей highWater начала порции цикл этой порции не обрабатывал.
                    if (i >= b.HighWater && w.Age[i] != 0) Bad($"{where}: всход {i} за границей порции обработан (возраст {w.Age[i]})");
                    if (w.Age[i] != 0 && w.Age[i] != (float)dt) Bad($"{where}: всход {i} возраст {w.Age[i]}");
                    if (f.Species.Woody[w.Species[i]] != 1) Bad($"{where}: всход {i} не древесный");
                }
            }
            ck.Deaths.Eq(bad == 0, () => ex);
        }

        /// <summary>После суток: целостность хранилища, счётчики ячеек, листва и хвоя.</summary>
        static void AfterDay(Simulation sim, Checks ck, string where)
        {
            var f = sim.World.Flora;
            var w = f.Woody;
            var t = f.Species;
            int alive = 0;
            for (int i = 0; i < w.HighWater; i++) if (w.Alive[i] == 1) alive++;
            for (int i = w.HighWater; i < w.Capacity; i++) if (w.Alive[i] != 0) { alive = -1; break; }
            var free = w.FreeSlots();
            var seen = new HashSet<int>();
            bool freeOk = true;
            foreach (int i in free) if (i < 0 || i >= w.HighWater || w.Alive[i] != 0 || !seen.Add(i)) freeOk = false;
            ck.Store.Eq(alive == w.Count && w.Count >= 0 && w.Count <= w.Capacity && w.Count + free.Length == w.HighWater && freeOk,
                () => $"{where}: хранилище: живых {alive}, Count {w.Count}, свободных {free.Length}, HighWater {w.HighWater}, стек {(freeOk ? "цел" : "повреждён")}");
            // Счётчик ячейки = число живых растений в ней (после первого пересчёта полога), не больше 12.
            int n = sim.World.Geo.N;
            var cnt = new int[n * n];
            for (int i = 0; i < w.HighWater; i++) if (w.Alive[i] == 1) cnt[w.Cell[i]]++;
            int mism = 0, over = 0;
            for (int c = 0; c < n * n; c++)
            {
                if (cnt[c] != f.WoodyCount[c]) mism++;
                if (f.WoodyCount[c] > FloraState.MaxWoodyPerCell) over++;
            }
            if (ck.CountsTrusted) ck.Cells.Eq(mism == 0 && over == 0, () => $"{where}: счётчики ячеек: расхождений {mism}, больше 12 — {over}");
            // Листва меняется не больше чем на 0,35 за сутки; вечнозелёные после первого шага — с хвоей (1).
            var d = ck.Day0;
            int leafBad = 0;
            for (int i = 0; i < Math.Min(w.HighWater, d.HighWater); i++)
            {
                if (w.Alive[i] != 1 || d.Alive[i] != 1 || d.Gen[i] != w.Generation[i]) continue;
                // Лиственные: шаг облиственности не больше 0,35 за сутки. Вечнозелёные: хвоя 1 с первого шага (так и в TS:
                // у всхода при первом шаге 0 → 1) и дальше не опадает.
                if (t.Evergreen[w.Species[i]] == 0 && Math.Abs((double)w.Leaf[i] - d.Leaf[i]) > 0.35 + 1e-6) leafBad++;
                if (t.Evergreen[w.Species[i]] == 1 && d.Leaf[i] == 1 && w.Leaf[i] != 1) leafBad++;
            }
            ck.Phenology.Eq(leafBad == 0, () => $"{where}: листва: нарушений {leafBad}");
            ck.Day0.Take(w);
            ck.CountsTrusted = true;
        }

        // ───────── Прогон ─────────

        sealed class Result
        {
            public string Name;
            public Simulation Sim;
            public readonly List<double> PortionMs = new(), DayMs = new();
            public readonly Dictionary<string, (long tick, List<Zone> zones, List<Dictionary<string, object>> plants)> Probes = new();
            public double MaxBalance;
            public long StepAllocated;
            public int StepGen0;
            public long LiveStart, LiveEnd;
            public FloraProfile Profile;
        }

        static Result Run(Dictionary<string, object> r, Part eq, Part balance, Checks ck, Options opt, bool profile = false, bool release = true)
        {
            string name = (string)r["name"];
            var sim = Create(O(r["setup"]), (string)r["geoHash"]);
            opt.Configure?.Invoke(sim);
            var res = new Result { Name = name, Sim = sim, LiveStart = sim.World.Flora.Woody.Count };
            var init = O(r["initial"]);
            Compact(eq, sim, init, $"{name} начало");
            Full(eq, sim, init, $"{name} начало");
            long start = sim.World.Tick, end = (long)MiniJson.Num(r["endTick"]);
            var days = A(r["days"]);
            int maxDays = Math.Min(days.Count, opt.Days ?? int.MaxValue);
            if (opt.Days != null && maxDays < days.Count) end = start + maxDays * (long)SimTime.TicksPerDay;
            var probes = new List<Dictionary<string, object>>();
            foreach (var po in A(r["probes"])) probes.Add(O(po));
            List<object> portions = r.TryGetValue("portions", out var pso) && pso != null ? A(pso) : null;
            int pi = 0, d = 0, portion = 0;
            double acc = 0;
            var sw = new Stopwatch();
            if (ck != null) { ck.Day0.Take(sim.World.Flora.Woody); ck.CountsTrusted = false; }
            if (profile) { res.Profile = new FloraProfile(); FloraSystem.Profile = res.Profile; }
            void DoProbes()
            {
                while (pi < probes.Count && (long)MiniJson.Num(probes[pi]["tick"]) <= sim.World.Tick)
                {
                    var p = probes[pi++];
                    string label = (string)p["label"];
                    eq.Eq((long)MiniJson.Num(p["tick"]) == sim.World.Tick && sim.StateHash() == (string)p["stateHash"], () => $"{name} выборка «{label}»: хеш");
                    var zones = new List<Zone>();
                    foreach (var zo in A(p["zones"]))
                    {
                        var ze = O(zo);
                        var z = ZoneOf(sim, I(ze["from"]), I(ze["to"]));
                        ZoneEq(eq, z, ze, $"{name} «{label}»");
                        zones.Add(z);
                    }
                    var plants = new List<Dictionary<string, object>>();
                    var w = sim.World.Flora.Woody;
                    foreach (var pl in A(p["plants"]))
                    {
                        var pe = O(pl);
                        int i = I(pe["i"]);
                        eq.Eq(w.Alive[i] == I(pe["alive"]) && w.Generation[i] == I(pe["generation"]) && w.Species[i] == I(pe["species"]) && Bits(w.Leaf[i]) == (string)pe["leaf"]
                            && Bits(w.Biomass[i]) == (string)pe["biomass"] && Bits(w.Health[i]) == (string)pe["health"] && w.Stage[i] == I(pe["stage"]) && Bits(w.Age[i]) == (string)pe["age"],
                            () => $"{name} «{label}»: растение {i}");
                        plants.Add(pe);
                    }
                    res.Probes[label] = (sim.World.Tick, zones, plants);
                }
            }
            DoProbes();
            while (sim.World.Tick < end)
            {
                long nextDay = start + (d + 1) * (long)SimTime.TicksPerDay;
                long target = Math.Min(nextDay, end);
                if (pi < probes.Count) target = Math.Min(target, (long)MiniJson.Num(probes[pi]["tick"]));
                while (sim.World.Tick < target)
                {
                    long tick = sim.World.Tick;
                    bool flora = (tick - FloraSystem.Phase) % FloraSystem.Period == 0;
                    if (flora && ck != null) { ck.Portion0.Take(sim.World.Flora.Woody); ck.LitterfallBefore = sim.World.Flora.Ledger[Ledger.Litterfall]; }
                    long a0 = opt.AllocatedBytes?.Invoke() ?? 0;
                    int g0 = GC.CollectionCount(0);
                    sw.Restart();
                    sim.Step();
                    double ms = sw.Elapsed.TotalMilliseconds;
                    res.StepGen0 += GC.CollectionCount(0) - g0;
                    if (opt.AllocatedBytes != null) res.StepAllocated += opt.AllocatedBytes() - a0;
                    acc += ms;
                    if (!flora) continue;
                    res.PortionMs.Add(ms);
                    portion++;
                    if (ck != null) AfterPortion(sim, ck, $"{name} сутки {d + 1} порция {portion}");
                    if (portions != null && d == 0)
                    {
                        string h = sim.StateHash();
                        int pp = portion;
                        eq.Eq(h == (string)portions[pp - 1], () => $"{name} порция {pp}: stateHash {h} ≠ {portions[pp - 1]}");
                    }
                }
                if (sim.World.Tick == nextDay)
                {
                    d++;
                    res.DayMs.Add(acc);
                    acc = 0;
                    var e = O(days[d - 1]);
                    Compact(eq, sim, e, $"{name} сутки {d}");
                    if (e.ContainsKey("arrays")) Full(eq, sim, e, $"{name} сутки {d}");
                    double err = BalanceError(sim);
                    res.MaxBalance = Math.Max(res.MaxBalance, err);
                    int dd = d;
                    balance?.Eq(err <= 1e-4, () => $"{name} сутки {dd}: ошибка баланса {err:E2}");
                    if (ck != null) AfterDay(sim, ck, $"{name} сутки {d}");
                }
                DoProbes();
            }
            FloraSystem.Profile = null;
            if (opt.Days == null || opt.Days >= days.Count)
            {
                var fin = O(r["final"]);
                string h = sim.StateHash();
                eq.Eq(sim.World.Tick == (long)MiniJson.Num(fin["tick"]) && h == (string)fin["stateHash"], () => $"{name} конец: stateHash {h} ≠ {fin["stateHash"]}");
            }
            res.LiveEnd = sim.World.Flora.Woody.Count;
            if (release) opt.Release?.Invoke(sim);
            return res;
        }

        static string Stat(List<double> xs)
        {
            if (xs.Count == 0) return "null";
            var s = new List<double>(xs);
            s.Sort();
            double mean = 0;
            foreach (var v in s) mean += v;
            mean /= s.Count;
            double P(double q) => s[Math.Min(s.Count - 1, (int)Math.Floor(q * s.Count))];
            return $"{{\"n\":{s.Count},\"mean\":{MiniJson.N(Math.Round(mean, 4))},\"p95\":{MiniJson.N(Math.Round(P(0.95), 4))},\"p99\":{MiniJson.N(Math.Round(P(0.99), 4))},\"max\":{MiniJson.N(Math.Round(s[s.Count - 1], 4))}}}";
        }

        static string TsStat(object o)
        {
            var x = O(o);
            return $"{{\"mean\":{MiniJson.N(Math.Round(MiniJson.Num(x["mean"]), 4))},\"p95\":{MiniJson.N(Math.Round(MiniJson.Num(x["p95"]), 4))},\"p99\":{MiniJson.N(Math.Round(MiniJson.Num(x["p99"]), 4))},\"max\":{MiniJson.N(Math.Round(MiniJson.Num(x["max"]), 4))}}}";
        }

        static long WoodyBytes(WoodyStore w) => (long)w.Capacity * (4 * 8 + 1 * 4 + 4) + 4L * w.Capacity;

        static long FloraBytes(FloraState f) =>
            f.SlotSpecies.Length + 4L * f.SlotBiomass.Length + 4L * (f.LitterFast.Length * 5 + f.Nutrient.Length) + 4L * f.SeedBank.Length + f.WoodyCount.Length
            + 4L * (f.AccT.Length * 4) + f.AccHours.Length + 4L * (f.DayT.Length * 2) + 8L * f.Capillary.Length + 4L * (f.Canopy.Length + 4 * f.TreeCover.Length)
            + 4L * 9 * f.Biome.Herb.Length + 3L * f.Biome.Current.Length + 8L * (f.ColonistMass.Length + f.ColonistFirst.Length + f.Ledger.Length);

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, Options opt = null)
        {
            opt ??= new Options();
            var root = O(MiniJson.Parse(goldenJson));
            var runs = O(root["runs"]);
            var parts = new List<Part>();
            Part New(string name) { var p = new Part { Name = name }; parts.Add(p); return p; }
            var total = Stopwatch.StartNew();
            var t = SpeciesTable.Default;
            bool Want(string n) => opt.Only == null || opt.Only.Contains(n);
            var pEq = New("G3 C побитно с TS");
            var pBal = New("баланс вещества по суткам (≤ 1e-4)");
            var ck = new Checks { Store = New("WoodyStore: целостность"), Cells = New("счётчики ячеек ≤ 12"), Deaths = New("смерть и повторное использование индексов"), Phenology = New("листва ±0,35 в сутки, хвоя") };
            var results = new Dictionary<string, Result>();
            var perf = new StringBuilder($"\"backend\":{MiniJson.Q(opt.Label)}");
            foreach (var kv in runs)
            {
                string name = kv.Key;
                if (!Want(name)) continue;
                bool load = name.StartsWith("load-");
                bool prof = load || name == "C1";
                var r = Run(O(kv.Value), pEq, pBal, load ? null : ck, opt, prof, release: true);
                results[name] = r;
                log($"g3c[{opt.Label}] {name}: {r.DayMs.Count} сут., древесных {r.LiveStart} → {r.LiveEnd}, ошибка баланса ≤ {r.MaxBalance:E2}, сутки {Stat(r.DayMs)}");
                if (prof)
                {
                    var p = r.Profile;
                    string M(long ticks) => MiniJson.N(Math.Round(FloraProfile.Ms(ticks), 2));
                    var ts = O(O(kv.Value)["timing"]);
                    perf.Append($",{MiniJson.Q(name)}:{{\"liveStart\":{r.LiveStart},\"liveEnd\":{r.LiveEnd},\"days\":{r.DayMs.Count},\"portionMs\":{Stat(r.PortionMs)},\"dayMs\":{Stat(r.DayMs)},\"ts\":{{\"portionMs\":{TsStat(ts["portionMs"])},\"dayMs\":{TsStat(ts["dayMs"])}}}")
                        .Append($",\"gen0CollectionsInSteps\":{r.StepGen0},\"allocatedBytesInSteps\":{(opt.AllocatedBytes != null ? r.StepAllocated.ToString() : "null")},\"floraStateBytes\":{FloraBytes(r.Sim.World.Flora)},\"woodyStoreBytes\":{WoodyBytes(r.Sim.World.Flora.Woody)},\"woodyCapacity\":{r.Sim.World.Flora.Woody.Capacity}")
                        .Append($",\"profile\":{{\"portions\":{p.Portions},\"cells\":{p.Cells},\"woodyProcessed\":{p.WoodyProcessed},\"deaths\":{p.Deaths},\"seedingPlants\":{p.SeedingPlants},\"packets\":{p.Packets},\"packetsExported\":{p.PacketsExported},\"established\":{p.Established}")
                        .Append($",\"coverMs\":{M(p.CoverTicks)},\"woodyLoopMs\":{M(p.WoodyTicks)},\"woodySeedsMs\":{M(p.WoodySeedTicks)},\"landingMs\":{M(p.LandingTicks)},\"deathMs\":{M(p.DeathTicks)},\"herbMs\":{M(p.HerbTicks)},\"herbSeedMs\":{M(p.SeedTicks)},\"germinationMs\":{M(p.GerminationTicks)},\"bankAgingMs\":{M(p.AgingTicks)},\"soilMs\":{M(p.SoilTicks)},\"coverBiomeMs\":{M(p.BiomeTicks)}}}}}");
                    ck.Deaths.Add($"{name}.packetsPerSeedingPlant", p.SeedingPlants > 0 ? p.Packets / (double)p.SeedingPlants : 0);
                    if (p.SeedingPlants > 0) ck.Deaths.Eq(p.Packets <= 8 * p.SeedingPlants, () => $"{name}: пакетов {p.Packets} больше 8 × {p.SeedingPlants}");
                }
            }
            ck.Deaths.Notes["births"] = ck.Births;
            ck.Deaths.Notes["deaths"] = ck.DeathsCount;
            ck.Deaths.Notes["reusedIndices"] = ck.Reused;
            pBal.Notes["max"] = 0;
            foreach (var r in results.Values) pBal.Notes["max"] = Math.Max(pBal.Notes["max"], r.MaxBalance);
            bool full = opt.Days == null;

            // ───────── Критерии исходных тестов TS ─────────
            int H(string id) => t.HerbSlot[t.IndexOf(id)];
            int Bi(string id) => Biomes.IndexOf(id);
            int Forest(Zone z) => z.Biomes[Bi("woodland")] + z.Biomes[Bi("broadleaf-forest")] + z.Biomes[Bi("mixed-forest")] + z.Biomes[Bi("coniferous-forest")];
            if (full)
            {
                var pC2 = New("C2: сукцессия (flora-succession, опыт A)");
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    if (!results.TryGetValue($"C2-{seed}", out var r)) continue;
                    Zone F(int y) => r.Probes[$"год {y}"].zones[0];
                    Zone N(int y) => r.Probes[$"год {y}"].zones[1];
                    string L = $"seed {seed}";
                    pC2.Eq(F(12).HerbOccupancy > 0.8 && F(12).ShrubCover < 0.01 && F(12).TreeCover < 0.01, () => $"{L}: год 12 — травы {F(12).HerbOccupancy:F3}, кустарники {F(12).ShrubCover:F4}, деревья {F(12).TreeCover:F4}");
                    pC2.Eq(F(40).Shrubs > 3 * F(15).Shrubs, () => $"{L}: кустарников год 40 {F(40).Shrubs}, год 15 {F(15).Shrubs}");
                    pC2.Eq(F(50).ShrubCover > 0.03, () => $"{L}: покрытие кустарниками год 50 {F(50).ShrubCover:F4}");
                    pC2.Eq(F(30).TreeStages[2] > 0, () => $"{L}: зрелых деревьев на 30-м году нет");
                    pC2.Eq(F(50).TreeCover > F(30).TreeCover, () => $"{L}: полог деревьев не вырос");
                    pC2.Eq(N(50).TreeCover > 0.05 && Forest(N(50)) > 0 && N(50).TopHeight > 12, () => $"{L}: у опушки год 50 — деревья {N(50).TreeCover:F3}, лес {Forest(N(50))}, высота {N(50).TopHeight:F1}");
                    bool lim = true;
                    for (int y = 1; y <= 50; y++) { var z = F(y); lim &= z.Shrubs + z.Trees <= 48 * 42 * FloraState.MaxWoodyPerCell && z.SeedBank < 50 && z.Herbs < 600 && z.Balance < 1e-4; }
                    pC2.Eq(lim, () => $"{L}: пределы популяций/банка/баланса нарушены");
                    pC2.Notes[$"seed{seed}.year12.herbOccupancy"] = F(12).HerbOccupancy;
                    pC2.Notes[$"seed{seed}.year15.shrubs"] = F(15).Shrubs;
                    pC2.Notes[$"seed{seed}.year40.shrubs"] = F(40).Shrubs;
                    pC2.Notes[$"seed{seed}.year50.shrubCover"] = F(50).ShrubCover;
                    pC2.Notes[$"seed{seed}.year30.matureTrees"] = F(30).TreeStages[2];
                    pC2.Notes[$"seed{seed}.year50.treeCover"] = F(50).TreeCover;
                    pC2.Notes[$"seed{seed}.near50.treeCover"] = N(50).TreeCover;
                    pC2.Notes[$"seed{seed}.near50.forestCells"] = Forest(N(50));
                    pC2.Notes[$"seed{seed}.near50.topHeight"] = N(50).TopHeight;
                }
                var pT = New("исходные тесты TS о древесных");
                if (results.TryGetValue("B", out var rb))
                {
                    var end = rb.Probes["год 40"].zones[0];
                    double tot = 0;
                    foreach (var v in end.HerbBySpecies) tot += v;
                    pT.Eq(end.HerbBySpecies[H("feather-grass")] / tot > 0.7 && end.HerbBySpecies[H("meadow-grass")] / tot < 0.1 && end.Biomes[Bi("steppe")] > end.Biomes[Bi("meadow")],
                        () => $"Опыт B: ковыль {end.HerbBySpecies[H("feather-grass")] / tot:F2}, мятлик {end.HerbBySpecies[H("meadow-grass")] / tot:F2}");
                    pT.Eq(end.TreeCover < 0.01 && Forest(end) < 20, () => $"Опыт B: полог деревьев {end.TreeCover:F4}, лес {Forest(end)}");
                    pT.Notes["B.featherShare"] = end.HerbBySpecies[H("feather-grass")] / tot;
                    pT.Notes["B.treeCover"] = end.TreeCover;
                }
                if (results.TryGetValue("shadeOpen", out var ro) && results.TryGetValue("shadeSpruce", out var rs))
                {
                    var open = ro.Probes["итог"].zones[0];
                    var shaded = rs.Probes["итог"].zones[0];
                    double Tol(Zone z) => z.HerbBySpecies[H("bilberry")] + z.HerbBySpecies[H("moss")];
                    pT.Eq(shaded.TreeCover > 0.7 && shaded.HerbBySpecies[H("meadow-grass")] < 0.3 * open.HerbBySpecies[H("meadow-grass")],
                        () => $"Опыт C: полог {shaded.TreeCover:F2}, мятлик под пологом {shaded.HerbBySpecies[H("meadow-grass")]:F1} / открыто {open.HerbBySpecies[H("meadow-grass")]:F1}");
                    pT.Eq(Tol(shaded) > shaded.HerbBySpecies[H("meadow-grass")] && open.HerbBySpecies[H("meadow-grass")] > 10 * Tol(open) && shaded.HerbBySpecies[H("clover")] < 1,
                        () => $"Опыт C: теневыносливые {Tol(shaded):F1} / мятлик {shaded.HerbBySpecies[H("meadow-grass")]:F1}; открыто мятлик {open.HerbBySpecies[H("meadow-grass")]:F1} / теневыносливые {Tol(open):F1}");
                    pT.Notes["C.shadedTreeCover"] = shaded.TreeCover;
                    pT.Notes["C.meadowOpen"] = open.HerbBySpecies[H("meadow-grass")];
                    pT.Notes["C.meadowShaded"] = shaded.HerbBySpecies[H("meadow-grass")];
                    pT.Notes["C.tolerantShaded"] = Tol(shaded);
                    pT.Notes["C.tolerantOpen"] = Tol(open);
                }
                if (results.TryGetValue("E5", out var r5) && results.TryGetValue("E6", out var r6))
                {
                    // Опыт E: тот же seed ещё раз — тот же хеш; другой seed — другой.
                    var again = Create(O(O(runs["E5"])["setup"]), (string)O(runs["E5"])["geoHash"]);
                    long endE = (long)MiniJson.Num(O(runs["E5"])["endTick"]);
                    while (again.World.Tick < endE) again.Step();
                    pT.Eq(again.StateHash() == r5.Sim.StateHash() && r5.Sim.StateHash() != r6.Sim.StateHash(), () => "Опыт E: детерминизм");
                }
                if (results.TryGetValue("birch", out var rbi))
                {
                    var s1 = rbi.Probes["лето 1"].plants[0];
                    var w1 = rbi.Probes["зима 1"].plants[0];
                    var s4 = rbi.Probes["лето 4"].plants[0];
                    pT.Eq(D(s1["leaf"]) > 0.9 && D(w1["leaf"]) < 0.1 && I(s4["alive"]) == 1 && D(s4["biomass"]) > 3 * D(s1["biomass"]) && rbi.Sim.World.Flora.Ledger[Ledger.Litterfall] > 0,
                        () => $"берёза: листва летом {D(s1["leaf"]):F2}, зимой {D(w1["leaf"]):F2}, масса {D(s1["biomass"]):F2} → {D(s4["biomass"]):F2}");
                    pT.Notes["birch.leafSummer1"] = D(s1["leaf"]);
                    pT.Notes["birch.leafWinter1"] = D(w1["leaf"]);
                    pT.Notes["birch.biomassSummer1"] = D(s1["biomass"]);
                    pT.Notes["birch.biomassSummer4"] = D(s4["biomass"]);
                }
                if (results.TryGetValue("pine", out var rp)) pT.Eq(D(rp.Probes["через 15 суток"].plants[0]["leaf"]) == 1, () => "сосна: хвоя зимой не 1");
                foreach (var bn in new[] { "balanceWet", "balanceDry" })
                {
                    if (!results.TryGetValue(bn, out var rr)) continue;
                    var l = rr.Sim.World.Flora.Ledger;
                    int neg = 0;
                    var f = rr.Sim.World.Flora;
                    for (int i = 0; i < f.Nutrient.Length; i++) if (f.Nutrient[i] < 0 || f.LitterFast[i] < 0 || f.LitterWood[i] < 0) neg++;
                    pT.Eq(l[Ledger.Weathering] > 0 && l[Ledger.Fixation] > 0 && l[Ledger.Decomposition] > 0 && BalanceError(rr.Sim) < 1e-4 && neg == 0, () => $"{bn}: потоки или баланс {BalanceError(rr.Sim):E2}, отрицательных {neg}");
                    pT.Notes[bn + ".balanceError"] = BalanceError(rr.Sim);
                }
                if (results.TryGetValue("storeFill", out var rf))
                {
                    var init = O(O(O(runs["storeFill"])["initial"])["soil"]);
                    var w = rf.Sim.World.Flora.Woody;
                    double lf = 0;
                    foreach (var v in rf.Sim.World.Flora.LitterFast) lf += v;
                    pT.Eq(I(A(O(O(runs["storeFill"])["initial"])["store"])[0]) == w.Capacity && w.Count <= w.Capacity && lf > D(init["litterFast"]) && BalanceError(rf.Sim) < 1e-4,
                        () => $"хранилище: заполнено {A(O(O(runs["storeFill"])["initial"])["store"])[0]}/{w.Capacity}, опад {lf:F1}");
                }
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    if (!results.TryGetValue($"spread-{seed}", out var rr)) continue;
                    var s0 = rr.Probes["начало"].zones;
                    var s3 = rr.Probes["3 года"].zones;
                    var s10 = rr.Probes["10 лет"].zones;
                    pT.Eq(s0[0].HerbOccupancy == 0 && s3[1].HerbOccupancy > s3[2].HerbOccupancy && s10[0].HerbOccupancy > 0.6 && s10[0].Trees + s10[0].Shrubs > 0
                        && rr.Sim.World.Flora.Ledger[Ledger.External] == 0 && BalanceError(rr.Sim) < 1e-4,
                        () => $"тест C seed {seed}: ближе {s3[1].HerbOccupancy:F2} / дальше {s3[2].HerbOccupancy:F2}, поле {s10[0].HerbOccupancy:F2}, потомков {s10[0].Trees + s10[0].Shrubs}");
                    pT.Notes[$"spread{seed}.offspring"] = s10[0].Trees + s10[0].Shrubs;
                }

                // C1: смерти, рождения, повторное использование индексов; повторный прогон 5 суток — тот же хеш.
                var pC1 = New("C1: нагрузочный стенд");
                if (results.TryGetValue("C1", out var c1))
                {
                    var p = c1.Profile;
                    pC1.Eq(p.Deaths > 0 && p.Established > 0 && ck.Reused > 0, () => $"C1: смертей {p.Deaths}, всходов {p.Established}, повторных индексов {ck.Reused}");
                    var again = Create(O(O(runs["C1"])["setup"]), (string)O(runs["C1"])["geoHash"]);
                    opt.Configure?.Invoke(again);
                    long st = again.World.Tick;
                    while (again.World.Tick < st + 5L * SimTime.TicksPerDay) again.Step();
                    string expect = (string)O(A(O(runs["C1"])["days"])[4])["stateHash"];
                    pC1.Eq(again.StateHash() == expect, () => "C1: повторный прогон 5 суток — другой хеш");
                    opt.Release?.Invoke(again);
                    pC1.Notes["deaths"] = p.Deaths;
                    pC1.Notes["established"] = p.Established;
                    pC1.Notes["seedingPlants"] = p.SeedingPlants;
                }
            }

            bool ok = true;
            int checkedAll = 0, failedAll = 0;
            var sb = new StringBuilder("{\"parts\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                var p = parts[i];
                ok &= p.Failed == 0 && (p.Checked > 0 || opt.Only != null);
                checkedAll += p.Checked;
                failedAll += p.Failed;
                var notes = new StringBuilder();
                foreach (var kv in p.Notes) notes.Append(notes.Length > 0 ? "," : "").Append(MiniJson.Q(kv.Key)).Append(':').Append(MiniJson.N(kv.Value));
                log($"g3c[{opt.Label}] {p.Name}: {(p.Failed == 0 && p.Checked > 0 ? "OK" : "FAIL")} — проверок {p.Checked}, расхождений {p.Failed}{(p.Notes.Count > 0 ? "; " + notes : "")}{(p.Examples.Count > 0 ? "; " + string.Join(" | ", p.Examples) : "")}");
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(p.Name)).Append(",\"checked\":").Append(p.Checked).Append(",\"failed\":").Append(p.Failed)
                    .Append(",\"notes\":{").Append(notes).Append("},\"examples\":[").Append(string.Join(",", p.Examples.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("],\"checked\":").Append(checkedAll).Append(",\"failed\":").Append(failedAll)
                .Append(",\"totalS\":").Append(MiniJson.N(Math.Round(total.Elapsed.TotalSeconds, 1))).Append(",\"perf\":{").Append(perf).Append("}}");
            log($"g3c[{opt.Label}] итого: проверок {checkedAll}, расхождений {failedAll}; {total.Elapsed.TotalSeconds:F0} с");
            reportJson = sb.ToString();
            return ok;
        }
    }
}
