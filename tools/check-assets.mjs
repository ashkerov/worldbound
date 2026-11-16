// Проверка манифеста ассетов: у каждого стороннего ассета должны быть автор,
// первоисточник, разрешённая лицензия и описание изменений; файл обязан существовать.
// Разрешены только CC0-1.0 и CC-BY-4.0 (решение заказчика от 2026-11-15) и собственные работы.

import { existsSync, readFileSync } from 'node:fs';

const ALLOWED = new Set(['CC0-1.0', 'CC-BY-4.0', 'own']);
const manifestPath = 'assets/manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];

if (!Array.isArray(manifest.assets)) errors.push('manifest.assets должен быть массивом');

for (const [i, asset] of (manifest.assets ?? []).entries()) {
  const where = `assets[${i}] (${asset.id ?? 'без id'})`;
  for (const field of ['id', 'title', 'license', 'files']) {
    if (asset[field] === undefined || asset[field] === '') errors.push(`${where}: нет поля «${field}»`);
  }
  if (!ALLOWED.has(asset.license)) {
    errors.push(`${where}: лицензия «${asset.license}» не разрешена (допустимы: ${[...ALLOWED].join(', ')})`);
  }
  if (asset.license !== 'own') {
    for (const field of ['author', 'source', 'licenseUrl', 'changes']) {
      if (!asset[field]) errors.push(`${where}: для стороннего ассета обязательно поле «${field}»`);
    }
  }
  for (const file of asset.files ?? []) {
    if (!existsSync(file)) errors.push(`${where}: файл не найден — ${file}`);
  }
}

if (errors.length > 0) {
  console.error('Манифест ассетов не прошёл проверку:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log(`Манифест ассетов в порядке: записей — ${manifest.assets.length}.`);
