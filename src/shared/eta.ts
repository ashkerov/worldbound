// Оценка оставшегося времени подготовки Wildlands. Каждый следующий год мира считается дольше предыдущего
// (растений становится больше), а внутри года цена неравномерна (вегетация, дни рассева). Поэтому оценка
// идёт по целым годам: время каждого прожитого года известно, к последним годам подбирается линейный тренд
// (наименьшие квадраты), и остаток — сумма продлённого тренда по оставшимся годам.
// Линейная оценка «по средней скорости» занижала остаток подготовки мира M на 20–35 % (этап 4, раздел 15.5).

/** Сколько последних прожитых лет участвует в подборе тренда. */
const TREND_YEARS = 6;
/** Наибольший рост цены года — доля средней цены прожитых лет в год. */
const MAX_GROWTH = 0.03;

export class YearlyCostEta {
  private readonly f: number[] = [];
  private readonly t: number[] = [];

  /** @param years сколько лет в подготовке (доля 1/years — один год) */
  constructor(private readonly years: number) {}

  /** Отметка: выполненная доля 0..1 и прошедшее время, с. */
  add(fraction: number, seconds: number): void {
    if (this.f.length > 0 && fraction <= this.f[this.f.length - 1]!) return;
    if (this.f.length === 0 && fraction > 0) {
      this.f.push(0);
      this.t.push(0);
    }
    this.f.push(fraction);
    this.t.push(seconds);
  }

  /** Оставшееся время, с; undefined — пока прогресс меньше 2 %. */
  remaining(): number | undefined {
    const n = this.f.length;
    if (n < 2) return undefined;
    const f = this.f[n - 1]!;
    const t = this.t[n - 1]!;
    if (f >= 1) return 0;
    if (f < 0.02) return undefined;
    const y = this.years;
    const pos = f * y;
    const done = Math.floor(pos);
    const costs: number[] = [];
    for (let k = 0; k < done; k++) costs.push(this.timeAt((k + 1) / y) - this.timeAt(k / y));
    // Меньше двух прожитых лет — тренда ещё нет: средняя скорость с начала.
    if (costs.length < 2) return (t / f) * (1 - f);
    // Первый год почти бесплатен (растений ещё нет) — в тренд он не входит, если есть из чего выбирать.
    const from = Math.max(costs.length > 2 ? 1 : 0, costs.length - TREND_YEARS);
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const m = costs.length - from;
    for (let k = from; k < costs.length; k++) {
      sx += k;
      sy += costs[k]!;
      sxx += k * k;
      sxy += k * costs[k]!;
    }
    const den = m * sxx - sx * sx;
    // Цена лет не падает: снижение — шум сезонов, а не свойство подготовки.
    let slope = den > 0 ? Math.max(0, (m * sxy - sx * sy) / den) : 0;
    const mean = sy / m;
    // Рост цены ограничен MAX_GROWTH в год от средней: по 2–3 шумным годам нельзя продлевать крутой тренд на 15 лет.
    slope = Math.min(slope, MAX_GROWTH * mean);
    // Уровень — средняя цена последних трёх лет (сглаживает шум отдельных лет), рост — от последнего года.
    const tail = costs.slice(Math.max(from, costs.length - 3));
    const level = tail.reduce((a, b) => a + b, 0) / tail.length;
    const centre = costs.length - (tail.length + 1) / 2;
    const cost = (k: number) => Math.max(0, level + slope * (k - centre));
    // Текущий год: прошедшая часть известна, остаток — по тренду.
    const inYear = pos - done;
    const spentInYear = t - this.timeAt(done / y);
    let left = Math.max(cost(done) - spentInYear, cost(done) * (1 - inYear));
    for (let k = done + 1; k < y; k++) left += cost(k);
    return left;
  }

  private timeAt(fraction: number): number {
    const fs = this.f;
    if (fraction <= fs[0]!) return this.t[0]!;
    if (fraction >= fs[fs.length - 1]!) return this.t[this.t.length - 1]!;
    let lo = 0;
    let hi = fs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fs[mid]! <= fraction) lo = mid;
      else hi = mid;
    }
    const span = fs[hi]! - fs[lo]!;
    const k = span > 0 ? (fraction - fs[lo]!) / span : 0;
    return this.t[lo]! + (this.t[hi]! - this.t[lo]!) * k;
  }
}
