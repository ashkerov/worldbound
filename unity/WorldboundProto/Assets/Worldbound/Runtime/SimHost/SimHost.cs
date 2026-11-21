// Адаптер ядра для Unity: создание мира из seed (генерация в фоновом потоке), фиксированные такты 100 мс игрового
// времени, скорость, снимки состояния для рендера и корректное освобождение ресурсов.
// Состояние мира живёт только в Simulation; рендер читает снимки (WorldSnapshot), камера — своё состояние отдельно.
using System;
using System.Diagnostics;
using System.Threading.Tasks;
using Worldbound.Sim;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.SimHost
{
    /// <summary>Поля ячеек 8 м после часового шага. Опубликованный экземпляр ядро не меняет до следующего часа.</summary>
    public sealed class FieldSnapshot
    {
        public int HourStep = -1;
        public int Version;
        /// <summary>Снег (мм в.э.), относительная влага почвы, расход (м³/с), облачность, температура (°C).</summary>
        public float[] Snow, MoistureRel, Discharge, Cloud, Temperature;

        public FieldSnapshot(int count)
        {
            Snow = new float[count];
            MoistureRel = new float[count];
            Discharge = new float[count];
            Cloud = new float[count];
            Temperature = new float[count];
        }
    }

    /// <summary>Снимок состояния для рендера: время, солнце, погода (каждый кадр) и ссылка на поля последнего часа.</summary>
    public sealed class WorldSnapshot
    {
        public long Tick;
        public int Speed;
        public SimTime.Calendar Calendar;
        public SunState Sun;
        public double Seasonal, Anomaly;
        public Wind Wind;
        public readonly float[] WeatherCells = new float[WeatherState.MaxCells * WeatherState.Stride];
        public readonly double[] WaterTotals = new double[4];
        public FieldSnapshot Fields;
    }

    public sealed class SimHost : IDisposable
    {
        public enum State { Idle, Generating, Running, Failed, Disposed }

        public State Status { get; private set; } = State.Idle;
        public string Stage = "";
        public double StageFraction;
        public Simulation Sim { get; private set; }
        public WorldConfig Config { get; private set; }
        public double GenerateMs { get; private set; }
        public string Error { get; private set; }
        public bool UseBurst = true;
        public bool BurstActive { get; private set; }
        public readonly WorldSnapshot Snapshot = new();
        FieldSnapshot backFields;
        BurstWater burst;
        Task<Generate.Result> genTask;
        readonly Stopwatch clock = Stopwatch.StartNew();
        double tickDebt;
        int lastSnapshotHour = int.MinValue;

        // Статистика для интерфейса и замеров.
        public double LastAdvanceMs, LastHourMs;
        public int TicksLastAdvance;
        public long TicksTotal;
        public bool Behind;

        /// <summary>Игровые такты в реальную секунду при скорости 1 (такт — 100 мс игрового времени).</summary>
        public const double TicksPerSecondAtSpeed1 = 1000.0 / SimTime.TickMs;

        public void Begin(WorldConfig config)
        {
            Config = config;
            Status = State.Generating;
            var sw = Stopwatch.StartNew();
            genTask = Task.Run(() =>
            {
                var r = Generate.World(config, (stage, f) => { Stage = stage; StageFraction = f; });
                GenerateMs = sw.Elapsed.TotalMilliseconds;
                return r;
            });
        }

        /// <summary>Вызывается каждый кадр; когда генерация готова — создаёт симуляцию.</summary>
        public void Poll()
        {
            if (Status != State.Generating || genTask == null || !genTask.IsCompleted) return;
            if (genTask.IsFaulted)
            {
                Error = genTask.Exception?.GetBaseException().ToString();
                Status = State.Failed;
                return;
            }
            Sim = new Simulation(Config, genTask.Result);
            genTask = null;
            Start();
        }

        void Start()
        {
            Sim.Clock = () => clock.Elapsed.TotalMilliseconds;
            if (UseBurst)
            {
                burst = new BurstWater(Sim.World);
                Sim.WaterAccelerator = burst;
                BurstActive = BurstWater.IsBurstActive();
            }
            int count = Sim.World.Geo.N * Sim.World.Geo.N;
            Snapshot.Fields = new FieldSnapshot(count);
            backFields = new FieldSnapshot(count);
            Status = State.Running;
            WriteSnapshot(force: true);
        }

        /// <summary>Принимает готовую симуляцию (например, загруженную из сохранения).</summary>
        public void Adopt(Simulation sim)
        {
            Config = sim.World.Config;
            Sim = sim;
            Start();
        }

        public int Speed => Sim?.World.Speed ?? 0;

        public void SetSpeed(int speed) => Sim?.Enqueue(Command.SetSpeed(speed));

        /// <summary>
        /// Продвигает мир на реальное время dt с учётом скорости; не дольше budgetMs за вызов.
        /// Если такты не успевают, долг ограничивается (не больше 2 с игры) — мир замедляется, а не «догоняет» рывком.
        /// </summary>
        public void Advance(double dt, double budgetMs)
        {
            if (Status != State.Running) return;
            Sim.ApplyCommands();
            double start = clock.Elapsed.TotalMilliseconds;
            tickDebt += dt * TicksPerSecondAtSpeed1 * Sim.World.Speed;
            double cap = TicksPerSecondAtSpeed1 * Math.Max(1, Sim.World.Speed) * 2;
            Behind = tickDebt > cap;
            if (Behind) tickDebt = cap;
            int ticks = 0;
            while (tickDebt >= 1)
            {
                bool hour = Sim.World.Tick % SimTime.TicksPerHour == 0;
                double t0 = hour ? clock.Elapsed.TotalMilliseconds : 0;
                Sim.Step();
                if (hour) LastHourMs = clock.Elapsed.TotalMilliseconds - t0;
                tickDebt -= 1;
                ticks++;
                if (clock.Elapsed.TotalMilliseconds - start > budgetMs) break;
            }
            TicksLastAdvance = ticks;
            TicksTotal += ticks;
            if (ticks > 0) WriteSnapshot(force: false);
            LastAdvanceMs = clock.Elapsed.TotalMilliseconds - start;
        }

        /// <summary>Обновить снимок после тактов, выполненных напрямую через Sim (замеры, перемотка).</summary>
        public void RefreshSnapshot()
        {
            if (Status == State.Running) WriteSnapshot(force: false);
        }

        /// <summary>Время, солнце и погода — каждый кадр; поля ячеек — после каждого часового шага (двойной буфер).</summary>
        void WriteSnapshot(bool force)
        {
            var w = Sim.World;
            var s = Snapshot;
            s.Tick = w.Tick;
            s.Speed = w.Speed;
            s.Calendar = SimTime.FromTick(w.Tick, w.Config.DaysPerSeason);
            var ctx = new TimeContext();
            ClimateModel.Context(w.Seed, w.Tick, w.Config.DaysPerSeason, ref ctx);
            s.Sun = ctx.Sun;
            s.Seasonal = ctx.Seasonal;
            s.Anomaly = ctx.Anomaly;
            Weather.WindAt(w, w.Tick, ref s.Wind);
            Array.Copy(w.Env.Weather.Cells, s.WeatherCells, s.WeatherCells.Length);
            Array.Copy(w.Env.WaterTotals, s.WaterTotals, 4);
            int hour = w.Env.LastHourStep;
            if (!force && hour == lastSnapshotHour) return;
            lastSnapshotHour = hour;
            var f = backFields;
            var g = w.Geo;
            var e = w.Env;
            var cap = w.Derived.Capacity;
            int count = g.N * g.N;
            for (int i = 0; i < count; i++)
            {
                double cloud = w.Sampler.Sample(e.Weather.ChunkCloud, i);
                f.Cloud[i] = (float)cloud;
                f.Snow[i] = e.Snow[i];
                f.MoistureRel[i] = g.WaterKind[i] == WaterKind.None ? e.Moisture[i] / cap[i] : 1;
                f.Discharge[i] = e.Discharge[i];
                f.Temperature[i] = (float)ClimateModel.CellTemperature(g.TMean[i], g.TAmp[i], ctx.Seasonal, ctx.Diurnal, ctx.Anomaly, cloud);
            }
            f.HourStep = hour;
            f.Version = s.Fields.Version + 1;
            backFields = s.Fields;
            s.Fields = f;
        }

        public void Dispose()
        {
            if (Status == State.Disposed) return;
            if (genTask != null && !genTask.IsCompleted)
            {
                try { genTask.Wait(5000); } catch { /* генерация прервана закрытием — результат не нужен */ }
            }
            if (Sim != null) Sim.WaterAccelerator = null;
            burst?.Dispose();
            burst = null;
            Status = State.Disposed;
        }
    }
}
