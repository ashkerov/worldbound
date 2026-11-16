// Просмотр динамики расширенной пищевой сети: npx tsx prototypes/web/explore.ts [seed] [дней] [без вида]
import { DEER, FOX, RABBIT, SEASONS, SPECIES_NAMES, WOLF, WebWorld } from './model';

const seed = Number(process.argv[2] ?? 1);
const days = Number(process.argv[3] ?? 400);
const absent = process.argv[4] ? [Number(process.argv[4])] : [];
const world = new WebWorld(seed, 8, 24, { absent });
const start = Date.now();
for (let day = 0; day <= days; day++) {
  if (day % 20 === 2 || day % 20 === 17) {
    console.log(
      `год ${String(Math.floor(day / 20)).padStart(3)} ${SEASONS[world.season]!.padEnd(5)} кр ${String(world.count(RABBIT)).padStart(5)} ол ${String(world.count(DEER)).padStart(4)} лис ${String(world.count(FOX)).padStart(4)} вол ${String(world.count(WOLF)).padStart(3)}  трава ${world.fieldMean(world.grass).toFixed(2)} куст ${world.fieldMean(world.shrub).toFixed(2)}  олени на ${(world.meanZ(DEER) / (24 * 128)).toFixed(2)}`,
    );
  }
  world.stepDay();
}
console.log(`время ${Date.now() - start} мс`);
for (let s = 0; s < 4; s++) console.log(SPECIES_NAMES[s], 'рождения по сезонам', world.births[s], 'смерти [голод,хищник,старость,случайная]', world.deaths[s]!.map((c) => c.reduce((a, b) => a + b, 0)));
