// Темп тактов: сколько тактов ядра выполнить за прошедшее реальное время при текущей скорости.
// Временная модель не меняется: такт — 100 мс игрового времени, скорость ×N — N·10 тактов в реальную секунду.
// Правила:
//  • команды применяются на границе такта — перед каждым тактом, поэтому пауза, пришедшая между тактами,
//    останавливает мир до следующего такта;
//  • на паузе долг тактов обнуляется: накопленное до паузы время не «догоняется» после неё;
//  • смена скорости пересчитывает оставшийся долг в такты новой скорости (сохраняется реальное время);
//  • долг ограничен MaxDebtSeconds реального времени: при отставании мир замедляется, а не догоняет рывком.
// Чистый класс ядра без Unity: его же проверяют регрессионные тесты (Worldbound.Sim.Golden.PacerCheck).
using System;

namespace Worldbound.Sim
{
    public sealed class TickPacer
    {
        /// <summary>Тактов в реальную секунду при скорости ×1 (такт — 100 мс игрового времени).</summary>
        public const double TicksPerSecondAtSpeed1 = 1000.0 / SimTime.TickMs;

        /// <summary>Предел долга в секундах реального времени.</summary>
        public double MaxDebtSeconds = 2;

        /// <summary>Долг тактов: сколько тактов положено выполнить, но ещё не выполнено.</summary>
        public double Debt { get; private set; }

        /// <summary>Долг упёрся в предел (мир не успевает за скоростью).</summary>
        public bool Behind { get; private set; }

        /// <summary>Длительность последнего такта с часовым шагом, мс (если есть часы).</summary>
        public double LastHourMs { get; private set; }

        int debtSpeed;

        double Cap(int speed) => TicksPerSecondAtSpeed1 * Math.Max(1, speed) * MaxDebtSeconds;

        /// <summary>Применяет ожидающие команды и приводит долг к текущей скорости.</summary>
        public void Sync(Simulation sim)
        {
            sim.ApplyCommands();
            int speed = sim.World.Speed;
            if (speed == debtSpeed) return;
            if (speed <= 0)
            {
                Debt = 0;
                Behind = false;
            }
            else if (debtSpeed > 0)
            {
                Debt = Math.Min(Debt * speed / debtSpeed, Cap(speed));
            }
            else Debt = 0;
            debtSpeed = speed;
        }

        /// <summary>
        /// Продвигает мир на реальное время dt (с) при текущей скорости, не дольше budgetMs по часам clock.
        /// Возвращает число выполненных тактов.
        /// </summary>
        public int Advance(Simulation sim, double dt, double budgetMs, Func<double> clock)
        {
            Sync(sim);
            int speed = sim.World.Speed;
            if (speed <= 0) return 0;
            Debt += dt * TicksPerSecondAtSpeed1 * speed;
            double cap = Cap(speed);
            Behind = Debt > cap;
            if (Behind) Debt = cap;
            double start = clock();
            int ticks = 0;
            while (Debt >= 1)
            {
                Sync(sim);
                if (sim.World.Speed <= 0) break;
                bool hour = sim.World.Tick % SimTime.TicksPerHour == 0;
                double t0 = hour ? clock() : 0;
                sim.Step();
                if (hour) LastHourMs = clock() - t0;
                Debt -= 1;
                ticks++;
                if (clock() - start > budgetMs) break;
            }
            return ticks;
        }

        /// <summary>Сбрасывает долг (новый мир, загрузка).</summary>
        public void Reset(Simulation sim)
        {
            Debt = 0;
            Behind = false;
            debtSpeed = sim?.World.Speed ?? 0;
        }
    }
}
