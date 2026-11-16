// Границы модулей WORLDBOUND (см. ARCHITECTURE.md, раздел 4.1).
// Нарушение границы — ошибка линтера; дополнительно ядро симуляции
// компилируется без библиотеки DOM (tsconfig.sim.json).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const forbid = (names, message) => ({
  'no-restricted-imports': [
    'error',
    {
      patterns: names.map((group) => ({ group: [group], message })),
    },
  ],
});

const UI_LIBS = ['react', 'react/*', 'react-dom', 'react-dom/*', 'zustand', 'zustand/*'];
const THREE = ['three', 'three/*'];
const dir = (name) => `**/${name}/**`;

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['src/shared/**'],
    rules: forbid(
      [...THREE, ...UI_LIBS, dir('sim'), dir('render'), dir('ui'), dir('worker'), dir('platform'), dir('app')],
      'shared не зависит ни от одного другого модуля',
    ),
  },
  {
    files: ['src/sim/**'],
    rules: {
      ...forbid(
        [...THREE, ...UI_LIBS, dir('render'), dir('ui'), dir('worker'), dir('platform'), dir('app')],
        'Ядро симуляции не зависит от рендера, UI, воркера и платформы',
      ),
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Ядро симуляции не знает о браузере' },
        { name: 'document', message: 'Ядро симуляции не знает о браузере' },
        { name: 'navigator', message: 'Ядро симуляции не знает о браузере' },
        { name: 'performance', message: 'Ядро детерминировано: время приходит снаружи' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Используйте ГПСЧ из shared/rng' },
        { object: 'Date', property: 'now', message: 'Ядро детерминировано: время приходит снаружи' },
      ],
    },
  },
  {
    files: ['src/worker/sim.worker.ts'],
    rules: forbid([...THREE, ...UI_LIBS, dir('render'), dir('ui'), dir('app')], 'Воркер симуляции не зависит от рендера и UI'),
  },
  {
    files: ['src/worker/client.ts'],
    rules: forbid([...THREE, ...UI_LIBS, dir('sim'), dir('render'), dir('ui'), dir('app')], 'Клиент воркера общается только по протоколу'),
  },
  {
    files: ['src/render/**'],
    rules: forbid([...UI_LIBS, dir('sim'), dir('ui'), dir('worker'), dir('platform'), dir('app')], 'Рендер читает только снимки из shared'),
  },
  {
    files: ['src/ui/**'],
    rules: forbid([...THREE, dir('sim'), dir('render'), dir('worker'), dir('platform'), dir('app')], 'UI получает только view-модели'),
  },
  {
    files: ['src/platform/**'],
    rules: forbid([...THREE, ...UI_LIBS, dir('sim'), dir('render'), dir('ui'), dir('worker'), dir('app')], 'platform не содержит игровой логики'),
  },
);
