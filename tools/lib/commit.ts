// Версия кода для протоколов замеров: SHA коммита и признак незакоммиченных изменений.

import { execSync } from 'node:child_process';

export interface CodeVersion {
  commit: string;
  /** true — в рабочей копии были изменения относительно коммита (замер не воспроизводится по одному SHA). */
  dirty: boolean;
  measuredAt: string;
}

/**
 * Версия фиксируется один раз — при загрузке модуля, то есть в начале замера: правки кода во время
 * длительного прогона не должны помечать уже загруженный и выполняющийся код как изменённый.
 */
const AT_START = readVersion();

export function codeVersion(): CodeVersion {
  return { ...AT_START, measuredAt: new Date().toISOString() };
}

function readVersion(): Omit<CodeVersion, 'measuredAt'> {
  let commit = 'unknown';
  let dirty = true;
  try {
    commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    // Только отслеживаемые файлы кода и каталогов: протоколы замеров сами меняются при записи.
    dirty = execSync('git status --porcelain --untracked-files=no -- src content tools tests package.json', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    // Нет git — версия неизвестна.
  }
  return { commit, dirty };
}
