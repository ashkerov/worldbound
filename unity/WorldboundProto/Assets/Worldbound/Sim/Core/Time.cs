// Модель времени (src/shared/time.ts, src/shared/sun.ts): такт 100 мс, 300 тактов в игровом часе,
// сутки 7200 тактов, год — 4 сезона по daysPerSeason суток. Мир начинается в середине весны, в 7:00.
using System;

namespace Worldbound.Sim
{
    public static class SimTime
    {
        public const int TickMs = 100;
        public const int TicksPerHour = 300;
        public const int HoursPerDay = 24;
        public const int TicksPerDay = TicksPerHour * HoursPerDay;
        public const int DaysPerSeason = 5;
        public const int SeasonsPerYear = 4;
        public static readonly int[] SeasonLengths = { 3, 5, 8 };
        public static readonly int[] Speeds = { 0, 1, 2, 4, 8 };

        public static long StartTick(int daysPerSeason) => (daysPerSeason / 2) * (long)TicksPerDay + 7 * TicksPerHour;
        public static double DayFraction(long tick) { double t = tick / (double)TicksPerDay; return t - Math.Floor(t); }
        public static double YearFraction(long tick, int daysPerSeason) { double t = tick / (double)(TicksPerDay * daysPerSeason * SeasonsPerYear); return t - Math.Floor(t); }
        public static double HoursPerYear(int daysPerSeason) => daysPerSeason * SeasonsPerYear * HoursPerDay;

        public readonly struct Calendar
        {
            public readonly int Year, Season, DayOfSeason, Hour, Minute;
            public Calendar(int y, int s, int d, int h, int m) { Year = y; Season = s; DayOfSeason = d; Hour = h; Minute = m; }
        }

        public static Calendar FromTick(long tick, int daysPerSeason)
        {
            int daysPerYear = daysPerSeason * SeasonsPerYear;
            long day = tick / TicksPerDay;
            long tickOfDay = tick - day * TicksPerDay;
            long minutes = tickOfDay * HoursPerDay * 60 / TicksPerDay;
            long dayOfYear = day % daysPerYear;
            return new Calendar((int)(day / daysPerYear) + 1, (int)(dayOfYear / daysPerSeason), (int)(dayOfYear % daysPerSeason) + 1, (int)(minutes / 60), (int)(minutes % 60));
        }
    }

    public struct SunState { public double X, Y, Z; }

    public static class Sun
    {
        public static double SeasonalSwing(double yearFrac) => DMath.DCos(DMath.TWO_PI * (yearFrac - 0.375));

        public static void Direction(double dayFrac, double yearFrac, ref SunState o)
        {
            double decl = 0.401 * SeasonalSwing(yearFrac);
            const double lat = 0.873;
            double hourAngle = DMath.TWO_PI * (dayFrac - 0.5);
            double sinDecl = DMath.DSin(decl), cosDecl = DMath.DCos(decl), sinLat = DMath.DSin(lat), cosLat = DMath.DCos(lat);
            double up = sinLat * sinDecl + cosLat * cosDecl * DMath.DCos(hourAngle);
            double east = -cosDecl * DMath.DSin(hourAngle);
            double north = cosLat * sinDecl - sinLat * cosDecl * DMath.DCos(hourAngle);
            double len = Math.Sqrt(up * up + east * east + north * north);
            if (len == 0 || double.IsNaN(len)) len = 1;
            o.X = east / len;
            o.Y = up / len;
            o.Z = -north / len;
        }
    }
}
