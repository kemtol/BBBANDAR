import { test, expect } from '@playwright/test';

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app-sssaham.mkemalw.workers.dev';

test('BULL broker summary page loads orderflow bubble chart', async ({ page }) => {
  // Navigate directly to the detail page
  await page.goto('/idx/emiten/broker-summary?kode=BULL', { waitUntil: 'domcontentloaded' });
  
  // Wait for the detail view to become visible (should appear after data loads)
  await page.locator('#detail-view').waitFor({ state: 'visible', timeout: 15000 });
  
  // Check that the "Belum Ada Data Broker" message is NOT present
  const noDataText = await page.locator('text=Belum Ada Data Broker').count();
  expect(noDataText).toBe(0);
  
  // Wait for bubble chart canvas to be rendered (might be inside a container)
  const bubbleCanvas = page.locator('#opportunity-bubble-chart');
  await expect(bubbleCanvas).toBeVisible({ timeout: 10000 });
  
  // Optionally check that at least one bubble point exists (requires chart data)
  // We'll just verify that the canvas is attached and has dimensions
  const canvasBox = await bubbleCanvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(0);
  expect(canvasBox?.height).toBeGreaterThan(0);
  
  // Verify that orderflow data is present (check for quadrant label)
  const quadrantLabel = page.locator('.quadrant-label, text=Q2');
  const hasQuadrant = await quadrantLabel.count();
  expect(hasQuadrant).toBeGreaterThan(0);
});