// Выбор уровня детализации древесного растения (чистая функция, общая для подсчёта и записи в заданиях Burst).
//
// Эффективное расстояние de = d / (k · bias), где k = clamp((высота / эталон)^0,35, 0,4, 1,35): крупное дерево
// упрощается позже, подрост — раньше. Уровни: 0, 1, 2 — модели; 3 — импостор (если у слоя есть импосторы).
// Плавность: в полосе шириной Band·T вокруг каждой границы растение рисуется обоими уровнями с попиксельным
// растворением (взаимодополняющий узор): ближний исчезает, дальний проявляется — без скачка размера и цвета.
// За Thin дальние растения прореживаются по рангу (seed), оставшиеся растут на 1/√доли — покрытие кронами
// сохраняется; на последних Band·Max — растворение до нуля.
// Кодирование растворения f: 0 — видно целиком; f > 0 — убрана доля f пикселей; f < 0 — оставлена доля |f|.

using Unity.Mathematics;

namespace Worldbound.FloraView
{
    public struct LodParams
    {
        public float T0, T1, T2, Thin, Max, Band, Bias, SizeRef;
        /// <summary>Число уровней: 3 (модели) или 4 (модели + импостор).</summary>
        public int Levels;
        public bool CrossFade;
    }

    public static class FloraLOD
    {
        public const float TreeSizeRef = 14, ShrubSizeRef = 3;
        public static float SizeFactor(float height, float sizeRef) => math.clamp(math.pow(math.max(0.05f, height) / sizeRef, 0.35f), 0.4f, 1.35f);

        static float T(in LodParams p, int i) => i == 0 ? p.T0 : i == 1 ? p.T1 : p.T2;

        /// <summary>Возвращает число записей (0–2): уровни l0/l1 с растворением f0/f1 и множитель роста при прореживании.</summary>
        public static int Select(in LodParams p, float de, float seed, out int l0, out float f0, out int l1, out float f1, out float grow)
        {
            l0 = -1; l1 = -1; f0 = 0; f1 = 0; grow = 1;
            if (de >= p.Max) return 0;
            float q = p.CrossFade ? math.saturate((de - p.Max * (1 - p.Band)) / (p.Max * p.Band)) : 0;
            if (de > p.Thin)
            {
                float keep = (p.Thin / de) * (p.Thin / de);
                if (seed > keep) return 0;
                if (p.CrossFade) q = math.max(q, math.saturate((seed - keep * 0.8f) / (keep * 0.2f)));
                grow = math.min(1.8f, math.rsqrt(keep));
            }
            int bounds = p.Levels - 1;
            int level = 0;
            for (int i = 0; i < bounds; i++) if (de >= T(p, i)) level = i + 1;
            if (p.CrossFade)
            {
                for (int i = 0; i < bounds; i++)
                {
                    float t = T(p, i), w = p.Band * t * 0.5f;
                    if (de > t - w && de < t + w)
                    {
                        float k = (de - (t - w)) / (2 * w);
                        l0 = i; f0 = math.max(k, q);
                        float keepFar = k * (1 - q);
                        if (keepFar > 0.002f) { l1 = i + 1; f1 = -keepFar; return 2; }
                        return f0 < 0.998f ? 1 : 0;
                    }
                }
            }
            l0 = level; f0 = q;
            return q < 0.998f ? 1 : 0;
        }
    }
}
