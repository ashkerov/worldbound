// Golden-проверка G3 (Stage 2.2): суточный цикл голой земли — побитно против настоящего TS `Simulation`
// (tools/unity-flora-g3-golden.ts → Golden/flora-g3.json). Сценарий A — Genesis, изоляция, S/42: полный stateHash и
// массивы после каждой из 144 порций первых суток, затем каждые сутки 20 лет; M/42 — 3 суток; влияние покрова на
// испарение (с флорой и без). Плюс собственные проверки C#: сброс накопителей именно в ячейках порции, голая земля,
// биомы, баланс вещества ≤ 1e-4, детерминизм; замеры порции и суток.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraG3Golden
    {
        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static string Bits(double v) => MiniJson.Bits(v);
        static int I(object o) => (int)MiniJson.Num(o);

        sealed class Part
        {
            public string Name;
            public int Checked, Failed;
            public readonly List<string> Examples = new();

            public void Eq(bool ok, Func<string> what)
            {
                Checked++;
                if (ok) return;
                Failed++;
                if (Examples.Count < 10) Examples.Add(what());
            }
        }

        public sealed class Options
        {
            /// <summary>Подключить ускоритель воды (Burst) — в Unity; результат обязан совпасть с управляемым.</summary>
            public Action<Simulation> Configure;
            public Action<Simulation> Release;
            /// <summary>Сколько суток сценария A проверять (null — все из эталона).</summary>
            public int? Days;
            public string Label = "managed";
        }

        static WorldConfig Config(int seed, WorldSize size) => new() { Seed = (uint)seed, Size = size, Scenario = Scenario.Genesis, Isolated = true };

        static Dictionary<string, string> Arrays(Simulation sim)
        {
            var f = sim.World.Flora;
            var e = sim.World.Env;
            var b = f.Biome;
            string H<T>(T[] a) where T : struct => StateHasher.Fnv(a);
            return new Dictionary<string, string>
            {
                ["dayT"] = H(f.DayT), ["dayW"] = H(f.DayW), ["accT"] = H(f.AccT), ["accW"] = H(f.AccW), ["accRunoff"] = H(f.AccRunoff), ["accMinT"] = H(f.AccMinT), ["accHours"] = H(f.AccHours),
                ["nutrient"] = H(f.Nutrient), ["litterFast"] = H(f.LitterFast), ["litterFastN"] = H(f.LitterFastN), ["litterFastQ"] = H(f.LitterFastQ), ["litterWood"] = H(f.LitterWood),
                ["litterWoodN"] = H(f.LitterWoodN), ["canopy"] = H(f.Canopy), ["greenness"] = H(e.Greenness), ["moisture"] = H(e.Moisture), ["snow"] = H(e.Snow), ["runoff"] = H(e.Runoff),
                ["biome.moisture"] = H(b.Moisture), ["biome.current"] = H(b.Current), ["biome.candidate"] = H(b.Candidate), ["biome.days"] = H(b.Days), ["biome.herb"] = H(b.Herb),
            };
        }

        /// <summary>Сводка состояния (те же поля, что summary() в инструменте TS) — сравнение с эталоном.</summary>
        static void Summary(Part p, Simulation sim, Dictionary<string, object> e, string where)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            int count = geo.N * geo.N;
            int accZero = 0, greenNonZero = 0;
            long accSum = 0;
            for (int c = 0; c < count; c++)
            {
                if (geo.WaterKind[c] != WaterKind.None) continue;
                if (f.AccHours[c] == 0) accZero++;
                accSum += f.AccHours[c];
                if (w.Env.Greenness[c] != 0) greenNonZero++;
            }
            string hash = sim.StateHash();
            p.Eq(hash == (string)e["stateHash"], () => $"{where}: stateHash {hash} ≠ {e["stateHash"]}");
            p.Eq(w.Tick == (long)MiniJson.Num(e["tick"]), () => $"{where}: такт {w.Tick} ≠ {e["tick"]}");
            var ledger = A(e["ledger"]);
            for (int j = 0; j < ledger.Count; j++) { int jj = j; p.Eq(Bits(f.Ledger[j]) == (string)ledger[j], () => $"{where}: ledger[{jj}] {Bits(f.Ledger[jj])} ≠ {ledger[jj]}"); }
            if (e.ContainsKey("stock"))
            {
                double stock = FloraState.NutrientStock(f, geo), budget = FloraState.NutrientBudget(f), init = f.Ledger[Ledger.InitialStock];
                p.Eq(Bits(stock) == (string)e["stock"] && Bits(budget) == (string)e["budget"], () => $"{where}: запас/бюджет");
                p.Eq(Bits(Math.Abs(stock - init - budget) / init) == (string)e["balanceError"], () => $"{where}: ошибка баланса");
                var bc = A(e["biomeCounts"]);
                var mine = BiomeState.Counts(w);
                for (int j = 0; j < bc.Count; j++) { int jj = j; p.Eq(mine[j] == I(bc[j]), () => $"{where}: биом {BiomeCatalog.All[jj].Id} {mine[jj]} ≠ {bc[jj]}"); }
                p.Eq(greenNonZero == I(e["greennessLandNonZero"]), () => $"{where}: покров суши ≠ 0 в {greenNonZero} ячейках");
                var wt = A(e["waterTotals"]);
                for (int j = 0; j < 4; j++) { int jj = j; p.Eq(Bits(w.Env.WaterTotals[j]) == (string)wt[j], () => $"{where}: waterTotals[{jj}]"); }
            }
            p.Eq(accZero == I(e["landAccHoursZero"]) && accSum == (long)MiniJson.Num(e["landAccHoursSum"]), () => $"{where}: накопители — нулевых {accZero}/{e["landAccHoursZero"]}, Σчасов {accSum}/{e["landAccHoursSum"]}");
            p.Eq(f.LastSliceHour == (long)MiniJson.Num(e["lastSliceHour"]), () => $"{where}: lastSliceHour {f.LastSliceHour} ≠ {e["lastSliceHour"]}");
            if (e.TryGetValue("arrays", out var ao) && ao != null)
            {
                var mine = Arrays(sim);
                foreach (var kv in O(ao)) { var key = kv.Key; p.Eq(mine[key] == (string)kv.Value, () => $"{where}: {key} {mine[key]} ≠ {kv.Value}"); }
            }
        }

        /// <summary>Свойства голой земли Genesis + изоляция — по состоянию C#, независимо от эталона.</summary>
        static void BareLand(Part p, Simulation sim, double prevWeathering, string where)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            int count = geo.N * geo.N;
            bool herbs = false, seeds = false, green = false, landBarren = true, waterBiomes = true;
            for (int j = 0; j < f.SlotSpecies.Length; j++) if (f.SlotSpecies[j] != SpeciesTable.NoSpecies || f.SlotBiomass[j] != 0) herbs = true;
            for (int j = 0; j < f.SeedBank.Length; j++) if (f.SeedBank[j] != 0) seeds = true;
            int barren = Biomes.IndexOf("barren"), river = Biomes.IndexOf("river"), lake = Biomes.IndexOf("lake"), sea = Biomes.IndexOf("sea");
            for (int c = 0; c < count; c++)
            {
                byte k = geo.WaterKind[c];
                if (k == WaterKind.None)
                {
                    if (w.Env.Greenness[c] != 0) green = true;
                    if (f.Biome.Current[c] != barren) landBarren = false;
                }
                else if (f.Biome.Current[c] != (k == WaterKind.River ? river : k == WaterKind.Lake ? lake : sea)) waterBiomes = false;
            }
            var l = f.Ledger;
            double stock = FloraState.NutrientStock(f, geo);
            double err = Math.Abs(stock - l[Ledger.InitialStock] - FloraState.NutrientBudget(f)) / l[Ledger.InitialStock];
            p.Eq(!herbs, () => $"{where}: появились травы");
            p.Eq(!seeds, () => $"{where}: появились семена");
            p.Eq(f.Woody.Count == 0 && f.Woody.HighWater == 0, () => $"{where}: появились древесные");
            p.Eq(!green, () => $"{where}: покров суши не 0");
            p.Eq(landBarren, () => $"{where}: суша не barren");
            p.Eq(waterBiomes, () => $"{where}: водные биомы не по типу воды");
            p.Eq(l[Ledger.External] == 0 && l[Ledger.Exported] == 0 && l[Ledger.Fixation] == 0 && l[Ledger.Creator] == 0 && l[Ledger.Photosynthesis] == 0 && l[Ledger.Litterfall] == 0,
                () => $"{where}: внешние потоки или потоки растений не 0");
            p.Eq(l[Ledger.Weathering] > prevWeathering, () => $"{where}: выветривание не растёт");
            p.Eq(l[Ledger.Leaching] >= 0 && l[Ledger.Decomposition] >= 0, () => $"{where}: вымывание/разложение отрицательны");
            p.Eq(err <= 1e-4, () => $"{where}: ошибка баланса {err:E2} > 1e-4");
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

        /// <summary>Такт с замером; порция флоры — в такты tick ≡ 25 (mod 50).</summary>
        static (double ms, bool flora) Step(Simulation sim, Stopwatch sw)
        {
            bool flora = (sim.World.Tick - FloraSystem.Phase) % FloraSystem.Period == 0;
            sw.Restart();
            sim.Step();
            return (sw.Elapsed.TotalMilliseconds, flora);
        }

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, Options opt = null)
        {
            opt ??= new Options();
            var root = O(MiniJson.Parse(goldenJson));
            var parts = new List<Part>();
            Part New(string name) { var p = new Part { Name = name }; parts.Add(p); return p; }
            var perf = new StringBuilder();
            var sw = new Stopwatch();
            var total = Stopwatch.StartNew();
            var A0 = O(root["scenarioA"]);

            // ───────── Сценарий A: первые 144 порции ─────────
            var sim = new Simulation(Config(42, WorldSize.S));
            opt.Configure?.Invoke(sim);
            var pInit = New("A.начало");
            Summary(pInit, sim, O(A0["initial"]), "такт 0");
            var pPortions = New("A.144 порции");
            var portionMs = new List<double>();
            var dayMs = new List<double>();
            int done = 0;
            double dayAcc = 0;
            var geo = sim.World.Geo;
            int n = geo.N;
            var expPortions = A(A0["portions"]);
            long prevPortionTick = -1;
            while (done < 144)
            {
                long tick = sim.World.Tick;
                var (ms, flora) = Step(sim, sw);
                dayAcc += ms;
                if (!flora) continue;
                portionMs.Add(ms);
                var e = O(expPortions[done]);
                done++;
                // Порядок порций: каждая следующая — ровно через 50 тактов, первая — в такт ≡ 25 (mod 50).
                pPortions.Eq(tick % FloraSystem.Period == FloraSystem.Phase && (prevPortionTick < 0 || tick == prevPortionTick + FloraSystem.Period), () => $"порция {done}: такт {tick} вне порядка");
                prevPortionTick = tick;
                Summary(pPortions, sim, e, $"порция {done}");
                p_PortionCells(pPortions, sim, tick, n, done);
            }

            // ───────── Сценарий A: сутки ─────────
            var pDays = New("A.сутки");
            var pBare = New("A.голая земля");
            var expDays = A(A0["days"]);
            int days = Math.Min(opt.Days ?? expDays.Count, expDays.Count);
            long start = (long)MiniJson.Num(O(A0["initial"])["tick"]);
            double prevWeathering = 0;
            string day2Hash = null;
            Dictionary<string, object> evapExp = O(A0["evaporation"]);
            for (int d = 1; d <= days; d++)
            {
                long target = start + d * (long)SimTime.TicksPerDay;
                while (sim.World.Tick < target)
                {
                    var (ms, flora) = Step(sim, sw);
                    dayAcc += ms;
                    if (flora && d > 1) portionMs.Add(ms);
                }
                dayMs.Add(dayAcc);
                dayAcc = 0;
                var e = O(expDays[d - 1]);
                Summary(pDays, sim, e, $"сутки {d}");
                BareLand(pBare, sim, prevWeathering, $"сутки {d}");
                prevWeathering = sim.World.Flora.Ledger[Ledger.Weathering];
                if (d == 2) day2Hash = sim.StateHash();
                if (d == 20)
                {
                    var wf = A(O(evapExp["withFlora20Days"])["waterTotals"]);
                    for (int j = 0; j < 4; j++) { int jj = j; pDays.Eq(Bits(sim.World.Env.WaterTotals[j]) == (string)wf[j], () => $"испарение с флорой: waterTotals[{jj}]"); }
                }
            }
            var balance = sim.World.Flora;
            double finalErr = Math.Abs(FloraState.NutrientStock(balance, sim.World.Geo) - balance.Ledger[Ledger.InitialStock] - FloraState.NutrientBudget(balance)) / balance.Ledger[Ledger.InitialStock];
            opt.Release?.Invoke(sim);

            // ───────── Детерминизм: второй прогон двух суток ─────────
            var pDet = New("A.детерминизм");
            if (days >= 2)
            {
                var again = new Simulation(Config(42, WorldSize.S));
                opt.Configure?.Invoke(again);
                while (again.World.Tick < start + 2 * (long)SimTime.TicksPerDay) again.Step();
                pDet.Eq(again.StateHash() == day2Hash, () => "второй прогон двух суток дал другой хеш");
                opt.Release?.Invoke(again);
            }

            // ───────── Покров → испарение: тот же мир без флоры (покров 0,25) ─────────
            var pEvap = New("A.покров и испарение");
            double evapFlora = 0, evapBare = 0, runFlora = 0, runBare = 0;
            if (days >= 20)
            {
                var bare = new Simulation(Config(42, WorldSize.S), null, null, new SimulationOptions { Populate = false, ScheduleFlora = false });
                while (bare.World.Tick < start + 20L * SimTime.TicksPerDay) bare.Step();
                var wb = A(O(evapExp["withoutFlora20Days"])["waterTotals"]);
                for (int j = 0; j < 4; j++) { int jj = j; pEvap.Eq(Bits(bare.World.Env.WaterTotals[j]) == (string)wb[j], () => $"без флоры: waterTotals[{jj}]"); }
                var wf = A(O(evapExp["withFlora20Days"])["waterTotals"]);
                evapFlora = MiniJson.FromBits(wf[1]);
                runFlora = MiniJson.FromBits(wf[3]);
                evapBare = bare.World.Env.WaterTotals[1];
                runBare = bare.World.Env.WaterTotals[3];
                pEvap.Eq(evapFlora < evapBare, () => $"испарение при покрове 0 ({evapFlora:E3}) не меньше, чем при 0,25 ({evapBare:E3})");
            }

            // ───────── M/42: 3 суток ─────────
            var pM = New("M.сутки");
            var M0 = O(root["scenarioM"]);
            var simM = new Simulation(Config(42, WorldSize.M));
            opt.Configure?.Invoke(simM);
            Summary(pM, simM, O(M0["initial"]), "M такт 0");
            long startM = simM.World.Tick;
            var portionMsM = new List<double>();
            var dayMsM = new List<double>();
            var expM = A(M0["days"]);
            double prevWeatheringM = 0;
            for (int d = 1; d <= expM.Count; d++)
            {
                double acc = 0;
                while (simM.World.Tick < startM + d * (long)SimTime.TicksPerDay)
                {
                    var (ms, flora) = Step(simM, sw);
                    acc += ms;
                    if (flora) portionMsM.Add(ms);
                }
                dayMsM.Add(acc);
                Summary(pM, simM, O(expM[d - 1]), $"M сутки {d}");
                BareLand(pM, simM, prevWeatheringM, $"M сутки {d}");
                prevWeatheringM = simM.World.Flora.Ledger[Ledger.Weathering];
            }
            opt.Release?.Invoke(simM);

            var ts = O(root["tsTiming"]);
            string TsStat(string k) { var x = O(ts[k]); return $"{{\"mean\":{MiniJson.N(Math.Round(MiniJson.Num(x["mean"]), 4))},\"p95\":{MiniJson.N(Math.Round(MiniJson.Num(x["p95"]), 4))},\"p99\":{MiniJson.N(Math.Round(MiniJson.Num(x["p99"]), 4))},\"max\":{MiniJson.N(Math.Round(MiniJson.Num(x["max"]), 4))}}}"; }
            perf.Append($"\"backend\":{MiniJson.Q(opt.Label)},\"days\":{days},\"portionMsS\":{Stat(portionMs)},\"dayMsS\":{Stat(dayMs)},\"portionMsM\":{Stat(portionMsM)},\"dayMsM\":{Stat(dayMsM)}")
                .Append($",\"ts\":{{\"portionMsS\":{TsStat("portionMsS")},\"dayMsS\":{TsStat("dayMsS")},\"portionMsM\":{TsStat("portionMsM")},\"dayMsM\":{TsStat("dayMsM")}}}")
                .Append($",\"finalBalanceError\":{MiniJson.N(finalErr)},\"evaporation20Days\":{{\"withFloraCover0\":{MiniJson.N(evapFlora)},\"withoutFloraCover025\":{MiniJson.N(evapBare)},\"localRunoffWithFlora\":{MiniJson.N(runFlora)},\"localRunoffWithoutFlora\":{MiniJson.N(runBare)}}}");

            bool ok = true;
            int checkedAll = 0, failedAll = 0;
            var sb = new StringBuilder("{\"parts\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                var p = parts[i];
                ok &= p.Failed == 0 && p.Checked > 0;
                checkedAll += p.Checked;
                failedAll += p.Failed;
                log($"g3[{opt.Label}] {p.Name}: {(p.Failed == 0 ? "OK" : "FAIL")} — проверок {p.Checked}, расхождений {p.Failed}{(p.Examples.Count > 0 ? "; " + string.Join(" | ", p.Examples) : "")}");
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(p.Name)).Append(",\"checked\":").Append(p.Checked).Append(",\"failed\":").Append(p.Failed)
                    .Append(",\"examples\":[").Append(string.Join(",", p.Examples.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("],\"checked\":").Append(checkedAll).Append(",\"failed\":").Append(failedAll).Append(",\"totalS\":").Append(MiniJson.N(Math.Round(total.Elapsed.TotalSeconds, 1)))
                .Append(",\"perf\":{").Append(perf).Append("}}");
            log($"g3[{opt.Label}] итого: проверок {checkedAll}, расхождений {failedAll}; сутки {days}; ошибка баланса в конце {finalErr:E2}; порция S {Stat(portionMs)}, сутки S {Stat(dayMs)}, сутки M {Stat(dayMsM)}; {total.Elapsed.TotalSeconds:F0} с");
            reportJson = sb.ToString();
            return ok;
        }

        /// <summary>
        /// Порция обработала ровно свои ячейки: суша в строках z ≡ час (mod 24) и столбцах порции — накопители сброшены
        /// (часовой шаг воды в этом часу уже прошёл, так что у остальных ячеек суши accHours &gt; 0 до их порции).
        /// </summary>
        static void p_PortionCells(Part p, Simulation sim, long tick, int n, int done)
        {
            var w = sim.World;
            var f = w.Flora;
            var geo = w.Geo;
            long hour = tick / SimTime.TicksPerHour;
            int sub = (int)((tick - hour * SimTime.TicksPerHour) / FloraSystem.Period);
            int slice = (int)(hour % 24);
            int x0 = (int)Math.Floor(sub * n / (double)FloraSystem.Substeps), x1 = (int)Math.Floor((sub + 1) * n / (double)FloraSystem.Substeps);
            bool ok = true;
            for (int z = slice; z < n; z += 24)
                for (int x = x0; x < x1; x++)
                {
                    int c = z * n + x;
                    if (geo.WaterKind[c] != WaterKind.None) continue;
                    if (f.AccHours[c] != 0 || f.AccT[c] != 0 || f.AccW[c] != 0 || f.AccRunoff[c] != 0 || f.AccMinT[c] != 99) ok = false;
                }
            p.Eq(ok, () => $"порция {done} (час {hour % 24}, часть {sub}): накопители ячеек порции не сброшены");
        }
    }
}
