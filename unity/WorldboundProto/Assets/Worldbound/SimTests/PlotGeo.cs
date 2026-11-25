// Опытный участок для проверок флоры — перенос tests/support/plot.ts (plotGeo): ровная суша 50 м, постоянные климат,
// почва и плодородие; по желанию — река в западных столбцах и другие условия в восточной половине. Только для тестов:
// игра участков не создаёт. Совпадение с TS проверяется отпечатком статики (FNV массивов) из эталона G3 B.
using System.Collections.Generic;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public sealed class PlotOptions
    {
        public int N = 32;
        public double TMean = 9, TAmp = 10, Precip = 800, Fertility = 0.75;
        public byte Soil = Soils.Loam;
        public int RiverColumns;
        public bool East;
        public byte? EastSoil;
        public double? EastPrecip, EastFertility;

        static byte SoilOf(string id)
        {
            for (int i = 0; i < Soils.All.Length; i++) if (Soils.All[i].Id == id) return (byte)i;
            throw new System.ArgumentException($"неизвестная почва {id}");
        }

        /// <summary>Параметры участка из JSON эталона (те же ключи, что PlotOptions в TS).</summary>
        public static PlotOptions From(Dictionary<string, object> o)
        {
            var p = new PlotOptions();
            if (o.TryGetValue("n", out var n)) p.N = (int)MiniJson.Num(n);
            if (o.TryGetValue("tMean", out var t)) p.TMean = MiniJson.Num(t);
            if (o.TryGetValue("tAmp", out var a)) p.TAmp = MiniJson.Num(a);
            if (o.TryGetValue("precip", out var pr)) p.Precip = MiniJson.Num(pr);
            if (o.TryGetValue("fertility", out var f)) p.Fertility = MiniJson.Num(f);
            if (o.TryGetValue("soil", out var s)) p.Soil = SoilOf((string)s);
            if (o.TryGetValue("riverColumns", out var r)) p.RiverColumns = (int)MiniJson.Num(r);
            if (o.TryGetValue("east", out var e))
            {
                var eo = MiniJson.Obj(e);
                p.East = true;
                if (eo.TryGetValue("soil", out var es)) p.EastSoil = SoilOf((string)es);
                if (eo.TryGetValue("precip", out var ep)) p.EastPrecip = MiniJson.Num(ep);
                if (eo.TryGetValue("fertility", out var ef)) p.EastFertility = MiniJson.Num(ef);
            }
            return p;
        }
    }

    public static class PlotGeo
    {
        static float[] Fill(int count, double v)
        {
            var a = new float[count];
            for (int i = 0; i < count; i++) a[i] = (float)v;
            return a;
        }

        public static Geo Build(PlotOptions o)
        {
            int n = o.N;
            const int cs = 8;
            int count = n * n;
            var waterKind = new byte[count];
            var waterDist = Fill(count, 1000);
            int river = o.RiverColumns;
            for (int z = 0; z < n; z++)
                for (int x = 0; x < n; x++)
                {
                    int i = z * n + x;
                    if (x < river) waterKind[i] = WaterKind.River;
                    waterDist[i] = x < river ? 0 : river > 0 ? (float)((x - river + 0.5) * cs) : 1000;
                }
            var soil = new byte[count];
            for (int i = 0; i < count; i++) soil[i] = o.Soil;
            var precip = Fill(count, o.Precip);
            var fertility = Fill(count, o.Fertility);
            if (o.East)
                for (int z = 0; z < n; z++)
                    for (int x = n >> 1; x < n; x++)
                    {
                        int i = z * n + x;
                        if (o.EastSoil.HasValue) soil[i] = o.EastSoil.Value;
                        if (o.EastPrecip.HasValue) precip[i] = (float)o.EastPrecip.Value;
                        if (o.EastFertility.HasValue) fertility[i] = (float)o.EastFertility.Value;
                    }
            var receiver = new int[count];
            var upstream = new int[count];
            var lakeId = new short[count];
            var province = new ushort[count];
            for (int i = 0; i < count; i++)
            {
                receiver[i] = -1;
                upstream[i] = i;
                lakeId[i] = -1;
                province[i] = 1;
            }
            int samples = n * cs / 2 + 1;
            return new Geo
            {
                N = n,
                CellSize = cs,
                Edges = new[] { EdgeKind.Sea, EdgeKind.Mountains, EdgeKind.Mountains, EdgeKind.Mountains },
                Height = Fill(count, 50),
                Slope = new float[count],
                WaterKind = waterKind,
                WaterLevel = Fill(count, 50),
                WaterDist = waterDist,
                SeaDist = Fill(count, 5000),
                Receiver = receiver,
                UpstreamOrder = upstream,
                MeanDischarge = Fill(count, river > 0 ? 1 : 0),
                LakeId = lakeId,
                Lakes = new Lake[0],
                TMean = Fill(count, o.TMean),
                TAmp = Fill(count, o.TAmp),
                Precip = precip,
                Soil = soil,
                Fertility = fertility,
                Deposit = new byte[count],
                DepositRichness = new byte[count],
                ProvinceOf = province,
                Provinces = new[]
                {
                    new Province { Id = 1, Name = "Опытный участок", Kind = "plain", X = n * cs / 2.0, Z = n * cs / 2.0, Cells = count, MeanHeight = 50, MeanTemp = o.TMean, MeanPrecip = o.Precip },
                },
                WindX = 0,
                WindZ = 1,
                Terrain = new Heights { Samples = samples, Spacing = 2, Data = Fill(samples * samples, 50) },
                Horizon = new Heights { Samples = 2, Spacing = n * cs, Data = Fill(4, 50) },
            };
        }
    }
}
