// Регрессионная проверка хоста: скорость в снимке обновляется сразу после команды (даже без нового такта),
// пауза останавливает мир немедленно и обнуляет долг, команда из ядра применяется без тактов на паузе.
using System;
using System.Text;
using Worldbound.Sim;
using Worldbound.Sim.Golden;

namespace Worldbound.SimHost
{
    public static class HostCheck
    {
        public static bool Run(Action<string> log, out string reportJson)
        {
            var sim = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S });
            var host = new SimHost { UseBurst = false };
            host.Adopt(sim);
            var sb = new StringBuilder("[");
            bool all = true;
            int n = 0;
            void Check(string name, bool ok, string detail)
            {
                all &= ok;
                log($"host {name}: {(ok ? "OK" : "FAIL")} — {detail}");
                if (n++ > 0) sb.Append(',');
                sb.Append("{\"name\":").Append(MiniJson.Q(name)).Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"detail\":").Append(MiniJson.Q(detail)).Append('}');
            }

            host.SetSpeed(4);
            Check("speed-in-snapshot-immediately", host.Snapshot.Speed == 4 && sim.World.Speed == 4, $"снимок ×{host.Snapshot.Speed} до первого такта");
            host.Advance(0.5, 1e9);
            Check("speed-x4-ticks", host.TicksLastAdvance == 20, $"0,5 с при ×4 → {host.TicksLastAdvance} тактов");
            host.Advance(0.07, 1e9); // частичный долг 0,8
            double partial = host.TickDebt;
            host.SetSpeed(0);
            long t0 = sim.World.Tick;
            Check("pause-immediate", host.Snapshot.Speed == 0 && host.TickDebt == 0, $"снимок ×{host.Snapshot.Speed}, долг до паузы {partial:0.##}, после {host.TickDebt}");
            host.Advance(3, 1e9);
            Check("pause-no-ticks", sim.World.Tick == t0 && host.TicksLastAdvance == 0, $"за 3 с паузы тактов {sim.World.Tick - t0}");
            sim.Enqueue(Command.SetSpeed(2)); // команда пришла в ядро напрямую (не через хост)
            host.Advance(0, 1e9);
            Check("command-applied-without-tick", host.Snapshot.Speed == 2 && host.TicksLastAdvance == 0, $"снимок ×{host.Snapshot.Speed}, тактов {host.TicksLastAdvance}");
            host.Advance(1, 1e9);
            Check("resume-x2", host.TicksLastAdvance == 20 && host.Snapshot.Tick == sim.World.Tick, $"1 с при ×2 → {host.TicksLastAdvance} тактов");
            host.Dispose();
            Check("dispose", host.Status == SimHost.State.Disposed, host.Status.ToString());
            reportJson = sb.Append(']').ToString();
            return all;
        }
    }
}
