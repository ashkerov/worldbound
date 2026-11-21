// Статические данные мира, созданные генератором из seed (src/sim/worldgen/geo.ts).
namespace Worldbound.Sim.WorldGen
{
    public static class WaterKind { public const byte None = 0, River = 1, Lake = 2, Sea = 3; }
    public static class EdgeKind { public const byte Sea = 0, Mountains = 1; }
    public static class DepositKind { public const byte None = 0, Stone = 1, Clay = 2, Ore = 3, Sand = 4; }

    public sealed class Lake { public int Id; public double Level; public int Cells; public int Outlet; }

    public sealed class Province
    {
        public int Id;
        public string Name;
        public string Kind;
        public double X, Z;
        public int Cells;
        public double MeanHeight, MeanTemp, MeanPrecip;
    }

    public sealed class Heights
    {
        public int Samples;
        public double Spacing;
        public float[] Data;
        public double OriginX, OriginZ;

        /// <summary>Высота билинейно (для рендера и запросов; на симуляцию не влияет).</summary>
        public double At(double x, double z)
        {
            double fx = (x - OriginX) / Spacing, fz = (z - OriginZ) / Spacing;
            if (fx < 0) fx = 0; else if (fx > Samples - 1.001) fx = Samples - 1.001;
            if (fz < 0) fz = 0; else if (fz > Samples - 1.001) fz = Samples - 1.001;
            int ix = (int)fx, iz = (int)fz;
            double tx = fx - ix, tz = fz - iz;
            int o = iz * Samples + ix;
            double a = Data[o] * (1 - tx) + Data[o + 1] * tx;
            double b = Data[o + Samples] * (1 - tx) + Data[o + Samples + 1] * tx;
            return a * (1 - tz) + b * tz;
        }
    }

    public sealed class Geo
    {
        public int N;
        public int CellSize;
        public byte[] Edges; // север, восток, юг, запад
        public float[] Height, Slope, WaterLevel, WaterDist, SeaDist, MeanDischarge, TMean, TAmp, Precip, Fertility;
        public byte[] WaterKind, Soil, Deposit, DepositRichness;
        public int[] Receiver, UpstreamOrder;
        public short[] LakeId;
        public ushort[] ProvinceOf;
        public Lake[] Lakes;
        public Province[] Provinces;
        public double WindX, WindZ;
        public Heights Terrain, Horizon;
    }
}
