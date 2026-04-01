import { test, expect } from '@playwright/test';

const API_BASE_URL = process.env.API_BASE_URL || 'https://api-saham.mkemalw.workers.dev';

function normalizeDateArray(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((row) => String(row?.date || '').trim())
    .filter(Boolean);
}

test.describe('Broker summary BBRI regression', () => {
  test('BBRI range 2026-03-30 to 2026-03-31 returns both trading days', async ({ page }) => {
    const from = '2026-03-30';
    const to = '2026-03-31';

    const responsePromise = page.waitForResponse((resp) => {
      const url = resp.url();
      return (
        url.startsWith(API_BASE_URL) &&
        url.includes('/cache-summary?') &&
        url.includes('symbol=BBRI') &&
        url.includes(`from=${from}`) &&
        url.includes(`to=${to}`)
      );
    });

    await page.goto(`/idx/emiten/broker-summary.html?kode=BBRI&start=${from}&end=${to}`, {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForSelector('#detail-view', { state: 'visible' });

    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();

    const payload = await response.json();
    const historyDates = normalizeDateArray(payload?.history);

    expect(historyDates.length).toBeGreaterThan(0);
    expect(historyDates).toContain('2026-03-30');
    expect(historyDates).toContain('2026-03-31');

    await expect(page.locator('#date-from')).toHaveValue(from);
    await expect(page.locator('#date-to')).toHaveValue(to);

    const warningText = page.locator('#broker-table-container');
    await expect(warningText).not.toContainText('Belum Ada Data Broker');
  });
});
