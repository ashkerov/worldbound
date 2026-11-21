// Названия провинций (src/sim/worldgen/names.ts): корень из слогов + прилагательное по роду существительного.
using System.Collections.Generic;

namespace Worldbound.Sim.WorldGen
{
    public static class Names
    {
        static readonly Dictionary<string, (string noun, char gender)[]> Nouns = new()
        {
            ["mountains"] = new[] { ("горы", 'p'), ("хребет", 'm') },
            ["highland"] = new[] { ("нагорье", 'n'), ("плато", 'n') },
            ["hills"] = new[] { ("холмы", 'p'), ("взгорье", 'n') },
            ["valley"] = new[] { ("долина", 'f'), ("дол", 'm') },
            ["coast"] = new[] { ("побережье", 'n'), ("берег", 'm') },
            ["lakeland"] = new[] { ("озёра", 'p'), ("приозерье", 'n') },
            ["plain"] = new[] { ("равнина", 'f'), ("поле", 'n'), ("луга", 'p') },
        };

        static string Ending(char g) => g switch { 'f' => "ая", 'm' => "ий", 'n' => "ое", _ => "ие" };

        static readonly string[] Start = { "Вел", "Яр", "Бел", "Ол", "Мир", "Свет", "Дуб", "Рад", "Зар", "Ист", "Тур", "Кам", "Вер", "Сос", "Бор", "Луг", "Сер", "Мед", "Влад", "Сол", "Кед", "Тих", "Ряб", "Хол", "Зор", "Ив", "Лис", "Род", "Сит", "Ял" };
        static readonly string[] Middle = { "", "", "о", "а", "е", "и" };
        static readonly string[] End = { "ан", "ен", "ин", "он", "ар", "ер", "ов", "ев", "ат", "ет", "ал", "ел", "им", "уш" };

        static bool Vowel(char c) => c == 'а' || c == 'е' || c == 'и' || c == 'о' || c == 'у';

        static string Root(Rng rng)
        {
            string a = Start[rng.Int(Start.Length)];
            string m = Middle[rng.Int(Middle.Length)];
            string e = End[rng.Int(End.Length)];
            if (rng.Next() < 0.25 && m == "") return a;
            string word = m.Length > 0 && Vowel(m[m.Length - 1]) && Vowel(e[0]) ? a + e : a + m + e;
            return word[word.Length - 1] == 'л' ? word + "ь" : word;
        }

        public static string Province(string kind, Rng rng, HashSet<string> used)
        {
            var options = Nouns[kind];
            for (int attempt = 0; attempt < 40; attempt++)
            {
                var (noun, gender) = options[rng.Int(options.Length)];
                string name = Root(rng) + "ск" + Ending(gender) + " " + noun;
                if (used.Add(name)) return name;
            }
            string fallback = "Край " + (used.Count + 1);
            used.Add(fallback);
            return fallback;
        }
    }
}
