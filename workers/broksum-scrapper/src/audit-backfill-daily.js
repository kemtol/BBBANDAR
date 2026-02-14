const MIN_DAYS = 20;
const LOOKBACK_DAYS = 30; // Untuk jaga-jaga hari libur

export async function auditAndBackfillDailyBrokerFlow(env, { log = console.log } = {}) {
  const start = Date.now();
  const today = getWIBToday();
  const fromDate = subtractDays(today, LOOKBACK_DAYS);

  log(`[AUDIT] Mulai audit kelengkapan data harian broker summary...`);

  const { results: tickers } = await env.SSSAHAM_DB.prepare(
    'SELECT DISTINCT ticker FROM daily_broker_flow'
  ).all();
  const tickerList = tickers || [];

  let totalBackfilled = 0;
  let totalAudited = 0;
  const backfillDetail = [];

  for (const { ticker } of tickerList) {
    const dayCount = await env.SSSAHAM_DB.prepare(
      'SELECT COUNT(DISTINCT date) as n FROM daily_broker_flow WHERE ticker = ? AND date >= ? AND date <= ?'
    ).bind(ticker, fromDate, today).first();
    const n = Number(dayCount?.n || 0);
    totalAudited++;

    if (n < MIN_DAYS) {
      log(`[BACKFILL] ${ticker}: hanya ada ${n} hari, backfill...`);
      totalBackfilled++;
      backfillDetail.push({ ticker, n });
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`[AUDIT] Selesai. Total ticker: ${totalAudited}, Perlu backfill: ${totalBackfilled}, Waktu: ${elapsed}s`);
  return { totalAudited, totalBackfilled, elapsed, backfillDetail };
}

function getWIBToday() {
  const now = new Date();
  const wib = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return wib.toISOString().split("T")[0];
}

function subtractDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}
