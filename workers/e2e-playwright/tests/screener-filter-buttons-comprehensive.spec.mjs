import { test, expect, devices } from '@playwright/test';

const SCREENER_PAGES = [
  {
    name: 'Stock Screener',
    path: '/idx/emiten/broker-summary.html?cache=rebuild',
    readyRowsSelector: '#tbody-index tr',
    presetSelector: '#preset-selector a[data-preset]',
    rangeSelector: '#foreign-range-selector a[data-days]',
    scopeSelector: null,
    resetSelector: '#btn-reset-filters',
    sanityAnySelectors: ['#dd-foreign', '#dd-local', '#dd-smart']
  },
  {
    name: 'Broker Screener',
    path: '/idx/broker/stock-summary.html?cache=rebuild',
    readyRowsSelector: '#tbody-broker tr',
    presetSelector: '#preset-selector a[data-merged-preset]',
    rangeSelector: '#broker-range-selector a[data-days]',
    scopeSelector: null,
    resetSelector: '#btn-reset-filters',
    sanityAnySelectors: ['#dd-category', '#dd-netdir', '#dd-quadrant']
  }
];

async function trigger(locator, mode) {
  if (mode === 'mobile') {
    await locator.tap();
  } else {
    await locator.click();
  }
}

async function auditToggleGroup(page, selector, mode) {
  if (!selector) return;
  const groupItems = page.locator(selector);
  const count = await groupItems.count();
  expect(count, `Expected at least one toggle for selector: ${selector}`).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const item = groupItems.nth(i);
    if (!(await item.isVisible())) continue;
    await item.scrollIntoViewIfNeeded();
    await trigger(item, mode);
    await expect(item).toHaveClass(/active/);
    await page.waitForTimeout(80);
  }
}

async function auditFilterDropdownButtons(page, mode) {
  const buttons = page.locator('#filter-row .dropdown > button.dropdown-toggle');
  const buttonCount = await buttons.count();
  expect(buttonCount).toBeGreaterThan(0);

  for (let i = 0; i < buttonCount; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible())) continue;
    const id = await button.getAttribute('id');
    if (!id) continue;

    await button.scrollIntoViewIfNeeded();
    await trigger(button, mode);

    const menu = page.locator(`#${id} + .dropdown-menu`);
    await expect(menu).toBeVisible();

    const option = menu.locator('[data-filter][data-val]:not([data-val="any"])').first();
    const optionCount = await option.count();

    if (optionCount > 0 && (await option.isVisible())) {
      await option.scrollIntoViewIfNeeded();
      await trigger(option, mode);
      await page.waitForTimeout(120);
      const updatedLabel = ((await button.textContent()) || '').toLowerCase();
      expect(updatedLabel).not.toContain('any');
    } else {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(80);
    }
  }
}

async function auditResetBehavior(page, mode, resetSelector, sanityAnySelectors) {
  const resetBtn = page.locator(resetSelector);
  if (!(await resetBtn.isVisible())) return;
  await resetBtn.scrollIntoViewIfNeeded();
  await trigger(resetBtn, mode);
  await page.waitForTimeout(200);

  for (const selector of sanityAnySelectors) {
    const label = ((await page.locator(selector).textContent()) || '').toLowerCase();
    expect(label, `Expected reset label to contain "any" for ${selector}`).toContain('any');
  }
}

async function runScreenerAudit(page, screener, mode) {
  await page.goto(screener.path, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(screener.readyRowsSelector);
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, screener.readyRowsSelector);

  await auditToggleGroup(page, screener.rangeSelector, mode);
  await auditToggleGroup(page, screener.presetSelector, mode);
  await auditToggleGroup(page, screener.scopeSelector, mode);
  await auditFilterDropdownButtons(page, mode);
  await auditResetBehavior(page, mode, screener.resetSelector, screener.sanityAnySelectors);
}

test.describe('Screener filter buttons comprehensive', () => {
  test('desktop: all screener filter buttons are clickable and functional', async ({ page }) => {
    test.setTimeout(600_000);
    for (const screener of SCREENER_PAGES) {
      await test.step(`Desktop audit on ${screener.name}`, async () => {
        await runScreenerAudit(page, screener, 'desktop');
      });
    }
  });

  test('mobile: all screener filter buttons are tappable and functional', async ({ browser }) => {
    test.setTimeout(1_200_000);
    const context = await browser.newContext({ ...devices['iPhone 12'] });
    const page = await context.newPage();
    try {
      for (const screener of SCREENER_PAGES) {
        await test.step(`Mobile audit on ${screener.name}`, async () => {
          await runScreenerAudit(page, screener, 'mobile');
        });
      }
    } finally {
      await context.close();
    }
  });
});
