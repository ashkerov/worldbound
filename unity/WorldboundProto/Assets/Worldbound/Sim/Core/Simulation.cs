// Мир и фасад ядра (src/sim/core/world.ts, simulation.ts) — часть, перенесённая в Stage 1: статика мира,
// среда (погода + вода), время, команды, хеш состояния среды. Флора и фауна не перенесены.
// Ядро не знает о Unity, рендере, потоках и часах: время для профилирования приходит снаружи (Clock).
using System;
using System.Collections.Generic;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim
{
    /// <summary>Всё авторитетное состояние мира, перенесённое на C#.</summary>
    public sealed class World
    {
        public WorldConfig Config;
        public uint Seed;
        /// <summary>Сторона мира, м.</summary>
        public int WorldSize;
        public long Tick;
        public int Speed = 1;
        public Geo Geo;
        public string GeoHash;
        public EnvState Env;
        public WorldDerived Derived;
        public FloraInputs Flora;
        /// <summary>Выборка полей чанков для ячеек (выводится из статики).</summary>
        public ChunkSampler Sampler;
    }

    public enum CommandType { SetSpeed }

    public readonly struct Command
    {
        public readonly CommandType Type;
        public readonly int Value;
        public Command(CommandType type, int value) { Type = type; Value = value; }
        public static Command SetSpeed(int speed) => new Command(CommandType.SetSpeed, speed);
    }

    public sealed class SystemTiming
    {
        public string Name;
        public int Runs;
        public double TotalMs, MaxMs;
    }

    public sealed class Simulation
    {
        public readonly World World;
        readonly List<Command> pending = new();
        readonly object pendingLock = new();
        /// <summary>Журнал применённых команд (такт, команда) — для воспроизведения и проверки.</summary>
        public readonly List<(long Tick, Command Command)> CommandLog = new();
        /// <summary>Ускоритель шага воды (Burst/Jobs в адаптере Unity); null — управляемый цикл.</summary>
        public IWaterAccelerator WaterAccelerator;
        /// <summary>Источник времени для профилирования, мс. Ядро само часы не читает.</summary>
        public Func<double> Clock;
        public readonly SystemTiming WeatherTiming = new() { Name = "env.weather" };
        public readonly SystemTiming WaterTiming = new() { Name = "env.water" };
        double[] sums;

        public static long StartTick(int daysPerSeason) => SimTime.StartTick(daysPerSeason);

        public Simulation(WorldConfig config, Generate.Result generated = null, Action<string, double> progress = null)
        {
            var gen = generated ?? Generate.World(config, progress);
            int worldSize = gen.Geo.N * gen.Geo.CellSize;
            World = new World
            {
                Config = config,
                Seed = config.Seed,
                WorldSize = worldSize,
                Tick = StartTick(config.DaysPerSeason),
                Geo = gen.Geo,
                GeoHash = gen.Hash,
                Env = EnvFactory.Create(gen.Geo, worldSize),
                Derived = WorldDerived.From(gen.Geo),
                Flora = new FloraInputs(gen.Geo.N * gen.Geo.N),
            };
            World.Sampler = new ChunkSampler(gen.Geo.N, World.Env.Weather.Chunks);
        }

        /// <summary>Команда применяется на границе следующего такта. Можно вызывать из другого потока.</summary>
        public void Enqueue(Command command)
        {
            lock (pendingLock) pending.Add(command);
        }

        public void ApplyCommands()
        {
            lock (pendingLock)
            {
                if (pending.Count == 0) return;
                foreach (var c in pending)
                {
                    if (c.Type == CommandType.SetSpeed) World.Speed = c.Value;
                    CommandLog.Add((World.Tick, c));
                }
                pending.Clear();
            }
        }

        /// <summary>Один такт: команды → системы по расписанию (погода, затем вода) → счётчик.</summary>
        public void Step()
        {
            ApplyCommands();
            long tick = World.Tick;
            if (tick % Weather.Period == 0)
            {
                double s = Clock != null ? Clock() : 0;
                Weather.Run(World, tick);
                Record(WeatherTiming, s);
            }
            if (tick % SimTime.TicksPerHour == 0)
            {
                if (WaterAccelerator != null && sums == null) sums = new double[World.Geo.N * World.Geo.N * 4];
                double s = Clock != null ? Clock() : 0;
                Water.Run(World, tick, WaterAccelerator, sums);
                Record(WaterTiming, s);
            }
            World.Tick++;
        }

        /// <summary>Выполняет такты до конца текущего игрового часа (не меньше одного такта).</summary>
        public void StepHour()
        {
            do Step();
            while (World.Tick % SimTime.TicksPerHour != 0);
        }

        void Record(SystemTiming timing, double start)
        {
            if (Clock == null) return;
            double e = Clock() - start;
            timing.Runs++;
            timing.TotalMs += e;
            if (e > timing.MaxMs) timing.MaxMs = e;
        }

        /// <summary>
        /// Хеш состояния среды: те же поля и тот же порядок, что Simulation.stateHash в TS, без агентов и флоры
        /// (их ещё нет в C#). Сверяется с tools/unity-env-golden.ts.
        /// </summary>
        public string EnvHash()
        {
            var w = World;
            var e = w.Env;
            var f = w.Flora;
            var h = new StateHasher().AddInt(unchecked((int)w.Seed)).AddInt(w.Config.DaysPerSeason).AddInt(w.Config.Size == WorldSize.M ? 2 : 1)
                .AddInt(w.Config.Scenario == Scenario.Genesis ? 1 : 0).AddInt(w.Config.Isolated ? 1 : 0);
            foreach (char ch in w.Config.ClimateId) h.AddInt(ch);
            foreach (char ch in w.GeoHash) h.AddInt(ch);
            h.AddInt((int)(w.Tick % 0x40000000)).AddInt((int)(w.Tick / 0x40000000)).AddInt(w.Speed)
                .AddArray(e.Moisture).AddArray(e.Snow).AddArray(e.Greenness).AddArray(e.Discharge).AddArray(e.Runoff).AddArray(e.WaterTotals)
                .AddArray(e.Weather.Cells).AddArray(e.Weather.ChunkRate).AddArray(e.Weather.ChunkCloud).AddArray(e.Weather.ChunkAccum).AddArray(e.Weather.Balance)
                .AddInt(e.LastHourStep)
                .AddArray(f.AccT).AddArray(f.AccW).AddArray(f.AccRunoff).AddArray(f.AccMinT).AddArray(f.AccHours).AddArray(f.Capillary);
            return h.Digest();
        }
    }
}
