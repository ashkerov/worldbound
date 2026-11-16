// Прототип 1D в Node: npx tsx tools/phase1d.ts → docs/measurements/phase1d-node.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { runSimBench } from '../prototypes/bench/simBench';

const report = runSimBench(`Node ${process.version}`, () => performance.now(), process.argv.includes('--quick'));
mkdirSync('docs/measurements', { recursive: true });
writeFileSync('docs/measurements/phase1d-node.json', JSON.stringify(report, null, 2));
for (const a of report.agents) console.log(`агенты ${String(a.agents).padStart(6)}: такт ${a.msAvg.toFixed(2)} мс (p95 ${a.msP95.toFixed(2)}, макс ${a.msMax.toFixed(2)})`);
console.log(`поля ${report.fields.cells} ячеек: суточный проход ${report.fields.msPerDailyPass.toFixed(1)} мс`);
for (const u of report.unified) console.log(`единая модель, ${u.chunks} чанков: ${u.rabbitsAvg.toFixed(0)} кроликов + ${u.foxesAvg.toFixed(0)} лис — ${u.msPerGameDay.toFixed(1)} мс на игровые сутки (${(u.individualHoursPerSecond / 1e6).toFixed(2)} млн особь-часов/с)`);
