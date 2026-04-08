import { test, expect } from '@playwright/test';

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app-sssaham.mkemalw.workers.dev';
const API_BASE_URL = process.env.API_BASE_URL || 'https://api-saham.mkemalw.workers.dev';

test('BULL page uses correct default date range before 18:00 WIB', async ({ page }) => {
  // Intercept network requests to cache-summary
  const capturedRequests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/cache-summary?symbol=BULL')) {
      capturedRequests.push(url);
    }
  });

  // Navigate to BULL detail page (no explicit start/end params)
  await page.goto('/idx/emiten/broker-summary?kode=BULL', { waitUntil: 'domcontentloaded' });
  
  // Wait for detail view to appear (indicating page loaded)
  await page.locator('#detail-view').waitFor({ state: 'visible', timeout: 15000 });
  
  // Wait a bit for any potential retries (but first request should happen quickly)
  await page.waitForTimeout(2000);
  
  // Expect at least one captured request
  expect(capturedRequests.length).toBeGreaterThan(0);
  const firstRequest = capturedRequests[0];
  console.log('Captured cache-summary URL:', firstRequest);
  
  // Parse URL query parameters
  const urlObj = new URL(firstRequest);
  const params = urlObj.searchParams;
  const from = params.get('from');
  const to = params.get('to');
  
  // Expected dates: today is 2026-04-06, before 18:00 WIB → end = 2026-04-05, start = 2026-03-16
  expect(from).toBe('2026-03-16');
  expect(to).toBe('2026-04-05');
  
  // Also verify that the daily cache-busting parameter is present (format YYYY-MM-DD)
  const cacheBuster = params.get('_');
  expect(cacheBuster).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});