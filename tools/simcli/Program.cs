// Консольный запуск ядра Worldbound.Sim вне Unity (.NET CoreCLR из поставки Unity Editor):
// быстрые golden-проверки при переносе и третья точка сравнения скорости (TS / Unity Mono / .NET).
// Сборка и запуск: tools/simcli/run.sh worldgen [cases]
using System;
using System.IO;
using Worldbound.Sim.Golden;

static class Program
{
    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0] : "worldgen";
        string golden = Environment.GetEnvironmentVariable("WB_GOLDEN") ?? "unity/WorldboundProto/Golden";
        string only = args.Length > 1 ? args[1] : null;
        bool ok;
        string report;
        switch (mode)
        {
            case "worldgen":
                ok = WorldgenGolden.Run(File.ReadAllText(Path.Combine(golden, "worldgen.json")), Console.WriteLine, out report, only);
                break;
            case "env":
                ok = EnvGolden.Run(File.ReadAllText(Path.Combine(golden, "env.json")), Console.WriteLine, out report,
                    new EnvGolden.Options { Only = only, Label = "dotnet6", AllocatedBytes = () => GC.GetAllocatedBytesForCurrentThread() });
                break;
            case "save":
                ok = SaveCheck.Run(Environment.GetEnvironmentVariable("WB_TMP") ?? "unity/WorldboundProto/Temp/savecheck", Console.WriteLine, out report, only == "M" ? Worldbound.Sim.WorldSize.M : Worldbound.Sim.WorldSize.S);
                break;
            case "flora":
                ok = FloraGolden.Run(File.ReadAllText(Path.Combine(golden, "flora-g0g1.json")), "content", Console.WriteLine, out report);
                break;
            case "g2":
                ok = FloraG2Golden.Run(File.ReadAllText(Path.Combine(golden, "flora-g2.json")), Console.WriteLine, out report);
                break;
            case "g3":
                ok = FloraG3Golden.Run(File.ReadAllText(Path.Combine(golden, "flora-g3.json")), Console.WriteLine, out report,
                    new FloraG3Golden.Options { Label = "dotnet6", Days = only != null ? int.Parse(only) : (int?)null });
                break;
            case "g3b":
                ok = FloraG3BGolden.Run(File.ReadAllText(Path.Combine(golden, "flora-g3b.json")), Console.WriteLine, out report,
                    new FloraG3BGolden.Options { Label = "dotnet6", Days = only != null ? int.Parse(only) : (int?)null, AllocatedBytes = () => GC.GetAllocatedBytesForCurrentThread() });
                break;
            case "g3c":
                ok = FloraG3CGolden.Run(File.ReadAllText(Path.Combine(golden, "flora-g3c.json")), Console.WriteLine, out report,
                    new FloraG3CGolden.Options { Label = "dotnet6", Only = only != null ? new System.Collections.Generic.HashSet<string>(only.Split(',')) : null, AllocatedBytes = () => GC.GetAllocatedBytesForCurrentThread() });
                break;
            case "g3d":
                ok = FloraG3DGolden.Run(File.ReadAllText(Path.Combine(golden, "flora-g3d.json")), Console.WriteLine, out report,
                    new FloraG3CGolden.Options { Label = "dotnet6", Only = only != null ? new System.Collections.Generic.HashSet<string>(only.Split(',')) : null, AllocatedBytes = () => GC.GetAllocatedBytesForCurrentThread() });
                break;
            case "woodyrestore":
                ok = WoodyRestoreCheck.Run(Console.WriteLine, out report);
                break;
            case "pacer":
                ok = PacerCheck.Run(Console.WriteLine, out report);
                break;
            case "robust":
                ok = SaveRobustness.Run(Environment.GetEnvironmentVariable("WB_TMP") ?? "unity/WorldboundProto/Temp/saverobust", Console.WriteLine, out report);
                break;
            default:
                Console.WriteLine("режимы: worldgen | env | save [S|M] | pacer | robust | flora | woodyrestore | g2 | g3 [сутки] | g3b [сутки] | g3c [прогоны] | g3d [прогоны]");
                return 2;
        }
        string outPath = Environment.GetEnvironmentVariable("WB_REPORT");
        if (outPath != null) File.WriteAllText(outPath, report);
        Console.WriteLine(ok ? "ИТОГ: OK" : "ИТОГ: РАСХОЖДЕНИЯ");
        return ok ? 0 : 1;
    }
}
