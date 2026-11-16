// Проверка всех каталогов контента по схемам (часть npm run verify).
// Каталог проверяется при импорте модуля: ошибка схемы — исключение с файлом, записью и полем.

import { SOILS } from '../src/sim/env/soils';
import { PLANTS } from '../src/sim/flora/species';
import { BIOMES } from '../src/sim/flora/biomes';

const forms = PLANTS.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.form]: (acc[p.form] ?? 0) + 1 }), {});
console.log(`Каталоги в порядке: почв — ${SOILS.length}, видов растений — ${PLANTS.length} (${Object.entries(forms).map(([k, v]) => `${k} ${v}`).join(', ')}), биомов — ${BIOMES.length}.`);
