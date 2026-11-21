// Минимальный разбор JSON для golden-файлов (без зависимостей: работает в Unity Mono, в сборке и в CLI .NET).
// Числа хранятся как double (разбор InvariantCulture — побитно то же значение, что напечатал JS).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Worldbound.Sim.Golden
{
    public static class MiniJson
    {
        public static object Parse(string s)
        {
            int i = 0;
            var v = Value(s, ref i);
            return v;
        }

        static void Ws(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            char c = s[i];
            if (c == '{')
            {
                var o = new Dictionary<string, object>();
                i++;
                Ws(s, ref i);
                if (s[i] == '}') { i++; return o; }
                for (;;)
                {
                    Ws(s, ref i);
                    string k = Str(s, ref i);
                    Ws(s, ref i);
                    i++; // :
                    o[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (s[i++] == '}') return o;
                }
            }
            if (c == '[')
            {
                var a = new List<object>();
                i++;
                Ws(s, ref i);
                if (s[i] == ']') { i++; return a; }
                for (;;)
                {
                    a.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (s[i++] == ']') return a;
                }
            }
            if (c == '"') return Str(s, ref i);
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (s.Length - i >= 5 && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (s.Length - i >= 4 && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            int st = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            return double.Parse(s.Substring(st, i - st), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static string Str(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++;
            while (s[i] != '"')
            {
                if (s[i] == '\\')
                {
                    i++;
                    char e = s[i++];
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u': sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                        default: sb.Append(e); break;
                    }
                }
                else sb.Append(s[i++]);
            }
            i++;
            return sb.ToString();
        }

        public static Dictionary<string, object> Obj(object o) => (Dictionary<string, object>)o;
        public static List<object> Arr(object o) => (List<object>)o;
        public static double Num(object o) => (double)o;

        /// <summary>Биты double в виде hex (как bits() в инструментах TS).</summary>
        public static string Bits(double v) => BitConverter.DoubleToInt64Bits(v).ToString("x16");

        /// <summary>double из hex-битов (обратное Bits).</summary>
        public static double FromBits(object hex) => BitConverter.Int64BitsToDouble(Convert.ToInt64((string)hex, 16));

        /// <summary>float из hex-битов float32 (8 цифр, как fbits в инструментах TS).</summary>
        public static float FloatFromBits(object hex) => BitConverter.Int32BitsToSingle(Convert.ToInt32((string)hex, 16));

        /// <summary>Число в формате, который JSON.parse прочтёт в то же значение (R — round-trip).</summary>
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
