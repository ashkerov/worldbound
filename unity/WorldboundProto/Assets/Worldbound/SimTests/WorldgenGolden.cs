// Golden-проверка генератора: тот же seed/размер/климат → тот же geoHash и побитно те же массивы, что в TS.
// Эталон — Golden/worldgen.json (tools/unity-worldgen-golden.ts). Не зависит от UnityEngine.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class WorldgenGolden
    {
        public static WorldConfig ConfigOf(Dictionary<string, object> c)
        {
            string climate = (string)c["climate"];
            return new WorldConfig
            {
                Seed = (uint)MiniJson.Num(c["seed"]),
                Size = (string)c["size"] == "S" ? WorldSize.S : WorldSize.M,
                Climate = climate == "cold" ? Climate.Cold : climate == "warm" ? Climate.Warm : Climate.Temperate,
            };
        }

        public static Dictionary<string, string> ArrayHashes(Geo g) => new()
        {
            ["height"] = StateHasher.Fnv(g.Height),
            ["slope"] = StateHasher.Fnv(g.Slope),
            ["waterKind"] = StateHasher.Fnv(g.WaterKind),
            ["waterLevel"] = StateHasher.Fnv(g.WaterLevel),
            ["waterDist"] = StateHasher.Fnv(g.WaterDist),
            ["seaDist"] = StateHasher.Fnv(g.SeaDist),
            ["receiver"] = StateHasher.Fnv(g.Receiver),
            ["upstreamOrder"] = StateHasher.Fnv(g.UpstreamOrder),
            ["meanDischarge"] = StateHasher.Fnv(g.MeanDischarge),
            ["lakeId"] = StateHasher.Fnv(g.LakeId),
            ["tMean"] = StateHasher.Fnv(g.TMean),
            ["tAmp"] = StateHasher.Fnv(g.TAmp),
            ["precip"] = StateHasher.Fnv(g.Precip),
            ["soil"] = StateHasher.Fnv(g.Soil),
            ["fertility"] = StateHasher.Fnv(g.Fertility),
            ["deposit"] = StateHasher.Fnv(g.Deposit),
            ["depositRichness"] = StateHasher.Fnv(g.DepositRichness),
            ["province"] = StateHasher.Fnv(g.ProvinceOf),
            ["terrain"] = StateHasher.Fnv(g.Terrain.Data),
            ["horizon"] = StateHasher.Fnv(g.Horizon.Data),
        };

        /// <summary>Проверяет все случаи файла; возвращает JSON-отчёт и общий итог.</summary>
        public static bool Run(string goldenJson, Action<string> log, out string reportJson, string only = null)
        {
            var root = MiniJson.Obj(MiniJson.Parse(goldenJson));
            var sb = new StringBuilder("[\n");
            bool allOk = true;
            bool first = true;
            foreach (var co in MiniJson.Arr(root["cases"]))
            {
                var c = MiniJson.Obj(co);
                string label = $"{MiniJson.Num(c["seed"])}:{c["size"]}:{c["climate"]}";
                if (only != null && !only.Split(',').Contains(label)) continue;
                var config = ConfigOf(c);
                var sw = Stopwatch.StartNew();
                var res = Generate.World(config);
                double ms = sw.Elapsed.TotalMilliseconds;
                var g = res.Geo;
                var mism = new List<string>();
                var expArrays = MiniJson.Obj(c["arrays"]);
                var got = ArrayHashes(g);
                foreach (var kv in expArrays)
                    if (got[kv.Key] != (string)kv.Value) mism.Add(kv.Key);
                var edges = MiniJson.Arr(c["edges"]);
                for (int e = 0; e < 4; e++) if (g.Edges[e] != (byte)MiniJson.Num(edges[e])) { mism.Add("edges"); break; }
                if (MiniJson.Bits(g.WindX) != (string)c["windX"] || MiniJson.Bits(g.WindZ) != (string)c["windZ"]) mism.Add("wind");
                var lakes = MiniJson.Arr(c["lakes"]);
                bool lakesOk = lakes.Count == g.Lakes.Length;
                for (int k = 0; lakesOk && k < lakes.Count; k++)
                {
                    var l = MiniJson.Arr(lakes[k]);
                    lakesOk = (string)l[0] == MiniJson.Bits(g.Lakes[k].Level) && (int)MiniJson.Num(l[1]) == g.Lakes[k].Cells && (int)MiniJson.Num(l[2]) == g.Lakes[k].Outlet;
                }
                if (!lakesOk) mism.Add("lakes");
                var provs = MiniJson.Arr(c["provinces"]);
                bool provOk = provs.Count == g.Provinces.Length;
                for (int k = 0; provOk && k < provs.Count; k++)
                {
                    var p = MiniJson.Obj(provs[k]);
                    var q = g.Provinces[k];
                    provOk = (string)p["name"] == q.Name && (string)p["kind"] == q.Kind && (int)MiniJson.Num(p["cells"]) == q.Cells && (string)p["x"] == MiniJson.Bits(q.X) && (string)p["z"] == MiniJson.Bits(q.Z)
                        && (string)p["meanHeight"] == MiniJson.Bits(q.MeanHeight) && (string)p["meanTemp"] == MiniJson.Bits(q.MeanTemp) && (string)p["meanPrecip"] == MiniJson.Bits(q.MeanPrecip);
                }
                if (!provOk) mism.Add("provinces");
                bool hashOk = res.Hash == (string)c["geoHash"];
                bool ok = hashOk && mism.Count == 0;
                allOk &= ok;
                log($"worldgen {label}: {(ok ? "OK" : "MISMATCH")} hash {res.Hash} (эталон {c["geoHash"]}), C# {ms:F0} мс, TS {MiniJson.Num(c["tsMs"])} мс{(mism.Count > 0 ? ", расхождения: " + string.Join(", ", mism) : "")}");
                if (!first) sb.Append(",\n");
                first = false;
                sb.Append("  {\"case\":").Append(MiniJson.Q(label)).Append(",\"ok\":").Append(ok ? "true" : "false")
                    .Append(",\"geoHash\":").Append(MiniJson.Q(res.Hash)).Append(",\"expected\":").Append(MiniJson.Q((string)c["geoHash"]))
                    .Append(",\"csMs\":").Append(MiniJson.N(Math.Round(ms))).Append(",\"tsMs\":").Append(MiniJson.N(MiniJson.Num(c["tsMs"])))
                    .Append(",\"mismatches\":[").Append(string.Join(",", mism.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("\n]");
            reportJson = sb.ToString();
            return allOk;
        }

        static bool Contains(this string[] a, string s) => Array.IndexOf(a, s) >= 0;
    }
}
