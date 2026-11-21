// Проверка сохранения: продолжение после загрузки побитно совпадает с непрерывным прогоном; повреждённый основной
// файл не открывается, вместо него берётся резервная копия; временного файла после записи не остаётся.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Worldbound.Sim.Persistence;

namespace Worldbound.Sim.Golden
{
    public static class SaveCheck
    {
        public static bool Run(string dir, Action<string> log, out string reportJson, WorldSize size = WorldSize.S, int hours = 100, Action<Simulation> configure = null, Action<Simulation> release = null)
        {
            Directory.CreateDirectory(dir);
            string path = Path.Combine(dir, $"check-{size}.wbsave");
            foreach (var f in Directory.GetFiles(dir, $"check-{size}.wbsave*")) File.Delete(f);
            var config = new WorldConfig { Seed = 42, Size = size };
            var sim = new Simulation(config);
            configure?.Invoke(sim);
            for (int h = 0; h < hours; h++) sim.StepHour();
            sim.Enqueue(Command.SetSpeed(4));
            sim.Step();
            string savedHash = sim.EnvHash();
            var sw = Stopwatch.StartNew();
            long bytes = SaveFile.Save(sim, path);
            double saveMs = sw.Elapsed.TotalMilliseconds;
            for (int h = 0; h < hours; h++) sim.StepHour();
            string continuous = sim.EnvHash();
            release?.Invoke(sim);

            sw.Restart();
            var loaded = SaveFile.Load(path, out var info);
            double loadMs = sw.Elapsed.TotalMilliseconds;
            configure?.Invoke(loaded);
            bool loadOk = loaded.EnvHash() == savedHash && info.UsedFile == path;
            for (int h = 0; h < hours; h++) loaded.StepHour();
            string resumed = loaded.EnvHash();
            bool resumeOk = resumed == continuous;

            // Вторая запись: прежний файл уходит в .bak1. Портим основной — загрузка берёт копию.
            SaveFile.Save(loaded, path);
            release?.Invoke(loaded);
            bool tmpGone = !File.Exists(path + ".tmp");
            bool bakMade = File.Exists(path + ".bak1");
            var raw = File.ReadAllBytes(path);
            raw[raw.Length / 2] ^= 0x5a;
            File.WriteAllBytes(path, raw);
            var fallback = SaveFile.Load(path, out var info2);
            bool fallbackOk = info2.UsedFile == path + ".bak1" && fallback.EnvHash() == savedHash && info2.Warnings.Count > 0;

            bool ok = loadOk && resumeOk && tmpGone && bakMade && fallbackOk;
            log($"save {size}: {(ok ? "OK" : "FAIL")} — файл {bytes / 1024} КБ, запись {saveMs:F0} мс, загрузка {loadMs:F0} мс; загрузка = сохранённое {loadOk}; " +
                $"продолжение = непрерывному ({hours} ч) {resumeOk}; .tmp удалён {tmpGone}; резервная копия {bakMade}; повреждённый файл → {Path.GetFileName(info2.UsedFile)} {fallbackOk} ({string.Join("; ", info2.Warnings)})");
            var sb = new StringBuilder();
            sb.Append("{\"size\":").Append(MiniJson.Q(size.ToString())).Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"bytes\":").Append(bytes)
                .Append(",\"saveMs\":").Append(MiniJson.N(Math.Round(saveMs))).Append(",\"loadMs\":").Append(MiniJson.N(Math.Round(loadMs)))
                .Append(",\"loadMatchesSaved\":").Append(loadOk ? "true" : "false").Append(",\"resumeMatchesContinuous\":").Append(resumeOk ? "true" : "false")
                .Append(",\"hoursAfter\":").Append(hours).Append(",\"tmpRemoved\":").Append(tmpGone ? "true" : "false").Append(",\"backupCreated\":").Append(bakMade ? "true" : "false")
                .Append(",\"corruptFallsBackToBackup\":").Append(fallbackOk ? "true" : "false").Append(",\"sections\":[").Append(string.Join(",", info.Sections.ConvertAll(MiniJson.Q))).Append("]}");
            reportJson = sb.ToString();
            return ok;
        }
    }
}
