// Названия провинций: корень из слогов + прилагательное, согласованное с родом
// существительного, выбранного по типу местности («Веланская долина», «Ярские холмы»).

import type { Rng } from '../../shared/rng';
import type { ProvinceKind } from './geo';

type Gender = 'f' | 'm' | 'n' | 'pl';

const NOUNS: Record<ProvinceKind, [string, Gender][]> = {
  mountains: [
    ['горы', 'pl'],
    ['хребет', 'm'],
  ],
  highland: [
    ['нагорье', 'n'],
    ['плато', 'n'],
  ],
  hills: [
    ['холмы', 'pl'],
    ['взгорье', 'n'],
  ],
  valley: [
    ['долина', 'f'],
    ['дол', 'm'],
  ],
  coast: [
    ['побережье', 'n'],
    ['берег', 'm'],
  ],
  lakeland: [
    ['озёра', 'pl'],
    ['приозерье', 'n'],
  ],
  plain: [
    ['равнина', 'f'],
    ['поле', 'n'],
    ['луга', 'pl'],
  ],
};

const ENDINGS: Record<Gender, string> = { f: 'ая', m: 'ий', n: 'ое', pl: 'ие' };

const START = ['Вел', 'Яр', 'Бел', 'Ол', 'Мир', 'Свет', 'Дуб', 'Рад', 'Зар', 'Ист', 'Тур', 'Кам', 'Вер', 'Сос', 'Бор', 'Луг', 'Сер', 'Мед', 'Влад', 'Сол', 'Кед', 'Тих', 'Ряб', 'Хол', 'Зор', 'Ив', 'Лис', 'Род', 'Сит', 'Ял'];
const MIDDLE = ['', '', 'о', 'а', 'е', 'и'];
const END = ['ан', 'ен', 'ин', 'он', 'ар', 'ер', 'ов', 'ев', 'ат', 'ет', 'ал', 'ел', 'им', 'уш'];

function root(rng: Rng): string {
  const a = START[rng.int(START.length)]!;
  const m = MIDDLE[rng.int(MIDDLE.length)]!;
  const e = END[rng.int(END.length)]!;
  // Короткие корни («Ярск») звучат лучше без окончания; длинные — с ним.
  if (rng.next() < 0.25 && m === '') return a;
  // Без стечения гласных («Зараан»): срединная гласная опускается перед окончанием на гласную.
  const word = /[аеиоу]$/.test(m) && /^[аеиоу]/.test(e) ? a + e : a + m + e;
  // «л» перед суффиксом смягчается: «Лугельская», а не «Лугелская».
  return word.endsWith('л') ? word + 'ь' : word;
}

export function provinceName(kind: ProvinceKind, rng: Rng, used: Set<string>): string {
  const options = NOUNS[kind];
  for (let attempt = 0; attempt < 40; attempt++) {
    const [noun, gender] = options[rng.int(options.length)]!;
    const name = `${root(rng)}ск${ENDINGS[gender]} ${noun}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `Край ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}
