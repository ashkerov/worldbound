// Регрессионные тесты темпа тактов (TickPacer): пауза без долга, с частичным долгом, с большим долгом после
// отставания, возобновление, переключение ×1/×2/×4/×8 (в том числе посреди долга). Часы — ручные, чтобы
// результат не зависел от скорости машины.
using System;
using System.Collections.Generic;
using System.Text;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Golden
{
    public static class PacerCheck
    {
        static Generate.Result world;

        static Simulation NewSim(int speed)
        {
            world ??= Generate.World(new WorldConfig { Seed = 42, Size = WorldSize.S });
            var sim = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S }, world);
            sim.Enqueue(Command.SetSpeed(speed));
            sim.ApplyCommands();
            return sim;
        }

        static readonly Func<double> Frozen = () => 0;

        public static bool Run(Action<string> log, out string reportJson)
        {
            var results = new List<(string name, bool ok, string detail)>();
            void Check(string name, bool ok, string detail) { results.Add((name, ok, detail)); log($"pacer {name}: {(ok ? "OK" : "FAIL")} — {detail}"); }

            // 1. Пауза без долга: ×1, ровно один такт, пауза → ни одного такта за 5 с.
            {
                var sim = NewSim(1);
                var p = new TickPacer();
                p.Reset(sim);
                int a = p.Advance(sim, 0.1, 1e9, Frozen);
                long t0 = sim.World.Tick;
                sim.Enqueue(Command.SetSpeed(0));
                int b = p.Advance(sim, 5, 1e9, Frozen);
                Check("pause-no-debt", a == 1 && b == 0 && sim.World.Tick == t0 && p.Debt == 0 && sim.World.Speed == 0, $"тактов до {a}, после паузы {b}, долг {p.Debt}");
            }
            // 2. Пауза с частичным долгом: долг 0,5 такта не переносится через паузу.
            {
                var sim = NewSim(1);
                var p = new TickPacer();
                p.Reset(sim);
                int a = p.Advance(sim, 0.15, 1e9, Frozen); // 1 такт, долг 0,5
                double debtBefore = p.Debt;
                sim.Enqueue(Command.SetSpeed(0));
                int b = p.Advance(sim, 0, 1e9, Frozen);
                sim.Enqueue(Command.SetSpeed(1));
                int c = p.Advance(sim, 0.05, 1e9, Frozen); // без переноса: долг 0,5 → 0 тактов; с переносом было бы 1
                Check("pause-partial-debt", a == 1 && Math.Abs(debtBefore - 0.5) < 1e-9 && b == 0 && c == 0, $"долг перед паузой {debtBefore:0.###}, после паузы тактов {b}, после возобновления на 0,05 с {c}");
            }
            // 3. Пауза с большим долгом после отставания: ×8, 5 с при бюджете 3 мс (часы +1 мс на вызов).
            {
                var sim = NewSim(8);
                var p = new TickPacer();
                p.Reset(sim);
                double fake = 0;
                Func<double> ticking = () => fake += 1;
                int a = p.Advance(sim, 5, 3, ticking);
                double debt = p.Debt;
                bool behind = p.Behind;
                long t0 = sim.World.Tick;
                sim.Enqueue(Command.SetSpeed(0));
                int b = p.Advance(sim, 0, 1e9, Frozen);
                int c = p.Advance(sim, 1, 1e9, Frozen);
                Check("pause-large-debt", behind && debt > 100 && b == 0 && c == 0 && sim.World.Tick == t0 && p.Debt == 0 && !p.Behind,
                    $"отставание {behind}, тактов в кадре {a}, долг {debt:0}, после паузы тактов {b + c}");
            }
            // 4. Возобновление: после паузы ×1 на 0,3 с — ровно 3 такта; затем ×4 на 0,5 с — 20.
            {
                var sim = NewSim(2);
                var p = new TickPacer();
                p.Reset(sim);
                p.Advance(sim, 0.33, 1e9, Frozen);
                sim.Enqueue(Command.SetSpeed(0));
                p.Advance(sim, 10, 1e9, Frozen);
                sim.Enqueue(Command.SetSpeed(1));
                int a = p.Advance(sim, 0.3, 1e9, Frozen);
                sim.Enqueue(Command.SetSpeed(4));
                int b = p.Advance(sim, 0.5, 1e9, Frozen);
                Check("resume", a == 3 && b == 20, $"×1 0,3 с → {a} тактов, ×4 0,5 с → {b}");
            }
            // 5. Переключение ×1, ×2, ×4, ×8: за 1 с — 10, 20, 40, 80 тактов; и смена посреди долга.
            {
                var sim = NewSim(1);
                var p = new TickPacer();
                p.Reset(sim);
                var got = new List<int>();
                foreach (int sp in new[] { 1, 2, 4, 8, 4, 2, 1 })
                {
                    sim.Enqueue(Command.SetSpeed(sp));
                    got.Add(p.Advance(sim, 1, 1e9, Frozen));
                }
                bool exact = string.Join(",", got) == "10,20,40,80,40,20,10";
                // Посреди долга: ×8, кадр оборван бюджетом → долг; переход на ×1 пересчитывает его в такты ×1
                // (то же реальное время), а не выполняет восьмикратный остаток.
                var sim2 = NewSim(8);
                var p2 = new TickPacer();
                p2.Reset(sim2);
                double fake = 0;
                Func<double> ticking = () => fake += 1;
                p2.Advance(sim2, 1, 3, ticking); // 80 тактов долга, выполнено несколько
                double d8 = p2.Debt;
                sim2.Enqueue(Command.SetSpeed(1));
                p2.Sync(sim2);
                double d1 = p2.Debt;
                int rest = p2.Advance(sim2, 0, 1e9, Frozen);
                bool rescaled = Math.Abs(d1 - d8 / 8) < 1e-9 && rest == (int)Math.Floor(d8 / 8);
                Check("speed-switch", exact && rescaled, $"тактов за 1 с: {string.Join(",", got)}; долг ×8 {d8:0.##} → ×1 {d1:0.##}, выполнено {rest}");
            }
            // 6. Команды применяются на границе такта и попадают в журнал с тактом применения.
            {
                var sim = NewSim(1);
                var p = new TickPacer();
                p.Reset(sim);
                p.Advance(sim, 0.5, 1e9, Frozen);
                sim.Enqueue(Command.SetSpeed(0));
                p.Sync(sim);
                var last = sim.CommandLog[sim.CommandLog.Count - 1];
                Check("command-log", last.Command.Value == 0 && last.Tick == sim.World.Tick, $"пауза записана на такте {last.Tick}, текущий {sim.World.Tick}");
            }

            bool all = true;
            var sb = new StringBuilder("[");
            for (int i = 0; i < results.Count; i++)
            {
                all &= results[i].ok;
                if (i > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(results[i].name)).Append(",\"ok\":").Append(results[i].ok ? "true" : "false").Append(",\"detail\":").Append(MiniJson.Q(results[i].detail)).Append('}');
            }
            reportJson = sb.Append(']').ToString();
            return all;
        }
    }
}
