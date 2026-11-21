// Golden-проверки Stage 2.0 (G0 и G1, docs/UNITY_MIGRATION_STAGE2_PLAN.md, раздел 6.1): каталоги, таблица видов,
// чистые функции, идентификаторы, генераторы случайных чисел, WoodyStore, FloraState — побитно против эталона,
// снятого с настоящего кода TS (tools/unity-flora-golden.ts → Golden/flora-g0g1.json). Входы — те же биты.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Worldbound.Sim.Flora;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class FloraGolden
    {
        sealed class Section
        {
            public string Name;
            public int Checked, Failed;
            public readonly List<string> Examples = new();

            public void Eq(bool ok, Func<string> what)
            {
                Checked++;
                if (ok) return;
                Failed++;
                if (Examples.Count < 8) Examples.Add(what());
            }
        }

        static List<object> A(object o) => MiniJson.Arr(o);
        static Dictionary<string, object> O(object o) => MiniJson.Obj(o);
        static double D(object o) => MiniJson.FromBits(o);
        static string Bits(double v) => MiniJson.Bits(v);
        static int I(object o) => (int)MiniJson.Num(o);
        static string Bn(double? v) => v.HasValue ? Bits(v.Value) : null;

        /// <summary>Отпечаток всех вычисленных C# значений — сравнивается между .NET 6, Mono редактора и сборки.</summary>
        sealed class Digest
        {
            uint h = 2166136261;
            public void Add(string s) { foreach (char c in s) h = unchecked((h ^ c) * 16777619); h = unchecked((h ^ 0x7c) * 16777619); }
            public override string ToString() => h.ToString("x8");
        }

        public static string LfSha256(string path)
        {
            var bytes = File.ReadAllBytes(path);
            var norm = new List<byte>(bytes.Length);
            for (int i = 0; i < bytes.Length; i++) if (!(bytes[i] == '\r' && i + 1 < bytes.Length && bytes[i + 1] == '\n')) norm.Add(bytes[i]);
            using var sha = SHA256.Create();
            var hash = sha.ComputeHash(norm.ToArray());
            var sb = new StringBuilder();
            foreach (byte b in hash) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        /// <param name="contentDir">Папка content/ репозитория (для сверки SHA-256 исходных JSON), null — не сверять с файлами.</param>
        public static bool Run(string goldenJson, string contentDir, Action<string> log, out string reportJson)
        {
            var root = O(MiniJson.Parse(goldenJson));
            var sections = new List<Section>();
            var dig = new Digest();
            Section New(string name) { var s = new Section { Name = name }; sections.Add(s); return s; }
            var sw = Stopwatch.StartNew();

            // ───────── G0: каталоги ─────────
            var cat = O(root["catalog"]);
            {
                var s = New("G0.sha256");
                s.Eq(PlantCatalog.SourceSha256 == (string)cat["plantsSha256"], () => $"PlantCatalog.g.cs {PlantCatalog.SourceSha256} ≠ эталон {cat["plantsSha256"]}");
                s.Eq(BiomeCatalog.SourceSha256 == (string)cat["biomesSha256"], () => $"BiomeCatalog.g.cs {BiomeCatalog.SourceSha256} ≠ эталон {cat["biomesSha256"]}");
                if (contentDir != null && File.Exists(Path.Combine(contentDir, "plants", "plants.json")))
                {
                    string p = LfSha256(Path.Combine(contentDir, "plants", "plants.json"));
                    string b = LfSha256(Path.Combine(contentDir, "biomes", "biomes.json"));
                    s.Eq(p == PlantCatalog.SourceSha256, () => $"plants.json на диске {p} ≠ сгенерированный {PlantCatalog.SourceSha256} — перегенерируйте каталог");
                    s.Eq(b == BiomeCatalog.SourceSha256, () => $"biomes.json на диске {b} ≠ сгенерированный {BiomeCatalog.SourceSha256}");
                }
            }
            {
                var s = New("G0.plants");
                var plants = A(cat["plants"]);
                s.Eq(plants.Count == PlantCatalog.All.Length, () => $"видов {PlantCatalog.All.Length} ≠ {plants.Count}");
                for (int i = 0; i < Math.Min(plants.Count, PlantCatalog.All.Length); i++)
                {
                    var e = O(plants[i]);
                    var p = PlantCatalog.All[i];
                    void F(string name, string got, object exp) => s.Eq(got == (string)exp, () => $"{p.Id}.{name}: {got} ≠ {exp}");
                    F("id", p.Id, e["id"]);
                    F("name", p.Name, e["name"]);
                    F("form", p.Form.ToString().ToLowerInvariant(), e["form"]);
                    F("leafHabit", char.ToLowerInvariant(p.LeafHabit.ToString()[0]) + p.LeafHabit.ToString().Substring(1), e["leafHabit"]);
                    F("community", p.Community?.ToString().ToLowerInvariant(), e["community"]);
                    var te = A(e["temperature"]);
                    F("temperature", string.Join(",", Bits(p.Temperature.Min), Bits(p.Temperature.OptMin), Bits(p.Temperature.OptMax), Bits(p.Temperature.Max)), string.Join(",", te));
                    var me = A(e["moisture"]);
                    F("moisture", string.Join(",", Bits(p.Moisture.Min), Bits(p.Moisture.OptMin), Bits(p.Moisture.OptMax), Bits(p.Moisture.Max)), string.Join(",", me));
                    F("frostKill", Bits(p.FrostKill), e["frostKill"]);
                    F("shadeTolerance", Bits(p.ShadeTolerance), e["shadeTolerance"]);
                    F("nutrientDemand", Bits(p.NutrientDemand), e["nutrientDemand"]);
                    F("growthRate", Bits(p.GrowthRate), e["growthRate"]);
                    F("maxBiomass", Bits(p.MaxBiomass), e["maxBiomass"]);
                    F("halfBiomass", Bn(p.HalfBiomass), e["halfBiomass"]);
                    F("maxHeight", Bn(p.MaxHeight), e["maxHeight"]);
                    F("maxCrownRadius", Bn(p.MaxCrownRadius), e["maxCrownRadius"]);
                    F("nutrientContent", Bits(p.NutrientContent), e["nutrientContent"]);
                    F("leafFraction", Bn(p.LeafFraction), e["leafFraction"]);
                    F("canopyTransmission", Bn(p.CanopyTransmission), e["canopyTransmission"]);
                    F("maturityYears", Bn(p.MaturityYears), e["maturityYears"]);
                    F("lifespanYears", Bn(p.LifespanYears), e["lifespanYears"]);
                    F("baseMortality", Bits(p.BaseMortality), e["baseMortality"]);
                    F("seedMass", Bits(p.SeedMass), e["seedMass"]);
                    F("fecundity", Bn(p.Fecundity), e["fecundity"]);
                    F("dispersalMean", Bn(p.DispersalMean), e["dispersalMean"]);
                    F("dispersalMax", Bn(p.DispersalMax), e["dispersalMax"]);
                    F("establishment", Bits(p.Establishment), e["establishment"]);
                    F("seedAllocation", Bn(p.SeedAllocation), e["seedAllocation"]);
                    F("seedBankYears", Bn(p.SeedBankYears), e["seedBankYears"]);
                    F("fixesNutrient", Bn(p.FixesNutrient), e["fixesNutrient"]);
                    F("litterQuality", Bits(p.LitterQuality), e["litterQuality"]);
                    F("colonistWeight", Bits(p.ColonistWeight), e["colonistWeight"]);
                    string gotSoil = p.SoilPreference == null ? null : string.Join(";", Array.ConvertAll(p.SoilPreference, x => x.Soil + "=" + Bits(x.Value)));
                    string expSoil = e["soilPreference"] == null ? null : string.Join(";", A(e["soilPreference"]).ConvertAll(x => (string)A(x)[0] + "=" + (string)A(x)[1]));
                    s.Eq(gotSoil == expSoil, () => $"{p.Id}.soilPreference: {gotSoil} ≠ {expSoil}");
                }
            }
            var T = SpeciesTable.Default;
            {
                var s = New("G0.speciesTable");
                var tab = O(cat["table"]);
                s.Eq(I(tab["count"]) == T.Count, () => $"count {T.Count} ≠ {tab["count"]}");
                var doubles = new Dictionary<string, double[]>
                {
                    ["tMin"] = T.TMin, ["tOptMin"] = T.TOptMin, ["tOptMax"] = T.TOptMax, ["tMax"] = T.TMax, ["frostKill"] = T.FrostKill,
                    ["wMin"] = T.WMin, ["wOptMin"] = T.WOptMin, ["wOptMax"] = T.WOptMax, ["wMax"] = T.WMax, ["lightNeed"] = T.LightNeed,
                    ["nutrientHalf"] = T.NutrientHalf, ["growth"] = T.Growth, ["maxBiomass"] = T.MaxBiomass, ["halfBiomass"] = T.HalfBiomass,
                    ["maxHeight"] = T.MaxHeight, ["maxCrown"] = T.MaxCrown, ["nutrient"] = T.Nutrient, ["leafFraction"] = T.LeafFraction,
                    ["transmission"] = T.Transmission, ["maturityYears"] = T.MaturityYears, ["lifespanYears"] = T.LifespanYears,
                    ["mortality"] = T.Mortality, ["seedMass"] = T.SeedMass, ["fecundity"] = T.Fecundity, ["dispersalMean"] = T.DispersalMean,
                    ["dispersalMax"] = T.DispersalMax, ["establishment"] = T.Establishment, ["seedAlloc"] = T.SeedAlloc,
                    ["seedBankYears"] = T.SeedBankYears, ["fixes"] = T.Fixes, ["litterQuality"] = T.LitterQuality, ["colonist"] = T.Colonist, ["soil"] = T.Soil,
                };
                var ints = new Dictionary<string, Func<int, int>>
                {
                    ["woody"] = i => T.Woody[i], ["tree"] = i => T.Tree[i], ["evergreen"] = i => T.Evergreen[i], ["dieback"] = i => T.Dieback[i],
                    ["herbSlot"] = i => T.HerbSlot[i], ["community"] = i => T.CommunityOf[i], ["conifer"] = i => T.Conifer[i],
                };
                int fields = 0;
                foreach (var kv in tab)
                {
                    if (kv.Key == "count") continue;
                    fields++;
                    var exp = A(kv.Value);
                    if (kv.Key == "herbs")
                    {
                        string got = string.Join(",", T.Herbs), want = string.Join(",", exp.ConvertAll(x => ((int)MiniJson.Num(x)).ToString()));
                        s.Eq(got == want, () => $"herbs {got} ≠ {want}");
                    }
                    else if (doubles.TryGetValue(kv.Key, out var arr))
                    {
                        s.Eq(arr.Length == exp.Count, () => $"{kv.Key}: длина {arr.Length} ≠ {exp.Count}");
                        for (int i = 0; i < Math.Min(arr.Length, exp.Count); i++) { int ii = i; s.Eq(Bits(arr[i]) == (string)exp[i], () => $"{kv.Key}[{ii}] {Bits(arr[ii])} ≠ {exp[ii]}"); }
                    }
                    else if (ints.TryGetValue(kv.Key, out var get))
                    {
                        for (int i = 0; i < exp.Count; i++) { int ii = i; s.Eq(get(i) == I(exp[i]), () => $"{kv.Key}[{ii}] {get(ii)} ≠ {exp[ii]}"); }
                    }
                    else s.Eq(false, () => $"поле таблицы {kv.Key} не перенесено");
                }
                s.Eq(fields == doubles.Count + ints.Count + 1, () => $"полей в эталоне {fields}, в C# {doubles.Count + ints.Count + 1}");
                var soils = A(cat["soils"]);
                for (int k = 0; k < soils.Count; k++) { int kk = k; s.Eq(k < Soils.All.Length && Soils.All[k].Id == (string)soils[k], () => $"порядок почв: {kk} {soils[kk]}"); }
            }
            {
                var s = New("G0.biomes");
                var biomes = A(cat["biomes"]);
                s.Eq(biomes.Count == BiomeCatalog.All.Length, () => $"биомов {BiomeCatalog.All.Length} ≠ {biomes.Count}");
                for (int i = 0; i < Math.Min(biomes.Count, BiomeCatalog.All.Length); i++)
                {
                    var e = O(biomes[i]);
                    var b = BiomeCatalog.All[i];
                    s.Eq(b.Id == (string)e["id"] && b.Name == (string)e["name"] && b.Color == (string)e["color"], () => $"{b.Id}: id/имя/цвет");
                    string w = b.Rule.Water == null ? null : string.Join(",", b.Rule.Water);
                    string we = e["water"] == null ? null : string.Join(",", A(e["water"]).ConvertAll(x => ((int)MiniJson.Num(x)).ToString()));
                    s.Eq(w == we, () => $"{b.Id}.water {w} ≠ {we}");
                    var r = O(e["rule"]);
                    var got = new Dictionary<string, double?>
                    {
                        ["treeCoverMin"] = b.Rule.TreeCoverMin, ["treeCoverMax"] = b.Rule.TreeCoverMax, ["shrubCoverMin"] = b.Rule.ShrubCoverMin,
                        ["tallShareMin"] = b.Rule.TallShareMin, ["tallShareMax"] = b.Rule.TallShareMax, ["herbBiomassMin"] = b.Rule.HerbBiomassMin,
                        ["herbBiomassMax"] = b.Rule.HerbBiomassMax, ["coniferShareMin"] = b.Rule.ConiferShareMin, ["coniferShareMax"] = b.Rule.ConiferShareMax,
                        ["tMeanMin"] = b.Rule.TMeanMin, ["tMeanMax"] = b.Rule.TMeanMax, ["moistureMin"] = b.Rule.MoistureMin, ["moistureMax"] = b.Rule.MoistureMax,
                        ["steppeShareMin"] = b.Rule.SteppeShareMin, ["steppeShareMax"] = b.Rule.SteppeShareMax, ["wetShareMin"] = b.Rule.WetShareMin,
                        ["pioneerShareMin"] = b.Rule.PioneerShareMin,
                    };
                    foreach (var kv in r) { var key = kv.Key; s.Eq(got.ContainsKey(key) && Bn(got[key]) == (string)kv.Value, () => $"{b.Id}.{key}"); }
                    s.Eq(r.Count == got.Count, () => $"{b.Id}: полей правила {r.Count} ≠ {got.Count}");
                }
            }

            // ───────── G1: чистые функции ─────────
            var vec = O(root["vectors"]);
            {
                var s = New("G1.trapezoid");
                var tr = O(vec["trapezoid"]);
                var args = A(tr["args"]);
                var outs = A(tr["out"]);
                for (int k = 0; k < args.Count; k++)
                {
                    var a = A(args[k]);
                    double r = Suitability.Trapezoid(D(a[0]), D(a[1]), D(a[2]), D(a[3]), D(a[4]));
                    dig.Add(Bits(r));
                    int kk = k;
                    s.Eq(Bits(r) == (string)outs[k], () => $"trapezoid #{kk}: {Bits(r)} ≠ {outs[kk]}");
                }
            }
            {
                var sResp = New("G1.responses");
                var sSuit = New("G1.suitability");
                var sAllo = New("G1.heightCrown");
                var sCap = New("G1.herbCapacity");
                foreach (var po in A(vec["species"]))
                {
                    var p = O(po);
                    int sp = I(p["s"]);
                    void Series(Section sec, string name, Func<double, double> f)
                    {
                        var x = O(p[name]);
                        var ins = A(x["in"]);
                        var outs = A(x["out"]);
                        for (int k = 0; k < ins.Count; k++)
                        {
                            double r = f(D(ins[k]));
                            dig.Add(Bits(r));
                            int kk = k;
                            sec.Eq(Bits(r) == (string)outs[k], () => $"{name}[s={sp}, вход {D(ins[kk]):R}]: {Bits(r)} ≠ {outs[kk]}");
                        }
                    }
                    Series(sResp, "temp", v => Suitability.TempResponse(T, sp, v));
                    Series(sResp, "moisture", v => Suitability.MoistureResponse(T, sp, v));
                    Series(sResp, "light", v => Suitability.LightResponse(T, sp, v));
                    Series(sResp, "nutrient", v => Suitability.NutrientResponse(T, sp, v));
                    var soil = A(p["soil"]);
                    for (int k = 0; k < soil.Count; k++) { int kk = k; double r = Suitability.SoilResponse(T, sp, k); dig.Add(Bits(r)); sResp.Eq(Bits(r) == (string)soil[k], () => $"soil[s={sp}, {kk}]"); }
                    foreach (var ro in A(p["suitability"]))
                    {
                        var r = A(ro);
                        double v = Suitability.Of(T, sp, D(r[0]), D(r[1]), D(r[2]), D(r[3]), int.Parse((string)r[4]));
                        dig.Add(Bits(v));
                        sSuit.Eq(Bits(v) == (string)r[5], () => $"suitability[s={sp}]: {Bits(v)} ≠ {r[5]}");
                    }
                    Series(sAllo, "height", b => FloraMath.WoodyHeight(T, sp, b));
                    Series(sAllo, "crown", b => FloraMath.CrownRadius(T, sp, b));
                    foreach (var ro in A(p["herbCapacity"]))
                    {
                        var r = A(ro);
                        double v = FloraMath.HerbCapacity(T, sp, D(r[0]), D(r[1]));
                        dig.Add(Bits(v));
                        sCap.Eq(Bits(v) == (string)r[2], () => $"herbCapacity[s={sp}]: {Bits(v)} ≠ {r[2]}");
                    }
                }
            }
            {
                var s = New("G1.light");
                foreach (var co in A(vec["light"]))
                {
                    var c = O(co);
                    var canopy = A(c["canopy"]).ConvertAll(x => MiniJson.FloatFromBits(x)).ToArray();
                    var hs = A(c["heights"]);
                    var la = A(c["lightAt"]);
                    for (int k = 0; k < hs.Count; k++)
                    {
                        double r = FloraMath.LightAt(canopy, 0, D(hs[k]));
                        dig.Add(Bits(r));
                        int kk = k;
                        s.Eq(Bits(r) == (string)la[k], () => $"lightAt(h={D(hs[kk]):R}): {Bits(r)} ≠ {la[kk]}");
                    }
                    double g = FloraMath.GroundLight(canopy, 0);
                    dig.Add(Bits(g));
                    s.Eq(Bits(g) == (string)c["ground"], () => $"groundLight: {Bits(g)} ≠ {c["ground"]}");
                }
                var hsh = O(vec["herbShade"]);
                var hin = A(hsh["in"]);
                var hout = A(hsh["out"]);
                for (int k = 0; k < hin.Count; k++) { int kk = k; double r = FloraMath.HerbShade(D(hin[k])); dig.Add(Bits(r)); s.Eq(Bits(r) == (string)hout[k], () => $"herbShade #{kk}"); }
            }
            {
                var s = New("G1.biomes");
                foreach (var bo in A(vec["biomes"]))
                {
                    var b = O(bo);
                    var x = A(b["in"]);
                    var c = new BiomeInput
                    {
                        Water = int.Parse((string)x[0]), TreeCover = D(x[1]), ShrubCover = D(x[2]), TallShare = D(x[3]), HerbBiomass = D(x[4]), ConiferShare = D(x[5]),
                        TMean = D(x[6]), Moisture = D(x[7]), SteppeShare = D(x[8]), WetShare = D(x[9]), PioneerShare = D(x[10]),
                    };
                    int cls = Biomes.Classify(c);
                    s.Eq(cls == I(b["cls"]), () => $"classify: {cls} ≠ {b["cls"]}");
                    var m = new StringBuilder();
                    for (int i = 0; i < BiomeCatalog.All.Length; i++)
                    {
                        if (i > 0) m.Append(',');
                        foreach (int mode in new[] { -1, 0, 1 }) m.Append(Biomes.RuleMatches(BiomeCatalog.All[i].Rule, c, mode) ? '1' : '0');
                    }
                    string ms = m.ToString();
                    s.Eq(ms == (string)b["matches"], () => $"ruleMatches {ms} ≠ {b["matches"]}");
                    bool conf = Biomes.ConfirmsChange(I(b["cur"]), I(b["next"]), c);
                    s.Eq((conf ? 1 : 0) == I(b["confirms"]), () => $"confirmsChange({b["cur"]}→{b["next"]})");
                    dig.Add(cls + ms + conf);
                }
            }
            {
                var s = New("G1.ids");
                var ids = O(vec["ids"]);
                s.Eq(I(ids["tree"]) == EntityKind.Tree, () => "EntityKind.Tree");
                foreach (var io in A(ids["make"]))
                {
                    var r = A(io);
                    uint id = EntityId.Make(I(r[0]), I(r[1]), I(r[2]));
                    dig.Add(id.ToString());
                    s.Eq(id == (uint)MiniJson.Num(r[3]), () => $"makeId({r[0]},{r[1]},{r[2]}) = {id} ≠ {r[3]}");
                }
                foreach (var io in A(ids["parts"]))
                {
                    var r = A(io);
                    uint id = (uint)MiniJson.Num(r[0]);
                    s.Eq(EntityId.Kind(id) == I(r[1]) && EntityId.Generation(id) == I(r[2]) && EntityId.Index(id) == I(r[3]), () => $"части id {id}");
                }
            }
            {
                var s = New("G1.rng");
                var rng = O(vec["rng"]);
                foreach (var mo in A(rng["mix32"])) { var r = A(mo); uint v = Hash.Mix32((uint)MiniJson.Num(r[0])); dig.Add(v.ToString()); s.Eq(v == (uint)MiniJson.Num(r[1]), () => $"mix32({r[0]})"); }
                foreach (var ho in A(rng["hash4"]))
                {
                    var r = A(ho);
                    int a = JsMath.ToInt32(MiniJson.Num(r[0])), b = JsMath.ToInt32(MiniJson.Num(r[1])), c = JsMath.ToInt32(MiniJson.Num(r[2])), d = JsMath.ToInt32(MiniJson.Num(r[3]));
                    uint h = Hash.Hash4(a, b, c, d);
                    double cr = Hash.CounterRandom(a, b, c, d);
                    dig.Add(h + Bits(cr));
                    s.Eq(h == (uint)MiniJson.Num(r[4]) && Bits(cr) == (string)r[5], () => $"hash4/counterRandom({r[0]},{r[1]},{r[2]},{r[3]}) = {h} ≠ {r[4]}");
                }
                foreach (var ro in A(rng["rng"]))
                {
                    var r = O(ro);
                    var gen = new Rng((uint)MiniJson.Num(r["seed"]), I(r["stream"]));
                    foreach (var u in A(r["u32"])) { uint v = gen.NextU32(); dig.Add(v.ToString()); s.Eq(v == (uint)MiniJson.Num(u), () => $"sfc32({r["seed"]},{r["stream"]}).nextU32"); }
                    foreach (var u in A(r["next"])) { double v = gen.Next(); s.Eq(Bits(v) == (string)u, () => $"sfc32.next"); }
                    foreach (var u in A(r["int"])) { int v = gen.Int(1000); s.Eq(v == I(u), () => $"sfc32.int"); }
                }
                foreach (var so in A(rng["seedFromString"])) { var r = A(so); uint v = Hash.SeedFromString((string)r[0]); s.Eq(v == (uint)MiniJson.Num(r[1]), () => $"seedFromString(«{r[0]}») = {v} ≠ {r[1]}"); }
            }
            {
                var s = New("G1.woodyStore");
                var ws = O(vec["woodyStore"]);
                var a = O(ws["a"]);
                var w = new WoodyStore(16);
                int step = 0;
                foreach (var oo in A(a["ops"]))
                {
                    var op = A(oo);
                    int st = step++;
                    if ((string)op[0] == "s")
                    {
                        int i = w.Spawn(I(op[1]), D(op[2]), D(op[3]), I(op[4]), D(op[5]), D(op[6]));
                        string free = string.Join(" ", w.FreeSlots());
                        long id = i >= 0 ? w.IdOf(i) : -1;
                        dig.Add($"{i}/{w.HighWater}/{w.Count}/{free}/{id}");
                        s.Eq(i == I(op[7]) && w.HighWater == I(op[8]) && w.Count == I(op[9]) && free == (string)op[10] && id == (long)MiniJson.Num(op[11]),
                            () => $"шаг {st} spawn: индекс {i}/{op[7]}, highWater {w.HighWater}/{op[8]}, count {w.Count}/{op[9]}, стек «{free}»/«{op[10]}», id {id}/{op[11]}");
                    }
                    else
                    {
                        int i = I(op[1]);
                        w.Remove(i);
                        string free = string.Join(" ", w.FreeSlots());
                        s.Eq(w.HighWater == I(op[2]) && w.Count == I(op[3]) && free == (string)op[4] && w.IdOf(i) == (uint)MiniJson.Num(op[5]),
                            () => $"шаг {st} remove({i}): highWater {w.HighWater}/{op[2]}, count {w.Count}/{op[3]}, стек «{free}»/«{op[4]}»");
                    }
                }
                var cols = O(a["columns"]);
                var got = new Dictionary<string, string>
                {
                    ["x"] = StateHasher.Fnv(w.X), ["z"] = StateHasher.Fnv(w.Z), ["species"] = StateHasher.Fnv(w.Species), ["age"] = StateHasher.Fnv(w.Age),
                    ["biomass"] = StateHasher.Fnv(w.Biomass), ["leaf"] = StateHasher.Fnv(w.Leaf), ["health"] = StateHasher.Fnv(w.Health), ["stage"] = StateHasher.Fnv(w.Stage),
                    ["stressW"] = StateHasher.Fnv(w.StressW), ["stressL"] = StateHasher.Fnv(w.StressL), ["cell"] = StateHasher.Fnv(w.Cell), ["alive"] = StateHasher.Fnv(w.Alive),
                    ["generation"] = StateHasher.Fnv(w.Generation),
                };
                foreach (var kv in cols) { var key = kv.Key; s.Eq(got[key] == (string)kv.Value, () => $"столбец {key}: {got[key]} ≠ {kv.Value}"); }
                // B: поколения 255 → 0.
                var g = new WoodyStore(4);
                g.Spawn(1, 0, 0, 0, 1, 0);
                var gexp = A(ws["b"]);
                for (int k = 0; k < gexp.Count / 3; k++)
                {
                    g.Remove(0);
                    int i = g.Spawn(1, 0, 0, 0, 1, 0);
                    int kk = k;
                    s.Eq(i == I(gexp[k * 3]) && g.Generation[0] == I(gexp[k * 3 + 1]) && g.IdOf(0) == (uint)MiniJson.Num(gexp[k * 3 + 2]), () => $"цикл поколения {kk}: поколение {g.Generation[0]}/{gexp[kk * 3 + 1]}");
                }
                // C: заполнение и LIFO.
                var f = new WoodyStore(8);
                var fill = new List<int>();
                for (int k = 0; k < 9; k++) fill.Add(f.Spawn(2, k, k, k, 1, 0));
                foreach (int i in new[] { 3, 5, 1 }) f.Remove(i);
                for (int k = 0; k < 4; k++) fill.Add(f.Spawn(3, 0, 0, 0, 1, 0));
                string fillGot = string.Join(",", fill), fillExp = string.Join(",", A(ws["c"]).ConvertAll(x => ((int)MiniJson.Num(x)).ToString()));
                s.Eq(fillGot == fillExp, () => $"заполнение/LIFO {fillGot} ≠ {fillExp}");
                // D: restore.
                var dd = O(ws["d"]);
                var r = new WoodyStore(10);
                for (int k = 0; k < 10; k++) r.Spawn(4, 0, 0, 0, 1, 0);
                foreach (int i in new[] { 2, 7, 4 }) r.Remove(i);
                var free2 = r.FreeSlots();
                var r2 = new WoodyStore(10);
                r2.Restore(r.HighWater, r.Count, free2);
                var restored = new List<int> { r2.HighWater, r2.Count };
                for (int k = 0; k < 4; k++) restored.Add(r2.Spawn(5, 0, 0, 0, 1, 0));
                string rGot = string.Join(",", restored), rExp = string.Join(",", A(dd["restored"]).ConvertAll(x => ((int)MiniJson.Num(x)).ToString()));
                s.Eq(string.Join(",", free2) == string.Join(",", A(dd["free"]).ConvertAll(x => ((int)MiniJson.Num(x)).ToString())) && rGot == rExp, () => $"restore {rGot} ≠ {rExp}");
                string err = "";
                try { r2.Restore(11, 0, new int[0]); } catch (InvalidOperationException e) { err = e.Message; }
                s.Eq(err == (string)dd["restoreError"], () => $"ошибка restore «{err}» ≠ «{dd["restoreError"]}»");
            }

            // ───────── FloraState на мире S/42 ─────────
            var perf = new StringBuilder();
            {
                var s = New("G1.floraState");
                var fs = O(root["floraState"]);
                var gsw = Stopwatch.StartNew();
                var geo = Generate.World(new WorldConfig { Seed = 42, Size = WorldSize.S }).Geo;
                double genMs = gsw.Elapsed.TotalMilliseconds;
                long mem0 = GC.GetTotalMemory(true);
                var csw = Stopwatch.StartNew();
                var flora = FloraState.Create(geo);
                double createMs = csw.Elapsed.TotalMilliseconds;
                long createBytes = GC.GetTotalMemory(false) - mem0;
                var created = O(fs["created"]);
                CompareArrays(s, "создание", flora, O(created["arrays"]));
                s.Eq(FloraState.WoodyCapacity(geo) == I(created["capacity"]) && flora.Woody.Capacity == I(created["woodyCapacityField"]), () => "ёмкость древесных");
                s.Eq(flora.LastSliceHour == I(created["lastSliceHour"]) && flora.PreparedYears == MiniJson.Num(created["preparedYears"]) && flora.RegionalSeedRain == (bool)created["regionalSeedRain"], () => "скалярные поля");
                s.Eq(Bits(FloraState.NutrientStock(flora, geo)) == (string)created["stock"], () => "nutrientStock пустого состояния");
                s.Eq(Bits(FloraState.NutrientBudget(flora)) == (string)created["budget"], () => "nutrientBudget пустого состояния");
                var fsw = Stopwatch.StartNew();
                Fill(flora, geo);
                double fillMs = fsw.Elapsed.TotalMilliseconds;
                var filled = O(fs["filled"]);
                CompareArrays(s, "заполнение", flora, O(filled["arrays"]));
                var ssw = Stopwatch.StartNew();
                double stock = FloraState.NutrientStock(flora, geo);
                double stockMs = ssw.Elapsed.TotalMilliseconds;
                dig.Add(Bits(stock));
                s.Eq(Bits(stock) == (string)filled["stock"], () => $"nutrientStock {Bits(stock)} ≠ {filled["stock"]}");
                s.Eq(Bits(FloraState.NutrientBudget(flora)) == (string)filled["budget"], () => "nutrientBudget");
                var hb = A(filled["herbBiomass"]);
                int[] cells = { 0, 1000, 33000, 65535 };
                for (int k = 0; k < cells.Length; k++) { int kk = k; s.Eq(Bits(FloraState.HerbBiomass(flora, cells[k])) == (string)hb[k], () => $"herbBiomass({cells[kk]})"); }
                s.Eq(flora.Woody.Count == I(filled["woodyCount"]) && flora.Woody.HighWater == I(filled["woodyHighWater"]) && StateHasher.Fnv(flora.Woody.FreeSlots()) == (string)filled["free"], () => "древесные после заполнения");
                // Память и время мира M (создание пустого состояния; эталона для M нет — только замер).
                var geoM = Generate.World(new WorldConfig { Seed = 42, Size = WorldSize.M }).Geo;
                long memM0 = GC.GetTotalMemory(true);
                var msw = Stopwatch.StartNew();
                var floraM = FloraState.Create(geoM);
                double createMMs = msw.Elapsed.TotalMilliseconds;
                long createMBytes = GC.GetTotalMemory(false) - memM0;
                var tsT = O(root["tsTiming"]);
                perf.Append("{\"createFloraS_ms\":").Append(MiniJson.N(Math.Round(createMs, 2))).Append(",\"createFloraS_MB\":").Append(MiniJson.N(Math.Round(createBytes / 1048576.0, 1)))
                    .Append(",\"createFloraM_ms\":").Append(MiniJson.N(Math.Round(createMMs, 2))).Append(",\"createFloraM_MB\":").Append(MiniJson.N(Math.Round(createMBytes / 1048576.0, 1)))
                    .Append(",\"woodyCapacityM\":").Append(floraM.Woody.Capacity)
                    .Append(",\"fillS_ms\":").Append(MiniJson.N(Math.Round(fillMs, 2))).Append(",\"nutrientStockS_ms\":").Append(MiniJson.N(Math.Round(stockMs, 2)))
                    .Append(",\"ts\":{\"createFloraS_ms\":").Append(MiniJson.N(Math.Round(MiniJson.Num(tsT["createFloraMs"]), 2))).Append(",\"fillS_ms\":").Append(MiniJson.N(Math.Round(MiniJson.Num(tsT["fillMs"]), 2)))
                    .Append(",\"nutrientStockS_ms\":").Append(MiniJson.N(Math.Round(MiniJson.Num(tsT["nutrientStockMs"]), 2))).Append('}');
                GC.KeepAlive(floraM);
            }
            // Пропускная способность чистых функций (без выделений памяти): вызовов в секунду.
            {
                long gc0 = GC.CollectionCount(0);
                long heap0 = GC.GetTotalMemory(false);
                var tsw = Stopwatch.StartNew();
                double acc = 0;
                const int N = 2_000_000;
                for (int k = 0; k < N; k++)
                {
                    int s = k % T.Count;
                    acc += Suitability.Of(T, s, (k % 97) * 0.4 - 5, (k % 53) * 0.02, (k % 11) * 0.1, (k % 29) * 0.5, k % 6);
                }
                double suitNs = tsw.Elapsed.TotalMilliseconds * 1e6 / N;
                var canopy = new float[] { 0.1f, 0.2f, 0.3f, 0.4f };
                tsw.Restart();
                for (int k = 0; k < N; k++) acc += FloraMath.LightAt(canopy, 0, (k % 40) * 0.5) + FloraMath.WoodyHeight(T, 12 + k % 6, k % 500);
                double lightNs = tsw.Elapsed.TotalMilliseconds * 1e6 / N;
                perf.Append(",\"suitabilityNs\":").Append(MiniJson.N(Math.Round(suitNs, 1))).Append(",\"lightAtPlusHeightNs\":").Append(MiniJson.N(Math.Round(lightNs, 1)))
                    .Append(",\"hotLoopGcGen0\":").Append(GC.CollectionCount(0) - gc0).Append(",\"hotLoopHeapDeltaBytes\":").Append(GC.GetTotalMemory(false) - heap0)
                    .Append(",\"checksum\":").Append(MiniJson.N(acc)).Append('}');
            }

            double totalMs = sw.Elapsed.TotalMilliseconds;
            bool ok = true;
            var sb = new StringBuilder("{\"sections\":[");
            for (int i = 0; i < sections.Count; i++)
            {
                var s = sections[i];
                ok &= s.Failed == 0 && s.Checked > 0;
                log($"flora {s.Name}: {(s.Failed == 0 ? "OK" : "FAIL")} — проверок {s.Checked}, расхождений {s.Failed}{(s.Examples.Count > 0 ? "; " + string.Join(" | ", s.Examples) : "")}");
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(s.Name)).Append(",\"checked\":").Append(s.Checked).Append(",\"failed\":").Append(s.Failed)
                    .Append(",\"examples\":[").Append(string.Join(",", s.Examples.ConvertAll(MiniJson.Q))).Append("]}");
            }
            sb.Append("],\"digest\":").Append(MiniJson.Q(dig.ToString())).Append(",\"totalMs\":").Append(MiniJson.N(Math.Round(totalMs))).Append(",\"perf\":").Append(perf).Append('}');
            log($"flora digest {dig} (одинаков в .NET 6, Mono редактора и сборки, если вычисления совпадают), проверка {totalMs:F0} мс; замеры {perf}");
            reportJson = sb.ToString();
            return ok;
        }

        /// <summary>Детерминированное заполнение состояния (тот же алгоритм, что в tools/unity-flora-golden.ts).</summary>
        static void Fill(FloraState flora, Geo geo)
        {
            int n = geo.N;
            int count = n * n;
            double F(int sys, int k) => Hash.CounterRandom(77, sys, k, 0);
            var herbs = flora.Species.Herbs;
            var land = new List<int>();
            for (int c = 0; c < count; c++)
            {
                if (geo.WaterKind[c] != WaterKind.None) continue;
                land.Add(c);
                for (int k = 0; k < FloraState.Slots; k++)
                {
                    if (F(1, c * 4 + k) < 0.45)
                    {
                        flora.SlotSpecies[c * FloraState.Slots + k] = (byte)herbs[(int)Math.Floor(F(2, c * 4 + k) * herbs.Length)];
                        flora.SlotBiomass[c * FloraState.Slots + k] = (float)(F(3, c * 4 + k) * 500);
                    }
                }
                flora.LitterFastN[c] = (float)(F(4, c) * 3);
                flora.LitterWoodN[c] = (float)(F(5, c) * 2);
                flora.Nutrient[c] = (float)(flora.Nutrient[c] + F(6, c));
                for (int h = 0; h < herbs.Length; h++) if (F(7, c * 8 + h) < 0.2) flora.SeedBank[h * count + c] = (float)(F(8, c * 8 + h) * 0.4);
            }
            var woodyList = new List<int>();
            for (int s = 0; s < flora.Species.Count; s++) if (flora.Species.Woody[s] == 1) woodyList.Add(s);
            var w = flora.Woody;
            for (int k = 0; k < 20000; k++)
            {
                int c = land[(int)Math.Floor(F(9, k) * land.Count)];
                int s = woodyList[(int)Math.Floor(F(10, k) * woodyList.Count)];
                int i = w.Spawn(s, (c % n + F(11, k)) * geo.CellSize, (Math.Floor(c / (double)n) + F(12, k)) * geo.CellSize, c, F(13, k) * 300, F(14, k) * 80);
                if (F(15, k) < 0.1) w.Remove(i);
            }
            for (int j = 0; j < 10; j++) flora.Ledger[j] = F(16, j) * 1000;
        }

        static void CompareArrays(Section s, string phase, FloraState f, Dictionary<string, object> exp)
        {
            var got = new Dictionary<string, string>
            {
                ["slotSpecies"] = StateHasher.Fnv(f.SlotSpecies), ["slotBiomass"] = StateHasher.Fnv(f.SlotBiomass), ["litterFast"] = StateHasher.Fnv(f.LitterFast),
                ["litterFastN"] = StateHasher.Fnv(f.LitterFastN), ["litterFastQ"] = StateHasher.Fnv(f.LitterFastQ), ["litterWood"] = StateHasher.Fnv(f.LitterWood),
                ["litterWoodN"] = StateHasher.Fnv(f.LitterWoodN), ["nutrient"] = StateHasher.Fnv(f.Nutrient), ["accT"] = StateHasher.Fnv(f.AccT), ["accW"] = StateHasher.Fnv(f.AccW),
                ["accRunoff"] = StateHasher.Fnv(f.AccRunoff), ["accMinT"] = StateHasher.Fnv(f.AccMinT), ["accHours"] = StateHasher.Fnv(f.AccHours), ["dayT"] = StateHasher.Fnv(f.DayT),
                ["dayW"] = StateHasher.Fnv(f.DayW), ["capillary"] = StateHasher.Fnv(f.Capillary), ["seedBank"] = StateHasher.Fnv(f.SeedBank), ["woodyCount"] = StateHasher.Fnv(f.WoodyCount),
                ["canopy"] = StateHasher.Fnv(f.Canopy), ["treeCover"] = StateHasher.Fnv(f.TreeCover), ["shrubCover"] = StateHasher.Fnv(f.ShrubCover), ["coniferCover"] = StateHasher.Fnv(f.ConiferCover),
                ["tallCover"] = StateHasher.Fnv(f.TallCover), ["colonistMass"] = StateHasher.Fnv(f.ColonistMass), ["colonistFirst"] = StateHasher.Fnv(f.ColonistFirst), ["ledger"] = StateHasher.Fnv(f.Ledger),
            };
            foreach (var kv in exp)
            {
                var key = kv.Key;
                if (key == "biome")
                {
                    var b = f.Biome;
                    var mine = new[] { StateHasher.Fnv(b.Herb), StateHasher.Fnv(b.Steppe), StateHasher.Fnv(b.Wet), StateHasher.Fnv(b.Pioneer), StateHasher.Fnv(b.Moisture), StateHasher.Fnv(b.Tree), StateHasher.Fnv(b.Shrub), StateHasher.Fnv(b.Conifer), StateHasher.Fnv(b.Tall), StateHasher.Fnv(b.Current), StateHasher.Fnv(b.Candidate), StateHasher.Fnv(b.Days) };
                    var want = A(kv.Value);
                    for (int k = 0; k < want.Count; k++) { int kk = k; s.Eq(mine[k] == (string)want[k], () => $"{phase}: biome[{kk}] {mine[kk]} ≠ {want[kk]}"); }
                }
                else if (key == "woody")
                {
                    var w = f.Woody;
                    var mine = new[] { StateHasher.Fnv(w.X), StateHasher.Fnv(w.Z), StateHasher.Fnv(w.Species), StateHasher.Fnv(w.Age), StateHasher.Fnv(w.Biomass), StateHasher.Fnv(w.Leaf), StateHasher.Fnv(w.Health), StateHasher.Fnv(w.Stage), StateHasher.Fnv(w.StressW), StateHasher.Fnv(w.StressL), StateHasher.Fnv(w.Cell), StateHasher.Fnv(w.Alive), StateHasher.Fnv(w.Generation) };
                    var want = A(kv.Value);
                    for (int k = 0; k < want.Count; k++) { int kk = k; s.Eq(mine[k] == (string)want[k], () => $"{phase}: woody[{kk}] {mine[kk]} ≠ {want[kk]}"); }
                }
                else s.Eq(got.TryGetValue(key, out var v) && v == (string)kv.Value, () => $"{phase}: {key} {(got.TryGetValue(key, out var v2) ? v2 : "нет")} ≠ {kv.Value}");
            }
        }
    }
}
