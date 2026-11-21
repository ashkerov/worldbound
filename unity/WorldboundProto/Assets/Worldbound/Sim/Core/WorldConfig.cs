// Конфигурация мира (src/shared/worldConfig.ts). Размеры: S — 2048 м, M — 4096 м; ячейка 8 м; рельеф 2 м; чанк 128 м.
namespace Worldbound.Sim
{
    public enum WorldSize { S, M }
    public enum Climate { Cold, Temperate, Warm }
    public enum Scenario { Wild, Genesis }

    public sealed class WorldConfig
    {
        public const int CellSize = 8;
        public const int HeightSpacing = 2;
        public const int ChunkSize = 128;

        public string Name = "Новый мир";
        public uint Seed = 1;
        public WorldSize Size = WorldSize.M;
        public int DaysPerSeason = SimTime.DaysPerSeason;
        public Climate Climate = Climate.Temperate;
        public Scenario Scenario = Scenario.Wild;
        public bool Isolated;

        public int Meters => Size == WorldSize.S ? 2048 : 4096;
        public string ClimateId => Climate == Climate.Cold ? "cold" : Climate == Climate.Warm ? "warm" : "temperate";
    }
}
