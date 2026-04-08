import { test, expect, devices } from '@playwright/test';

test.use({
  ...devices['iPhone 12']
});

test.describe('Broker activity mobile filter taps', () => {
  test('can tap filter buttons and apply dropdown values on mobile', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto('/idx/broker/stock-summary.html?days=5&cache=rebuild', {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForSelector('#dd-category');
    await page.waitForFunction(() => document.querySelectorAll('#tbody-broker tr').length > 0);

    await page.locator('#dd-category').tap();
    await page.waitForSelector('#dd-category + .dropdown-menu.show');
    await page.locator('#dd-category + .dropdown-menu [data-filter="category"][data-val="foreign"]').tap();
    await expect(page.locator('#dd-category')).toContainText('Category: foreign');

    await page.locator('#dd-netdir').tap();
    await page.waitForSelector('#dd-netdir + .dropdown-menu.show');
    await page.locator('#dd-netdir + .dropdown-menu [data-filter="netdir"][data-val="buy"]').tap();
    await expect(page.locator('#dd-netdir')).toContainText('Net: Net Buy');

    await expect(page).toHaveURL(/preset=foreign/);
    await expect(page).toHaveURL(/netdir=buy/);
  });
});
