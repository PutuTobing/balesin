import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { screens } from './screens';

const OUT_DIR = path.join(import.meta.dirname, '..', 'screenshots');
const only = process.env.SCREENS?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

mkdirSync(OUT_DIR, { recursive: true });

/** Tinggikan viewport sebanyak isi tersembunyi di kontainer gulir terbesar (maks 6000 px). */
async function growToContent(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const hidden = await page.evaluate(() =>
    Math.max(
      0,
      ...Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY))
        .map((node) => node.scrollHeight - node.clientHeight),
    ),
  );
  if (hidden <= 0) return;
  await page.setViewportSize({
    width: viewport.width,
    height: Math.min(viewport.height + hidden, 6000),
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

for (const screen of screens) {
  if (only && only.length > 0 && !only.includes(screen.name)) continue;

  test(`foto ${screen.name}`, async ({ page }, testInfo) => {
    if (screen.before) await screen.before(page);
    // Layar dengan permintaan yang sengaja tidak dijawab (memuat) tidak pernah "networkidle".
    await page.goto(screen.path, { waitUntil: screen.waitUntil ?? 'networkidle' });
    if (screen.waitFor) await page.locator(screen.waitFor).first().waitFor({ state: 'visible' });
    if (screen.prepare) await screen.prepare(page);
    // Tunggu font self-host selesai dimuat supaya tipografi di foto akurat.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (screen.tall) await growToContent(page);
    await page.screenshot({
      path: path.join(OUT_DIR, `${screen.name}--${testInfo.project.name}.png`),
      fullPage: screen.fullPage ?? false,
      animations: 'disabled',
    });
  });
}
