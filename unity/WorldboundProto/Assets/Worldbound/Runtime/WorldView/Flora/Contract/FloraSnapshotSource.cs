// Источник снимков растительности и общий «издатель» версий по чанкам.
//
// Схема: источник (адаптер симуляции, синтетический стенд) раз в час/сутки игры кладёт в FloraSnapshotPublisher
// новые чанки (Stage*), затем Commit. Издатель сравнивает контрольные суммы, ставит изменившимся чанкам новую версию
// и отдаёт рендеру по запросу либо полный снимок, либо только чанки новее версии, которую рендер уже применил.
// Состояния «на получателя» нет: одну публикацию могут читать несколько рендеров. Опубликованные объекты чанков
// неизменяемы (новые данные — новый объект), поэтому рендер читает их без копирования и без гонок.

using System;
using System.Collections.Generic;

namespace Worldbound.FloraView
{
    public interface IFloraSnapshotSource
    {
        FloraCatalogInfo Catalog { get; }
        /// <summary>Условия текущего кадра (время года, ветер, снег).</summary>
        FloraEnvironment Environment { get; }
        /// <summary>
        /// Изменения после версии appliedVersion мира appliedWorldId (−1 — у рендера ничего нет → полный снимок).
        /// false — ничего нового.
        /// </summary>
        bool TryGetUpdate(long appliedWorldId, long appliedVersion, out FloraUpdate update);
    }

    /// <summary>Контрольные суммы контракта (FNV-1a, как в TS FloraFeed).</summary>
    public static class FloraChecksum
    {
        public const uint Empty = 2166136261;

        public static uint Mix(uint h, uint v) => (h ^ v) * 16777619u;

        static uint Bits(float f) => (uint)BitConverter.SingleToInt32Bits(f);

        public static uint Woody(WoodyChunk c)
        {
            if (c == null || c.Count == 0) return Empty;
            uint h = Mix(Empty, (uint)c.Chunk);
            for (int i = 0; i < c.Count; i++)
            {
                ref readonly var p = ref c.Plants[i];
                h = Mix(h, p.Id);
                h = Mix(h, Bits(p.X));
                h = Mix(h, Bits(p.Z));
                h = Mix(h, Bits(p.Height));
                h = Mix(h, Bits(p.CrownRadius));
                h = Mix(h, Bits(p.Biomass));
                h = Mix(h, p.Species | (uint)p.Leaf << 16 | (uint)p.Health << 24);
                h = Mix(h, p.Stage | (uint)p.Flags << 8);
            }
            return h;
        }

        public static uint Field(FieldChunk c)
        {
            if (c == null) return Empty;
            uint h = Mix(Empty, (uint)c.Chunk);
            h = Bytes(h, c.Herbs);
            h = Bytes(h, c.HerbCell);
            h = Bytes(h, c.Canopy);
            h = Bytes(h, c.Surface);
            return h;
        }

        static uint Bytes(uint h, byte[] b)
        {
            if (b == null) return Mix(h, 0xFFFFFFFF);
            h = Mix(h, (uint)b.Length);
            for (int i = 0; i < b.Length; i++) h = (h ^ b[i]) * 16777619u;
            return h;
        }

        /// <summary>Свёртка сумм всех чанков мира по порядку номеров (пустые — Empty).</summary>
        public static uint State(uint[] chunkSums)
        {
            uint h = Empty;
            for (int k = 0; k < chunkSums.Length; k++) h = Mix(Mix(h, (uint)k), chunkSums[k]);
            return h;
        }
    }

    /// <summary>Издатель снимков: версии по чанкам, полные и инкрементальные пакеты, свёртки для проверки целостности.</summary>
    public sealed class FloraSnapshotPublisher
    {
        readonly object gate = new();
        FloraGrid grid;
        long worldId, version, simTick;
        WoodyChunk[] woody;
        FieldChunk[] fields;
        long[] woodyVer, fieldVer;
        uint[] woodySum, fieldSum;
        int woodyTotal;
        readonly Dictionary<int, WoodyChunk> stagedWoody = new();
        readonly Dictionary<int, FieldChunk> stagedFields = new();

        /// <summary>Сколько чанков изменилось в последнем Commit (для отчёта о доле изменившихся).</summary>
        public int LastChangedWoody { get; private set; }
        public int LastChangedFields { get; private set; }
        public long Version { get { lock (gate) return version; } }
        public long WorldId { get { lock (gate) return worldId; } }
        public FloraGrid Grid => grid;

        public FloraSnapshotPublisher(FloraGrid grid, long worldId) => Reset(grid, worldId);

        /// <summary>Новый мир: всё пусто, версия 0.</summary>
        public void Reset(FloraGrid g, long newWorldId)
        {
            lock (gate)
            {
                grid = g;
                worldId = newWorldId;
                version = 0;
                int n = g.ChunkCount;
                woody = new WoodyChunk[n];
                fields = new FieldChunk[n];
                woodyVer = new long[n];
                fieldVer = new long[n];
                woodySum = new uint[n];
                fieldSum = new uint[n];
                for (int k = 0; k < n; k++) { woodySum[k] = FloraChecksum.Empty; fieldSum[k] = FloraChecksum.Empty; }
                woodyTotal = 0;
                stagedWoody.Clear();
                stagedFields.Clear();
            }
        }

        /// <summary>Подготовить чанк древесных к публикации. После вызова объект нельзя менять.</summary>
        public void StageWoody(WoodyChunk c)
        {
            c.Checksum = FloraChecksum.Woody(c);
            lock (gate) stagedWoody[c.Chunk] = c;
        }

        public void StageField(FieldChunk c)
        {
            c.Checksum = FloraChecksum.Field(c);
            lock (gate) stagedFields[c.Chunk] = c;
        }

        /// <summary>Опубликовать подготовленные чанки. Чанки с прежней контрольной суммой не считаются изменившимися.</summary>
        public long Commit(long tick)
        {
            lock (gate)
            {
                long next = version + 1;
                int changedW = 0, changedF = 0;
                foreach (var kv in stagedWoody)
                {
                    int k = kv.Key;
                    if ((uint)k >= (uint)woody.Length) continue;
                    var c = kv.Value;
                    if (c.Checksum == woodySum[k] && (woody[k]?.Count ?? 0) == c.Count) continue;
                    woodyTotal += c.Count - (woody[k]?.Count ?? 0);
                    woody[k] = c.Count > 0 ? c : null;
                    woodySum[k] = c.Checksum;
                    woodyVer[k] = next;
                    changedW++;
                }
                foreach (var kv in stagedFields)
                {
                    int k = kv.Key;
                    if ((uint)k >= (uint)fields.Length) continue;
                    var c = kv.Value;
                    if (c.Checksum == fieldSum[k]) continue;
                    fields[k] = c;
                    fieldSum[k] = c.Checksum;
                    fieldVer[k] = next;
                    changedF++;
                }
                stagedWoody.Clear();
                stagedFields.Clear();
                LastChangedWoody = changedW;
                LastChangedFields = changedF;
                simTick = tick;
                if (changedW > 0 || changedF > 0) version = next;
                return version;
            }
        }

        public bool TryGetUpdate(long appliedWorldId, long appliedVersion, out FloraUpdate update)
        {
            lock (gate)
            {
                update = null;
                bool full = appliedWorldId != worldId || appliedVersion < 0 || appliedVersion > version;
                if (!full && appliedVersion == version) return false;
                var w = new List<WoodyChunk>();
                var f = new List<FieldChunk>();
                for (int k = 0; k < woody.Length; k++)
                {
                    if (full ? woody[k] != null : woodyVer[k] > appliedVersion) w.Add(woody[k] ?? new WoodyChunk { Chunk = k, Count = 0, Checksum = FloraChecksum.Empty });
                    if (full ? fields[k] != null : fieldVer[k] > appliedVersion) { if (fields[k] != null) f.Add(fields[k]); }
                }
                update = new FloraUpdate
                {
                    Kind = full ? FloraUpdateKind.Full : FloraUpdateKind.Incremental,
                    WorldId = worldId,
                    Version = version,
                    BaseVersion = full ? -1 : appliedVersion,
                    SimTick = simTick,
                    Grid = grid,
                    Woody = w.ToArray(),
                    Fields = f.ToArray(),
                    WoodyStateChecksum = FloraChecksum.State(woodySum),
                    FieldStateChecksum = FloraChecksum.State(fieldSum),
                    WoodyTotal = woodyTotal,
                };
                return true;
            }
        }
    }
}
