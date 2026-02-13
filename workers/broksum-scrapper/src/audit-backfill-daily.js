// Audit kelengkapan data harian broker summary untuk semua ticker
// dan backfill jika kurang dari 20 hari terakhir.
// Catat waktu eksekusi untuk performance test.

const MIN_DAYS = 20;
const LOOKBACK_DAYS = 30; // Untuk jaga-jaga hari libur

async function auditAndBackfillDailyBrokerFlow(env, { log }) {
  const start = Date.now();
  log(`[AUDIT] Mulai audit kelengkapan data harian broker summary...`);

  // 1. Ambil semua ticker unik dari DB
  const { results: tickers } = await env.SSSAHAM_DB.prepare(
    'SELECT DISTINCT ticker FROM daily_broker_flow'
  ).all();

  let totalBackfilled = 0;
  let totalAudited = 0;
  let backfillDetail = [];

  for (const { ticker } of tickers) {
    // Hitung jumlah hari data tersedia untuk ticker ini (30 hari ke belakang)
    const { results: days } = await env.SSSAHAM_DB.prepare(
      'SELECT COUNT(*) as n FROM daily_broker_flow WHERE ticker = ? AND date >= ?'
    ).bind(ticker, subtractDays(getWIBToday(), LOOKBACK_DAYS)).all();
    const n = days[0]?.n || 0;
    totalAudited++;
    if (n < MIN_DAYS) {
      // Perlu backfill
      log(`[BACKFILL] ${ticker}: hanya ada ${n} hari, backfill...`);
      // Panggil endpoint internal atau fungsi backfill harian (misal: dari RAW_BROKSUM)
      // Contoh:
      // Simulasi backfill: delay 100ms per ticker (ganti dengan logic asli jika di Worker)
      await new Promise(r => setTimeout(r, 100));
      totalBackfilled++;
      backfillDetail.push({ ticker, n });
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`[AUDIT] Selesai. Total ticker: ${totalAudited}, Perlu backfill: ${totalBackfilled}, Waktu: ${elapsed}s`);
  return { totalAudited, totalBackfilled, elapsed, backfillDetail };
}

// CLI runner
if (require.main === module) {
  (async () => {
    // Mock env & log
    const env = {
      SSSAHAM_DB: require('better-sqlite3')('db.sqlite'), // Ganti dengan path DB lokal jika ada
      BROKSUM_SERVICE: { fetch: async (url) => { console.log('[MOCK] fetch', url); } }
    };
    const log = console.log;
    console.log('--- Audit & Backfill Daily Broker Flow ---');
    const result = await auditAndBackfillDailyBrokerFlow(env, { log });
    console.log('--- Hasil ---');
    console.log(result);
  })();
}
}

// Helper
function getWIBToday() {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() + 7); // WIB = UTC+7
  return now.toISOString().slice(0, 10);
}
function subtractDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
