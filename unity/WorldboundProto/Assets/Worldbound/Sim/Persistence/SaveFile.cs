// Сохранение мира (формат WBSV, docs/UNITY_SAVE_FORMAT.md). Бинарный файл из секций:
//   заголовок: "WBSV", версия формата (u32), число секций (u32);
//   секция: идентификатор (4 ASCII), версия секции (u16), флаги (u16: 1 — Deflate), длина данных (u64), CRC32 данных, данные;
//   хвост: CRC32 всего предшествующего содержимого.
// Секции v1: CONF (параметры мира), GEOG (вся статика генератора — сохранение не зависит от версии генератора),
// TIME (такт, скорость), WTHR (погода), WATR (вода, снег, покров), FLIN (накопители для флоры), HASH (хеши для сверки).
// Флора (FLOR) и фауна (FAUN) — зарезервированные секции: появятся вместе с переносом этих систем; читатель пропускает
// неизвестные секции, поэтому старые программы не ломаются на новых файлах той же версии формата.
// Запись атомарная: временный файл → сброс на диск → File.Replace с резервной копией; хранятся 3 копии (.bak1–.bak3).
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using Worldbound.Sim.Env;
using Worldbound.Sim.WorldGen;

namespace Worldbound.Sim.Persistence
{
    public sealed class SaveException : Exception
    {
        public SaveException(string message) : base(message) { }
    }

    public static class Crc32
    {
        static readonly uint[] Table = Make();

        static uint[] Make()
        {
            var t = new uint[256];
            for (uint i = 0; i < 256; i++)
            {
                uint c = i;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                t[i] = c;
            }
            return t;
        }

        public static uint Compute(ReadOnlySpan<byte> data, uint crc = 0)
        {
            crc = ~crc;
            foreach (byte b in data) crc = Table[(crc ^ b) & 0xff] ^ (crc >> 8);
            return ~crc;
        }
    }

    public sealed class SaveInfo
    {
        public string Path;
        public string UsedFile;
        public int FormatVersion;
        public long Tick;
        public string GeoHash, EnvHash;
        public List<string> Sections = new();
        public List<string> Warnings = new();
        public long Bytes;
    }

    public static class SaveFile
    {
        public const int FormatVersion = 1;
        public const int Backups = 3;
        static readonly byte[] Magic = { (byte)'W', (byte)'B', (byte)'S', (byte)'V' };

        // ───────── запись ─────────

        internal sealed class Section
        {
            public string Id;
            public ushort Version = 1;
            public bool Compress;
            public byte[] Data;
        }

        sealed class Buf
        {
            readonly MemoryStream ms = new();
            public readonly BinaryWriter W;
            public Buf() { W = new BinaryWriter(ms, Encoding.UTF8); }
            public Buf Str(string s) { W.Write(s ?? ""); return this; }
            public Buf I(int v) { W.Write(v); return this; }
            public Buf L(long v) { W.Write(v); return this; }
            public Buf D(double v) { W.Write(v); return this; }
            public Buf B(byte v) { W.Write(v); return this; }

            public Buf Arr<T>(T[] a) where T : struct
            {
                W.Write(a.Length);
                W.Write(MemoryMarshal.AsBytes(new ReadOnlySpan<T>(a)));
                return this;
            }

            public byte[] Bytes() { W.Flush(); return ms.ToArray(); }
        }

        /// <summary>Снимок состояния для записи: копии изменяемых данных (быстро, на потоке симуляции).</summary>
        public sealed class Capture
        {
            internal List<Section> Sections;
            internal Geo Geo;
            public long Tick;
        }

        /// <summary>Копирует изменяемое состояние в байты секций. Статика (Geo) неизменна — берётся по ссылке.</summary>
        public static Capture Take(Simulation sim)
        {
            var w = sim.World;
            var e = w.Env;
            var f = w.Flora;
            var c = w.Config;
            return new Capture
            {
                Geo = w.Geo,
                Tick = w.Tick,
                Sections = new List<Section>
                {
                    new() { Id = "CONF", Data = new Buf().Str(c.Name).L(c.Seed).Str(c.Size.ToString()).Str(c.ClimateId).I(c.DaysPerSeason).Str(c.Scenario.ToString()).B((byte)(c.Isolated ? 1 : 0)).Bytes() },
                    new() { Id = "GEOG", Compress = true },
                    new() { Id = "TIME", Data = new Buf().L(w.Tick).I(w.Speed).Bytes() },
                    new() { Id = "WTHR", Compress = true, Data = new Buf().I(e.Weather.Chunks).Arr(e.Weather.Cells).Arr(e.Weather.ChunkRate).Arr(e.Weather.ChunkCloud).Arr(e.Weather.ChunkAccum).Arr(e.Weather.Balance).Bytes() },
                    new() { Id = "WATR", Compress = true, Data = new Buf().Arr(e.Moisture).Arr(e.Snow).Arr(e.Greenness).Arr(e.Discharge).Arr(e.Runoff).Arr(e.WaterTotals).I(e.LastHourStep).Bytes() },
                    new() { Id = "FLIN", Compress = true, Data = new Buf().Arr(f.AccT).Arr(f.AccW).Arr(f.AccRunoff).Arr(f.AccMinT).Arr(f.AccHours).Arr(f.Capillary).Bytes() },
                    new() { Id = "HASH", Data = new Buf().I(Generate.WorldgenVersion).Str(w.GeoHash).Str(sim.EnvHash()).Bytes() },
                },
            };
        }

        public static long Save(Simulation sim, string path) => Write(Take(sim), path);

        /// <summary>Сжатие, контрольные суммы и атомарная запись. Потокобезопасно: можно вызывать в фоне.</summary>
        public static long Write(Capture cap, string path)
        {
            var ms = new MemoryStream();
            var bw = new BinaryWriter(ms);
            bw.Write(Magic);
            bw.Write((uint)FormatVersion);
            bw.Write((uint)cap.Sections.Count);
            foreach (var s in cap.Sections)
            {
                byte[] raw = s.Id == "GEOG" ? GeoBytes(cap.Geo) : s.Data;
                byte[] data = s.Compress ? Deflate(raw) : raw;
                bw.Write(Encoding.ASCII.GetBytes(s.Id));
                bw.Write(s.Version);
                bw.Write((ushort)(s.Compress ? 1 : 0));
                bw.Write((ulong)data.Length);
                bw.Write(Crc32.Compute(data));
                bw.Write(data);
            }
            bw.Flush();
            uint total = Crc32.Compute(new ReadOnlySpan<byte>(ms.GetBuffer(), 0, (int)ms.Length));
            bw.Write(total);
            bw.Flush();
            WriteAtomic(path, ms.GetBuffer(), (int)ms.Length);
            return ms.Length;
        }

        static byte[] GeoBytes(Geo g)
        {
            var b = new Buf().I(g.N).I(g.CellSize).Arr(g.Edges)
                .Arr(g.Height).Arr(g.Slope).Arr(g.WaterLevel).Arr(g.WaterDist).Arr(g.SeaDist).Arr(g.MeanDischarge).Arr(g.TMean).Arr(g.TAmp).Arr(g.Precip).Arr(g.Fertility)
                .Arr(g.WaterKind).Arr(g.Soil).Arr(g.Deposit).Arr(g.DepositRichness).Arr(g.Receiver).Arr(g.UpstreamOrder).Arr(g.LakeId).Arr(g.ProvinceOf)
                .D(g.WindX).D(g.WindZ);
            b.I(g.Lakes.Length);
            foreach (var l in g.Lakes) b.I(l.Id).D(l.Level).I(l.Cells).I(l.Outlet);
            b.I(g.Provinces.Length);
            foreach (var p in g.Provinces) b.I(p.Id).Str(p.Name).Str(p.Kind).D(p.X).D(p.Z).I(p.Cells).D(p.MeanHeight).D(p.MeanTemp).D(p.MeanPrecip);
            foreach (var h in new[] { g.Terrain, g.Horizon }) b.I(h.Samples).D(h.Spacing).D(h.OriginX).D(h.OriginZ).Arr(h.Data);
            return b.Bytes();
        }

        static byte[] Deflate(byte[] data)
        {
            var o = new MemoryStream();
            using (var z = new DeflateStream(o, CompressionLevel.Fastest, true)) z.Write(data, 0, data.Length);
            return o.ToArray();
        }

        static byte[] Inflate(byte[] data, string id)
        {
            try
            {
                var o = new MemoryStream();
                using (var z = new DeflateStream(new MemoryStream(data), CompressionMode.Decompress))
                {
                    var buf = new byte[1 << 16];
                    int n;
                    while ((n = z.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (o.Length + n > MaxInflated) throw new SaveException($"секция {id}: распакованный размер больше {MaxInflated >> 20} МБ");
                        o.Write(buf, 0, n);
                    }
                }
                return o.ToArray();
            }
            catch (InvalidDataException) { throw new SaveException($"секция {id}: сжатые данные повреждены"); }
        }

        /// <summary>Временный файл → сброс на диск → замена с резервной копией; старые копии сдвигаются (.bak1 → .bak2 → .bak3).</summary>
        static void WriteAtomic(string path, byte[] bytes, int length)
        {
            string dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, FileOptions.WriteThrough))
            {
                fs.Write(bytes, 0, length);
                fs.Flush(true);
            }
            if (File.Exists(path))
            {
                for (int k = Backups; k > 1; k--)
                {
                    string from = $"{path}.bak{k - 1}", to = $"{path}.bak{k}";
                    if (!File.Exists(from)) continue;
                    if (File.Exists(to)) File.Delete(to);
                    File.Move(from, to);
                }
                File.Replace(tmp, path, path + ".bak1", true);
            }
            else File.Move(tmp, path);
        }

        // ───────── чтение ─────────

        sealed class Reader
        {
            readonly BinaryReader r;
            readonly MemoryStream ms;
            readonly string section;

            public Reader(byte[] data, string section)
            {
                ms = new MemoryStream(data);
                r = new BinaryReader(ms, Encoding.UTF8);
                this.section = section;
            }

            long Left => ms.Length - ms.Position;

            void Need(long bytes)
            {
                if (bytes < 0 || bytes > Left) throw new SaveException($"секция {section}: данные обрезаны или длина некорректна");
            }

            public string Str()
            {
                Need(1);
                try { return r.ReadString(); }
                catch (Exception e) when (e is EndOfStreamException || e is FormatException) { throw new SaveException($"секция {section}: строка повреждена"); }
            }

            public int I() { Need(4); return r.ReadInt32(); }
            public long L() { Need(8); return r.ReadInt64(); }
            public double D() { Need(8); return r.ReadDouble(); }
            public byte B() { Need(1); return r.ReadByte(); }

            public T[] Arr<T>() where T : struct
            {
                int n = I();
                if (n < 0) throw new SaveException($"секция {section}: отрицательная длина массива");
                Need((long)n * Marshal.SizeOf<T>());
                var a = new T[n];
                var bytes = MemoryMarshal.AsBytes(new Span<T>(a));
                int read = r.Read(bytes);
                if (read != bytes.Length) throw new SaveException($"секция {section}: массив обрезан");
                return a;
            }

            public void Into<T>(T[] dst) where T : struct
            {
                var a = Arr<T>();
                if (a.Length != dst.Length) throw new SaveException($"секция {section}: размер массива {a.Length} ≠ {dst.Length}");
                Array.Copy(a, dst, a.Length);
            }

            /// <summary>Секция прочитана целиком: лишние байты — признак несовместимой или испорченной схемы.</summary>
            public void End()
            {
                if (Left != 0) throw new SaveException($"секция {section}: {Left} лишних байт");
            }
        }

        /// <summary>Предел размера распакованной секции (защита от «бомбы» сжатия): 1 ГБ.</summary>
        const long MaxInflated = 1L << 30;
        /// <summary>Разумный предел числа секций в файле.</summary>
        const int MaxSections = 256;

        /// <summary>
        /// Поддерживаемые версии схем известных секций (поле «версия секции» в заголовке). Секция известна —
        /// её версия обязана быть в этом диапазоне, иначе файл отклоняется (версия 0 некорректна, более новая —
        /// записана более новой программой). Неизвестные секции пропускаются при любой версии.
        /// Новая схема секции добавляется сюда вместе с чтением старой (или миграцией секции).
        /// </summary>
        public static readonly IReadOnlyDictionary<string, (ushort min, ushort max)> SectionVersions = new Dictionary<string, (ushort, ushort)>
        {
            ["CONF"] = (1, 1),
            ["GEOG"] = (1, 1),
            ["TIME"] = (1, 1),
            ["WTHR"] = (1, 1),
            ["WATR"] = (1, 1),
            ["FLIN"] = (1, 1),
            ["HASH"] = (1, 1),
        };

        static void CheckSectionVersions(Dictionary<string, (ushort ver, byte[] data)> sections)
        {
            foreach (var kv in sections)
            {
                if (!SectionVersions.TryGetValue(kv.Key, out var range)) continue;
                ushort v = kv.Value.ver;
                if (v == 0) throw new SaveException($"секция {kv.Key}: некорректная версия схемы 0");
                if (v > range.max) throw new SaveException($"секция {kv.Key}: версия схемы {v} новее поддерживаемой ({range.max}) — файл записан более новой версией программы");
                if (v < range.min) throw new SaveException($"секция {kv.Key}: версия схемы {v} больше не поддерживается (минимум {range.min})");
            }
        }

        /// <summary>Миграции схемы: из версии k в k+1 (по секциям). В формате v1 их нет; новая версия добавляет шаг сюда.</summary>
        static readonly Dictionary<int, Func<Dictionary<string, (ushort ver, byte[] data)>, Dictionary<string, (ushort ver, byte[] data)>>> Migrations = new();

        static Dictionary<string, (ushort ver, byte[] data)> ReadSections(string file, SaveInfo info)
        {
            byte[] all = File.ReadAllBytes(file);
            info.Bytes = all.Length;
            if (all.Length < 16) throw new SaveException("файл слишком короткий");
            for (int k = 0; k < 4; k++) if (all[k] != Magic[k]) throw new SaveException("не файл сохранения WORLDBOUND");
            uint stored = BitConverter.ToUInt32(all, all.Length - 4);
            if (Crc32.Compute(new ReadOnlySpan<byte>(all, 0, all.Length - 4)) != stored) throw new SaveException("контрольная сумма файла не сходится (файл повреждён или записан не полностью)");
            var body = new MemoryStream(all, 0, all.Length - 4);
            var r = new BinaryReader(body);
            r.ReadBytes(4);
            int version = (int)r.ReadUInt32();
            info.FormatVersion = version;
            if (version < 1) throw new SaveException($"некорректная версия формата {version}");
            if (version > FormatVersion) throw new SaveException($"сохранение из более новой версии (формат {version}, поддерживается до {FormatVersion})");
            uint count = r.ReadUInt32();
            if (count > MaxSections) throw new SaveException($"некорректное число секций {count}");
            var sections = new Dictionary<string, (ushort, byte[])>();
            const int header = 4 + 2 + 2 + 8 + 4;
            for (int s = 0; s < count; s++)
            {
                if (body.Length - body.Position < header) throw new SaveException($"заголовок секции {s + 1} обрезан");
                byte[] idBytes = r.ReadBytes(4);
                foreach (byte c in idBytes)
                    if (!((c >= (byte)'A' && c <= (byte)'Z') || (c >= (byte)'0' && c <= (byte)'9'))) throw new SaveException($"некорректный идентификатор секции {s + 1}");
                string id = Encoding.ASCII.GetString(idBytes);
                ushort ver = r.ReadUInt16();
                ushort flags = r.ReadUInt16();
                ulong len = r.ReadUInt64();
                uint crc = r.ReadUInt32();
                if ((flags & ~1) != 0) throw new SaveException($"секция {id}: неизвестные флаги 0x{flags:x4}");
                if (len > (ulong)(body.Length - body.Position)) throw new SaveException($"секция {id}: длина {len} больше остатка файла");
                if (sections.ContainsKey(id)) throw new SaveException($"секция {id} встречается дважды");
                byte[] data = r.ReadBytes((int)len);
                if (Crc32.Compute(data) != crc) throw new SaveException($"контрольная сумма секции {id} не сходится");
                if ((flags & 1) != 0) data = Inflate(data, id);
                sections[id] = (ver, data);
                info.Sections.Add(id);
            }
            if (body.Position != body.Length) throw new SaveException($"после секций {body.Length - body.Position} лишних байт");
            for (int v = version; v < FormatVersion; v++)
            {
                if (!Migrations.TryGetValue(v, out var step)) throw new SaveException($"нет миграции формата {v} → {v + 1}");
                sections = step(sections);
            }
            return sections;
        }

        /// <summary>
        /// Загружает мир: основной файл, при ошибке — резервные копии по порядку. Статика берётся из файла и
        /// сверяется с сохранённым geoHash; после восстановления хеш среды сверяется с сохранённым.
        /// </summary>
        public static Simulation Load(string path, out SaveInfo info)
        {
            var errors = new List<string>();
            var candidates = new List<string> { path };
            for (int k = 1; k <= Backups; k++) candidates.Add($"{path}.bak{k}");
            foreach (var file in candidates)
            {
                if (!File.Exists(file)) continue;
                var inf = new SaveInfo { Path = path, UsedFile = file };
                try
                {
                    var sim = Restore(ReadSections(file, inf), inf);
                    inf.Warnings.AddRange(errors);
                    info = inf;
                    return sim;
                }
                catch (Exception ex) when (!(ex is OutOfMemoryException))
                {
                    // Любая ошибка разбора — контролируемый отказ этого файла; дальше пробуется резервная копия.
                    string why = ex is SaveException ? ex.Message : $"{ex.GetType().Name}: {ex.Message}";
                    errors.Add($"{System.IO.Path.GetFileName(file)}: {why}");
                }
            }
            throw new SaveException(errors.Count == 0 ? "файл сохранения не найден" : "ни один файл не открылся: " + string.Join("; ", errors));
        }

        static Simulation Restore(Dictionary<string, (ushort ver, byte[] data)> s, SaveInfo info)
        {
            CheckSectionVersions(s);
            foreach (var need in new[] { "CONF", "GEOG", "TIME", "WTHR", "WATR", "FLIN", "HASH" })
                if (!s.ContainsKey(need)) throw new SaveException($"нет секции {need}");
            var cr = new Reader(s["CONF"].data, "CONF");
            var config = new WorldConfig
            {
                Name = cr.Str(),
                Seed = (uint)cr.L(),
                Size = cr.Str() switch { "S" => WorldSize.S, "M" => WorldSize.M, var x => throw new SaveException($"секция CONF: неизвестный размер мира «{x}»") },
            };
            string climate = cr.Str();
            config.Climate = climate == "cold" ? Climate.Cold : climate == "warm" ? Climate.Warm : Climate.Temperate;
            config.DaysPerSeason = cr.I();
            if (config.DaysPerSeason < 1 || config.DaysPerSeason > 1000) throw new SaveException($"секция CONF: некорректная длина сезона {config.DaysPerSeason}");
            config.Scenario = cr.Str() switch { "Wild" => Scenario.Wild, "Genesis" => Scenario.Genesis, var x => throw new SaveException($"секция CONF: неизвестный сценарий «{x}»") };
            config.Isolated = cr.B() == 1;
            cr.End();
            var hr = new Reader(s["HASH"].data, "HASH");
            int worldgenVersion = hr.I();
            info.GeoHash = hr.Str();
            info.EnvHash = hr.Str();
            hr.End();
            var geo = ReadGeo(new Reader(s["GEOG"].data, "GEOG"));
            string geoHash = Generate.HashGeo(geo);
            if (geoHash != info.GeoHash) throw new SaveException($"статика мира не совпадает с сохранённым хешем ({geoHash} ≠ {info.GeoHash})");
            if (worldgenVersion != Generate.WorldgenVersion) info.Warnings.Add($"мир создан генератором версии {worldgenVersion} (текущая {Generate.WorldgenVersion}); статика взята из файла");
            // Как в TS: при загрузке начальное заселение пропускается (populate: false) — состояние придёт из секций.
            var sim = new Simulation(config, new Generate.Result { Geo = geo, Hash = geoHash }, null, new SimulationOptions { Populate = false });
            var w = sim.World;
            var tr = new Reader(s["TIME"].data, "TIME");
            w.Tick = tr.L();
            w.Speed = tr.I();
            tr.End();
            if (w.Tick < 0 || w.Speed < 0) throw new SaveException("секция TIME: некорректные такт или скорость");
            info.Tick = w.Tick;
            var wr = new Reader(s["WTHR"].data, "WTHR");
            if (wr.I() != w.Env.Weather.Chunks) throw new SaveException("сетка погоды не совпадает");
            wr.Into(w.Env.Weather.Cells);
            wr.Into(w.Env.Weather.ChunkRate);
            wr.Into(w.Env.Weather.ChunkCloud);
            wr.Into(w.Env.Weather.ChunkAccum);
            wr.Into(w.Env.Weather.Balance);
            wr.End();
            var ar = new Reader(s["WATR"].data, "WATR");
            ar.Into(w.Env.Moisture);
            ar.Into(w.Env.Snow);
            ar.Into(w.Env.Greenness);
            ar.Into(w.Env.Discharge);
            ar.Into(w.Env.Runoff);
            ar.Into(w.Env.WaterTotals);
            w.Env.LastHourStep = ar.I();
            ar.End();
            var fr = new Reader(s["FLIN"].data, "FLIN");
            fr.Into(w.Flora.AccT);
            fr.Into(w.Flora.AccW);
            fr.Into(w.Flora.AccRunoff);
            fr.Into(w.Flora.AccMinT);
            fr.Into(w.Flora.AccHours);
            fr.Into(w.Flora.Capillary);
            fr.End();
            string envHash = sim.EnvHash();
            if (envHash != info.EnvHash) throw new SaveException($"состояние после загрузки не совпадает с сохранённым ({envHash} ≠ {info.EnvHash})");
            return sim;
        }

        static Geo ReadGeo(Reader r)
        {
            var g = new Geo { N = r.I(), CellSize = r.I(), Edges = r.Arr<byte>() };
            if (g.N < 4 || g.N > 4096 || g.CellSize < 1 || g.CellSize > 1024) throw new SaveException($"секция GEOG: некорректная сетка {g.N} × {g.CellSize} м");
            g.Height = r.Arr<float>(); g.Slope = r.Arr<float>(); g.WaterLevel = r.Arr<float>(); g.WaterDist = r.Arr<float>(); g.SeaDist = r.Arr<float>();
            g.MeanDischarge = r.Arr<float>(); g.TMean = r.Arr<float>(); g.TAmp = r.Arr<float>(); g.Precip = r.Arr<float>(); g.Fertility = r.Arr<float>();
            g.WaterKind = r.Arr<byte>(); g.Soil = r.Arr<byte>(); g.Deposit = r.Arr<byte>(); g.DepositRichness = r.Arr<byte>();
            g.Receiver = r.Arr<int>(); g.UpstreamOrder = r.Arr<int>(); g.LakeId = r.Arr<short>(); g.ProvinceOf = r.Arr<ushort>();
            g.WindX = r.D();
            g.WindZ = r.D();
            int lakes = r.I();
            if (lakes < 0 || lakes > g.N * g.N) throw new SaveException("секция GEOG: некорректное число озёр");
            g.Lakes = new Lake[lakes];
            for (int k = 0; k < g.Lakes.Length; k++) g.Lakes[k] = new Lake { Id = r.I(), Level = r.D(), Cells = r.I(), Outlet = r.I() };
            int provinces = r.I();
            if (provinces < 0 || provinces > 65535) throw new SaveException("секция GEOG: некорректное число провинций");
            g.Provinces = new Province[provinces];
            for (int k = 0; k < g.Provinces.Length; k++)
                g.Provinces[k] = new Province { Id = r.I(), Name = r.Str(), Kind = r.Str(), X = r.D(), Z = r.D(), Cells = r.I(), MeanHeight = r.D(), MeanTemp = r.D(), MeanPrecip = r.D() };
            Heights H()
            {
                var h = new Heights { Samples = r.I(), Spacing = r.D(), OriginX = r.D(), OriginZ = r.D(), Data = r.Arr<float>() };
                if (h.Samples < 2 || (long)h.Samples * h.Samples != h.Data.Length || !(h.Spacing > 0)) throw new SaveException("секция GEOG: некорректная сетка высот");
                return h;
            }
            g.Terrain = H();
            g.Horizon = H();
            r.End();
            // Согласованность размеров: дальше ядро индексирует массивы по n·n без проверок.
            int count = g.N * g.N;
            if (g.Edges.Length != 4) throw new SaveException("секция GEOG: краёв должно быть 4");
            foreach (var len in new[] { g.Height.Length, g.Slope.Length, g.WaterLevel.Length, g.WaterDist.Length, g.SeaDist.Length, g.MeanDischarge.Length, g.TMean.Length, g.TAmp.Length,
                         g.Precip.Length, g.Fertility.Length, g.WaterKind.Length, g.Soil.Length, g.Deposit.Length, g.DepositRichness.Length, g.Receiver.Length, g.UpstreamOrder.Length, g.LakeId.Length, g.ProvinceOf.Length })
                if (len != count) throw new SaveException("секция GEOG: размеры массивов не совпадают с сеткой");
            return g;
        }
    }
}
