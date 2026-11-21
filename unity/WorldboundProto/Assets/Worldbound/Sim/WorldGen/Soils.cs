// Каталог почв (content/soils/soils.json). Значения сверяются с JSON эталоном (golden-тест).
namespace Worldbound.Sim.WorldGen
{
    public readonly struct SoilType
    {
        public readonly string Id, Name;
        public readonly double FieldCapacityMm, DrainagePerDay, Fertility;

        public SoilType(string id, string name, double cap, double drain, double fert)
        {
            Id = id;
            Name = name;
            FieldCapacityMm = cap;
            DrainagePerDay = drain;
            Fertility = fert;
        }
    }

    public static class Soils
    {
        public static readonly SoilType[] All =
        {
            new("rock", "Каменистая", 35, 0.6, 0.12),
            new("sand", "Песчаная", 70, 0.4, 0.3),
            new("loam", "Суглинистая", 160, 0.14, 0.75),
            new("clay", "Глинистая", 210, 0.06, 0.55),
            new("alluvial", "Аллювиальная", 185, 0.1, 0.95),
            new("peat", "Торфяная", 320, 0.03, 0.45),
        };

        public const byte Rock = 0, Sand = 1, Loam = 2, Clay = 3, Alluvial = 4, Peat = 5;
    }
}
