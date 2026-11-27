// Применение снимков к рендеру. Полный пакет — сброс и загрузка всех чанков; инкрементальный — только
// изменившиеся чанки (пустой чанк — растения исчезли). Применение растянуто по кадрам с бюджетом времени
// (300 тыс. деревьев не дают длинного кадра): древесные пачками превращаются в экземпляры заданием Burst
// (вид → профиль и возрастной архетип, высота и крона из снимка → растяжение модели, высота рельефа, поворот
// и вариация по номеру растения), затем раскладываются по спискам чанков слоёв деревьев и кустарников.
// Целостность: контрольная сумма каждого чанка (по желанию) и свёртка сумм всех чанков после применения
// пакета. Расхождение → версия сбрасывается, следующий запрос получает полный снимок.

using System;
using System.Collections.Generic;
using Unity.Burst;
using Unity.Collections;
using Unity.Collections.LowLevel.Unsafe;
using Unity.Jobs;
using Unity.Mathematics;
using UnityEngine;

namespace Worldbound.FloraView
{
    public sealed unsafe class FloraChunkManager : IDisposable
    {
        public readonly FloraGrid Grid;
        readonly FloraTerrain terrain;
        readonly FloraWoodyLayer trees, shrubs;
        readonly FloraFieldStore fields;
        NativeArray<SpeciesMap> maps;
        readonly uint[] woodySums, fieldSums;
        readonly Queue<WoodyChunk> woodyQueue = new();
        readonly Queue<FieldChunk> fieldQueue = new();
        FloraUpdate current;

        public long WorldId { get; private set; } = -1;
        /// <summary>Версия, применённая целиком (−1 — нет данных или нужна полная пересылка).</summary>
        public long Version { get; private set; } = -1;
        public bool Busy => current != null;
        public int WoodyTotal => trees.Total + shrubs.Total;

        // Статистика.
        public float LastFrameApplyMs, LastUpdateMs, MaxFrameApplyMs;
        public int LastUpdateChunks, LastUpdatePlants, ChecksumFailures, StateMismatches, UpdatesApplied, FullUpdates;
        public FloraUpdateKind LastKind;
        double updateStarted;
        public bool VerifyChecksums = true;

        public FloraChunkManager(FloraGrid grid, FloraTerrain terrain, FloraWoodyLayer trees, FloraWoodyLayer shrubs, FloraFieldStore fields, SpeciesMap[] speciesMaps)
        {
            Grid = grid;
            this.terrain = terrain;
            this.trees = trees;
            this.shrubs = shrubs;
            this.fields = fields;
            maps = new NativeArray<SpeciesMap>(speciesMaps, Allocator.Persistent);
            woodySums = new uint[grid.ChunkCount];
            fieldSums = new uint[grid.ChunkCount];
            ResetSums();
        }

        void ResetSums()
        {
            for (int k = 0; k < woodySums.Length; k++) { woodySums[k] = FloraChecksum.Empty; fieldSums[k] = FloraChecksum.Empty; }
        }

        /// <summary>Начать применение пакета (если предыдущий ещё применяется — пакет не принимается).</summary>
        public bool Begin(FloraUpdate u)
        {
            if (current != null) return false;
            if (!u.Grid.Equals(Grid)) { Debug.LogError($"[Flora] сетка снимка {u.Grid.Cells} не совпадает с сеткой рендера {Grid.Cells}"); return false; }
            bool reset = u.Kind == FloraUpdateKind.Full || u.WorldId != WorldId;
            if (u.Kind == FloraUpdateKind.Incremental && (u.WorldId != WorldId || u.BaseVersion != Version))
            {
                Debug.LogWarning("[Flora] инкрементальный пакет не к той версии — запрошу полный снимок");
                Version = -1;
                return false;
            }
            if (reset)
            {
                trees.Clear(); shrubs.Clear(); fields.Clear();
                ResetSums();
                FullUpdates++;
            }
            current = u;
            updateStarted = Time.realtimeSinceStartupAsDouble;
            LastUpdateChunks = u.Woody.Length + u.Fields.Length;
            LastUpdatePlants = 0;
            foreach (var c in u.Woody) { woodyQueue.Enqueue(c); LastUpdatePlants += c.Count; }
            foreach (var c in u.Fields) fieldQueue.Enqueue(c);
            LastKind = u.Kind;
            return true;
        }

        /// <summary>Применить часть очереди в пределах бюджета. true — пакет применён полностью.</summary>
        public bool Step(float budgetMs)
        {
            if (current == null) return true;
            var t0 = Time.realtimeSinceStartupAsDouble;
            while (fieldQueue.Count > 0 && Elapsed(t0) < budgetMs)
            {
                var c = fieldQueue.Dequeue();
                if (VerifyChecksums && FloraChecksum.Field(c) != c.Checksum) { ChecksumFailures++; Debug.LogWarning($"[Flora] контрольная сумма поля чанка {c.Chunk} не совпала"); }
                fields.Apply(c);
                fieldSums[c.Chunk] = c.Checksum;
            }
            while (woodyQueue.Count > 0 && Elapsed(t0) < budgetMs)
            {
                // Пачка чанков ≈ 20 тыс. растений на задание.
                var batch = new List<WoodyChunk>();
                int plants = 0;
                while (woodyQueue.Count > 0 && (plants < 20000 || batch.Count == 0))
                {
                    var c = woodyQueue.Dequeue();
                    if (VerifyChecksums && FloraChecksum.Woody(c) != c.Checksum) { ChecksumFailures++; Debug.LogWarning($"[Flora] контрольная сумма чанка {c.Chunk} не совпала"); }
                    batch.Add(c);
                    plants += c.Count;
                }
                ApplyWoody(batch, plants);
            }
            float ms = (float)Elapsed(t0);
            LastFrameApplyMs = ms;
            MaxFrameApplyMs = Mathf.Max(MaxFrameApplyMs, ms);
            if (woodyQueue.Count > 0 || fieldQueue.Count > 0) return false;
            // Пакет применён: проверка свёртки состояния.
            trees.RefreshTotals();
            shrubs.RefreshTotals();
            uint ws = FloraChecksum.State(woodySums), fs = FloraChecksum.State(fieldSums);
            if (ws != current.WoodyStateChecksum || fs != current.FieldStateChecksum)
            {
                StateMismatches++;
                Debug.LogWarning($"[Flora] состояние после пакета {current.Version} не совпало с источником — нужна полная пересылка");
                Version = -1;
            }
            else Version = current.Version;
            WorldId = current.WorldId;
            LastUpdateMs = (float)((Time.realtimeSinceStartupAsDouble - updateStarted) * 1000);
            UpdatesApplied++;
            current = null;
            return true;
        }

        static double Elapsed(double t0) => (Time.realtimeSinceStartupAsDouble - t0) * 1000;

        void ApplyWoody(List<WoodyChunk> batch, int plants)
        {
            var input = new NativeArray<WoodyPlant>(Math.Max(1, plants), Allocator.TempJob, NativeArrayOptions.UninitializedMemory);
            var ranges = new NativeArray<int3>(batch.Count, Allocator.TempJob); // чанк, начало, конец
            int at = 0;
            for (int i = 0; i < batch.Count; i++)
            {
                var c = batch[i];
                if (c.Count > 0) NativeArray<WoodyPlant>.Copy(c.Plants, 0, input, at, c.Count);
                ranges[i] = new int3(c.Chunk, at, at + c.Count);
                at += c.Count;
                woodySums[c.Chunk] = c.Checksum;
            }
            var inst = new NativeArray<WoodyInstance>(Math.Max(1, plants), Allocator.TempJob, NativeArrayOptions.UninitializedMemory);
            var layer = new NativeArray<byte>(Math.Max(1, plants), Allocator.TempJob, NativeArrayOptions.UninitializedMemory);
            var h1 = new ConvertJob { Plants = input, Maps = maps, Heights = terrain.Heights, Samples = terrain.Samples, Spacing = terrain.Spacing, Out = inst, Layer = layer }.Schedule(plants, 256);
            var h2 = new GroupJob
            {
                Ranges = ranges, Inst = inst, Layer = layer,
                Trees = trees.ListsPtr, Shrubs = shrubs.ListsPtr,
                TreeMin = trees.ChunkMin, TreeMax = trees.ChunkMax, TreeCount = trees.ChunkCount,
                ShrubMin = shrubs.ChunkMin, ShrubMax = shrubs.ChunkMax, ShrubCount = shrubs.ChunkCount,
            }.Schedule(batch.Count, 1, h1);
            h2.Complete();
            input.Dispose(); ranges.Dispose(); inst.Dispose(); layer.Dispose();
        }

        [BurstCompile]
        struct ConvertJob : IJobParallelFor
        {
            [ReadOnly] public NativeArray<WoodyPlant> Plants;
            [ReadOnly] public NativeArray<SpeciesMap> Maps;
            [ReadOnly] public NativeArray<float> Heights;
            public int Samples;
            public float Spacing;
            public NativeArray<WoodyInstance> Out;
            public NativeArray<byte> Layer;

            public void Execute(int i)
            {
                var p = Plants[i];
                Layer[i] = 0;
                if (p.Species >= Maps.Length || p.Height < 0.25f) return;
                var m = Maps[p.Species];
                if (m.Layer == 0) return;
                float h = p.Height;
                float rel = h / math.max(0.1f, m.MaxHeight);
                float pick = FloraJobMath.F(p.Id, 11, 0);
                int form; // 0 young, 1 matureA, 2 matureB, 3 old
                if (m.Young >= 0 && (p.Stage == 1 || p.Stage == 0 || (p.Stage == 255 && rel < 0.3f) || rel < 0.2f)) form = 0;
                else if (m.Old >= 0 && (p.Stage == 3 || (p.Stage == 255 && rel > 0.9f && pick < 0.6f))) form = 3;
                else form = m.MatureB >= 0 && pick > 0.5f ? 2 : 1;
                int arch = form == 0 ? m.Young : form == 1 ? m.MatureA : form == 2 ? m.MatureB : m.Old;
                if (arch < 0) { arch = m.MatureA; form = 1; }
                float refH = m.RefH[form], refR = m.RefR[form];
                float sy = h / refH;
                float sxz = p.CrownRadius > 0.01f ? p.CrownRadius / refR : sy;
                sxz = math.clamp(sxz, sy * 0.65f, sy * 1.5f);
                float y = FloraJobMath.Height(Heights, Samples, Spacing, p.X, p.Z);
                float seed = FloraJobMath.F(p.Id, 3, 0);
                Out[i] = new WoodyInstance
                {
                    Pos = new float3(p.X, y - 0.08f * sy, p.Z),
                    Yaw = FloraJobMath.F(p.Id, 5, 0) * 6.2831853f,
                    ScaleXZ = sxz,
                    ScaleY = sy,
                    Seed = seed,
                    Leaf = p.Leaf / 255f,
                    Health = p.Health / 255f,
                    Height = h,
                    Radius = math.max(refR * sxz, refH * sy * 0.55f) * 1.15f,
                    CentreY = h * 0.55f,
                    Archetype = arch,
                    Visual = m.Visual,
                    ImpostorRow = form == 3 ? m.ImpostorOld : m.ImpostorMature,
                    LastLod = 255,
                };
                Layer[i] = (byte)m.Layer;
            }
        }

        [BurstCompile]
        struct GroupJob : IJobParallelFor
        {
            [ReadOnly] public NativeArray<int3> Ranges;
            [ReadOnly] public NativeArray<WoodyInstance> Inst;
            [ReadOnly] public NativeArray<byte> Layer;
            [NativeDisableUnsafePtrRestriction] public UnsafeList<WoodyInstance>* Trees, Shrubs;
            [NativeDisableParallelForRestriction] public NativeArray<float3> TreeMin, TreeMax, ShrubMin, ShrubMax;
            [NativeDisableParallelForRestriction] public NativeArray<int> TreeCount, ShrubCount;

            public void Execute(int e)
            {
                int3 r = Ranges[e];
                int k = r.x;
                ref var tl = ref Trees[k];
                ref var sl = ref Shrubs[k];
                tl.Clear(); sl.Clear();
                float3 tMin = new float3(float.MaxValue), tMax = new float3(float.MinValue), sMin = tMin, sMax = tMax;
                for (int i = r.y; i < r.z; i++)
                {
                    byte l = Layer[i];
                    if (l == 0) continue;
                    var w = Inst[i];
                    float3 c = w.Pos + new float3(0, w.CentreY, 0);
                    if (l == 1) { tl.Add(w); tMin = math.min(tMin, c - w.Radius); tMax = math.max(tMax, c + w.Radius); }
                    else { sl.Add(w); sMin = math.min(sMin, c - w.Radius); sMax = math.max(sMax, c + w.Radius); }
                }
                TreeCount[k] = tl.Length; ShrubCount[k] = sl.Length;
                TreeMin[k] = tMin; TreeMax[k] = tMax; ShrubMin[k] = sMin; ShrubMax[k] = sMax;
            }
        }

        public void Dispose() { if (maps.IsCreated) maps.Dispose(); }
    }
}
