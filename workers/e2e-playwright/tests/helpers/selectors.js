export const brokerSummary = {
  screenerTable: '#screener-table',
  screenerBody: '#tbody-index',
  screenerRow: '#tbody-index tr',
  searchInput: '#emiten-search',
  loadingIndicator: '#loading-indicator',
  appRoot: '#app',
  indexView: '#index-view',
  detailView: '#detail-view',
  pageRange: '#page-range',
  totalItems: '#total-items'
};

export async function waitForScreenerReady(page) {
  await page.locator(brokerSummary.appRoot).waitFor({ state: 'visible' });
  await page.locator(brokerSummary.screenerTable).waitFor({ state: 'visible' });
  await page.locator(brokerSummary.screenerBody).waitFor({ state: 'visible' });
}
