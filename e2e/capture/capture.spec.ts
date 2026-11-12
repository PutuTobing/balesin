import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { screens } from './screens';

const OUT_DIR = path.join(import.meta.dirname, '..', 'screenshots');
const only = process.env.SCREENS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT_DIR, { recursive: true });

for (const screen of screens) {
  if (only && only.length > 0 && !only.includes(screen.name)) continue;

  test(`foto ${screen.name}`, async ({ page }, testInfo) => {
    await page.goto(screen.path, { waitUntil: 'networkidle' });
    if (screen.waitFor) await page.locator(screen.waitFor).first().waitFor({ state: 'visible' });
    if (screen.prepare) await screen.prepare(page);
    // Tunggu font self-host selesai dimuat supaya tipografi di foto akurat.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({
      path: path.join(OUT_DIR, `${screen.name}--${testInfo.project.name}.png`),
      fullPage: screen.fullPage ?? false,
      animations: 'disabled',
    });
  });
}
