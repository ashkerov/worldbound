// Мир и фасад ядра (src/sim/core/world.ts, simulation.ts): статика мира, среда (погода + вода), состояние флоры,
// время, команды, хеши. Stage 2.1: создание начального состояния флоры (Genesis, Wildlands, полог, покров, биомы)
// и метаданные подготовки Wildlands — как конструктор Simulation в TS. Флора в расписание тактов ещё не входит (2.2).
// Ядро не знает о Unity, рендере, потоках и часах: время для профилирования приходит снаружи (Clock).
using System;
using System.Collections.Generic;
using Worldbound.Sim.Env;
using Worldbound.Sim.Flora;
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
        /// <summary>Состояние растительности (FloraState в TS); его накопители пишет часовой шаг воды.</summary>
        public FloraState Flora;
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

    /// <summary>Подготовка Wildlands: такты от StartTick до TargetTick идут с семенами региона на всю сушу (этап 2.5).</summary>
    public sealed class Preparation
    {
        public long StartTick, TargetTick;
        public double Years;
    }

    /// <summary>Параметры создания симуляции (как WorldInit в TS).</summary>
    public sealed class SimulationOptions
    {
        /// <summary>false — не заселять (состояние придёт из сохранения).</summary>
        public bool Populate = true;
        /// <summary>Wildlands: сколько лет готовить мир; null — WorldConfig.WildlandsYears.</summary>
        public double? PrepareYears;
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

        /// <summary>Идёт подготовка Wildlands (создание мира не завершено); null — мир готов.</summary>
        public Preparation Preparation;

        public Simulation(WorldConfig config, Generate.Result generated = null, Action<string, double> progress = null, SimulationOptions options = null)
        {
            options ??= new SimulationOptions();
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
                Flora = FloraState.Create(gen.Geo),
            };
            World.Sampler = new ChunkSampler(gen.Geo.N, World.Env.Weather.Chunks);
            // Порядок как в конструкторе TS: заселение → полог и покров (вход испарения) → биомы → подготовка Wildlands.
            // При загрузке сохранения растения приходят из секций, а не из начального заселения.
            if (options.Populate)
            {
                if (config.Scenario == Scenario.Genesis) Populate.Genesis(World);
                else Populate.Wildlands(World);
                Cover.Refresh(World, true);
                BiomeState.InitBiomes(World);
                if (config.Scenario == Scenario.Wild)
                {
                    double years = options.PrepareYears ?? WorldConfig.WildlandsYears;
                    long ticksPerYear = (long)config.DaysPerSeason * SimTime.SeasonsPerYear * SimTime.TicksPerDay;
                    Preparation = new Preparation { StartTick = World.Tick, TargetTick = World.Tick + (long)JsMath.Round(years * ticksPerYear), Years = years };
                    if (years <= 0) FinishPreparation();
                }
            }
        }

        /// <summary>Доля выполненной подготовки (1 — мир готов).</summary>
        public double PreparationFraction()
        {
            var p = Preparation;
            if (p == null) return 1;
            return Math.Min(1, (World.Tick - p.StartTick) / (double)Math.Max(1, p.TargetTick - p.StartTick));
        }

        void FinishPreparation()
        {
            var p = Preparation;
            World.Flora.RegionalSeedRain = false;
            World.Flora.PreparedYears = p.Years;
            Preparation = null;
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
            if (Preparation != null && World.Tick >= Preparation.TargetTick) FinishPreparation();
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

        static readonly float[] NoAgents = new float[0];
        static readonly byte[] NoAgentBytes = new byte[0];

        /// <summary>
        /// Полный хеш авторитетного состояния — те же поля и порядок, что Simulation.stateHash() в TS: параметры, статика
        /// (через geoHash), время, среда, агенты (в C# их нет — пустые массивы, как при testAgents = 0), флора.
        /// </summary>
        public string StateHash()
        {
            var w = World;
            var e = w.Env;
            var f = w.Flora;
            var wd = f.Woody;
            var h = new StateHasher().AddInt(unchecked((int)w.Seed)).AddInt(w.Config.DaysPerSeason).AddInt(w.Config.Size == WorldSize.M ? 2 : 1)
                .AddInt(w.Config.Scenario == Scenario.Genesis ? 1 : 0).AddInt(w.Config.Isolated ? 1 : 0);
            foreach (char ch in w.Config.ClimateId) h.AddInt(ch);
            foreach (char ch in w.GeoHash) h.AddInt(ch);
            h.AddInt((int)(w.Tick % 0x40000000)).AddInt((int)(w.Tick / 0x40000000)).AddInt(w.Speed)
                .AddArray(e.Moisture).AddArray(e.Snow).AddArray(e.Greenness).AddArray(e.Discharge).AddArray(e.Runoff).AddArray(e.WaterTotals)
                .AddArray(e.Weather.Cells).AddArray(e.Weather.ChunkRate).AddArray(e.Weather.ChunkCloud).AddArray(e.Weather.ChunkAccum).AddArray(e.Weather.Balance)
                .AddInt(e.LastHourStep)
                // Агенты: count, x, z, heading, targetHeading, speed, alive, generation до highWater (= 0).
                .AddInt(0).AddArray(NoAgents, 0).AddArray(NoAgents, 0).AddArray(NoAgents, 0).AddArray(NoAgents, 0).AddArray(NoAgents, 0).AddArray(NoAgentBytes, 0).AddArray(NoAgentBytes, 0)
                .AddArray(f.SlotSpecies).AddArray(f.SlotBiomass).AddArray(f.LitterFast).AddArray(f.LitterFastN).AddArray(f.LitterFastQ).AddArray(f.SeedBank).AddArray(f.WoodyCount)
                .AddArray(f.LitterWood).AddArray(f.LitterWoodN).AddArray(f.Nutrient).AddArray(f.AccT).AddArray(f.AccW).AddArray(f.AccRunoff).AddArray(f.AccMinT).AddArray(f.AccHours)
                .AddArray(f.DayT).AddArray(f.DayW).AddArray(f.Capillary).AddArray(f.Canopy).AddArray(f.TreeCover).AddArray(f.ShrubCover).AddArray(f.ConiferCover).AddArray(f.TallCover)
                .AddArray(f.Biome.Herb).AddArray(f.Biome.Steppe).AddArray(f.Biome.Wet).AddArray(f.Biome.Pioneer).AddArray(f.Biome.Moisture).AddArray(f.Biome.Tree).AddArray(f.Biome.Shrub)
                .AddArray(f.Biome.Conifer).AddArray(f.Biome.Tall).AddArray(f.Biome.Current).AddArray(f.Biome.Candidate).AddArray(f.Biome.Days)
                .AddArray(f.ColonistMass).AddArray(f.ColonistFirst).AddArray(f.Ledger)
                .AddInt((int)f.LastSliceHour).AddInt((int)JsMath.Round(f.PreparedYears * 1000)).AddInt(f.RegionalSeedRain ? 1 : 0)
                .AddInt(wd.Count)
                .AddArray(wd.X, wd.HighWater).AddArray(wd.Z, wd.HighWater).AddArray(wd.Species, wd.HighWater).AddArray(wd.Age, wd.HighWater).AddArray(wd.Biomass, wd.HighWater)
                .AddArray(wd.Leaf, wd.HighWater).AddArray(wd.Health, wd.HighWater).AddArray(wd.Stage, wd.HighWater).AddArray(wd.StressW, wd.HighWater).AddArray(wd.StressL, wd.HighWater)
                .AddArray(wd.Alive, wd.HighWater).AddArray(wd.Generation, wd.HighWater);
            return h.Digest();
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
