// Негативные тесты WoodyStore.Restore: каждый некорректный случай даёт контролируемый отказ и не меняет хранилище;
// корректное восстановление сохраняет порядок выдачи (LIFO) — как у исходного хранилища до сохранения.
using System;
using System.Collections.Generic;
using System.Text;
using Worldbound.Sim.Flora;

namespace Worldbound.Sim.Golden
{
    public static class WoodyRestoreCheck
    {
        /// <summary>Исходное хранилище: 10 растений, освобождены 2, 7, 4 (стек 2, 7, 4 — следующей выдаётся 4).</summary>
        static WoodyStore Source()
        {
            var w = new WoodyStore(16);
            for (int k = 0; k < 10; k++) w.Spawn(k % 18, k, k, k, 1, 0);
            foreach (int i in new[] { 2, 7, 4 }) w.Remove(i);
            return w;
        }

        /// <summary>Новое хранилище со столбцами Alive источника (как после чтения столбцов из сохранения).</summary>
        static WoodyStore Columns(WoodyStore src, Action<WoodyStore> tamper = null)
        {
            var w = new WoodyStore(src.Capacity);
            Array.Copy(src.Alive, w.Alive, src.Capacity);
            Array.Copy(src.Generation, w.Generation, src.Capacity);
            tamper?.Invoke(w);
            return w;
        }

        public static bool Run(Action<string> log, out string reportJson)
        {
            var src = Source();
            int hw = src.HighWater, cnt = src.Count;
            var free = src.FreeSlots();
            var cases = new List<(string name, Func<WoodyStore> store, int highWater, int count, int[] free)>
            {
                ("high-water-above-capacity", () => Columns(src), 17, cnt, free),
                ("high-water-negative", () => Columns(src), -1, 0, new int[0]),
                ("count-above-high-water", () => Columns(src), hw, hw + 1, free),
                ("count-negative", () => Columns(src), hw, -1, free),
                ("free-stack-too-long", () => Columns(src), hw, cnt, new[] { 2, 7, 4, 9 }),
                ("free-stack-too-short", () => Columns(src), hw, cnt, new[] { 2, 7 }),
                ("free-stack-null", () => Columns(src), hw, cnt, null),
                ("duplicate-free-index", () => Columns(src), hw, cnt, new[] { 2, 7, 7 }),
                ("free-index-at-high-water", () => Columns(src), hw, cnt, new[] { 2, 7, hw }),
                ("free-index-negative", () => Columns(src), hw, cnt, new[] { 2, -1, 4 }),
                ("free-index-is-alive", () => Columns(src), hw, cnt, new[] { 2, 7, 5 }),
                ("alive-count-mismatch", () => Columns(src, w => w.Alive[2] = 1), hw, cnt, free),
            };
            var sb = new StringBuilder("[");
            bool all = true;
            int n = 0;
            void Report(string name, bool ok, string detail)
            {
                all &= ok;
                log($"woody-restore {name}: {(ok ? "OK" : "FAIL")} — {detail}");
                if (n++ > 0) sb.Append(',');
                sb.Append("{\"case\":").Append(MiniJson.Q(name)).Append(",\"ok\":").Append(ok ? "true" : "false").Append(",\"detail\":").Append(MiniJson.Q(detail)).Append('}');
            }
            foreach (var (name, make, h, c, f) in cases)
            {
                var w = make();
                try
                {
                    w.Restore(h, c, f);
                    Report(name, false, "принято без ошибки");
                }
                catch (InvalidOperationException e)
                {
                    // Хранилище не изменено: граница, число и стек остались пустыми.
                    bool untouched = w.HighWater == 0 && w.Count == 0 && w.FreeCount == 0;
                    Report(name, untouched, (untouched ? "отказ, хранилище не изменено: " : "отказ, но хранилище изменено: ") + e.Message);
                }
                catch (Exception e)
                {
                    Report(name, false, $"неконтролируемое {e.GetType().Name}: {e.Message}");
                }
            }
            // Корректное восстановление: те же highWater/count/стек; выдача индексов — как у исходного хранилища (LIFO).
            {
                var w = Columns(src);
                w.Restore(hw, cnt, free);
                var orig = Source();
                var a = new List<int>();
                var b = new List<int>();
                for (int k = 0; k < 6; k++)
                {
                    a.Add(w.Spawn(3, 0, 0, 0, 1, 0));
                    b.Add(orig.Spawn(3, 0, 0, 0, 1, 0));
                }
                string got = string.Join(",", a), want = string.Join(",", b);
                bool ok = got == want && got.StartsWith("4,7,2,10");
                Report("valid-restore-lifo", ok, $"выдача после восстановления {got}, у исходного {want}");
            }
            reportJson = sb.Append(']').ToString();
            return all;
        }
    }
}
