// Прототип 1A: проверка управления камерой настоящими событиями мыши и клавиатуры.
import { expect, test } from '@playwright/test';
import type {} from '../../prototypes/diorama/diorama';

test('управление камерой: масштаб, сдвиг, вращение, режимы, слежение', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/prototypes/diorama/index.html?renderer=webgl2&quality=low');
  await page.waitForFunction(() => window.__diorama?.ready === true, undefined, { timeout: 240_000 });
  const view = () => page.evaluate(() => window.__diorama!.view());
  const settle = () => page.waitForTimeout(900);

  const start = await view();
  expect(start.mode).toBe('strategic');

  // Колесо — приближение.
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, -600);
  await settle();
  const zoomed = await view();
  expect(zoomed.distance).toBeLessThan(start.distance - 20);

  // Левая кнопка в стратегическом режиме — сдвиг цели.
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(520, 330, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  await settle();
  const panned = await view();
  expect(Math.hypot(panned.target[0] - zoomed.target[0], panned.target[2] - zoomed.target[2])).toBeGreaterThan(3);
  expect(panned.yaw).toBeCloseTo(zoomed.yaw, 2);

  // Правая кнопка в стратегическом режиме — вращение.
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(700, 330, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await settle();
  const rotated = await view();
  expect(Math.abs(rotated.yaw - panned.yaw)).toBeGreaterThan(0.3);

  // Клавиши: W — движение, Tab — смена режима.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyW');
  await settle();
  const moved = await view();
  expect(Math.hypot(moved.target[0] - rotated.target[0], moved.target[2] - rotated.target[2])).toBeGreaterThan(2);

  await page.keyboard.press('Tab');
  await settle();
  const free = await view();
  expect(free.mode).toBe('free');
  expect(free.distance).toBeLessThan(40);
  expect(free.pitch).toBeLessThan(0.45);

  // В свободном режиме левая кнопка вращает.
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(820, 330, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  await settle();
  expect(Math.abs((await view()).yaw - free.yaw)).toBeGreaterThan(0.3);

  // Кнопки панели: слежение за оленем — цель движется вместе с ним.
  await page.getByRole('button', { name: 'Олень', exact: true }).click();
  await settle();
  const follow1 = await view();
  await page.waitForTimeout(3000);
  const follow2 = await view();
  expect(follow1.distance).toBeLessThan(12);
  expect(Math.hypot(follow2.target[0] - follow1.target[0], follow2.target[2] - follow1.target[2])).toBeGreaterThan(0.5);

  // Кнопка «Обзор» возвращает стратегический режим; время суток меняется ползунком.
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await settle();
  expect((await view()).mode).toBe('strategic');
  await page.locator('#hour').fill('21.5');
  await expect(page.locator('#clock')).toHaveText('21:30');

  // H скрывает интерфейс.
  await page.keyboard.press('KeyH');
  await expect(page.locator('#controls')).toBeHidden();
});
