// Оценка оставшегося времени подготовки Wildlands (src/shared/eta.ts: YearlyCostEta). Каждый следующий год мира
// считается дольше предыдущего (растений больше), а внутри года цена неравномерна (вегетация, дни рассева). Поэтому
// оценка идёт по целым годам: время каждого прожитого года известно, к последним годам подбирается линейный тренд
// (наименьшие квадраты), остаток — сумма продлённого тренда по оставшимся годам. На состояние мира не влияет.
using System;
using System.Collections.Generic;

namespace Worldbound.Sim
{
    public sealed class YearlyCostEta
    {
        /// <summary>Сколько последних прожитых лет участвует в подборе тренда.</summary>
        const int TrendYears = 6;
        /// <summary>Наибольший рост цены года — доля средней цены прожитых лет в год.</summary>
        const double MaxGrowth = 0.03;

        readonly List<double> f = new(), t = new();
        readonly double years;

        /// <param name="years">сколько лет в подготовке (доля 1/years — один год)</param>
        public YearlyCostEta(double years) => this.years = years;

        /// <summary>Отметка: выполненная доля 0..1 и прошедшее время, с.</summary>
        public void Add(double fraction, double seconds)
        {
            if (f.Count > 0 && fraction <= f[f.Count - 1]) return;
            if (f.Count == 0 && fraction > 0)
            {
                f.Add(0);
                t.Add(0);
            }
            f.Add(fraction);
            t.Add(seconds);
        }

        /// <summary>Оставшееся время, с; null — пока прогресс меньше 2 %.</summary>
        public double? Remaining()
        {
            int n = f.Count;
            if (n < 2) return null;
            double fr = f[n - 1], tt = t[n - 1];
            if (fr >= 1) return 0;
            if (fr < 0.02) return null;
            double y = years;
            double pos = fr * y;
            int done = (int)Math.Floor(pos);
            var costs = new List<double>();
            for (int k = 0; k < done; k++) costs.Add(TimeAt((k + 1) / y) - TimeAt(k / y));
            // Меньше двух прожитых лет — тренда ещё нет: средняя скорость с начала.
            if (costs.Count < 2) return tt / fr * (1 - fr);
            // Первый год почти бесплатен (растений ещё нет) — в тренд он не входит, если есть из чего выбирать.
            int from = Math.Max(costs.Count > 2 ? 1 : 0, costs.Count - TrendYears);
            double sx = 0, sy = 0, sxx = 0, sxy = 0;
            int m = costs.Count - from;
            for (int k = from; k < costs.Count; k++)
            {
                sx += k;
                sy += costs[k];
                sxx += k * k;
                sxy += k * costs[k];
            }
            double den = m * sxx - sx * sx;
            // Цена лет не падает: снижение — шум сезонов. Рост ограничен MaxGrowth в год от средней.
            double slope = den > 0 ? Math.Max(0, (m * sxy - sx * sy) / den) : 0;
            double mean = sy / m;
            slope = Math.Min(slope, MaxGrowth * mean);
            // Уровень — средняя цена последних трёх лет, рост — от последнего года.
            int tailFrom = Math.Max(from, costs.Count - 3);
            double level = 0;
            for (int k = tailFrom; k < costs.Count; k++) level += costs[k];
            int tailLen = costs.Count - tailFrom;
            level /= tailLen;
            double centre = costs.Count - (tailLen + 1) / 2.0;
            double Cost(int k) => Math.Max(0, level + slope * (k - centre));
            // Текущий год: прошедшая часть известна, остаток — по тренду.
            double inYear = pos - done;
            double spentInYear = tt - TimeAt(done / y);
            double left = Math.Max(Cost(done) - spentInYear, Cost(done) * (1 - inYear));
            for (int k = done + 1; k < y; k++) left += Cost(k);
            return left;
        }

        double TimeAt(double fraction)
        {
            if (fraction <= f[0]) return t[0];
            if (fraction >= f[f.Count - 1]) return t[t.Count - 1];
            int lo = 0, hi = f.Count - 1;
            while (hi - lo > 1)
            {
                int mid = (lo + hi) >> 1;
                if (f[mid] <= fraction) lo = mid;
                else hi = mid;
            }
            double span = f[hi] - f[lo];
            double k = span > 0 ? (fraction - f[lo]) / span : 0;
            return t[lo] + (t[hi] - t[lo]) * k;
        }
    }
}
