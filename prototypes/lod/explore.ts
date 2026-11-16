// Быстрый просмотр динамики одного режима: npx tsx prototypes/lod/explore.ts [s0|meanfield|cohort] [seed] [days]
import { calibrate } from './calibrate';
import { FOX, LodWorld, RABBIT, type FarMode } from './model';

const regime = process.argv[2] ?? 's0';
const seed = Number(process.argv[3] ?? 1);
const days = Number(process.argv[4] ?? 300);
const size = 10;

const fp = regime === 's0' ? null : calibrate({ seeds: [101, 102, 103], nx: size, ny: size, days: 300, warmup: 60 });
const world = new LodWorld(seed, size, size, regime === 's0' ? 'meanfield' : (regime as FarMode), fp);
if (regime !== 's0') world.setFocus(() => false);
const start = Date.now();
for (let day = 0; day <= days; day++) {
  if (day % 20 === 0) {
    console.log(`день ${String(day).padStart(4)}  кролики ${String(world.count(RABBIT)).padStart(5)}  лисы ${String(world.count(FOX)).padStart(4)}  трава ${world.grassMean().toFixed(2)}`);
  }
  world.stepDay();
}
console.log(`время: ${Date.now() - start} мс; рождения ${world.births}; смерти кроликов ${world.deaths[0]}; смерти лис ${world.deaths[1]}`);
