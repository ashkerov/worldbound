// Golden-проверка среды: тот же мир, тот же стартовый такт, та же последовательность команд → тот же хеш
// состояния среды после каждого игрового часа, что у настоящих weatherSystem/waterSystem TS
// (tools/unity-env-golden.ts). Заодно — время часа и шага воды (среднее, p95, p99) и память.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.Env;

namespace Worldbound.Sim.Golden
{
    public static class EnvGolden
    {
        public sealed class Options
        {
            /// <summary>Настройка симуляции перед прогоном (например, подключить Burst-ускоритель).</summary>
            public Action<Simulation> Configure;
            /// <summary>Освобождение того, что подключил Configure.</summary>
            public Action<Simulation> Release;
            public string Only;
            public string Label = "managed";
            /// <summary>Байты, выделенные текущим потоком (если среда умеет); null — не измеряется.</summary>
            public Func<long> AllocatedBytes;
        }

        static double Pct(List<double> sorted, double p) => sorted[Math.Min(sorted.Count - 1, (int)Math.Floor(p * sorted.Count))];

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, string only = null) =>
            Run(goldenJson, log, out reportJson, new Options { Only = only });

        public static bool Run(string goldenJson, Action<string> log, out string reportJson, Options opt)
        {
            var root = MiniJson.Obj(MiniJson.Parse(goldenJson));
            var sb = new StringBuilder("[\n");
            bool allOk = true, first = true;
            foreach (var co in MiniJson.Arr(root["cases"]))
            {
                var c = MiniJson.Obj(co);
                string label = $"{MiniJson.Num(c["seed"])}:{c["size"]}:{c["climate"]}";
                if (opt.Only != null && Array.IndexOf(opt.Only.Split(','), label) < 0) continue;
                var config = WorldgenGolden.ConfigOf(c);
                config.DaysPerSeason = (int)MiniJson.Num(c["daysPerSeason"]);
                var genSw = Stopwatch.StartNew();
                // Эталон tools/unity-env-golden.ts строит мир без заселения флорой (покров createEnv = 0,25 на суше).
                var sim = new Simulation(config, null, null, new SimulationOptions { Populate = false, ScheduleFlora = false });
                double createMs = genSw.Elapsed.TotalMilliseconds;
                var w = sim.World;
                opt.Configure?.Invoke(sim);
                var commands = new List<(long tick, int speed)>();
                foreach (var x in MiniJson.Arr(c["commands"]))
                {
                    var cmd = MiniJson.Obj(x);
                    commands.Add(((long)MiniJson.Num(cmd["tick"]), (int)MiniJson.Num(cmd["speed"])));
                }
                var problems = new List<string>();
                if (w.GeoHash != (string)c["geoHash"]) problems.Add("geoHash");
                if (w.Tick != (long)MiniJson.Num(c["startTick"])) problems.Add("startTick");
                if (sim.EnvHash() != (string)c["initialHash"]) problems.Add("initialHash");
                var records = MiniJson.Arr(c["records"]);
                var hourMs = new List<double>(records.Count);
                var waterMs = new List<double>(records.Count);
                int firstBad = -1, badHours = 0;
                string firstBadDetail = null;
                var sw = new Stopwatch();
                var hsw = new Stopwatch();
                sim.Clock = () => sw.Elapsed.TotalMilliseconds;
                sw.Start();
                long gc0 = GC.CollectionCount(0);
                long mem0 = GC.GetTotalMemory(false);
                long alloc0 = opt.AllocatedBytes != null ? opt.AllocatedBytes() : 0;
                foreach (var ro in records)
                {
                    var rec = MiniJson.Obj(ro);
                    double water0 = sim.WaterTiming.TotalMs;
                    hsw.Restart();
                    for (int k = 0; k < SimTime.TicksPerHour; k++)
                    {
                        foreach (var cmd in commands) if (cmd.tick == w.Tick) sim.Enqueue(Command.SetSpeed(cmd.speed));
                        sim.Step();
                    }
                    hourMs.Add(hsw.Elapsed.TotalMilliseconds);
                    waterMs.Add(sim.WaterTiming.TotalMs - water0);
                    string hash = sim.EnvHash();
                    if (hash != (string)rec["hash"] || w.Tick != (long)MiniJson.Num(rec["tick"]))
                    {
                        badHours++;
                        if (firstBad < 0)
                        {
                            firstBad = (int)MiniJson.Num(rec["h"]);
                            firstBadDetail = rec.ContainsKey("arrays") ? Diff(sim, rec) : "(массивы в эталоне для этого часа не записаны)";
                        }
                    }
                }
                long alloc = opt.AllocatedBytes != null ? opt.AllocatedBytes() - alloc0 : -1;
                long gcs = GC.CollectionCount(0) - gc0;
                long mem = GC.GetTotalMemory(false) - mem0;
                opt.Release?.Invoke(sim);
                bool ok = problems.Count == 0 && badHours == 0;
                allOk &= ok;
                hourMs.Sort();
                waterMs.Sort();
                double hm = 0, wm = 0;
                foreach (var v in hourMs) hm += v;
                foreach (var v in waterMs) wm += v;
                hm /= hourMs.Count;
                wm /= waterMs.Count;
                var ts = MiniJson.Obj(c["tsTiming"]);
                log($"env[{opt.Label}] {label} dps {config.DaysPerSeason}, {records.Count} ч: {(ok ? "OK — все часы побитно" : $"MISMATCH: {string.Join(",", problems)} плохих часов {badHours}, первый {firstBad} {firstBadDetail}")}; "
                    + $"час {hm:F2} мс (p95 {Pct(hourMs, 0.95):F2}, p99 {Pct(hourMs, 0.99):F2}), вода {wm:F2} мс (p99 {Pct(waterMs, 0.99):F2}); TS час {MiniJson.Num(ts["hourMean"]):F2} мс, вода {MiniJson.Num(ts["waterMean"]):F2} мс; GC gen0 {gcs}, alloc {(alloc >= 0 ? (alloc / 1024).ToString() + " КБ" : "н/д")}");
                if (!first) sb.Append(",\n");
                first = false;
                sb.Append("  {\"case\":").Append(MiniJson.Q(label)).Append(",\"backend\":").Append(MiniJson.Q(opt.Label)).Append(",\"ok\":").Append(ok ? "true" : "false")
                    .Append(",\"hours\":").Append(records.Count).Append(",\"badHours\":").Append(badHours).Append(",\"firstBadHour\":").Append(firstBad)
                    .Append(",\"problems\":[").Append(string.Join(",", problems.ConvertAll(MiniJson.Q))).Append("]")
                    .Append(",\"detail\":").Append(firstBadDetail == null ? "null" : MiniJson.Q(firstBadDetail))
                    .Append(",\"createMs\":").Append(MiniJson.N(Math.Round(createMs)))
                    .Append(",\"hourMs\":{\"mean\":").Append(MiniJson.N(hm)).Append(",\"p95\":").Append(MiniJson.N(Pct(hourMs, 0.95))).Append(",\"p99\":").Append(MiniJson.N(Pct(hourMs, 0.99))).Append(",\"max\":").Append(MiniJson.N(hourMs[hourMs.Count - 1])).Append('}')
                    .Append(",\"waterMs\":{\"mean\":").Append(MiniJson.N(wm)).Append(",\"p95\":").Append(MiniJson.N(Pct(waterMs, 0.95))).Append(",\"p99\":").Append(MiniJson.N(Pct(waterMs, 0.99))).Append('}')
                    .Append(",\"weatherMsTotal\":").Append(MiniJson.N(sim.WeatherTiming.TotalMs))
                    .Append(",\"tsTiming\":{\"hourMean\":").Append(MiniJson.N(MiniJson.Num(ts["hourMean"]))).Append(",\"hourP95\":").Append(MiniJson.N(MiniJson.Num(ts["hourP95"]))).Append(",\"hourP99\":").Append(MiniJson.N(MiniJson.Num(ts["hourP99"])))
                    .Append(",\"waterMean\":").Append(MiniJson.N(MiniJson.Num(ts["waterMean"]))).Append('}')
                    .Append(",\"gcGen0\":").Append(gcs).Append(",\"allocBytes\":").Append(alloc).Append(",\"heapDeltaBytes\":").Append(mem)
                    .Append(",\"finalHash\":").Append(MiniJson.Q(sim.EnvHash())).Append('}');
            }
            sb.Append("\n]");
            reportJson = sb.ToString();
            return allOk;
        }

        static string Diff(Simulation sim, Dictionary<string, object> rec)
        {
            var e = sim.World.Env;
            var f = sim.World.Flora;
            var got = new Dictionary<string, string>
            {
                ["moisture"] = StateHasher.Fnv(e.Moisture),
                ["snow"] = StateHasher.Fnv(e.Snow),
                ["discharge"] = StateHasher.Fnv(e.Discharge),
                ["runoff"] = StateHasher.Fnv(e.Runoff),
                ["cells"] = StateHasher.Fnv(e.Weather.Cells),
                ["chunkRate"] = StateHasher.Fnv(e.Weather.ChunkRate),
                ["chunkCloud"] = StateHasher.Fnv(e.Weather.ChunkCloud),
                ["accT"] = StateHasher.Fnv(f.AccT),
                ["accW"] = StateHasher.Fnv(f.AccW),
                ["accMinT"] = StateHasher.Fnv(f.AccMinT),
            };
            var bad = new List<string>();
            foreach (var kv in MiniJson.Obj(rec["arrays"])) if (got[kv.Key] != (string)kv.Value) bad.Add(kv.Key);
            var totals = MiniJson.Arr(rec["totals"]);
            for (int k = 0; k < 4; k++)
                if ((string)totals[k] != MiniJson.Bits(e.WaterTotals[k])) bad.Add($"totals[{k}] {MiniJson.Bits(e.WaterTotals[k])} vs {totals[k]}");
            var bal = MiniJson.Arr(rec["balance"]);
            for (int k = 0; k < 2; k++)
                if ((string)bal[k] != MiniJson.Bits(e.Weather.Balance[k])) bad.Add($"balance[{k}] {MiniJson.Bits(e.Weather.Balance[k])} vs {bal[k]}");
            if ((string)rec["capillary"] != MiniJson.Bits(f.Capillary[0])) bad.Add("capillary");
            return bad.Count == 0 ? "(массивы совпали, отличие в прочих полях хеша)" : string.Join(", ", bad);
        }
    }
}
