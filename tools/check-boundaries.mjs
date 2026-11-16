// Проверка критерия фазы 0: «запрещённый импорт ломает сборку».
// Создаёт временные файлы-нарушители и убеждается, что линтер и/или компилятор их отвергают.

import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const cases = [
  {
    name: 'sim → three',
    file: 'src/sim/__violation_three.ts',
    code: "import { Vector3 } from 'three';\nexport const v = new Vector3();\n",
    checks: ['lint'],
  },
  {
    name: 'sim → DOM (document)',
    file: 'src/sim/__violation_dom.ts',
    code: 'export const title = document.title;\n',
    checks: ['lint', 'tsc'],
  },
  {
    name: 'sim → Math.random',
    file: 'src/sim/__violation_random.ts',
    code: 'export const r = Math.random();\n',
    checks: ['lint'],
  },
  {
    name: 'sim → render',
    file: 'src/sim/__violation_render.ts',
    code: "import type { RenderStats } from '../render/WorldView';\nexport type R = RenderStats;\n",
    checks: ['lint'],
  },
  {
    name: 'render → sim',
    file: 'src/render/__violation_sim.ts',
    code: "import { Simulation } from '../sim/core/simulation';\nexport const S = Simulation;\n",
    checks: ['lint'],
  },
  {
    name: 'ui → sim',
    file: 'src/ui/__violation_sim.ts',
    code: "import { Simulation } from '../sim/core/simulation';\nexport const S = Simulation;\n",
    checks: ['lint'],
  },
  {
    name: 'ui → three',
    file: 'src/ui/__violation_three.ts',
    code: "import { Vector3 } from 'three';\nexport const v = new Vector3();\n",
    checks: ['lint'],
  },
  {
    name: 'shared → sim',
    file: 'src/shared/__violation_sim.ts',
    code: "import { Simulation } from '../sim/core/simulation';\nexport const S = Simulation;\n",
    checks: ['lint'],
  },
];

function fails(command) {
  try {
    execSync(command, { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

let ok = true;
for (const c of cases) {
  writeFileSync(c.file, c.code);
  try {
    for (const check of c.checks) {
      const command = check === 'lint' ? `npx eslint "${c.file}"` : 'npx tsc -p tsconfig.sim.json';
      const rejected = fails(command);
      console.log(`${rejected ? '✔' : '✘'} ${c.name} — ${check === 'lint' ? 'линтер' : 'компилятор'} ${rejected ? 'отклонил' : 'ПРОПУСТИЛ'}`);
      if (!rejected) ok = false;
    }
  } finally {
    rmSync(c.file, { force: true });
  }
}

if (!ok) {
  console.error('\nГраницы модулей не защищены.');
  process.exit(1);
}
console.log('\nГраницы модулей защищены.');
