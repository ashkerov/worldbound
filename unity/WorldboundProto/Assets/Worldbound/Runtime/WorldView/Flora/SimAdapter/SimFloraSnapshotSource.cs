// Адаптер «настоящая симуляция C# → контракт рендера растительности». ЧЕРНОВИК ДЛЯ ИНТЕГРАЦИИ: компилируется вместе
// с ядром, но нигде не подключён (WorldApp / SimHost не менялись). Только читает World — ни одного присваивания
// в массивы ядра, RNG симуляции не вызывается. Вызывать на главном потоке между шагами симуляции.
//
// Связь с ядром — только через публичные массивы WoodyStore / FloraState / EnvState и FloraMath; номера видов
// не зашиты: каталог для рендера строится из PlantCatalog. Отображения величин, которых нет в ядре
// (высота травостоя, ветошь, намокание), помечены «предварительно» — их уточняет интеграция
// (docs/FLORA_RENDERER_INTEGRATION.md, раздел «Адаптер»).

using System;
using System.Collections.Generic;
using Worldbound.Sim;
using Worldbound.Sim.Env;
using Worldbound.Sim.Flora;

namespace Worldbound.FloraView
{
    public sealed class SimFloraSnapshotSource : IFloraSnapshotSource
    {
        readonly World world;
        readonly FloraSnapshotPublisher publisher;
        readonly FloraGrid grid;
        readonly FloraCatalogInfo catalog;
        readonly int herbCount;
        FloraEnvironment env = FloraEnvironment.Default;
        // Буферы сборки чанков (переиспользуются между снимками).
        readonly List<WoodyPlant>[] perChunk;

        public FloraCatalogInfo Catalog => catalog;
        public FloraEnvironment Environment => env;
        public FloraSnapshotPublisher Publisher => publisher;

        public SimFloraSnapshotSource(World world)
        {
            this.world = world;
            var geo = world.Geo;
            grid = new FloraGrid(geo.N, geo.CellSize, FloraContract.ChunkCells);
            long worldId = ((long)world.Seed << 32) ^ (uint)(world.GeoHash ?? "").GetHashCode() ^ world.WorldSize;
            publisher = new FloraSnapshotPublisher(grid, worldId);
            catalog = BuildCatalog(world.Flora.Species);
            herbCount = catalog.HerbOrder.Length;
            perChunk = new List<WoodyPlant>[grid.ChunkCount];
            for (int k = 0; k < perChunk.Length; k++) perChunk[k] = new List<WoodyPlant>();
        }

        static FloraCatalogInfo BuildCatalog(SpeciesTable t)
        {
            var plants = PlantCatalog.All;
            var list = new FloraSpeciesInfo[plants.Length];
            for (int i = 0; i < plants.Length; i++)
            {
                var p = plants[i];
                list[i] = new FloraSpeciesInfo
                {
                    Id = i,
                    Key = p.Id,
                    Form = p.Form == PlantForm.Tree ? FloraForm.Tree : p.Form == PlantForm.Shrub ? FloraForm.Shrub : FloraForm.Herb,
                    Habit = p.LeafHabit == LeafHabit.Evergreen ? FloraLeafHabit.Evergreen : p.LeafHabit == LeafHabit.Deciduous ? FloraLeafHabit.Deciduous : FloraLeafHabit.AnnualDieback,
                    MaxHeight = (float)t.MaxHeight[i],
                    MaxCrownRadius = (float)t.MaxCrown[i],
                };
            }
            return new FloraCatalogInfo { Species = list, HerbOrder = (int[])t.Herbs.Clone() };
        }

        /// <summary>Снять снимок всего мира и опубликовать изменившиеся чанки. Стоимость — один проход по хранилищу и ячейкам.</summary>
        public long CaptureAll()
        {
            CaptureWoody();
            CaptureFields(0, grid.ChunksPerSide);
            return publisher.Commit(world.Tick);
        }

        /// <summary>Древесные: все живые растения, по чанкам, с квантованием (меньше «дребезга» чанков от суточного роста).</summary>
        public void CaptureWoody()
        {
            var f = world.Flora;
            var w = f.Woody;
            var t = f.Species;
            foreach (var l in perChunk) l.Clear();
            for (int i = 0; i < w.HighWater; i++)
            {
                if (w.Alive[i] != 1) continue;
                int s = w.Species[i];
                double b = w.Biomass[i];
                var p = new WoodyPlant
                {
                    Id = w.IdOf(i),
                    X = w.X[i],
                    Z = w.Z[i],
                    Height = Q((float)FloraMath.WoodyHeight(t, s, b), 20),
                    CrownRadius = Q((float)FloraMath.CrownRadius(t, s, b), 20),
                    Biomass = b > 0 ? (float)Math.Exp(Math.Round(Math.Log(b) * 50) / 50) : 0, // ≈2 % шаг
                    Species = (ushort)s,
                    Leaf = (byte)(Math.Round(Math.Min(1, Math.Max(0, w.Leaf[i])) * 31) * 255 / 31),
                    Health = (byte)(Math.Round(Math.Min(1, Math.Max(0, w.Health[i])) * 15) * 17),
                    Stage = w.Stage[i],
                };
                perChunk[grid.ChunkOfCell(w.Cell[i])].Add(p);
            }
            for (int k = 0; k < perChunk.Length; k++)
            {
                var l = perChunk[k];
                l.Sort((a, b) => a.Id.CompareTo(b.Id));
                publisher.StageWoody(new WoodyChunk { Chunk = k, Plants = l.ToArray(), Count = l.Count });
            }
        }

        /// <summary>Поля трав, полога и поверхности для строк чанков [rowFrom, rowTo) — можно растянуть на несколько кадров.</summary>
        public void CaptureFields(int rowFrom, int rowTo)
        {
            var f = world.Flora;
            var t = f.Species;
            var e = world.Env;
            var cap = world.Derived?.Capacity;
            int cpc = grid.CellsPerChunk, cps = grid.ChunksPerSide;
            // Средняя облиственность древесных по ячейке (как в TS FloraFeed.field).
            var leafSum = new float[grid.CellCount];
            var leafN = new ushort[grid.CellCount];
            var w = f.Woody;
            for (int i = 0; i < w.HighWater; i++)
            {
                if (w.Alive[i] != 1) continue;
                int c = w.Cell[i];
                leafSum[c] += w.Leaf[i];
                if (leafN[c] < 65535) leafN[c]++;
            }
            for (int cz = Math.Max(0, rowFrom); cz < Math.Min(cps, rowTo); cz++)
                for (int cx = 0; cx < cps; cx++)
                {
                    int k = cz * cps + cx;
                    var fc = new FieldChunk { Chunk = k, Herbs = new byte[cpc * herbCount], HerbCell = new byte[cpc * 4], Canopy = new byte[cpc * 4], Surface = new byte[cpc * 2] };
                    for (int local = 0; local < cpc; local++)
                    {
                        int c = grid.CellOfChunk(k, local);
                        if (c < 0) continue;
                        double total = 0;
                        for (int slot = 0; slot < FloraState.Slots; slot++)
                        {
                            int s = f.SlotSpecies[c * FloraState.Slots + slot];
                            if (s == SpeciesTable.NoSpecies) continue;
                            int h = t.HerbSlot[s];
                            if (h < 0) continue;
                            double g = f.SlotBiomass[c * FloraState.Slots + slot];
                            total += g;
                            int o = local * herbCount + h;
                            fc.Herbs[o] = (byte)Math.Min(255, fc.Herbs[o] + FloraContract.HerbByte((float)g));
                        }
                        // Предварительно: покрытие — насыщающаяся функция биомассы; высота 0 — «по видам» (решает рендер);
                        // зелень — индекс зелени среды; ветошь — быстрый опад относительно 300 г/м².
                        fc.HerbCell[local * 4] = FloraContract.Unit((float)(1 - Math.Exp(-total / 120)));
                        fc.HerbCell[local * 4 + 1] = 0;
                        fc.HerbCell[local * 4 + 2] = FloraContract.Unit(e.Greenness != null ? e.Greenness[c] : 1);
                        fc.HerbCell[local * 4 + 3] = FloraContract.Unit(f.LitterFast != null ? f.LitterFast[c] / 300f : 0);
                        float tree = f.TreeCover[c];
                        fc.Canopy[local * 4] = FloraContract.Unit(tree);
                        fc.Canopy[local * 4 + 1] = tree > 1e-4f ? FloraContract.Unit(f.ConiferCover[c] / tree) : (byte)0;
                        fc.Canopy[local * 4 + 2] = FloraContract.Unit(f.ShrubCover[c]);
                        fc.Canopy[local * 4 + 3] = leafN[c] > 0 ? FloraContract.Unit(leafSum[c] / leafN[c]) : (byte)255;
                        fc.Surface[local * 2] = FloraContract.Unit(e.Snow[c] / 25f);
                        fc.Surface[local * 2 + 1] = cap != null && cap[c] > 0 ? FloraContract.Unit(e.Moisture[c] / cap[c]) : (byte)0;
                    }
                    publisher.StageField(fc);
                }
        }

        /// <summary>Условия кадра: доля года и суток из такта, ветер — из той же функции, что погода ядра (чистое чтение).</summary>
        public void UpdateEnvironment(float meanSnow01, float rain01)
        {
            int dps = world.Config.DaysPerSeason;
            var wind = new Wind();
            Weather.WindAt(world, world.Tick, ref wind);
            env.YearPhase = (float)SimTime.YearFraction(world.Tick, dps);
            env.DayPhase = (float)SimTime.DayFraction(world.Tick);
            env.WindDirection = (float)Math.Atan2(wind.Z, wind.X);
            env.WindSpeed = (float)wind.Speed;
            env.Gustiness = 0.35f;
            env.Snow = meanSnow01;
            env.Wetness = rain01;
        }

        public bool TryGetUpdate(long appliedWorldId, long appliedVersion, out FloraUpdate update) => publisher.TryGetUpdate(appliedWorldId, appliedVersion, out update);

        static float Q(float v, float steps) => (float)Math.Round(v * steps) / steps;
    }
}
