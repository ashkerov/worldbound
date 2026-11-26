// Запись JSON-отчётов приложения (замеры, проверки рендера) без тестовой сборки: в Release её нет.
using System.Globalization;
using System.Text;

namespace Worldbound.App
{
    public static class Json
    {
        /// <summary>Число, которое JSON.parse прочтёт в то же значение (R — round-trip).</summary>
        public static string N(double v) => double.IsNaN(v) || double.IsInfinity(v) ? "null" : v.ToString("R", CultureInfo.InvariantCulture);

        public static string Q(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch == '\n') sb.Append("\\n");
                else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }
    }
}
