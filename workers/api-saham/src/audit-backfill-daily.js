const MIN_DAYS = 20;
const LOOKBACK_DAYS = 30; // Untuk jaga-jaga hari libur
const DEFAULT_TRIGGER_LIMIT = 40;
const MAX_TRIGGER_LIMIT = 80;
const MAX_TRIGGER_CONCURRENCY = 6;

export async function auditAndBackfillDailyBrokerFlow(
  env,
  { log = console.log, triggerLimit = DEFAULT_TRIGGER_LIMIT } = {}
) {
  const start = Date.now();
  log(`[AUDIT] Mulai audit kelengkapan data harian broker summary...`);
  const today = getWIBToday();
  const fromDate = subtractDays(today, LOOKBACK_DAYS);

  // 1. Ambil semua ticker unik dari DB
  const { results: tickers } = await env.SSSAHAM_DB.prepare(
    'SELECT DISTINCT ticker FROM daily_broker_flow'
  ).all();
  const tickerList = tickers || [];

  if (tickerList.length === 0) {
    log(`[AUDIT] Tidak ada ticker pada daily_broker_flow`);
    return {
      totalAudited: 0,
      totalBackfilled: 0,
      elapsed: "0.0",
      backfillDetail: [],
      triggerSummary: { requested: 0, triggered: 0, deferred: 0, success: 0, failed: 0 }
    };
  }

  let totalBackfilled = 0;
  let totalAudited = 0;
  let backfillDetail = [];
  const clampedLimit = clampTriggerLimit(triggerLimit);

  for (const row of tickerList) {
    const ticker = row.ticker;
    // Hitung jumlah hari data tersedia untuk ticker ini (30 hari ke belakang)
    const dayCount = await env.SSSAHAM_DB.prepare(
      'SELECT COUNT(DISTINCT date) as n FROM daily_broker_flow WHERE ticker = ? AND date >= ? AND date <= ?'
    ).bind(ticker, fromDate, today).first();
    const n = Number(dayCount?.n || 0);
    totalAudited++;

    if (n < MIN_DAYS) {
      // Perlu backfill
      log(`[BACKFILL] ${ticker}: hanya ada ${n} hari, backfill...`);
      totalBackfilled++;
      backfillDetail.push({ ticker, n });
    }
  }

  backfillDetail.sort((a, b) => a.n - b.n || a.ticker.localeCompare(b.ticker));
  const selected = backfillDetail.slice(0, clampedLimit);
  const deferred = Math.max(0, backfillDetail.length - selected.length);
  const triggerTasks = [];
  const triggerFailed = [];
  let triggerSuccess = 0;

  if (selected.length > 0) {
    if (env.BROKSUM_SERVICE && env.BROKSUM_SERVICE.fetch) {
      for (const { ticker } of selected) {
        triggerTasks.push(async () => {
          const keyQuery = env.INTERNAL_KEY ? `&key=${encodeURIComponent(env.INTERNAL_KEY)}` : "";
          const url = `http://internal/backfill-flow?ticker=${encodeURIComponent(ticker)}&days=${LOOKBACK_DAYS}${keyQuery}`;
          try {
            const resp = await env.BROKSUM_SERVICE.fetch(url);
            if (!resp.ok) {
              const body = await resp.text();
              throw new Error(`status=${resp.status} body=${body.slice(0, 180)}`);
            }
            triggerSuccess++;
          } catch (e) {
            const msg = `[BACKFILL] Trigger failed for ${ticker}: ${e.message}`;
            log(msg);
            triggerFailed.push({ ticker, error: e.message });
          }
        });
      }
    } else {
      for (const { ticker } of selected) {
        triggerFailed.push({ ticker, error: "BROKSUM_SERVICE binding missing" });
      }
      log(`[BACKFILL] BROKSUM_SERVICE binding missing; semua trigger batch dilewati`);
    }
  }

  if (triggerTasks.length > 0) {
    await runTasksWithConcurrency(triggerTasks, MAX_TRIGGER_CONCURRENCY);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(
    `[AUDIT] Selesai. Total ticker: ${totalAudited}, Perlu backfill: ${totalBackfilled}, Triggered: ${selected.length}, Deferred: ${deferred}, Trigger OK: ${triggerSuccess}, Trigger Fail: ${triggerFailed.length}, Waktu: ${elapsed}s`
  );

  return {
    totalAudited,
    totalBackfilled,
    elapsed,
    backfillDetail,
    triggerSummary: {
      requested: backfillDetail.length,
      triggered: selected.length,
      deferred,
      limit: clampedLimit,
      success: triggerSuccess,
      failed: triggerFailed.length,
      failedTickers: triggerFailed
    }
  };
}

function getWIBToday() {
  // Shift to WIB calendar day and keep date-only output
  const now = new Date();
  const wib = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return wib.toISOString().split("T")[0];
}

function subtractDays(dateStr, n) {
  // Noon UTC avoids DST / local offset edge-cases for date-only math.
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

async function runTasksWithConcurrency(taskFactories, limit) {
  const size = Math.max(1, Math.min(limit || 1, taskFactories.length));
  let cursor = 0;

  const workers = Array.from({ length: size }, async () => {
    while (cursor < taskFactories.length) {
      const idx = cursor++;
      await taskFactories[idx]();
    }
  });

  await Promise.all(workers);
}

function clampTriggerLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TRIGGER_LIMIT;
  return Math.max(0, Math.min(MAX_TRIGGER_LIMIT, Math.floor(n)));
}
