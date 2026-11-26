// Golden-проверка G3 B (Stage 2.3): травяной ярус — побитно против настоящего TS `Simulation`
// (tools/unity-flora-g3b-golden.ts → Golden/flora-g3b.json) и 12 обязательных проверок свойств модели по состоянию C#.
//  • B1 (WET) и B2 (DRY): участок 48 × 48, опушка без древесных, 20 лет — stateHash после каждой порции первых суток B1,
//    затем каждые сутки: stateHash, ведомость, запас, бюджет, ошибка баланса, биомы, сводки трав, массивы;
//  • малые опыты 32 × 32: рост, конкуренция, предел питания, мороз, засуха/исчезновение, расселение у реки,
//    прорастание, старение банка — сутки побитно с TS плюс проверки свойств после каждой порции;
//  • нагрузка: Genesis S/42 и M/42 с лугом и банком на всей суше — 2 суток, время, разбивка по частям шага, память, GC.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraG3BGolden
    {
        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static string Bits(double v) => MiniJson.Bits(v);
        static int I(object o) => (int)MiniJson.Num(o);

        sealed class Part
        {
            public string Name;
            public int Checked, Failed;
            public long Cells;
            public readonly List<string> Examples = new();
            public readonly Dictionary<string, double> Notes = new();

            public void Eq(bool ok, Func<string> what)
            {
                Checked++;
                if (ok) return;
                Failed++;
                if (Examples.Count < 10) Examples.Add(what());
            }

            public void Fail(string what)
            {
                Failed++;
                if (Examples.Count < 10) Examples.Add(what);
            }
        }

        public sealed class Options
        {
            public Action<Simulation> Configure;
            public Action<Simulation> Release;
            /// <summary>Сколько суток B1/B2 проверять (null — все из эталона).</summary>
            public int? Days;
            public string Label = "managed";
            /// <summary>Выделено байт текущим потоком (.NET); null — не замерять.</summary>
            public Func<long> AllocatedBytes;
        }

        // ───────── Создание участка и начальная заливка (как create/applyFills в инструменте TS) ─────────

        static Simulation Create(Dictionary<string, object> setup, string geoHash)
        {
            uint seed = (uint)MiniJson.Num(setup["seed"]);
            if (setup.TryGetValue("plot", out var po) && po != null)
            {
                var geo = PlotGeo.Build(PlotOptions.From(O(po)));
                var cfg = new WorldConfig { Seed = seed, Size = WorldSize.S, DaysPerSeason = 5, Scenario = Scenario.Genesis, Isolated = true };
                return new Simulation(cfg, new Generate.Result { Geo = geo, Hash = geoHash });
            }
            var size = (string)setup["size"] == "M" ? WorldSize.M : WorldSize.S;
            return new Simulation(new WorldConfig { Seed = seed, Size = size, Scenario = Scenario.Genesis, Isolated = true });
        }

        static int HerbIndex(SpeciesTable t, string id)
        {
            int i = t.IndexOf(id);
            if (t.Woody[i] == 1) throw new ArgumentException($"не трава: {id}");
            return i;
        }

        static void ApplyFills(Simulation sim, List<object> fills)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            var t = f.Species;
            int n = geo.N, count = n * n, m = 0;
            var herbs = t.Herbs;
            foreach (var fo in fills)
            {
                var fill = O(fo);
                int x0 = I(fill["x0"]);
                int x1 = (int)Math.Min(MiniJson.Num(fill["x1"]), n);
                for (int z = 0; z < n; z++)
                    for (int x = x0; x < x1; x++)
                    {
                        int c = z * n + x;
                        if (geo.WaterKind[c] != WaterKind.None) continue;
                        if (fill.TryGetValue("bank", out var bo))
                        {
                            var b = O(bo);
                            float v = (float)MiniJson.Num(b["value"]);
                            if (b["species"] is string) foreach (int s in herbs) f.SeedBank[t.HerbSlot[s] * count + c] = v;
                            else foreach (var id in A(b["species"])) f.SeedBank[t.HerbSlot[HerbIndex(t, (string)id)] * count + c] = v;
                        }
                        if (fill.TryGetValue("cycle", out var cy))
                            for (int k = 0; k < FloraState.Slots; k++)
                            {
                                f.SlotSpecies[c * FloraState.Slots + k] = (byte)herbs[m++ % herbs.Length];
                                f.SlotBiomass[c * FloraState.Slots + k] = (float)MiniJson.Num(cy);
                            }
                        if (fill.TryGetValue("slots", out var so))
                        {
                            var list = A(so);
                            for (int k = 0; k < list.Count; k++)
                            {
                                var pair = A(list[k]);
                                f.SlotSpecies[c * FloraState.Slots + k] = (byte)HerbIndex(t, (string)pair[0]);
                                f.SlotBiomass[c * FloraState.Slots + k] = (float)MiniJson.Num(pair[1]);
                            }
                        }
                        if (fill.TryGetValue("nutrient", out var nu)) f.Nutrient[c] = (float)MiniJson.Num(nu);
                    }
            }
            Cover.Refresh(w, true);
            Array.Clear(f.Ledger, 0, f.Ledger.Length);
            f.Ledger[Ledger.InitialStock] = FloraState.NutrientStock(f, geo);
        }

        // ───────── Сводки (те же, что summary()/herbs()/arrays() в инструменте TS) ─────────

        sealed class HerbStats
        {
            public double[] Biomass, Bank;
            public int[] Slots;
            public int Occupied, NewCells, Frontier;
            public double Green, Litter;
        }

        static HerbStats Herbs(Simulation sim, int sourceColumns)
        {
            var f = sim.World.Flora;
            var t = f.Species;
            int n = sim.World.Geo.N, count = n * n, H = t.Herbs.Length;
            var r = new HerbStats { Biomass = new double[H], Bank = new double[H], Slots = new int[H], Frontier = -1 };
            for (int c = 0; c < count; c++)
            {
                double hb = 0;
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    int s = f.SlotSpecies[c * FloraState.Slots + k];
                    if (s == SpeciesTable.NoSpecies) continue;
                    double b = f.SlotBiomass[c * FloraState.Slots + k];
                    int h = t.HerbSlot[s];
                    r.Biomass[h] += b;
                    r.Slots[h]++;
                    hb += b;
                }
                r.Green += sim.World.Env.Greenness[c];
                r.Litter += f.LitterFast[c];
                if (hb > 1)
                {
                    r.Occupied++;
                    int x = c % n;
                    if (x >= sourceColumns) r.NewCells++;
                    if (x > r.Frontier) r.Frontier = x;
                }
            }
            for (int h = 0; h < H; h++) for (int c = 0; c < count; c++) r.Bank[h] += f.SeedBank[h * count + c];
            return r;
        }

        static Dictionary<string, string> Arrays(Simulation sim)
        {
            var f = sim.World.Flora;
            var e = sim.World.Env;
            var b = f.Biome;
            string H<T>(T[] a) where T : struct => StateHasher.Fnv(a);
            return new Dictionary<string, string>
            {
                ["slotSpecies"] = H(f.SlotSpecies), ["slotBiomass"] = H(f.SlotBiomass), ["seedBank"] = H(f.SeedBank), ["nutrient"] = H(f.Nutrient), ["litterFast"] = H(f.LitterFast),
                ["litterFastN"] = H(f.LitterFastN), ["litterFastQ"] = H(f.LitterFastQ), ["dayT"] = H(f.DayT), ["dayW"] = H(f.DayW), ["greenness"] = H(e.Greenness), ["moisture"] = H(e.Moisture),
                ["biome.herb"] = H(b.Herb), ["biome.steppe"] = H(b.Steppe), ["biome.wet"] = H(b.Wet), ["biome.pioneer"] = H(b.Pioneer), ["biome.current"] = H(b.Current),
            };
        }

        static void GeoPrint(Part p, Simulation sim, Dictionary<string, object> e, string where)
        {
            var g = sim.World.Geo;
            var d = sim.World.Derived;
            string H<T>(T[] a) where T : struct => StateHasher.Fnv(a);
            var mine = new Dictionary<string, string>
            {
                ["height"] = H(g.Height), ["slope"] = H(g.Slope), ["waterKind"] = H(g.WaterKind), ["waterLevel"] = H(g.WaterLevel), ["waterDist"] = H(g.WaterDist), ["seaDist"] = H(g.SeaDist),
                ["receiver"] = H(g.Receiver), ["upstreamOrder"] = H(g.UpstreamOrder), ["meanDischarge"] = H(g.MeanDischarge), ["lakeId"] = H(g.LakeId), ["tMean"] = H(g.TMean), ["tAmp"] = H(g.TAmp),
                ["precip"] = H(g.Precip), ["soil"] = H(g.Soil), ["fertility"] = H(g.Fertility), ["deposit"] = H(g.Deposit), ["depositRichness"] = H(g.DepositRichness), ["province"] = H(g.ProvinceOf),
                ["terrain"] = H(g.Terrain.Data), ["horizon"] = H(g.Horizon.Data), ["capacity"] = H(d.Capacity), ["pFactor"] = H(d.PFactor), ["drainHour"] = H(d.DrainHour),
            };
            foreach (var kv in mine) { var key = kv.Key; p.Eq(kv.Value == (string)e[key], () => $"{where}: статика {key} {mine[key]} ≠ {e[key]}"); }
            var edges = A(e["edges"]);
            for (int j = 0; j < 4; j++) { int jj = j; p.Eq(g.Edges[j] == I(edges[j]), () => $"{where}: край {jj}"); }
            p.Eq(g.N == I(e["n"]) && g.CellSize == I(e["cellSize"]) && sim.World.WorldSize == I(e["worldSize"]), () => $"{where}: размеры участка");
            p.Eq(Bits(g.WindX) == (string)e["windX"] && Bits(g.WindZ) == (string)e["windZ"], () => $"{where}: ветер");
            p.Eq(g.Terrain.Samples == I(e["terrainSamples"]) && g.Horizon.Samples == I(e["horizonSamples"]) && g.Horizon.Spacing == MiniJson.Num(e["horizonSpacing"]), () => $"{where}: сетки высот");
        }

        static void Summary(Part p, Simulation sim, Dictionary<string, object> e, string where, int sourceColumns)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            string hash = sim.StateHash();
            p.Eq(hash == (string)e["stateHash"], () => $"{where}: stateHash {hash} ≠ {e["stateHash"]}");
            p.Eq(w.Tick == (long)MiniJson.Num(e["tick"]), () => $"{where}: такт {w.Tick} ≠ {e["tick"]}");
            p.Eq(Bits(SimTime.YearFraction(w.Tick, w.Config.DaysPerSeason)) == (string)e["yearFrac"], () => $"{where}: доля года");
            var ledger = A(e["ledger"]);
            for (int j = 0; j < ledger.Count; j++) { int jj = j; p.Eq(Bits(f.Ledger[j]) == (string)ledger[j], () => $"{where}: ledger[{jj}] {Bits(f.Ledger[jj])} ≠ {ledger[jj]}"); }
            double stock = FloraState.NutrientStock(f, geo), budget = FloraState.NutrientBudget(f), init = f.Ledger[Ledger.InitialStock];
            p.Eq(Bits(stock) == (string)e["stock"] && Bits(budget) == (string)e["budget"], () => $"{where}: запас/бюджет");
            p.Eq(Bits(Math.Abs(stock - init - budget) / init) == (string)e["balanceError"], () => $"{where}: ошибка баланса");
            var bc = A(e["biomeCounts"]);
            var counts = BiomeState.Counts(w);
            for (int j = 0; j < bc.Count; j++) { int jj = j; p.Eq(counts[j] == I(bc[j]), () => $"{where}: биом {BiomeCatalog.All[jj].Id} {counts[jj]} ≠ {bc[jj]}"); }
            var he = O(e["herbs"]);
            var hs = Herbs(sim, sourceColumns);
            var eb = A(he["biomass"]);
            var ek = A(he["bank"]);
            var es = A(he["slots"]);
            for (int h = 0; h < hs.Biomass.Length; h++)
            {
                int hh = h;
                p.Eq(Bits(hs.Biomass[h]) == (string)eb[h], () => $"{where}: биомасса травы {hh}");
                p.Eq(Bits(hs.Bank[h]) == (string)ek[h], () => $"{where}: банк семян травы {hh}");
                p.Eq(hs.Slots[h] == I(es[h]), () => $"{where}: слотов травы {hh} {hs.Slots[hh]} ≠ {es[hh]}");
            }
            p.Eq(hs.Occupied == I(he["occupied"]) && hs.NewCells == I(he["newCells"]) && hs.Frontier == I(he["frontier"]), () => $"{where}: занятые ячейки/фронт");
            p.Eq(Bits(hs.Green) == (string)he["green"] && Bits(hs.Litter) == (string)he["litter"], () => $"{where}: покров/опад");
            if (e.TryGetValue("arrays", out var ao) && ao != null)
            {
                var mine = Arrays(sim);
                foreach (var kv in O(ao)) { var key = kv.Key; p.Eq(mine[key] == (string)kv.Value, () => $"{where}: {key} {mine[key]} ≠ {kv.Value}"); }
            }
        }

        // ───────── Проверки свойств после каждой порции ─────────

        sealed class Snapshot
        {
            public byte[] Sp;
            public float[] Bio, Bank, Nut;
            public double[] Led;

            public void Take(FloraState f)
            {
                Sp ??= new byte[f.SlotSpecies.Length];
                Bio ??= new float[f.SlotBiomass.Length];
                Bank ??= new float[f.SeedBank.Length];
                Nut ??= new float[f.Nutrient.Length];
                Led ??= new double[f.Ledger.Length];
                Array.Copy(f.SlotSpecies, Sp, Sp.Length);
                Array.Copy(f.SlotBiomass, Bio, Bio.Length);
                Array.Copy(f.SeedBank, Bank, Bank.Length);
                Array.Copy(f.Nutrient, Nut, Nut.Length);
                Array.Copy(f.Ledger, Led, Led.Length);
            }
        }

        /// <summary>Включённые проверки порций (null — выключена) и счётчики событий.</summary>
        sealed class Watch
        {
            public Part Competition, Nutrient, Frost, Extinction, SeedWindow, Germination, Aging;
            public readonly Snapshot Before = new();
            public bool Any => Competition != null || Nutrient != null || Frost != null || Extinction != null || SeedWindow != null || Germination != null || Aging != null;
        }

        static readonly List<int> processed = new();

        static void CheckPortion(Simulation sim, long tick, Watch wt, string where)
        {
            var w = sim.World;
            var f = w.Flora;
            var t = f.Species;
            var geo = w.Geo;
            var W = wt.Before;
            int n = geo.N, count = n * n, S = FloraState.Slots;
            long hour = tick / SimTime.TicksPerHour;
            int sub = (int)((tick - hour * SimTime.TicksPerHour) / FloraSystem.Period);
            int slice = (int)(hour % 24);
            int x0 = (int)Math.Floor(sub * n / (double)FloraSystem.Substeps), x1 = (int)Math.Floor((sub + 1) * n / (double)FloraSystem.Substeps);
            processed.Clear();
            for (int z = slice; z < n; z += 24)
                for (int x = x0; x < x1; x++)
                    if (geo.WaterKind[z * n + x] == WaterKind.None) processed.Add(z * n + x);
            double yf = SimTime.YearFraction(tick, w.Config.DaysPerSeason);
            bool germSeason = yf >= FloraSystem.GerminationSeason[0] && yf < FloraSystem.GerminationSeason[1];
            bool seedSeason = yf >= FloraSystem.HerbSeedSeason[0] && yf < FloraSystem.HerbSeedSeason[1];
            double dt = 1.0 / (w.Config.DaysPerSeason * SimTime.SeasonsPerYear);
            double area = geo.CellSize * geo.CellSize;
            string bad = null;
            int badCount = 0;
            void Bad(string s) { badCount++; bad ??= s; }

            int cBad = 0, nBad = 0, frBad = 0, agBad = 0;
            double deadSum = 0;
            foreach (int c in processed)
            {
                double T = f.DayT[c], snow = w.Env.Snow[c];
                bool cold = T < 2 || snow > 5;
                bool germ = germSeason && T > 6 && snow < 1;
                double light = FloraMath.GroundLight(f.Canopy, c);
                double before = 0, after = 0;
                for (int k = 0; k < S; k++) { before += W.Bio[c * S + k]; after += f.SlotBiomass[c * S + k]; }
                // 2. Суммарная биомасса после шага не выше max(было, вместимость лучшего вида ячейки).
                if (wt.Competition != null && !germ)
                {
                    double bound = before;
                    for (int k = 0; k < S; k++)
                    {
                        int s = W.Sp[c * S + k];
                        if (s == SpeciesTable.NoSpecies) continue;
                        bound = Math.Max(bound, FloraMath.HerbCapacity(t, s, FloraSystem.HerbFit(w, s, c, light), W.Nut[c]));
                    }
                    wt.Competition.Cells++;
                    if (after > bound * (1 + 1e-6) + 1e-9) { cBad++; Bad($"{where}: ячейка {c} травостой {after:F4} > вместимости {bound:F4}"); }
                    if (after > before && after >= bound * 0.999) wt.Competition.Notes["cellsAtCapacity"] = wt.Competition.Notes.GetValueOrDefault("cellsAtCapacity") + 1;
                }
                // 3. Прирост забирает не больше половины запаса питания: Σ Δb·N ≤ 0,5·питание.
                if (wt.Nutrient != null && !germ)
                {
                    double gain = 0, scaleN = 0;
                    for (int k = 0; k < S; k++)
                    {
                        int s = W.Sp[c * S + k];
                        if (s == SpeciesTable.NoSpecies) continue;
                        gain += ((double)f.SlotBiomass[c * S + k] - W.Bio[c * S + k]) * t.Nutrient[s];
                        scaleN += W.Bio[c * S + k] * t.Nutrient[s];
                    }
                    double limit = 0.5 * W.Nut[c];
                    wt.Nutrient.Cells++;
                    if (gain > limit + 1e-6 * scaleN + 1e-9) { nBad++; Bad($"{where}: ячейка {c} прирост забрал {gain:E4} > 0,5·питание {limit:E4}"); }
                    if (limit > 0) wt.Nutrient.Notes["maxShareOfLimit"] = Math.Max(wt.Nutrient.Notes.GetValueOrDefault("maxShareOfLimit"), gain / limit);
                    // Связывает ли предел: потребность прироста прохода 1 (формула TS) больше половины запаса.
                    double needN = 0;
                    if (!cold)
                        for (int k = 0; k < S; k++)
                        {
                            int s = W.Sp[c * S + k];
                            if (s == SpeciesTable.NoSpecies) continue;
                            double fit = FloraSystem.HerbFit(w, s, c, light);
                            double capacity = FloraMath.HerbCapacity(t, s, fit, W.Nut[c]);
                            double crowd = capacity > 0 ? 1 - before / capacity : -1;
                            if (crowd > 0) needN += t.Growth[s] * dt * W.Bio[c * S + k] * fit * Suitability.NutrientResponse(t, s, W.Nut[c]) * crowd * t.Nutrient[s];
                        }
                    if (needN > limit) wt.Nutrient.Notes["cellsAtNutrientLimit"] = wt.Nutrient.Notes.GetValueOrDefault("cellsAtNutrientLimit") + 1;
                }
                // 4. Холод: прироста нет; у видов с отмиранием надземная часть теряет ≥ 35 % сверх корневого запаса.
                if (wt.Frost != null && cold)
                {
                    wt.Frost.Cells++;
                    for (int k = 0; k < S; k++)
                    {
                        int s = W.Sp[c * S + k];
                        if (s == SpeciesTable.NoSpecies) continue;
                        double b0 = W.Bio[c * S + k], b1 = f.SlotBiomass[c * S + k];
                        if (b1 > b0) { frBad++; Bad($"{where}: ячейка {c} рост в холод {b0} → {b1}"); }
                        if (t.Dieback[s] == 1)
                        {
                            double cap = b0 - 0.35 * (b0 - Math.Min(b0, 0.1 * t.MaxBiomass[s]));
                            if (b1 > cap * (1 + 1e-6) + 1e-9) { frBad++; Bad($"{where}: ячейка {c} нет зимнего отмирания {b0} → {b1} (≤ {cap})"); }
                        }
                    }
                }
                // 9. Старение банка: bank' = bank − bank·min(1, dt/лет хранения), ровно как в float32.
                if (wt.Aging != null)
                {
                    for (int k = 0; k < S; k++) if (f.SlotSpecies[c * S + k] != SpeciesTable.NoSpecies) { agBad++; Bad($"{where}: ячейка {c}: проросли семена в опыте старения"); }
                    for (int h = 0; h < t.Herbs.Length; h++)
                    {
                        int o = h * count + c;
                        double b0 = W.Bank[o];
                        if (b0 <= 0) continue;
                        double dead = b0 * Math.Min(1, dt / t.SeedBankYears[t.Herbs[h]]);
                        deadSum += dead;
                        wt.Aging.Cells++;
                        if (f.SeedBank[o] != (float)(b0 - dead)) { agBad++; Bad($"{where}: ячейка {c} банк {f.SeedBank[o]} ≠ {(float)(b0 - dead)}"); }
                    }
                }
            }
            if (wt.Competition != null) wt.Competition.Eq(cBad == 0, () => bad);
            if (wt.Nutrient != null) wt.Nutrient.Eq(nBad == 0, () => bad);
            if (wt.Frost != null) wt.Frost.Eq(frBad == 0, () => bad);
            if (wt.Aging != null)
            {
                double dl = f.Ledger[Ledger.Litterfall] - W.Led[Ledger.Litterfall];
                double expect = deadSum * area / 1000;
                wt.Aging.Eq(agBad == 0 && Math.Abs(dl - expect) <= 1e-9 * Math.Max(1e-12, expect), () => bad ?? $"{where}: опад {dl:E6} ≠ отмершие семена {expect:E6}");
            }
            // 5. Исчезновение: слот без вида — биомасса ровно 0; переход вид → пусто только с ростом опада.
            if (wt.Extinction != null)
            {
                int ext = 0, eBad = 0;
                for (int j = 0; j < f.SlotSpecies.Length; j++)
                {
                    if (f.SlotSpecies[j] == SpeciesTable.NoSpecies && f.SlotBiomass[j] != 0) { eBad++; Bad($"{where}: слот {j} без вида с биомассой {f.SlotBiomass[j]}"); }
                    if (W.Sp[j] != SpeciesTable.NoSpecies && f.SlotSpecies[j] == SpeciesTable.NoSpecies) ext++;
                }
                if (ext > 0 && !(f.Ledger[Ledger.Litterfall] > W.Led[Ledger.Litterfall])) { eBad++; Bad($"{where}: исчезло {ext} популяций без опада"); }
                wt.Extinction.Notes["extinctions"] = wt.Extinction.Notes.GetValueOrDefault("extinctions") + ext;
                wt.Extinction.Eq(eBad == 0, () => bad);
            }
            // 6. Банк семян пополняется только в сезон плодоношения.
            if (wt.SeedWindow != null)
            {
                int inc = 0;
                for (int o = 0; o < f.SeedBank.Length; o++) if (f.SeedBank[o] > W.Bank[o]) inc++;
                if (inc > 0) wt.SeedWindow.Notes[seedSeason ? "increasesInSeason" : "increasesOutOfSeason"] = wt.SeedWindow.Notes.GetValueOrDefault(seedSeason ? "increasesInSeason" : "increasesOutOfSeason") + inc;
                wt.SeedWindow.Eq(inc == 0 || seedSeason, () => $"{where}: банк пополнился вне сезона (доля года {yf:F3}, {inc} значений)");
            }
            // 8. Новые популяции — только прорастанием: в сезон, в ячейках порции, при T > 6 и без снега.
            if (wt.Germination != null)
            {
                int gBad = 0, born = 0;
                for (int j = 0; j < f.SlotSpecies.Length; j++)
                {
                    if (W.Sp[j] != SpeciesTable.NoSpecies || f.SlotSpecies[j] == SpeciesTable.NoSpecies) continue;
                    born++;
                    int c = j / S;
                    bool ok = germSeason && processed.Contains(c) && f.DayT[c] > 6 && w.Env.Snow[c] < 1;
                    if (!ok) { gBad++; Bad($"{where}: всход в ячейке {c} вне условий (доля года {yf:F3}, T {f.DayT[c]:F1})"); }
                }
                wt.Germination.Notes["germinatedSlots"] = wt.Germination.Notes.GetValueOrDefault("germinatedSlots") + born;
                wt.Germination.Eq(gBad == 0, () => bad);
            }
        }

        // ───────── Прогон опыта ─────────

        sealed class RunResult
        {
            public Simulation Sim;
            public readonly List<double> PortionMs = new(), DayMs = new();
            public readonly List<HerbStats> Days = new();
            public double MaxBalanceError;
            public string Name;
            /// <summary>Выделено байт и сборок поколения 0 только внутри шагов ядра (без обвязки проверки).</summary>
            public long StepAllocated;
            public int StepGen0;
        }

        static RunResult Run(Dictionary<string, object> r, Part eq, Part balance, Watch wt, int? daysLimit, Options opt, Action<Simulation, int> onDay = null, bool release = true)
        {
            var setup = O(r["setup"]);
            string name = (string)setup["name"];
            int sourceColumns = I(r["sourceColumns"]);
            var sim = Create(setup, (string)r["geoHash"]);
            ApplyFills(sim, A(setup["fills"]));
            opt.Configure?.Invoke(sim);
            var res = new RunResult { Sim = sim, Name = name };
            if (r.TryGetValue("geo", out var go) && go != null) GeoPrint(eq, sim, O(go), name);
            Summary(eq, sim, O(r["initial"]), $"{name} начало", sourceColumns);
            var expDays = A(r["days"]);
            List<object> portions = r.TryGetValue("portions", out var po) && po != null ? A(po) : null;
            int days = Math.Min(daysLimit ?? expDays.Count, expDays.Count);
            long start = sim.World.Tick;
            var sw = new Stopwatch();
            int portion = 0;
            for (int d = 1; d <= days; d++)
            {
                double acc = 0;
                while (sim.World.Tick < start + d * (long)SimTime.TicksPerDay)
                {
                    long tick = sim.World.Tick;
                    bool flora = (tick - FloraSystem.Phase) % FloraSystem.Period == 0;
                    if (flora && wt != null && wt.Any) wt.Before.Take(sim.World.Flora);
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
                    if (wt != null && wt.Any) CheckPortion(sim, tick, wt, $"{name} сутки {d} порция {portion}");
                    if (portions != null && d == 1)
                    {
                        string h = sim.StateHash();
                        int pp = portion;
                        eq.Eq(h == (string)portions[portion - 1], () => $"{name} порция {pp}: stateHash {h} ≠ {portions[pp - 1]}");
                    }
                }
                res.DayMs.Add(acc);
                Summary(eq, sim, O(expDays[d - 1]), $"{name} сутки {d}", sourceColumns);
                res.Days.Add(Herbs(sim, sourceColumns));
                var f = sim.World.Flora;
                double err = Math.Abs(FloraState.NutrientStock(f, sim.World.Geo) - f.Ledger[Ledger.InitialStock] - FloraState.NutrientBudget(f)) / f.Ledger[Ledger.InitialStock];
                res.MaxBalanceError = Math.Max(res.MaxBalanceError, err);
                int dd = d;
                balance?.Eq(err <= 1e-4, () => $"{name} сутки {dd}: ошибка баланса {err:E2} > 1e-4");
                onDay?.Invoke(sim, d);
            }
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

        static long FloraBytes(FloraState f)
        {
            long b = f.SlotSpecies.Length + 4L * f.SlotBiomass.Length + 4L * (f.LitterFast.Length * 5 + f.Nutrient.Length) + 4L * f.SeedBank.Length + f.WoodyCount.Length
                + 4L * (f.AccT.Length * 4) + f.AccHours.Length + 4L * (f.DayT.Length * 2) + 8L * f.Capillary.Length + 4L * (f.Canopy.Length + 4 * f.TreeCover.Length)
                + 4L * 9 * f.Biome.Herb.Length + 3L * f.Biome.Current.Length + 8L * (f.ColonistMass.Length + f.ColonistFirst.Length + f.Ledger.Length);
            return b;
        }

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, Options opt = null)
        {
            opt ??= new Options();
            var root = O(MiniJson.Parse(goldenJson));
            var parts = new List<Part>();
            Part New(string name) { var p = new Part { Name = name }; parts.Add(p); return p; }
            var total = Stopwatch.StartNew();
            var t = SpeciesTable.Default;
            int meadowGrass = t.HerbSlot[t.IndexOf("meadow-grass")], sedge = t.HerbSlot[t.IndexOf("sedge")], feather = t.HerbSlot[t.IndexOf("feather-grass")];

            var p1 = New("1. рост");
            var p2 = New("2. конкуренция ≤ вместимости");
            var p3 = New("3. предел питания");
            var p4 = New("4. мороз и засуха");
            var p5 = New("5. исчезновение → опад");
            var p6 = New("6. окно плодоношения");
            var p7 = New("7. расселение: детерминизм, не в воду");
            var p8 = New("8. прорастание");
            var p9 = New("9. старение банка → опад");
            var p10 = New("10. баланс вещества по суткам");
            var p11 = New("11. детерминизм");
            var p12 = New("12. биомы и покров");
            var pB1 = New("B1 (WET) побитно с TS");
            var pB2 = New("B2 (DRY) побитно с TS");
            var pUnit = New("опыты побитно с TS");
            var pLoad = New("нагрузка S/M побитно с TS");

            // ───────── B1, B2: 20 лет ─────────
            var wB = new Watch { Competition = p2, Nutrient = p3, Extinction = p5, SeedWindow = p6, Germination = p8 };
            var b1 = Run(O(root["B1"]), pB1, p10, wB, opt.Days, opt);
            log($"g3b[{opt.Label}] B1: {b1.Days.Count} сут., ошибка баланса ≤ {b1.MaxBalanceError:E2}");
            var b2 = Run(O(root["B2"]), pB2, p10, wB, opt.Days, opt);
            log($"g3b[{opt.Label}] B2: {b2.Days.Count} сут., ошибка баланса ≤ {b2.MaxBalanceError:E2}");
            p10.Notes["B1max"] = b1.MaxBalanceError;
            p10.Notes["B2max"] = b2.MaxBalanceError;

            // ───────── Малые опыты ─────────
            var units = new Dictionary<string, RunResult>();
            var unitJson = new Dictionary<string, Dictionary<string, object>>();
            foreach (var uo in A(root["unit"]))
            {
                var u = O(uo);
                string name = (string)O(u["setup"])["name"];
                unitJson[name] = u;
                Watch wt = name switch
                {
                    "competition" => new Watch { Competition = p2, Extinction = p5 },
                    "nutrient-poor" or "nutrient-rich" => new Watch { Nutrient = p3, Competition = p2 },
                    "frost" => new Watch { Frost = p4, Extinction = p5 },
                    "drought" => new Watch { Frost = p4, Extinction = p5, Competition = p2 },
                    "dispersal" => new Watch { SeedWindow = p6, Extinction = p5 },
                    "germination" => new Watch { Germination = p8, SeedWindow = p6 },
                    "aging" => new Watch { Aging = p9 },
                    _ => new Watch { Competition = p2 },
                };
                Action<Simulation, int> onDay = null;
                if (name == "dispersal")
                    onDay = (sim, d) =>
                    {
                        var g = sim.World.Geo;
                        int count = g.N * g.N;
                        int wet = 0;
                        for (int h = 0; h < t.Herbs.Length; h++)
                            for (int c = 0; c < count; c++)
                                if (g.WaterKind[c] != WaterKind.None && sim.World.Flora.SeedBank[h * count + c] != 0) wet++;
                        p7.Eq(wet == 0, () => $"dispersal сутки {d}: семена в {wet} водных ячейках");
                    };
                units[name] = Run(u, pUnit, p10, wt, null, opt, onDay);
            }

            // 1. Рост: биомасса одного вида растёт каждые сутки до сезона семян, ассимиляция > 0.
            var gr = units["growth"];
            for (int d = 1; d < 6; d++) { int dd = d; p1.Eq(gr.Days[d].Biomass[meadowGrass] > gr.Days[d - 1].Biomass[meadowGrass], () => $"рост: сутки {dd + 1} не больше суток {dd}"); }
            p1.Eq(gr.Days[5].Biomass[meadowGrass] > 10 * gr.Days[0].Biomass[meadowGrass], () => "рост: за 6 суток весны меньше чем в 10 раз");
            p1.Eq(gr.Sim.World.Flora.Ledger[Ledger.Photosynthesis] > 0, () => "рост: ассимиляция 0");
            p1.Notes["day1"] = gr.Days[0].Biomass[meadowGrass] / 1024;
            p1.Notes["day6"] = gr.Days[5].Biomass[meadowGrass] / 1024;
            // 2. Конкуренция: плотный луг сокращается к вместимости — суммарная биомасса падает.
            var co = units["competition"];
            double Sum(HerbStats h) { double s = 0; foreach (var v in h.Biomass) s += v; return s; }
            p2.Eq(Sum(co.Days[4]) < Sum(co.Days[0]), () => "конкуренция: переполненный луг не сокращается");
            // 3. Предел питания: на бедной почве пик биомассы ≤ 25 % пика на богатой.
            double Peak(RunResult r) { double m = 0; foreach (var h in r.Days) m = Math.Max(m, Sum(h)); return m; }
            double poor = Peak(units["nutrient-poor"]), rich = Peak(units["nutrient-rich"]);
            p3.Eq(poor < 0.25 * rich, () => $"предел питания: пик на бедной {poor:F0} не меньше 25 % пика на богатой {rich:F0}");
            p3.Eq(p3.Notes.GetValueOrDefault("cellsAtNutrientLimit") > 0, () => "предел питания ни разу не был достигнут");
            p3.Notes["peakPoor"] = poor / 1024;
            p3.Notes["peakRich"] = rich / 1024;
            // 4. Мороз (холодные ячейки проверены) и засуха: осока исчезает, ковыль держится.
            p4.Eq(p4.Cells > 0, () => "холодных суток не было");
            var dr = units["drought"];
            var drEnd = dr.Days[dr.Days.Count - 1];
            p4.Eq(drEnd.Slots[sedge] == 0 && drEnd.Slots[feather] == 1024, () => $"засуха: осока {drEnd.Slots[sedge]} слотов, ковыль {drEnd.Slots[feather]}");
            p4.Eq(dr.Days[19].Biomass[sedge] < 0.5 * dr.Days[0].Biomass[sedge], () => "засуха: осока за год не убыла вдвое");
            p5.Eq(p5.Notes.GetValueOrDefault("extinctions") > 0, () => "ни одного исчезновения популяции");
            p6.Eq(p6.Notes.GetValueOrDefault("increasesInSeason") > 0, () => "семян не было");
            // 7. Расселение: вынос > 0, семена дальше опушки, фронт B1 продвинулся; повторный прогон — тот же хеш.
            var di = units["dispersal"];
            var dl = di.Sim.World.Flora;
            p7.Eq(dl.Ledger[Ledger.Exported] > 0, () => "вынос семян 0");
            {
                var g = di.Sim.World.Geo;
                int n = g.N, count = n * n;
                double far = 0;
                for (int h = 0; h < t.Herbs.Length; h++) for (int c = 0; c < count; c++) if (c % n >= 7) far += dl.SeedBank[h * count + c];
                p7.Eq(far > 0, () => "семена не ушли за пределы луга");
                p7.Notes["exported"] = dl.Ledger[Ledger.Exported];
                p7.Notes["bankBeyondMeadow"] = far;
                var again = Create(O(unitJson["dispersal"]["setup"]), (string)unitJson["dispersal"]["geoHash"]);
                ApplyFills(again, A(O(unitJson["dispersal"]["setup"])["fills"]));
                long start = again.World.Tick;
                while (again.World.Tick < start + di.Days.Count * (long)SimTime.TicksPerDay) again.Step();
                p7.Eq(again.StateHash() == di.Sim.StateHash(), () => "повторное расселение дало другой хеш");
            }
            if (b1.Days.Count >= 200) p7.Eq(b1.Days[199].Frontier > 40, () => $"B1: фронт за 10 лет {b1.Days[199].Frontier}");
            p7.Notes["B1frontierYear10"] = b1.Days.Count >= 200 ? b1.Days[199].Frontier : -1;
            p8.Eq(p8.Notes.GetValueOrDefault("germinatedSlots") > 0, () => "прорастаний не было");
            p8.Eq(units["germination"].Days[4].Occupied == 1024, () => "прорастание: голая земля не заселилась за 5 суток весны");
            p9.Eq(p9.Cells > 0, () => "старения банка не было");

            // 11. Детерминизм: B1 ещё раз (40 суток или меньше) — тот же хеш.
            {
                var r = O(root["B1"]);
                var setup = O(r["setup"]);
                var again = Create(setup, (string)r["geoHash"]);
                ApplyFills(again, A(setup["fills"]));
                opt.Configure?.Invoke(again);
                int d = Math.Min(40, b1.Days.Count);
                long start = again.World.Tick;
                while (again.World.Tick < start + d * (long)SimTime.TicksPerDay) again.Step();
                string expect = (string)O(A(r["days"])[d - 1])["stateHash"];
                p11.Eq(again.StateHash() == expect, () => $"B1 повторно {d} сут.: {again.StateHash()} ≠ {expect}");
                opt.Release?.Invoke(again);
            }

            // 12. Биомы и покров отвечают составу трав.
            void BiomeCheck(RunResult r, string label)
            {
                var w = r.Sim.World;
                var g = w.Geo;
                var f = w.Flora;
                int count = g.N * g.N;
                int land = 0, barren = 0, noGreen = 0, noShade = 0;
                int bar = Biomes.IndexOf("barren");
                for (int c = 0; c < count; c++)
                {
                    if (g.WaterKind[c] != WaterKind.None) continue;
                    land++;
                    if (f.Biome.Current[c] == bar) barren++;
                    if (FloraState.HerbBiomass(f, c) > 1)
                    {
                        if (!(w.Env.Greenness[c] > 0)) noGreen++;
                        if (!(FloraMath.HerbShade(f.SlotBiomass, c) < 1)) noShade++;
                    }
                }
                p12.Eq(noGreen == 0 && noShade == 0, () => $"{label}: у травостоя покров 0 в {noGreen}, тени нет в {noShade} ячейках");
                p12.Notes[label + ".barrenShare"] = barren / (double)land;
            }
            BiomeCheck(b1, "B1");
            BiomeCheck(b2, "B2");
            {
                var c1 = BiomeState.Counts(b1.Sim.World);
                var c2 = BiomeState.Counts(b2.Sim.World);
                int meadow = Biomes.IndexOf("meadow"), pioneer = Biomes.IndexOf("pioneer"), steppe = Biomes.IndexOf("steppe");
                if (b1.Days.Count >= 200)
                {
                    p12.Eq(c1[meadow] + c1[pioneer] > 0.5 * 2304, () => $"B1: луга и пионерные {c1[meadow] + c1[pioneer]} из 2304");
                    p12.Eq(c2[steppe] > c1[steppe] && c2[steppe] > 100, () => $"B2: степь {c2[steppe]} (B1 {c1[steppe]})");
                }
                p12.Notes["B1.meadow"] = c1[meadow];
                p12.Notes["B1.pioneer"] = c1[pioneer];
                p12.Notes["B2.steppe"] = c2[steppe];
            }

            // ───────── Защита неперенесённых ветвей: травы ведутся, древесные, колонизация и Wildlands — нет ─────────
            var pGuard = New("защита неперенесённых ветвей");
            {
                var u = unitJson["germination"];
                var setup = O(u["setup"]);
                var sim = Create(setup, (string)u["geoHash"]);
                ApplyFills(sim, A(setup["fills"]));
                pGuard.Eq(sim.FloraUnsupported == null, () => $"мир с травами и банком семян заблокирован: {sim.FloraUnsupported}");
                var f = sim.World.Flora;
                f.Woody.Spawn(t.IndexOf("spruce"), 4, 4, 0, 100, 10);
                f.WoodyCount[0]++;
                string why = sim.FloraUnsupported;
                // С этапа 2.4 древесные перенесены: изолированный мир с травами и деревом ведётся сутки без остановки.
                pGuard.Eq(why == null, () => $"мир с древесным заблокирован: {why}");
                string threw = null;
                long st = sim.World.Tick;
                try { while (sim.World.Tick < st + SimTime.TicksPerDay) sim.Step(); }
                catch (FloraNotPortedException e) { threw = e.Message; }
                pGuard.Eq(threw == null, () => $"шаг мира с древесным остановился: {threw}");
                var open = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S, Scenario = Scenario.Genesis, Isolated = false });
                pGuard.Eq(open.FloraUnsupported != null, () => "открытый мир (колонизация) не заблокирован");
                var wild = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S, Scenario = Scenario.Wild });
                pGuard.Eq(wild.FloraUnsupported != null, () => "Wildlands (подготовка) не заблокирован");
                log($"g3b[{opt.Label}] защита: древесные — {(why == null ? "ведутся" : "«" + why + "»")}, открытый мир — «{open.FloraUnsupported}», Wildlands — «{wild.FloraUnsupported}»");
            }

            // ───────── Нагрузка: S и M с лугом и банком на всей суше ─────────
            var perf = new StringBuilder();
            perf.Append($"\"backend\":{MiniJson.Q(opt.Label)}");
            foreach (var lo in A(root["load"]))
            {
                var l = O(lo);
                string name = (string)O(l["setup"])["name"];
                var lr = Run(l, pLoad, null, null, null, opt, release: false);
                // Разбивка по частям шага (замеры на результат не влияют): сутки 3 — весна, прорастание; сутки 7 — плодоношение
                // и расселение семян (доля года ≈ 0,41). Между ними — сутки без замеров.
                long start = lr.Sim.World.Tick - 2L * SimTime.TicksPerDay;
                string ProfDay(int day)
                {
                    while (lr.Sim.World.Tick < start + (day - 1) * (long)SimTime.TicksPerDay) lr.Sim.Step();
                    var prof = new FloraProfile();
                    FloraSystem.Profile = prof;
                    var swDay = Stopwatch.StartNew();
                    while (lr.Sim.World.Tick < start + day * (long)SimTime.TicksPerDay) lr.Sim.Step();
                    double ms = swDay.Elapsed.TotalMilliseconds;
                    FloraSystem.Profile = null;
                    double yf = SimTime.YearFraction(lr.Sim.World.Tick - SimTime.TicksPerDay / 2, lr.Sim.World.Config.DaysPerSeason);
                    string M(long ticks) => MiniJson.N(Math.Round(FloraProfile.Ms(ticks), 2));
                    return $"{{\"day\":{day},\"yearFrac\":{MiniJson.N(Math.Round(yf, 3))},\"dayMs\":{MiniJson.N(Math.Round(ms, 2))},\"portions\":{prof.Portions},\"cells\":{prof.Cells},\"occupiedSlots\":{prof.OccupiedSlots},\"seedingSlots\":{prof.SeedingSlots},\"germinationCells\":{prof.Germinations}"
                        + $",\"herbMs\":{M(prof.HerbTicks)},\"seedDispersalMs\":{M(prof.SeedTicks)},\"germinationMs\":{M(prof.GerminationTicks)},\"bankAgingMs\":{M(prof.AgingTicks)},\"soilMs\":{M(prof.SoilTicks)},\"coverBiomeMs\":{M(prof.BiomeTicks)}}}";
                }
                string spring = ProfDay(3), seeding = ProfDay(7);
                opt.Release?.Invoke(lr.Sim);
                var tsT = O(l["timing"]);
                long fb = FloraBytes(lr.Sim.World.Flora);
                int gcs = lr.StepGen0;
                perf.Append($",{MiniJson.Q(name)}:{{\"portionMs\":{Stat(lr.PortionMs)},\"dayMs\":{Stat(lr.DayMs)},\"ts\":{{\"portionMs\":{TsStat(tsT["portionMs"])},\"dayMs\":{TsStat(tsT["dayMs"])}}}")
                    .Append($",\"gen0CollectionsInSteps\":{gcs},\"allocatedBytesInSteps\":{(opt.AllocatedBytes != null ? lr.StepAllocated.ToString() : "null")},\"floraStateBytes\":{fb},\"woodyStoreCapacity\":{lr.Sim.World.Flora.Woody.Capacity}")
                    .Append($",\"profileSpring\":{spring},\"profileSeeding\":{seeding}}}");
                log($"g3b[{opt.Label}] {name}: порция {Stat(lr.PortionMs)}, сутки {Stat(lr.DayMs)}, GC0 {gcs}, состояние флоры {fb / 1048576.0:F1} МБ");
            }
            string RunPerf(RunResult r, Dictionary<string, object> json) => $"{{\"portionMs\":{Stat(r.PortionMs)},\"dayMs\":{Stat(r.DayMs)},\"ts\":{{\"portionMs\":{TsStat(O(json["timing"])["portionMs"])},\"dayMs\":{TsStat(O(json["timing"])["dayMs"])}}}}}";
            perf.Append($",\"B1\":{RunPerf(b1, O(root["B1"]))},\"B2\":{RunPerf(b2, O(root["B2"]))}");

            bool ok = true;
            int checkedAll = 0, failedAll = 0;
            var sb = new StringBuilder("{\"parts\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                var p = parts[i];
                ok &= p.Failed == 0 && p.Checked > 0;
                checkedAll += p.Checked;
                failedAll += p.Failed;
                var notes = new StringBuilder();
                foreach (var kv in p.Notes) notes.Append(notes.Length > 0 ? "," : "").Append(MiniJson.Q(kv.Key)).Append(':').Append(MiniJson.N(kv.Value));
                log($"g3b[{opt.Label}] {p.Name}: {(p.Failed == 0 && p.Checked > 0 ? "OK" : "FAIL")} — проверок {p.Checked}{(p.Cells > 0 ? $" (ячеек {p.Cells})" : "")}, расхождений {p.Failed}{(p.Notes.Count > 0 ? "; " + notes : "")}{(p.Examples.Count > 0 ? "; " + string.Join(" | ", p.Examples) : "")}");
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(p.Name)).Append(",\"checked\":").Append(p.Checked).Append(",\"cells\":").Append(p.Cells).Append(",\"failed\":").Append(p.Failed)
                    .Append(",\"notes\":{").Append(notes).Append("},\"examples\":[").Append(string.Join(",", p.Examples.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("],\"checked\":").Append(checkedAll).Append(",\"failed\":").Append(failedAll).Append(",\"days\":").Append(b1.Days.Count)
                .Append(",\"totalS\":").Append(MiniJson.N(Math.Round(total.Elapsed.TotalSeconds, 1))).Append(",\"perf\":{").Append(perf).Append("}}");
            log($"g3b[{opt.Label}] итого: проверок {checkedAll}, расхождений {failedAll}; {total.Elapsed.TotalSeconds:F0} с");
            reportJson = sb.ToString();
            return ok;
        }
    }
}
