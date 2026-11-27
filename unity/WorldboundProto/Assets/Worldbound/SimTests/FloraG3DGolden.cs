// Golden-проверка G3 D/E/F (Stage 2.5): колонизация, Genesis, Wildlands и подготовка — побитно против настоящего TS
// `Simulation` (tools/unity-flora-g3d-golden.ts → Golden/flora-g3d.json) и критерии исходных тестов TS
// (tests/sim/flora-worlds.test.ts: A, D, F, «болото у реки», H, «Изолированный Wildlands»; flora-dynamics о берёзе и
// сосне в открытом Genesis). Сравнение и сводки — общие с G3 C (FloraG3CGolden). Дополнительно:
//  • подготовка пакетами разного размера (AdvancePreparation 7200 и 5000 тактов) даёт тот же мир;
//  • прерванная подготовка и новый запуск с начала дают тот же мир;
//  • после подготовки изолированный мир не получает ничего извне, открытый — получает;
//  • хранилище древесных в настоящем Wildlands: заполнение, свободные индексы, состав видов по годам.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraG3DGolden
    {
        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static int I(object o) => (int)MiniJson.Num(o);
        static double D(object o) => MiniJson.FromBits(o);

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, FloraG3CGolden.Options opt = null)
        {
            opt ??= new FloraG3CGolden.Options();
            var root = O(MiniJson.Parse(goldenJson));
            var runs = O(root["runs"]);
            var parts = new List<FloraG3CGolden.Part>();
            FloraG3CGolden.Part New(string name) { var p = new FloraG3CGolden.Part { Name = name }; parts.Add(p); return p; }
            var total = Stopwatch.StartNew();
            var t = SpeciesTable.Default;
            var pEq = New("G3 D–F побитно с TS");
            var pBal = New("баланс вещества по суткам (≤ 1e-4)");
            var ck = new FloraG3CGolden.Checks { Store = New("WoodyStore: целостность"), Cells = New("счётчики ячеек ≤ 12"), Deaths = New("смерть и повторное использование индексов"), Phenology = New("листва ±0,35 в сутки, хвоя") };
            var res = new Dictionary<string, FloraG3CGolden.Result>();
            var perf = new StringBuilder($"\"backend\":{MiniJson.Q(opt.Label)}");
            foreach (var kv in runs)
            {
                string name = kv.Key;
                if (opt.Only != null && !opt.Only.Contains(name)) continue;
                var r = O(kv.Value);
                bool world = (string)O(r["setup"])["kind"] == "world";
                // Проверки после каждой порции — на участках; на мирах S/M они дороже самого прогона (снимок хранилища).
                var rr = FloraG3CGolden.Run(r, pEq, pBal, world ? null : ck, opt, profile: world);
                res[name] = rr;
                log($"g3d[{opt.Label}] {name}: {rr.DayMs.Count} сут., древесных {rr.LiveStart} → {rr.LiveEnd}, подготовка {rr.PrepMs / 1000:F1} с, ошибка баланса ≤ {rr.MaxBalance:E2}");
                if (world)
                {
                    var p = rr.Profile;
                    string M(long ticks) => MiniJson.N(Math.Round(FloraProfile.Ms(ticks), 1));
                    var ts = O(r["timing"]);
                    var prep = r.TryGetValue("preparation", out var po) && po != null ? O(po) : null;
                    perf.Append($",{MiniJson.Q(name)}:{{\"prepMs\":{MiniJson.N(Math.Round(rr.PrepMs, 1))},\"prepTicks\":{rr.PrepTicks},\"tsPrepMs\":{MiniJson.N(Math.Round(MiniJson.Num(ts["prepMs"]), 1))},\"liveEnd\":{rr.LiveEnd},\"days\":{rr.DayMs.Count}")
                        .Append($",\"portionMs\":{FloraG3CGolden.Stat(rr.PortionMs)},\"dayMs\":{FloraG3CGolden.Stat(rr.DayMs)},\"ts\":{{\"portionMs\":{FloraG3CGolden.TsStat(ts["portionMs"])},\"dayMs\":{FloraG3CGolden.TsStat(ts["dayMs"])}}}")
                        .Append($",\"gen0CollectionsInSteps\":{rr.StepGen0},\"allocatedBytesInSteps\":{(opt.AllocatedBytes != null ? rr.StepAllocated.ToString() : "null")},\"woodyCapacity\":{rr.Sim.World.Flora.Woody.Capacity}")
                        .Append($",\"profile\":{{\"cells\":{p.Cells},\"woodyProcessed\":{p.WoodyProcessed},\"deaths\":{p.Deaths},\"seedingPlants\":{p.SeedingPlants},\"packets\":{p.Packets},\"established\":{p.Established}")
                        .Append($",\"coverMs\":{M(p.CoverTicks)},\"woodyLoopMs\":{M(p.WoodyTicks)},\"woodySeedsMs\":{M(p.WoodySeedTicks)},\"landingMs\":{M(p.LandingTicks)},\"deathMs\":{M(p.DeathTicks)},\"colonizeMs\":{M(p.ColonizeTicks)},\"seedRainMs\":{M(p.SeedRainTicks)}")
                        .Append($",\"herbMs\":{M(p.HerbTicks)},\"herbSeedMs\":{M(p.SeedTicks)},\"germinationMs\":{M(p.GerminationTicks)},\"bankAgingMs\":{M(p.AgingTicks)},\"soilMs\":{M(p.SoilTicks)},\"coverBiomeMs\":{M(p.BiomeTicks)}}}}}");
                }
            }
            bool full = opt.Only == null && opt.Days == null;
            var pW = New("исходные тесты TS: колонизация и Wildlands");
            var pP = New("подготовка: пакеты, повтор, изоляция");
            if (full)
            {
                int Bi(string id) => Biomes.IndexOf(id);
                double Share(FloraG3CGolden.Zone z, string id) { int all = 0; foreach (var v in z.Biomes) all += v; return z.Biomes[Bi(id)] / (double)all; }
                // Тест A: Genesis без изоляции — заселение извне (seed 1–3).
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    var r = res[$"A-{seed}"];
                    var z0 = r.Probes["начало"].zones[0];
                    var y1 = r.Probes["год 1"].zones;
                    var sh = new List<double>();
                    foreach (int y in new[] { 3, 5, 7, 9 }) sh.Add(r.Probes[$"год {y}"].zones[0].HerbOccupancy);
                    bool gradual = sh[0] < 0.6 && sh[3] > 0.6;
                    for (int k = 1; k < sh.Count; k++) gradual &= sh[k] >= sh[k - 1] - 0.02;
                    var f = r.Sim.World.Flora;
                    int arrived = 0;
                    for (int s = 0; s < t.Count; s++) if (f.ColonistFirst[s] >= 0) arrived++;
                    double maxAge = 0;
                    for (int i = 0; i < f.Woody.HighWater; i++) if (f.Woody.Alive[i] == 1) maxAge = Math.Max(maxAge, f.Woody.Age[i]);
                    var end = r.Probes["год 9"].zones[0];
                    pW.Eq(z0.HerbOccupancy == 0 && z0.SeedBank == 0 && z0.Trees + z0.Shrubs == 0 && Share(z0, "barren") == 1, () => $"A seed {seed}: мир не пуст в начале");
                    pW.Eq(r.States["год 1"].External > 0 && y1[0].SeedBank > 3 * y1[1].SeedBank, () => $"A seed {seed}: год 1 — приток {r.States["год 1"].External:E2}, банк у края {y1[0].SeedBank:E3} / в середине {y1[1].SeedBank:E3}");
                    pW.Eq(gradual, () => $"A seed {seed}: занятость по годам {string.Join(", ", sh.ConvertAll(v => v.ToString("F3")))}");
                    pW.Eq(arrived >= 10 && f.Woody.Count > 0 && maxAge <= 9.01 && Share(end, "barren") < 0.5 && FloraG3CGolden.BalanceError(r.Sim) < 1e-4,
                        () => $"A seed {seed}: видов-колонистов {arrived}, древесных {f.Woody.Count}, старше 9 лет {maxAge:F2}, голой земли {Share(end, "barren"):F2}");
                    pW.Notes[$"A{seed}.occupancyYears3-9"] = sh[3];
                    pW.Notes[$"A{seed}.colonistSpecies"] = arrived;
                }
                // Тест D: непригодная территория.
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    var z = res[$"Dbound-{seed}"].Probes["итог"].zones;
                    pW.Eq(z[0].HerbOccupancy > 0.5 && z[1].HerbOccupancy == 0 && z[1].Trees + z[1].Shrubs == 0, () => $"D seed {seed}: запад {z[0].HerbOccupancy:F2}, восток {z[1].HerbOccupancy:F2}, древесных на востоке {z[1].Trees + z[1].Shrubs}");
                }
                // Тест F: детерминизм колонизации.
                {
                    var a = res["Fdet-1"];
                    var again = FloraG3CGolden.Create(O(O(runs["Fdet-1"])["setup"]), (string)O(runs["Fdet-1"])["geoHash"]);
                    long end = (long)MiniJson.Num(O(runs["Fdet-1"])["endTick"]);
                    while (again.World.Tick < end) again.Step();
                    bool sameFirst = true;
                    for (int s = 0; s < t.Count; s++) sameFirst &= again.World.Flora.ColonistFirst[s] == a.Sim.World.Flora.ColonistFirst[s];
                    pW.Eq(again.StateHash() == a.Sim.StateHash() && sameFirst && a.Sim.StateHash() != res["Fdet-101"].Sim.StateHash(), () => "F: детерминизм колонизации");
                }
                // Болото у реки.
                {
                    var z = res["bog-6"].Probes["итог"].zones[0];
                    pW.Eq(z.Biomes[Bi("bog")] > 0 && z.Biomes[Bi("river")] == 4 * 32, () => $"болото: {z.Biomes[Bi("bog")]}, река {z.Biomes[Bi("river")]}");
                }
                // flora-dynamics в исходном виде (открытый Genesis).
                {
                    var r = res["birchOpen"];
                    var s1 = r.Probes["лето 1"].plants[0];
                    var w1 = r.Probes["зима 1"].plants[0];
                    var s4 = r.Probes["лето 4"].plants[0];
                    pW.Eq(D(s1["leaf"]) > 0.9 && D(w1["leaf"]) < 0.1 && I(s4["alive"]) == 1 && D(s4["biomass"]) > 3 * D(s1["biomass"]) && r.Sim.World.Flora.Ledger[Ledger.Litterfall] > 0,
                        () => $"берёза (открытый мир): листва {D(s1["leaf"]):F2}/{D(w1["leaf"]):F2}, биомасса {D(s1["biomass"]):F2} → {D(s4["biomass"]):F2}");
                    pW.Eq(D(res["pineOpen"].Probes["через 15 суток"].plants[0]["leaf"]) == 1, () => "сосна (открытый мир): хвоя не 1");
                }
                // Тест H: Wildlands на участке, 20 лет.
                foreach (int seed in new[] { 1, 2, 3 })
                {
                    var r = res[$"H-{seed}"];
                    var f = r.Sim.World.Flora;
                    var geo = r.Sim.World.Geo;
                    int land = 0, occ = 0;
                    for (int c = 0; c < geo.N * geo.N; c++)
                    {
                        if (geo.WaterKind[c] != WaterKind.None) continue;
                        land++;
                        if (FloraState.HerbBiomass(f, c) > 1) occ++;
                    }
                    var stages = new int[4];
                    var species = new HashSet<int>();
                    double oldest = 0, tallest = 0;
                    for (int i = 0; i < f.Woody.HighWater; i++)
                    {
                        if (f.Woody.Alive[i] != 1) continue;
                        stages[f.Woody.Stage[i]]++;
                        species.Add(f.Woody.Species[i]);
                        oldest = Math.Max(oldest, f.Woody.Age[i]);
                        tallest = Math.Max(tallest, f.Woody.Biomass[i]);
                    }
                    var bc = BiomeState.Counts(r.Sim.World);
                    int kinds = 0;
                    for (int b = 0; b < bc.Length; b++) if (bc[b] > 0 && BiomeCatalog.All[b].Id != "sea" && BiomeCatalog.All[b].Id != "lake" && BiomeCatalog.All[b].Id != "river") kinds++;
                    pW.Eq(r.Sim.Preparation == null && f.PreparedYears == 20 && !f.RegionalSeedRain && occ / (double)land > 0.8 && stages[0] > 0 && stages[1] > 0 && stages[2] > 0 && species.Count >= 5
                        && oldest <= 20.01 && tallest > 10 && kinds >= 3 && FloraG3CGolden.BalanceError(r.Sim) < 1e-4,
                        () => $"H seed {seed}: занято {occ / (double)land:F2}, стадии {string.Join("/", stages)}, видов {species.Count}, старше {oldest:F2}, биомасса {tallest:F1}, биомов {kinds}");
                    pW.Notes[$"H{seed}.woody"] = f.Woody.Count;
                    pW.Notes[$"H{seed}.species"] = species.Count;
                }
                // Изолированный Wildlands: подготовка у изолированного и открытого мира одинакова.
                foreach (int seed in new[] { 1, 2 })
                {
                    var iso = res[$"isoW-{seed}"];
                    var open = res[$"openW-{seed}"];
                    pP.Eq(iso.Sim.World.Config.Isolated && iso.Sim.World.Flora.Ledger[Ledger.External] > 0 && iso.Sim.World.Flora.Woody.Count > 0
                        && FloraG3CGolden.FloraPrint(iso.Sim) == FloraG3CGolden.FloraPrint(open.Sim), () => $"изолированный Wildlands seed {seed}: флора после подготовки отличается от открытого");
                    // После подготовки (6 лет) — 3 года без притока; растения мира размножаются, новых видов нет.
                    var r6 = res[$"isoW6-{seed}"];
                    var at = r6.States["подготовка завершена"];
                    var f = r6.Sim.World.Flora;
                    bool colSame = true;
                    for (int s = 0; s < t.Count; s++) colSame &= f.ColonistMass[s] == at.ColonistMass[s] && f.ColonistFirst[s] == at.ColonistFirst[s];
                    int born = 0;
                    bool known = true;
                    double years = (r6.Sim.World.Tick - r6.Probes["подготовка завершена"].tick) / (20.0 * SimTime.TicksPerDay);
                    for (int i = 0; i < f.Woody.HighWater; i++)
                    {
                        if (f.Woody.Alive[i] != 1) continue;
                        known &= at.Species.Contains(f.Woody.Species[i]);
                        if (f.Woody.Age[i] < years) born++;
                    }
                    foreach (var sp in f.SlotSpecies) if (sp != SpeciesTable.NoSpecies) known &= at.Species.Contains(sp);
                    pP.Eq(f.Ledger[Ledger.External] == at.External && colSame && known && born > 0 && FloraG3CGolden.BalanceError(r6.Sim) < 1e-4,
                        () => $"изолированный Wildlands seed {seed}: после подготовки приток {f.Ledger[Ledger.External] - at.External:E2}, новых видов {(known ? "нет" : "есть")}, родилось {born}");
                }
                // Пакеты разного размера и прерванная подготовка дают тот же мир (isoW-1: 2 года, участок 32 × 32).
                {
                    var r = O(runs["isoW-1"]);
                    string expect = (string)O(r["final"])["stateHash"];
                    var setup = O(r["setup"]);
                    string Prepare(long chunk)
                    {
                        var s = FloraG3CGolden.Create(setup, (string)r["geoHash"]);
                        while (s.Preparation != null) s.AdvancePreparation(chunk);
                        return s.StateHash();
                    }
                    pP.Eq(Prepare(7200) == expect && Prepare(5000) == expect && Prepare(50) == expect, () => "подготовка пакетами 7200/5000/50 тактов дала разные миры");
                    // Прерванная подготовка (отмена после 3000 тактов): мир отброшен, новый запуск с начала даёт тот же мир.
                    var cancelled = FloraG3CGolden.Create(setup, (string)r["geoHash"]);
                    cancelled.AdvancePreparation(3000);
                    pP.Eq(cancelled.Preparation != null && cancelled.PreparationFraction() < 1 && Prepare(7200) == expect, () => "повторная подготовка после отмены дала другой мир");
                }
                // Изоляция после подготовки на настоящих мирах: F (изолированный) — притока нет, E (открытый) — есть.
                {
                    var e = res["E-S42"];
                    var f = res["F-S42"];
                    var ee = e.States["подготовка завершена"];
                    var fe = f.States["подготовка завершена"];
                    pP.Eq(ee.FloraPrint == fe.FloraPrint, () => "E/F: флора к концу подготовки различается");
                    pP.Eq(f.Sim.World.Flora.Ledger[Ledger.External] == fe.External, () => $"F: после подготовки приток {f.Sim.World.Flora.Ledger[Ledger.External] - fe.External:E3}");
                    pP.Eq(e.Sim.World.Flora.Ledger[Ledger.External] > ee.External, () => "E: после подготовки нет притока через края");
                    pP.Notes["E.externalAfterPrep"] = e.Sim.World.Flora.Ledger[Ledger.External] - ee.External;
                    pP.Notes["F.externalAfterPrep"] = f.Sim.World.Flora.Ledger[Ledger.External] - fe.External;
                }
            }
            ck.Deaths.Notes["births"] = ck.Births;
            ck.Deaths.Notes["deaths"] = ck.DeathsCount;
            ck.Deaths.Notes["reusedIndices"] = ck.Reused;
            double maxBal = 0;
            foreach (var r in res.Values) maxBal = Math.Max(maxBal, r.MaxBalance);
            pBal.Notes["max"] = maxBal;

            bool ok = true;
            int checkedAll = 0, failedAll = 0;
            var sb = new StringBuilder("{\"parts\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                var p = parts[i];
                ok &= p.Failed == 0 && (p.Checked > 0 || !full);
                checkedAll += p.Checked;
                failedAll += p.Failed;
                var notes = new StringBuilder();
                foreach (var kv in p.Notes) notes.Append(notes.Length > 0 ? "," : "").Append(MiniJson.Q(kv.Key)).Append(':').Append(MiniJson.N(kv.Value));
                log($"g3d[{opt.Label}] {p.Name}: {(p.Failed == 0 && (p.Checked > 0 || !full) ? "OK" : "FAIL")} — проверок {p.Checked}, расхождений {p.Failed}{(p.Notes.Count > 0 ? "; " + notes : "")}{(p.Examples.Count > 0 ? "; " + string.Join(" | ", p.Examples) : "")}");
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(p.Name)).Append(",\"checked\":").Append(p.Checked).Append(",\"failed\":").Append(p.Failed)
                    .Append(",\"notes\":{").Append(notes).Append("},\"examples\":[").Append(string.Join(",", p.Examples.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("],\"checked\":").Append(checkedAll).Append(",\"failed\":").Append(failedAll)
                .Append(",\"totalS\":").Append(MiniJson.N(Math.Round(total.Elapsed.TotalSeconds, 1))).Append(",\"perf\":{").Append(perf).Append("}}");
            log($"g3d[{opt.Label}] итого: проверок {checkedAll}, расхождений {failedAll}; {total.Elapsed.TotalSeconds:F0} с");
            reportJson = sb.ToString();
            return ok;
        }
    }
}
