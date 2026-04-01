import { test, expect } from '@playwright/test';

function mockTrailingPayload() {
  return {
    ok: true,
    broker: 'IF',
    days: 20,
    dates: ['2026-03-01', '2026-03-02', '2026-03-03'],
    stock_summary: [
      {
        stock_code: 'TRON',
        total_net: 135_000_000,
        total_buy: 170_000_000,
        total_sell: 35_000_000,
        days_active: 3
      },
      {
        stock_code: 'DEWA',
        total_net: 70_000_000,
        total_buy: 120_000_000,
        total_sell: 50_000_000,
        days_active: 3
      },
      {
        stock_code: 'AMMN',
        total_net: -60_000_000,
        total_buy: 90_000_000,
        total_sell: 150_000_000,
        days_active: 3
      }
    ],
    series: {
      TRON: [
        { date: '2026-03-01', buy_val: 100_000_000, sell_val: 20_000_000, net_val: 80_000_000, cumulative_net: 80_000_000, buy_freq: 2, sell_freq: 1 },
        { date: '2026-03-02', buy_val: 50_000_000, sell_val: 10_000_000, net_val: 40_000_000, cumulative_net: 120_000_000, buy_freq: 1, sell_freq: 1 },
        { date: '2026-03-03', buy_val: 20_000_000, sell_val: 5_000_000, net_val: 15_000_000, cumulative_net: 135_000_000, buy_freq: 1, sell_freq: 1 }
      ],
      DEWA: [
        { date: '2026-03-01', buy_val: 80_000_000, sell_val: 20_000_000, net_val: 60_000_000, cumulative_net: 60_000_000, buy_freq: 2, sell_freq: 1 },
        { date: '2026-03-02', buy_val: 20_000_000, sell_val: 20_000_000, net_val: 0, cumulative_net: 60_000_000, buy_freq: 1, sell_freq: 1 },
        { date: '2026-03-03', buy_val: 20_000_000, sell_val: 10_000_000, net_val: 10_000_000, cumulative_net: 70_000_000, buy_freq: 1, sell_freq: 1 }
      ],
      AMMN: [
        { date: '2026-03-01', buy_val: 40_000_000, sell_val: 60_000_000, net_val: -20_000_000, cumulative_net: -20_000_000, buy_freq: 1, sell_freq: 2 },
        { date: '2026-03-02', buy_val: 30_000_000, sell_val: 50_000_000, net_val: -20_000_000, cumulative_net: -40_000_000, buy_freq: 1, sell_freq: 1 },
        { date: '2026-03-03', buy_val: 20_000_000, sell_val: 40_000_000, net_val: -20_000_000, cumulative_net: -60_000_000, buy_freq: 1, sell_freq: 1 }
      ]
    }
  };
}

async function mockBrokerTrailing(page) {
  await page.route('**/broker-activity/trailing?**', async (route) => {
    const reqUrl = new URL(route.request().url());
    if (reqUrl.searchParams.get('broker') !== 'IF') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      },
      body: JSON.stringify(mockTrailingPayload())
    });
  });
}

test.describe('SSSAHAM broker detail stock focus', () => {
  test('focuses to one stock when stock query param is present', async ({ page }) => {
    await mockBrokerTrailing(page);

    await page.goto('/idx/broker/detail.html?kode=IF&stock=TRON&days=20', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#tbody-holdings tr').length > 0);

    const ui = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#tbody-holdings tr'));
      return {
        rows: rows.map((row) => row.getAttribute('data-stock')),
        activeRows: rows.filter((row) => row.classList.contains('table-active')).map((row) => row.getAttribute('data-stock')),
        holdingsCount: document.querySelector('#holdings-count')?.textContent?.trim() || '',
        breadth: document.querySelector('#stat-breadth')?.textContent?.trim() || '',
        trailingLabels: (typeof trailingChart !== 'undefined' && trailingChart?.data?.datasets)
          ? trailingChart.data.datasets.map((dataset) => dataset.label)
          : [],
        momentumLabels: (typeof momentumChart !== 'undefined' && momentumChart?.data?.labels)
          ? momentumChart.data.labels.slice()
          : []
      };
    });

    expect(ui.rows).toEqual(['TRON']);
    expect(ui.activeRows).toEqual(['TRON']);
    expect(ui.holdingsCount).toContain('1 stocks');
    expect(ui.breadth).toBe('1');
    expect(ui.trailingLabels).toEqual(['TRON']);
    expect(ui.momentumLabels).toEqual(['TRON']);
  });

  test('keeps full list when stock query param is absent', async ({ page }) => {
    await mockBrokerTrailing(page);

    await page.goto('/idx/broker/detail.html?kode=IF&days=20', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#tbody-holdings tr').length > 0);

    const ui = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#tbody-holdings tr'));
      return {
        rows: rows.map((row) => row.getAttribute('data-stock')),
        holdingsCount: document.querySelector('#holdings-count')?.textContent?.trim() || '',
        breadth: document.querySelector('#stat-breadth')?.textContent?.trim() || '',
        trailingLabels: (typeof trailingChart !== 'undefined' && trailingChart?.data?.datasets)
          ? trailingChart.data.datasets.map((dataset) => dataset.label)
          : []
      };
    });

    expect(ui.rows).toEqual(expect.arrayContaining(['TRON', 'DEWA', 'AMMN']));
    expect(ui.rows.length).toBe(3);
    expect(ui.holdingsCount).toContain('3 stocks');
    expect(ui.breadth).toBe('3');
    expect(ui.trailingLabels.length).toBeGreaterThan(1);
  });

  test('supports in-page stock filter for individual stock view', async ({ page }) => {
    await mockBrokerTrailing(page);

    await page.goto('/idx/broker/detail.html?kode=IF&days=20', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#tbody-holdings tr').length > 0);

    await page.locator('#stock-filter-input').fill('tron');
    await page.locator('#stock-filter-input').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#tbody-holdings tr').length === 1);

    const filtered = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#tbody-holdings tr'));
      return {
        url: location.href,
        rows: rows.map((row) => row.getAttribute('data-stock')),
        holdingsCount: document.querySelector('#holdings-count')?.textContent?.trim() || '',
        breadth: document.querySelector('#stat-breadth')?.textContent?.trim() || '',
        trailingLabels: (typeof trailingChart !== 'undefined' && trailingChart?.data?.datasets)
          ? trailingChart.data.datasets.map((dataset) => dataset.label)
          : [],
        momentumLabels: (typeof momentumChart !== 'undefined' && momentumChart?.data?.labels)
          ? momentumChart.data.labels.slice()
          : []
      };
    });

    expect(filtered.url).toContain('stock_q=TRON');
    expect(filtered.rows).toEqual(['TRON']);
    expect(filtered.holdingsCount).toContain('1 stocks');
    expect(filtered.breadth).toBe('1');
    expect(filtered.trailingLabels).toEqual(['TRON']);
    expect(filtered.momentumLabels).toEqual(['TRON']);

    await page.locator('#stock-filter-clear').click();
    await page.waitForFunction(() => document.querySelectorAll('#tbody-holdings tr').length === 3);

    const reset = await page.evaluate(() => ({
      url: location.href,
      rowCount: document.querySelectorAll('#tbody-holdings tr').length
    }));
    expect(reset.url).not.toContain('stock_q=');
    expect(reset.rowCount).toBe(3);
  });
});
