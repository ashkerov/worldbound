// Устойчивость чтения WBSV к некорректным файлам. Из настоящего сохранения собираются испорченные варианты
// (с пересчитанными CRC, чтобы ошибка дошла до разбора секций): неверные длины секций и массивов, дубли
// идентификаторов, неизвестные флаги, обрезка, мусор, неизвестная версия, битые сжатые данные. Каждый вариант
// должен дать SaveException (контролируемый отказ), а не другое исключение; неизвестная секция — загружаться.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using Worldbound.Sim.Persistence;

namespace Worldbound.Sim.Golden
{
    public static class SaveRobustness
    {
        sealed class Sec
        {
            public string Id;
            public ushort Ver, Flags;
            public ulong Len;
            public uint Crc;
            public byte[] Data;
            public bool KeepLen, KeepCrc;
        }

        static (uint version, List<Sec> secs) Parse(byte[] all)
        {
            var r = new BinaryReader(new MemoryStream(all, 0, all.Length - 4));
            r.ReadBytes(4);
            uint version = r.ReadUInt32();
            uint count = r.ReadUInt32();
            var list = new List<Sec>();
            for (int i = 0; i < count; i++)
            {
                var s = new Sec { Id = Encoding.ASCII.GetString(r.ReadBytes(4)), Ver = r.ReadUInt16(), Flags = r.ReadUInt16(), Len = r.ReadUInt64(), Crc = r.ReadUInt32() };
                s.Data = r.ReadBytes((int)s.Len);
                list.Add(s);
            }
            return (version, list);
        }

        /// <summary>Собирает файл: CRC секций и файла пересчитываются, если не просили оставить как есть.</summary>
        static byte[] Build(uint version, List<Sec> secs, uint? countOverride = null)
        {
            var ms = new MemoryStream();
            var w = new BinaryWriter(ms);
            w.Write(Encoding.ASCII.GetBytes("WBSV"));
            w.Write(version);
            w.Write(countOverride ?? (uint)secs.Count);
            foreach (var s in secs)
            {
                w.Write(Encoding.ASCII.GetBytes(s.Id));
                w.Write(s.Ver);
                w.Write(s.Flags);
                w.Write(s.KeepLen ? s.Len : (ulong)s.Data.Length);
                w.Write(s.KeepCrc ? s.Crc : Crc32.Compute(s.Data));
                w.Write(s.Data);
            }
            w.Flush();
            w.Write(Crc32.Compute(new ReadOnlySpan<byte>(ms.GetBuffer(), 0, (int)ms.Length)));
            w.Flush();
            return ms.ToArray();
        }

        static byte[] Inflate(byte[] d)
        {
            var o = new MemoryStream();
            using (var z = new DeflateStream(new MemoryStream(d), CompressionMode.Decompress)) z.CopyTo(o);
            return o.ToArray();
        }

        static byte[] Deflate(byte[] d)
        {
            var o = new MemoryStream();
            using (var z = new DeflateStream(o, CompressionLevel.Fastest, true)) z.Write(d, 0, d.Length);
            return o.ToArray();
        }

        static List<Sec> Clone(List<Sec> src)
        {
            var l = new List<Sec>();
            foreach (var s in src) l.Add(new Sec { Id = s.Id, Ver = s.Ver, Flags = s.Flags, Len = s.Len, Crc = s.Crc, Data = (byte[])s.Data.Clone() });
            return l;
        }

        public static bool Run(string dir, Action<string> log, out string reportJson)
        {
            Directory.CreateDirectory(dir);
            string good = Path.Combine(dir, "robust-base.wbsave");
            foreach (var f in Directory.GetFiles(dir, "robust-*")) File.Delete(f);
            var sim = new Simulation(new WorldConfig { Seed = 42, Size = WorldSize.S, Scenario = Scenario.Genesis, Isolated = true });
            for (int h = 0; h < 5; h++) sim.StepHour();
            SaveFile.Save(sim, good);
            byte[] baseBytes = File.ReadAllBytes(good);
            var (ver, secs) = Parse(baseBytes);

            var cases = new List<(string name, Func<byte[]> make, bool shouldLoad)>
            {
                ("section-length-too-big", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "TIME"); t.Len = (ulong)t.Data.Length + 1000; t.KeepLen = true; return Build(ver, l); }, false),
                ("section-length-huge", () => { var l = Clone(secs); l[0].Len = ulong.MaxValue; l[0].KeepLen = true; return Build(ver, l); }, false),
                ("section-length-too-small", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "TIME"); t.Len = 3; t.KeepLen = true; return Build(ver, l); }, false),
                ("duplicate-id", () => { var l = Clone(secs); l.Add(Clone(secs).Find(x => x.Id == "TIME")); return Build(ver, l); }, false),
                ("unknown-flags", () => { var l = Clone(secs); l.Find(x => x.Id == "TIME").Flags = 0x0002; return Build(ver, l); }, false),
                ("bad-section-id", () => { var l = Clone(secs); l[2].Id = "t!m\u0001"; return Build(ver, l); }, false),
                ("section-crc-mismatch", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "TIME"); t.Crc = Crc32.Compute(t.Data) ^ 1; t.KeepCrc = true; return Build(ver, l); }, false),
                ("section-count-huge", () => Build(ver, Clone(secs), 0xFFFFFFFF), false),
                ("section-count-too-big", () => Build(ver, Clone(secs), (uint)secs.Count + 1), false),
                ("newer-format-version", () => Build(ver + 1, Clone(secs)), false),
                ("format-version-zero", () => Build(0, Clone(secs)), false),
                ("missing-section", () => { var l = Clone(secs); l.RemoveAll(x => x.Id == "WATR"); return Build(ver, l); }, false),
                ("corrupt-deflate", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "WATR"); for (int i = 0; i < t.Data.Length; i += 7) t.Data[i] ^= 0xA5; return Build(ver, l); }, false),
                ("negative-array-length", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "WATR"); var raw = Inflate(t.Data); BitConverter.GetBytes(-5).CopyTo(raw, 0); t.Data = Deflate(raw); return Build(ver, l); }, false),
                ("huge-array-length", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "WATR"); var raw = Inflate(t.Data); BitConverter.GetBytes(int.MaxValue).CopyTo(raw, 0); t.Data = Deflate(raw); return Build(ver, l); }, false),
                ("trailing-bytes-in-section", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "TIME"); var d = new byte[t.Data.Length + 9]; t.Data.CopyTo(d, 0); t.Data = d; return Build(ver, l); }, false),
                ("garbage-config", () => { var l = Clone(secs); var t = l.Find(x => x.Id == "CONF"); for (int i = 0; i < t.Data.Length; i++) t.Data[i] = 0xFF; return Build(ver, l); }, false),
                ("truncated-file", () => { var b = (byte[])baseBytes.Clone(); Array.Resize(ref b, b.Length / 2); return b; }, false),
                ("empty-file", () => new byte[0], false),
                ("random-garbage", () => { var b = new byte[4096]; new Random(7).NextBytes(b); return b; }, false),
                ("flipped-byte", () => { var b = (byte[])baseBytes.Clone(); b[b.Length / 3] ^= 0x10; return b; }, false),
                ("unknown-extra-section", () => { var l = Clone(secs); l.Add(new Sec { Id = "ZZZZ", Ver = 1, Flags = 0, Data = Encoding.ASCII.GetBytes("future data") }); return Build(ver, l); }, true),
                // Версии схем известных секций: 0 — некорректна, будущая — отказ; неизвестная секция — любая версия.
                ("section-version-zero", () => { var l = Clone(secs); l.Find(x => x.Id == "TIME").Ver = 0; return Build(ver, l); }, false),
                ("section-version-future", () => { var l = Clone(secs); l.Find(x => x.Id == "WATR").Ver = 2; return Build(ver, l); }, false),
                ("section-version-max", () => { var l = Clone(secs); l.Find(x => x.Id == "GEOG").Ver = ushort.MaxValue; return Build(ver, l); }, false),
                ("unknown-section-any-version", () => { var l = Clone(secs); l.Add(new Sec { Id = "FLOR", Ver = 0, Flags = 1, Data = Deflate(Encoding.ASCII.GetBytes("reserved")) }); l.Add(new Sec { Id = "Z9Z9", Ver = 65535, Flags = 0, Data = new byte[0] }); return Build(ver, l); }, true),
            };

            var sb = new StringBuilder("[");
            bool all = true;
            int idx = 0;
            foreach (var (name, make, shouldLoad) in cases)
            {
                string path = Path.Combine(dir, $"robust-{name}.wbsave");
                File.WriteAllBytes(path, make());
                string outcome;
                bool ok;
                try
                {
                    var loaded = SaveFile.Load(path, out var info);
                    outcome = "загружен";
                    ok = shouldLoad && loaded.EnvHash() == sim.EnvHash();
                }
                catch (SaveException ex)
                {
                    outcome = "SaveException: " + ex.Message;
                    ok = !shouldLoad;
                }
                catch (Exception ex)
                {
                    outcome = $"НЕКОНТРОЛИРУЕМОЕ {ex.GetType().Name}: {ex.Message}";
                    ok = false;
                }
                all &= ok;
                log($"save-robust {name}: {(ok ? "OK" : "FAIL")} — {outcome}");
                if (idx++ > 0) sb.Append(',');
                sb.Append("{\"case\":").Append(MiniJson.Q(name)).Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"outcome\":").Append(MiniJson.Q(outcome)).Append('}');
            }
            // Несовместимая версия секции в основном файле → загрузка берёт резервную копию.
            {
                string path = Path.Combine(dir, "robust-version-fallback.wbsave");
                File.Copy(good, path + ".bak1", true);
                var l = Clone(secs);
                l.Find(x => x.Id == "WTHR").Ver = 7;
                File.WriteAllBytes(path, Build(ver, l));
                bool ok;
                string outcome;
                try
                {
                    var loaded = SaveFile.Load(path, out var info);
                    ok = info.UsedFile.EndsWith(".bak1") && loaded.EnvHash() == sim.EnvHash() && info.Warnings.Count == 1 && info.Warnings[0].Contains("версия схемы 7");
                    outcome = $"взят {Path.GetFileName(info.UsedFile)}; предупреждение: {string.Join("; ", info.Warnings)}";
                }
                catch (Exception ex) { ok = false; outcome = ex.GetType().Name + ": " + ex.Message; }
                all &= ok;
                log($"save-robust version-fallback-to-backup: {(ok ? "OK" : "FAIL")} — {outcome}");
                sb.Append(",{\"case\":\"version-fallback-to-backup\",\"ok\":").Append(ok ? "true" : "false").Append(",\"outcome\":").Append(MiniJson.Q(outcome)).Append('}');
            }
            // Резерв поверх испорченного основного: основной — мусор, .bak1 — нормальный файл.
            {
                string path = Path.Combine(dir, "robust-fallback.wbsave");
                File.Copy(good, path + ".bak1", true);
                File.WriteAllBytes(path, Encoding.ASCII.GetBytes("WBSV not really a save"));
                bool ok;
                string outcome;
                try
                {
                    var loaded = SaveFile.Load(path, out var info);
                    ok = info.UsedFile.EndsWith(".bak1") && loaded.EnvHash() == sim.EnvHash() && info.Warnings.Count == 1;
                    outcome = $"взят {Path.GetFileName(info.UsedFile)}; предупреждение: {string.Join("; ", info.Warnings)}";
                }
                catch (Exception ex) { ok = false; outcome = ex.GetType().Name + ": " + ex.Message; }
                all &= ok;
                log($"save-robust fallback-to-backup: {(ok ? "OK" : "FAIL")} — {outcome}");
                sb.Append(",{\"case\":\"fallback-to-backup\",\"ok\":").Append(ok ? "true" : "false").Append(",\"outcome\":").Append(MiniJson.Q(outcome)).Append('}');
            }
            reportJson = sb.Append(']').ToString();
            return all;
        }
    }
}
