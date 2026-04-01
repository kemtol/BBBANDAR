import { test, expect } from '@playwright/test';
import { createRequestTracker, isApiRequest } from './helpers/network.js';
import { brokerSummary, waitForScreenerReady } from './helpers/selectors.js';

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app-sssaham.mkemalw.workers.dev';
const API_BASE_URL = process.env.API_BASE_URL || 'https://api-saham.mkemalw.workers.dev';

test.describe('SSSAHAM broker summary screener', () => {
  test('loads rows, uses bulk orderflow, supports search, and navigates to detail', async ({ page }) => {
    const tracker = createRequestTracker(page);
    await page.goto('/idx/emiten/broker-summary.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenerReady(page);

    const rowCount = await page.locator(brokerSummary.screenerRow).count();
    expect(rowCount).toBeGreaterThan(0);
    await expect(page.locator(brokerSummary.screenerRow).first()).toBeVisible();

    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('#tbody-index tr');
      return rows.length > 0 && Array.from(rows).some((row) => row.textContent && row.textContent.trim().length > 0);
    });

    const screenerCalls = tracker.byUrl('/screener-accum');
    expect(screenerCalls.length).toBeGreaterThan(0);
    expect(screenerCalls.some((entry) => entry.url.includes('include_orderflow=false'))).toBeTruthy();

    await page.waitForFunction(() => {
      const bodyText = document.querySelector('#tbody-index')?.textContent || '';
      return bodyText.length > 0;
    });

    const bulkOrderflowCalls = tracker.byUrl('/orderflow/snapshots');
    expect(bulkOrderflowCalls.length).toBeGreaterThan(0);

    const cacheSummaryCalls = tracker.byUrl('/cache-summary?symbol=');
    expect(cacheSummaryCalls.length).toBeLessThan(8);

    const symbol = await page.locator(brokerSummary.screenerRow).first().getAttribute('data-symbol');
    expect(symbol, 'symbol from first row').toBeTruthy();

    await page.locator(brokerSummary.searchInput).fill(symbol);
    await page.waitForFunction((sym) => {
      const rows = Array.from(document.querySelectorAll('#tbody-index tr'));
      return rows.length > 0 && rows.every((row) => row.textContent?.toUpperCase().includes(sym));
    }, symbol.toUpperCase());

    const filteredCount = await page.locator(brokerSummary.screenerRow).count();
    expect(filteredCount).toBeGreaterThan(0);
    const filteredText = await page.locator(brokerSummary.screenerBody).textContent();
    expect(filteredText?.toUpperCase()).toContain(symbol.toUpperCase());

    const firstRow = page.locator(brokerSummary.screenerRow).first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    await expect(page).toHaveURL(new RegExp(`/idx/emiten/broker-summary(?:\\.html)?\\?kode=${symbol}$`));
    await expect(page.locator(brokerSummary.detailView)).toBeVisible();

    tracker.stop();

    const relevantRequests = tracker.requests.filter((item) => isApiRequest(item.url, API_BASE_URL, '/'));
    expect(relevantRequests.length).toBeGreaterThan(0);
  });

  test('initial screener request avoids orderflow fan-out', async ({ page }) => {
    const tracker = createRequestTracker(page);

    await page.goto('/idx/emiten/broker-summary.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenerReady(page);

    await page.waitForFunction(() => document.querySelectorAll('#tbody-index tr').length > 0);

    const screenerCalls = tracker.byUrl('/screener-accum');
    expect(screenerCalls.some((entry) => entry.url.includes('include_orderflow=false'))).toBeTruthy();

    const cacheSummaryCalls = tracker.byUrl('/cache-summary?symbol=');
    expect(cacheSummaryCalls.length).toBeLessThan(8);

    const bulkOrderflowCalls = tracker.byUrl('/orderflow/snapshots');
    expect(bulkOrderflowCalls.length).toBeGreaterThan(0);

    tracker.stop();
  });
});
