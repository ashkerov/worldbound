// Golden-проверка G2 (Stage 2.1): начальное состояние мира до первого такта — побитно против конструктора TS
// `Simulation` (tools/unity-flora-g2-golden.ts → Golden/flora-g2.json). Плюс независимые проверки C# для Genesis и
// Wildlands, детерминизм, совпадение пошаговой сборки (заселение → покров → биомы) с полным созданием, стенд с
// древесными (путь полога и покрова с растениями) и замеры времени и памяти.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraG2Golden
    {
        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static string Bits(double v) => MiniJson.Bits(v);
        static int I(object o) => (int)MiniJson.Num(o);

        sealed class Case
        {
            public string Name;
            public int Checked, Failed;
            public readonly List<string> Examples = new();
            public string Hash;
            public readonly StringBuilder Perf = new();

            public void Eq(bool ok, Func<string> what)
            {
                Checked++;
                if (ok) return;
                Failed++;
                if (Examples.Count < 10) Examples.Add(what());
            }
        }

        public static Dictionary<string, string> Arrays(FloraState f)
        {
            var b = f.Biome;
            var w = f.Woody;
            string H<T>(T[] a) where T : struct => StateHasher.Fnv(a);
            return new Dictionary<string, string>
            {
                ["slotSpecies"] = H(f.SlotSpecies), ["slotBiomass"] = H(f.SlotBiomass), ["litterFast"] = H(f.LitterFast), ["litterFastN"] = H(f.LitterFastN), ["litterFastQ"] = H(f.LitterFastQ),
                ["litterWood"] = H(f.LitterWood), ["litterWoodN"] = H(f.LitterWoodN), ["nutrient"] = H(f.Nutrient), ["accT"] = H(f.AccT), ["accW"] = H(f.AccW), ["accRunoff"] = H(f.AccRunoff),
                ["accMinT"] = H(f.AccMinT), ["accHours"] = H(f.AccHours), ["dayT"] = H(f.DayT), ["dayW"] = H(f.DayW), ["capillary"] = H(f.Capillary), ["seedBank"] = H(f.SeedBank),
                ["woodyCount"] = H(f.WoodyCount), ["canopy"] = H(f.Canopy), ["treeCover"] = H(f.TreeCover), ["shrubCover"] = H(f.ShrubCover), ["coniferCover"] = H(f.ConiferCover),
                ["tallCover"] = H(f.TallCover), ["colonistMass"] = H(f.ColonistMass), ["colonistFirst"] = H(f.ColonistFirst), ["ledger"] = H(f.Ledger),
                ["biome.herb"] = H(b.Herb), ["biome.steppe"] = H(b.Steppe), ["biome.wet"] = H(b.Wet), ["biome.pioneer"] = H(b.Pioneer), ["biome.moisture"] = H(b.Moisture),
                ["biome.tree"] = H(b.Tree), ["biome.shrub"] = H(b.Shrub), ["biome.conifer"] = H(b.Conifer), ["biome.tall"] = H(b.Tall), ["biome.current"] = H(b.Current),
                ["biome.candidate"] = H(b.Candidate), ["biome.days"] = H(b.Days),
                ["woody.x"] = H(w.X), ["woody.z"] = H(w.Z), ["woody.species"] = H(w.Species), ["woody.age"] = H(w.Age), ["woody.biomass"] = H(w.Biomass), ["woody.leaf"] = H(w.Leaf),
                ["woody.health"] = H(w.Health), ["woody.stage"] = H(w.Stage), ["woody.stressW"] = H(w.StressW), ["woody.stressL"] = H(w.StressL), ["woody.cell"] = H(w.Cell),
                ["woody.alive"] = H(w.Alive), ["woody.generation"] = H(w.Generation), ["woody.free"] = H(w.FreeSlots()),
            };
        }

        static WorldConfig ConfigOf(Dictionary<string, object> c) => new()
        {
            Seed = (uint)MiniJson.Num(c["seed"]),
            Size = (string)c["size"] == "S" ? WorldSize.S : WorldSize.M,
            Scenario = (string)c["scenario"] == "genesis" ? Scenario.Genesis : Scenario.Wild,
            Climate = (string)c["climate"] == "cold" ? Climate.Cold : (string)c["climate"] == "warm" ? Climate.Warm : Climate.Temperate,
            DaysPerSeason = I(c["daysPerSeason"]),
            Isolated = (bool)c["isolated"],
        };

        /// <summary>Сравнение снимка состояния с эталоном (те же поля, что snapshot() в инструменте TS).</summary>
        static void Compare(Case k, Simulation sim, Dictionary<string, object> e)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            k.Hash = sim.StateHash();
            k.Eq(k.Hash == (string)e["stateHash"], () => $"stateHash {k.Hash} ≠ {e["stateHash"]}");
            k.Eq(w.Tick == (long)MiniJson.Num(e["tick"]), () => $"такт {w.Tick} ≠ {e["tick"]}");
            var arrays = Arrays(f);
            foreach (var kv in O(e["arrays"])) { var key = kv.Key; k.Eq(arrays.TryGetValue(key, out var v) && v == (string)kv.Value, () => $"{key}: {(arrays.TryGetValue(key, out var v2) ? v2 : "нет")} ≠ {kv.Value}"); }
            k.Eq(arrays.Count == O(e["arrays"]).Count, () => $"массивов в C# {arrays.Count}, в эталоне {O(e["arrays"]).Count}");
            var env = O(e["env"]);
            k.Eq(StateHasher.Fnv(w.Env.Greenness) == (string)env["greenness"], () => $"env.greenness {StateHasher.Fnv(w.Env.Greenness)} ≠ {env["greenness"]}");
            k.Eq(StateHasher.Fnv(w.Env.Moisture) == (string)env["moisture"], () => "env.moisture");
            k.Eq(StateHasher.Fnv(w.Env.Snow) == (string)env["snow"], () => "env.snow");
            var ledger = A(e["ledger"]);
            for (int j = 0; j < ledger.Count; j++) { int jj = j; k.Eq(Bits(f.Ledger[j]) == (string)ledger[j], () => $"ledger[{jj}] {Bits(f.Ledger[jj])} ≠ {ledger[jj]}"); }
            double stock = FloraState.NutrientStock(f, geo);
            k.Eq(Bits(stock) == (string)e["stock"], () => $"nutrientStock {Bits(stock)} ≠ {e["stock"]}");
            k.Eq(Bits(FloraState.NutrientBudget(f)) == (string)e["budget"], () => "nutrientBudget");
            k.Eq(f.RegionalSeedRain == (bool)e["regionalSeedRain"], () => $"regionalSeedRain {f.RegionalSeedRain}");
            k.Eq(Bits(f.PreparedYears) == (string)e["preparedYears"], () => "preparedYears");
            k.Eq(f.LastSliceHour == (long)MiniJson.Num(e["lastSliceHour"]), () => "lastSliceHour");
            var p = sim.Preparation;
            if (e["preparation"] == null) k.Eq(p == null, () => "подготовка: в TS нет, в C# есть");
            else
            {
                var pe = O(e["preparation"]);
                k.Eq(p != null && p.StartTick == (long)MiniJson.Num(pe["startTick"]) && p.TargetTick == (long)MiniJson.Num(pe["targetTick"]) && Bits(p.Years) == (string)pe["years"],
                    () => $"подготовка {(p == null ? "нет" : $"{p.StartTick}…{p.TargetTick}, {p.Years} лет")} ≠ {pe["startTick"]}…{pe["targetTick"]}");
            }
            k.Eq(Bits(sim.PreparationFraction()) == (string)e["preparationFraction"], () => "preparationFraction");
            // Сводки: считаются в C# по состоянию и сверяются с теми же сводками TS.
            var s = O(e["summary"]);
            int count = geo.N * geo.N;
            int land = 0, seedLand = 0, seedWater = 0, greenNonZero = 0, herbSlots = 0;
            double seedSum = 0, greenMax = 0;
            var t = f.Species;
            for (int c = 0; c < count; c++)
            {
                bool isLand = geo.WaterKind[c] == WaterKind.None;
                if (isLand)
                {
                    land++;
                    if (w.Env.Greenness[c] != 0) greenNonZero++;
                    if (w.Env.Greenness[c] > greenMax) greenMax = w.Env.Greenness[c];
                }
                bool any = false;
                for (int h = 0; h < t.Herbs.Length; h++)
                {
                    double v = f.SeedBank[h * count + c];
                    if (v > 0) any = true;
                    seedSum += v;
                }
                if (any) { if (isLand) seedLand++; else seedWater++; }
            }
            for (int j = 0; j < count * FloraState.Slots; j++) if (f.SlotSpecies[j] != SpeciesTable.NoSpecies) herbSlots++;
            k.Eq(land == I(s["landCells"]), () => "landCells");
            k.Eq(seedLand == I(s["seedBankLandCells"]) && seedWater == I(s["seedBankWaterCells"]) && Bits(seedSum) == (string)s["seedBankSum"], () => $"банк семян: суша {seedLand}/{s["seedBankLandCells"]}, вода {seedWater}/{s["seedBankWaterCells"]}");
            k.Eq(greenNonZero == I(s["greennessLandNonZero"]) && Bits(greenMax) == (string)s["greennessLandMax"], () => $"покров суши ≠ 0: {greenNonZero}/{s["greennessLandNonZero"]}");
            k.Eq(herbSlots == I(s["herbSlotsUsed"]) && f.Woody.Count == I(s["woodyCount"]) && f.Woody.HighWater == I(s["woodyHighWater"]), () => "травы/древесные");
            var counts = BiomeState.Counts(w);
            var ce = A(s["biomeCounts"]);
            for (int j = 0; j < ce.Count; j++) { int jj = j; k.Eq(counts[j] == I(ce[j]), () => $"биом {BiomeCatalog.All[jj].Id}: {counts[jj]} ≠ {ce[jj]}"); }
        }

        /// <summary>Обязательные свойства сценария — проверяются по состоянию C# независимо от эталона.</summary>
        static void Properties(Case k, Simulation sim)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            int count = geo.N * geo.N;
            bool genesis = w.Config.Scenario == Scenario.Genesis;
            bool herbsEmpty = true, woodyEmpty = f.Woody.Count == 0 && f.Woody.HighWater == 0, greenZero = true, waterBiomes = true, waterSeeds = false, landSeeds = false;
            for (int j = 0; j < count * FloraState.Slots; j++) if (f.SlotSpecies[j] != SpeciesTable.NoSpecies || f.SlotBiomass[j] != 0) herbsEmpty = false;
            int river = Biomes.IndexOf("river"), lake = Biomes.IndexOf("lake"), sea = Biomes.IndexOf("sea");
            for (int c = 0; c < count; c++)
            {
                byte kind = geo.WaterKind[c];
                if (kind == WaterKind.None && w.Env.Greenness[c] != 0) greenZero = false;
                if (kind != WaterKind.None)
                {
                    int want = kind == WaterKind.River ? river : kind == WaterKind.Lake ? lake : sea;
                    if (f.Biome.Current[c] != want || f.Biome.Candidate[c] != want || f.Biome.Days[c] != 0) waterBiomes = false;
                }
                for (int h = 0; h < f.Species.Herbs.Length; h++)
                    if (f.SeedBank[h * count + c] > 0) { if (kind == WaterKind.None) landSeeds = true; else waterSeeds = true; }
            }
            double stock = FloraState.NutrientStock(f, geo);
            bool ledgerStart = f.Ledger[Ledger.InitialStock] == stock;
            for (int j = 0; j < Ledger.Size; j++) if (j != Ledger.InitialStock && f.Ledger[j] != 0) ledgerStart = false;
            k.Eq(herbsEmpty, () => "травяной ярус не пуст");
            k.Eq(woodyEmpty, () => "есть древесные");
            k.Eq(greenZero, () => "покров суши не 0 (растений нет)");
            k.Eq(waterBiomes, () => "водные биомы неверны");
            k.Eq(ledgerStart && FloraState.NutrientBudget(f) == 0, () => "ведомость: не нули или initialStock ≠ полный запас");
            k.Eq(!waterSeeds, () => "банк семян в воде");
            if (genesis)
            {
                k.Eq(!landSeeds, () => "Genesis: банк семян не пуст");
                k.Eq(!f.RegionalSeedRain && sim.Preparation == null, () => "Genesis: семена региона или подготовка");
            }
            else
            {
                long perYear = (long)w.Config.DaysPerSeason * SimTime.SeasonsPerYear * SimTime.TicksPerDay;
                var p = sim.Preparation;
                k.Eq(landSeeds, () => "Wildlands: нет банка семян на суше");
                k.Eq(f.RegionalSeedRain, () => "Wildlands: семена региона выключены");
                k.Eq(p != null && p.Years == WorldConfig.WildlandsYears && p.StartTick == w.Tick && p.TargetTick - p.StartTick == (long)WorldConfig.WildlandsYears * perYear && sim.PreparationFraction() == 0,
                    () => "Wildlands: метаданные подготовки (20 лет от текущего такта)");
            }
        }

        static double[] Stats(List<double> xs)
        {
            var s = new List<double>(xs);
            s.Sort();
            double mean = 0;
            foreach (var v in s) mean += v;
            mean /= s.Count;
            double P(double q) => s[Math.Min(s.Count - 1, (int)Math.Floor(q * s.Count))];
            return new[] { mean, P(0.95), P(0.99), s[0], s[s.Count - 1], s.Count };
        }

        static string StatJson(List<double> xs)
        {
            var st = Stats(xs);
            return $"{{\"n\":{st[5]},\"mean\":{MiniJson.N(Math.Round(st[0], 3))},\"p95\":{MiniJson.N(Math.Round(st[1], 3))},\"p99\":{MiniJson.N(Math.Round(st[2], 3))},\"min\":{MiniJson.N(Math.Round(st[3], 3))},\"max\":{MiniJson.N(Math.Round(st[4], 3))}}}";
        }

        public static bool Run(string goldenJson, Action<string> log, out string reportJson)
        {
            var root = O(MiniJson.Parse(goldenJson));
            var cases = new List<Case>();
            var sb = new StringBuilder("{\"cases\":[");
            bool ok = true;
            var hashes = new HashSet<string>();
            var sw = Stopwatch.StartNew();
            foreach (var co in A(root["cases"]))
            {
                var c = O(co);
                var k = new Case { Name = $"{c["scenario"]} {c["size"]}/{MiniJson.Num(c["seed"])}" };
                cases.Add(k);
                var config = ConfigOf(c);
                var gen = Generate.World(config);
                k.Eq(gen.Hash == (string)c["geoHash"], () => $"geoHash {gen.Hash} ≠ {c["geoHash"]}");
                var sim = new Simulation(config, gen);
                Compare(k, sim, c);
                Properties(k, sim);
                // Детерминизм: повтор из тех же входов; разные случаи — разные хеши.
                string again = new Simulation(config, gen).StateHash();
                k.Eq(again == k.Hash && (bool)c["deterministicRepeat"], () => "повтор дал другой хеш");
                k.Eq(hashes.Add(k.Hash), () => "хеш совпал с другим сценарием/seed");
                // Пошаговая сборка (без заселения, затем те же шаги) = полное создание (подготовка в хеш не входит).
                int reps = config.Size == WorldSize.S ? 12 : 4;
                var full = new List<double>();
                var pop = new List<double>();
                var cover = new List<double>();
                var biomes = new List<double>();
                var create = new List<double>();
                string steps = null;
                var t = new Stopwatch();
                for (int r = 0; r < reps; r++)
                {
                    t.Restart();
                    new Simulation(config, gen);
                    full.Add(t.Elapsed.TotalMilliseconds);
                    t.Restart();
                    var bare = new Simulation(config, gen, null, new SimulationOptions { Populate = false });
                    create.Add(t.Elapsed.TotalMilliseconds);
                    t.Restart();
                    if (config.Scenario == Scenario.Genesis) Populate.Genesis(bare.World); else Populate.Wildlands(bare.World);
                    pop.Add(t.Elapsed.TotalMilliseconds);
                    t.Restart();
                    Cover.Refresh(bare.World, true);
                    cover.Add(t.Elapsed.TotalMilliseconds);
                    t.Restart();
                    BiomeState.InitBiomes(bare.World);
                    biomes.Add(t.Elapsed.TotalMilliseconds);
                    steps = bare.StateHash();
                }
                k.Eq(steps == k.Hash && steps == (string)c["stepsStateHash"], () => $"пошаговая сборка {steps} ≠ {k.Hash}");
                // Память: управляемая куча, занятая одной симуляцией (рельеф уже есть).
                GC.Collect();
                long mem0 = GC.GetTotalMemory(true);
                var keep = new Simulation(config, gen);
                long mem = GC.GetTotalMemory(true) - mem0;
                GC.KeepAlive(keep);
                var ts = O(c["tsTiming"]);
                string Ts(string key) { var x = O(ts[key]); return $"{{\"mean\":{MiniJson.N(Math.Round(MiniJson.Num(x["mean"]), 3))},\"p95\":{MiniJson.N(Math.Round(MiniJson.Num(x["p95"]), 3))}}}"; }
                k.Perf.Append($"\"fullInitMs\":{StatJson(full)},\"simulationWithoutFloraInitMs\":{StatJson(create)},\"populateMs\":{StatJson(pop)},\"refreshCoverMs\":{StatJson(cover)},\"initBiomesMs\":{StatJson(biomes)},\"simulationHeapMB\":{MiniJson.N(Math.Round(mem / 1048576.0, 1))}")
                    .Append($",\"ts\":{{\"fullInitMs\":{Ts("fullInitMs")},\"populateMs\":{Ts("populateMs")},\"refreshCoverMs\":{Ts("refreshCoverMs")},\"initBiomesMs\":{Ts("initBiomesMs")}}}");
                var fs = Stats(full);
                log($"g2 {k.Name}: {(k.Failed == 0 ? "OK" : "FAIL")} — проверок {k.Checked}, расхождений {k.Failed}; stateHash {k.Hash}; создание {fs[0]:F1} мс (p95 {Stats(full)[1]:F1}), заселение {Stats(pop)[0]:F2}, полог {Stats(cover)[0]:F2}, биомы {Stats(biomes)[0]:F2} мс; куча {mem / 1048576.0:F1} МБ{(k.Examples.Count > 0 ? "; " + string.Join(" | ", k.Examples) : "")}");
            }
            // Стенд: Genesis S/42 + 20 000 древесных — полог, покров и биомы с настоящими растениями.
            {
                var st = O(root["stand"]);
                var k = new Case { Name = "стенд genesis S/42 + 20000 древесных" };
                cases.Add(k);
                var sim = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S, Scenario = Scenario.Genesis });
                var t = Stopwatch.StartNew();
                int planted = Populate.LoadStand(sim.World, I(st["target"]));
                double ms = t.Elapsed.TotalMilliseconds;
                k.Eq(planted == I(st["planted"]), () => $"посажено {planted} ≠ {st["planted"]}");
                Compare(k, sim, st);
                k.Perf.Append($"\"loadStandMs\":{MiniJson.N(Math.Round(ms, 2))},\"ts\":{{\"loadStandMs\":{MiniJson.N(Math.Round(MiniJson.Num(st["tsMs"]), 2))}}}");
                log($"g2 {k.Name}: {(k.Failed == 0 ? "OK" : "FAIL")} — проверок {k.Checked}, расхождений {k.Failed}; stateHash {k.Hash}; посажено {planted}, {ms:F1} мс{(k.Examples.Count > 0 ? "; " + string.Join(" | ", k.Examples) : "")}");
            }
            int total = 0, failed = 0;
            for (int i = 0; i < cases.Count; i++)
            {
                var k = cases[i];
                ok &= k.Failed == 0 && k.Checked > 0;
                total += k.Checked;
                failed += k.Failed;
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(k.Name)).Append(",\"stateHash\":").Append(MiniJson.Q(k.Hash)).Append(",\"checked\":").Append(k.Checked).Append(",\"failed\":").Append(k.Failed)
                    .Append(",\"examples\":[").Append(string.Join(",", k.Examples.ConvertAll(MiniJson.Q))).Append("],\"perf\":{").Append(k.Perf).Append("}}");
            }
            sb.Append("],\"checked\":").Append(total).Append(",\"failed\":").Append(failed).Append(",\"totalMs\":").Append(MiniJson.N(Math.Round(sw.Elapsed.TotalMilliseconds))).Append('}');
            log($"g2 итого: проверок {total}, расхождений {failed}, {sw.Elapsed.TotalSeconds:F1} с");
            reportJson = sb.ToString();
            return ok;
        }
    }
}
