/**
 * @worker livetrade-taping-agregator
 * @objective Aggregates live trade data from Durable Objects and raw files into intraday/footprint JSONs, and handles historical seeding/backfilling via asynchronous queues.
 *
 * @endpoints
 * - POST /admin/seed-day -> Triggers or queues historical seeding (public/admin)
 * - GET /admin/seed-status -> Checks status of seeding jobs (public/admin)
 * - GET /debug/coverage -> Checks R2 file coverage (public/debug)
 *
 * @triggers
 * - http: yes (Admin/Debug endpoints)
 * - cron: 0 * * * * (Hourly aggregation)
 * - queue: livetrade-backfill-queue, livetrade-processed-queue
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: R2 (tape-data-saham), DO (StateEngine/V2 stub)
 * - writes: R2 (tape-data-saham), Queue (BACKFILL_QUEUE)
 *
 * @relations
 * - upstream: livetrade-durable-object (via livetrade-processed-queue), livetrade-taping (via R2 raw_lt)
 * - downstream: Frontend (via R2 public access)
 *
 * @success_metrics
 * - Latency of queue processing
 * - Completion rate of backfill jobs
 * - Data integrity (no missing minutes)
 *
 * @notes
 * - Uses partial ID matching for tick logic.
 * - Relies on implicit "market closed" logic for EOD processing.
 */
// workers/livetrade-taping-agregator/src/index.js
const BACKFILL_STATE_PREFIX = "backfill_state_";

// WIB = UTC+7, market closed setelah 15:15 WIB
function isMarketClosedWIB(nowUtc) {
  const wibMs = nowUtc.getTime() + 7 * 60 * 60 * 1000;
  const wib = new Date(wibMs);

  const hh = wib.getUTCHours();
  const mm = wib.getUTCMinutes();

  // closed kalau sudah lewat / sama dengan 15:15 WIB
  if (hh > 15) return true;
  if (hh === 15 && mm >= 15) return true;
  return false;
}

// ==============================
// REGEX PARSER UNTUK raw_lt (FAST PATH GEN-1)
// ==============================
// Asumsi line legacy: {"ts":..., "raw":"20251209|090001|...|RG|..."}
const REGEX_RAW = /"raw"\s*:\s*"([^"]+)"/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    console.log(`📡 [${request.method}] ${pathname} ${url.search}`);

    // Cron-checker integration endpoints
    if (request.method === "POST" && pathname === "/run") {
      try {
        const force = url.searchParams.get("force") === "1";
        const dateOverride = url.searchParams.get("date"); // e.g., "2026-01-07"
        console.log(`ðŸš€ /run endpoint triggered (force=${force}, date=${dateOverride || 'today'})`);
        await runDailyCron(env, force, dateOverride);
        // TODO: Add compression logic

        return Response.json({
          ok: true,
          message: "Aggregation completed",
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error("Error in /run:", error);
        return Response.json(
          { ok: false, error: error.message },
          { status: 500 }
        );
      }
    }



    if (request.method === "POST" && pathname === "/queue-start") {
      const dateOverride = url.searchParams.get("date");
      const now = new Date();
      let dateStr = dateOverride;
      if (!dateStr) {
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        dateStr = `${y}-${m}-${d}`;
      }

      const job = {
        date: dateStr,
        cursor: null, // Start from beginning
        limit: 2000,
        force: true
      };

      await env.BACKFILL_QUEUE.send(job);
      return Response.json({ ok: true, message: "Job pushed to queue", job });
    }

    if (request.method === "GET" && pathname === "/schedule") {
      return Response.json({
        ok: true,
        worker: 'livetrade-taping-agregator',
        schedule: {
          interval: '1h',
          cron_expression: '0 * * * *'
        }
      });
    }

    if (pathname === "/step-backfill") {
      return stepBackfill(env, url);
    }

    if (pathname === "/signal-realtime") {
      return realtimeSignal(env, url);
    }

    if (request.method === "POST" && pathname === "/admin/seed-all-hours") {
      const date = url.searchParams.get("date");
      const reset = url.searchParams.get("reset") === "true";
      const startHour = parseInt(url.searchParams.get("start") || "2"); // Default: 02 UTC (09:00 WIB)
      const endHour = parseInt(url.searchParams.get("end") || "10");   // Default: 10 UTC (17:00 WIB)
      const mode = url.searchParams.get("mode") || "stream"; // Default to stream

      if (!date) return new Response("Missing date", { status: 400 });

      const hours = [];
      const messages = [];

      for (let h = startHour; h <= endHour; h++) {
        const hourStr = String(h).padStart(2, "0");
        hours.push(hourStr);

        // Dispatch to Queue instead of inline ctx.waitUntil
        messages.push({
          body: {
            type: "seed_hour",
            date,
            hour: hourStr,
            reset,
            mode
          }
        });
      }

      // Batch send to queue
      if (messages.length > 0) {
        // Cloudflare Queues batch send
        await env.BACKFILL_QUEUE.sendBatch(messages);
      }

      return new Response(JSON.stringify({
        ok: true,
        message: "All hours queued to BACKFILL_QUEUE",
        date,
        reset,
        hours,
        mode,
        strategy: "queue_dispatch"
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST" && pathname === "/admin/seed-day") {
      const date = url.searchParams.get("date");
      if (!date) return new Response("Missing date", { status: 400 });
      ctx.waitUntil(seedDay(env, date));
      return new Response(JSON.stringify({ ok: true, message: "Jobs queued", count: 1 }), { headers: { "Content-Type": "application/json" } });
    }

    if (request.method === "POST" && pathname === "/admin/seed-hour") {
      const date = url.searchParams.get("date");
      const hour = url.searchParams.get("hour");
      const reset = url.searchParams.get("reset") === "true";
      const mode = url.searchParams.get("mode") || "stream";
      if (!date || !hour) return new Response("Missing date or hour", { status: 400 });
      ctx.waitUntil(seedHour(env, date, hour, reset, mode));
      return new Response(JSON.stringify({ ok: true, message: "Hour job queued", date, hour, reset, mode }), { headers: { "Content-Type": "application/json" } });
    }

    if (pathname === "/admin/backfill-logs") {
      try {
        if (!env.DB) return Response.json({ error: "DB not bound" }, { status: 500 });
        const { results } = await env.DB.prepare(
          "SELECT * FROM backfill_stats ORDER BY id DESC LIMIT 50"
        ).all();
        return Response.json(results);
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    if (pathname === "/admin/read-r2") {
      const key = url.searchParams.get("key");
      const obj = await env.DATA_LAKE.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body);
    }

    if (pathname === "/debug-r2") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("Missing ?key=", { status: 400 });
      const obj = await env.DATA_LAKE.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      const text = await obj.text();
      return new Response(text, { headers: { "Content-Type": "text/plain" } });
    }

    // Verify integrity endpoint
    if (pathname === "/verify-integrity") {
      const date = url.searchParams.get("date");
      if (!date) {
        return Response.json({ ok: false, error: "Missing date param" }, { status: 400 });
      }
      try {
        const result = await compressRawLtForDate(env, date);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (request.method === "POST" && pathname === "/test-delete") {
      const retention = parseInt(url.searchParams.get("retention") || "7", 10);
      const dryRun = url.searchParams.get("dryRun") === "true";

      try {
        if (dryRun) {
          return Response.json({
            ok: true,
            message: "Dry-run mode - use dryRun=false to actually delete",
            retention
          });
        }
        const result = await deleteOldRawLt(env, retention);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    if (pathname === "/" || pathname === "") {
      return new Response(
        JSON.stringify({ name: "aggregator", status: "ok" }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (request.method === "GET" && pathname === "/debug/coverage") {
      const date = url.searchParams.get("date") || new Date().toISOString().split('T')[0];
      const [y, m, d] = date.split("-"); // ensure YYYY-MM-DD
      const prefix = url.searchParams.get("prefix") || `raw_lt/${y}/${m}/${d}/`;

      const listed = await env.DATA_LAKE.list({ prefix, limit: 1000 });
      // Group by Hour
      const coverage = {};
      const sampleKeys = [];
      for (const obj of listed.objects) {
        const parts = obj.key.split("/");
        // raw_lt/Y/M/D/HH/...
        // parts[0]=raw_lt, [1]=Y, [2]=M, [3]=D, [4]=HH?
        // Let's verify standard path: raw_lt/2026/01/15/09/... 
        // If uploaded via DO, it uses HH folder.
        // If legacy, maybe not?
        const hh = parts[4];
        if (!coverage[hh]) coverage[hh] = 0;
        coverage[hh]++;
        if (sampleKeys.length < 5) sampleKeys.push(obj.key);
      }
      return Response.json({ prefix, total: listed.objects.length, truncated: listed.truncated, coverage, samples: sampleKeys });
    }

    if (request.method === "GET" && pathname === "/admin/seed-status") {
      const date = url.searchParams.get("date") || new Date().toISOString().split('T')[0];
      const key = `seed_status/${date}.json`;
      const obj = await env.DATA_LAKE.get(key);
      if (!obj) return Response.json({ status: "NOT_FOUND", date });
      return Response.json(await obj.json());
    }

    if (request.method === "GET" && pathname === "/admin/seed-hour-status") {
      const date = url.searchParams.get("date");
      const hour = url.searchParams.get("hour");
      if (!date || !hour) return Response.json({ error: "Missing date or hour" }, { status: 400 });
      const key = `seed_status/${date}_h${hour}.json`;
      const obj = await env.DATA_LAKE.get(key);
      if (!obj) return Response.json({ status: "NOT_FOUND", date, hour });
      return Response.json(await obj.json());
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    console.log("â° CRON Triggered: Memulai Aggregasi Otomatis...");
    ctx.waitUntil(runDailyCron(env));
  },

  async queue(batch, env) {
    if (batch.queue === "livetrade-processed-queue") {
      await handleProcessedBatch(batch, env);
      return;
    }

    // Backfill Queue (Shared)
    console.log(`📥 Queue Batch Received: ${batch.messages.length} messages`);
    for (const msg of batch.messages) {
      try {
        const job = msg.body; // { date, cursor, limit, force, type }

        // Routing based on Job Type
        if (job.type === 'seed_day') {
          console.log(`🌱 Processing Seed Job: ${job.date} on ${job.engine || 'BACKFILL_ENGINE_1'}`);
          await seedDay(env, job.date, job.engine);
          msg.ack();
          continue;
        }

        if (job.type === 'seed_hour') {
          console.log(`⏰ Processing Queue Hour Job: ${job.date} h=${job.hour} (mode=${job.mode})`);
          await seedHour(env, job.date, job.hour, job.reset, job.mode);
          msg.ack();
          continue;
        }

        // Default: Backfill Steps (Legacy)
        console.log(`🧶 Processing Backfill Job: date=${job.date}, cursor=${job.cursor}`);
        const fakeUrl = new URL("http://internal/step-backfill");
        if (job.date) fakeUrl.searchParams.set("date", job.date);
        if (job.cursor) fakeUrl.searchParams.set("cursor", job.cursor);
        if (job.limit) fakeUrl.searchParams.set("limit", String(job.limit));

        await stepBackfill(env, fakeUrl, true);
        msg.ack();
      } catch (err) {
        console.error("❌ Queue Job Failed:", err);
        msg.retry();
      }
    }
  },
};



// Restored runDailyCron
async function runDailyCron(env, force = false, dateOverride = null) {
  const now = new Date();
  const marketClosed = isMarketClosedWIB(now);

  let dateStr;
  if (dateOverride) {
    dateStr = dateOverride; // Use provided date
  } else {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    dateStr = `${y}-${m}-${d}`;
  }
  console.log(`📅 CRON Processing Date: ${dateStr} (marketClosed=${marketClosed}, force=${force})`);

  // Global const might be missing, reuse literal if needed
  const stateKey = `backfill_state_${dateStr}.json`;
  let state = { cursor: null, done: false };

  const stored = await env.DATA_LAKE.get(stateKey);
  if (stored) {
    try {
      state = await stored.json();
    } catch (e) {
      console.error("❌ Gagal parse state backfill, reset state:", e);
      state = { cursor: null, done: false };
    }
  }

  // Kalau sudah DONE dan market benar-benar tutup → boleh skip total
  // KECUALI kalau force=true → tetap jalankan
  if (state.done && marketClosed && !force) {
    console.log("✅ Backfill hari ini sudah selesai & market closed, cron skip.");
    return;
  }

  // Kalau force DAN state sudah DONE → reset untuk mulai lagi dari awal
  // Tapi hanya jika cursor masih null (belum mulai proses baru)
  if (force && state.done && !state.cursor) {
    console.log("⚠️ FORCE MODE: Resetting done flag to reprocess data");
    state.done = false;
    // cursor tetap null supaya pakai reset=true di stepBackfill
  }

  // Kalau state.done = true tapi market belum tutup (misal habis sesi 1 / break)
  // → anggap belum final, lanjutkan lagi.
  if (state.done && !marketClosed) {
    console.log("⚠️ state.done=true tapi market belum tutup, reset flag done=false & cursor=null.");
    state.done = false;
    state.cursor = null; // supaya next call pakai reset=true
  }


  const params = new URLSearchParams();
  params.set("date", dateStr);

  // Limit 2500 prevents timeout; Queue chaining handles EOD speed
  params.set("limit", "2500");

  if (!state.cursor) {
    params.set("reset", "true");
  } else {
    params.set("cursor", state.cursor);
  }

  // ⚠️ FLAG: cron minta TANPA snapshot di batch tengah
  // params.set("noSnapshot", "1"); // Disabled to save snapshot

  const fakeUrl = new URL(`http://internal/step-backfill?${params.toString()}`);

  const res = await stepBackfill(env, fakeUrl);
  const data = await res.json();

  if (data.status === "PROGRESS") {
    console.log(
      `🔄 Batch jalan. processed=${data.processed}, next_cursor=${data.next_cursor}`
    );
    state.cursor = data.next_cursor;
    state.done = false; // jelas belum selesai
    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));

    if (env.BACKFILL_QUEUE) {
      console.log(`🚀 Kickstarting Queue Chain (limit=2500)...`);
      await env.BACKFILL_QUEUE.send({
        date: dateStr,
        cursor: data.next_cursor,
        limit: 2500,
        force: force
      });
    }
  } else if (data.status === "DONE") {
    console.log(
      `✅ stepBackfill DONE (batch terakhir) untuk ${dateStr}, total_items: ${data.total_items}`
    );
    state.cursor = null;

    if (marketClosed) {
      // HANYA kalau market tutup baru kita anggap EOD final
      state.done = true;
      console.log("✅ Market closed → tandai backfill hari ini FINAL.");

      // 🧹 COMPRESSION & CLEANUP - Run after successful aggregation
      console.log("🧹 Starting post-aggregation cleanup...");

      // Compress YESTERDAY's data (safer than today)
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yY = yesterday.getUTCFullYear();
      const yM = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
      const yD = String(yesterday.getUTCDate()).padStart(2, "0");
      const yesterdayStr = `${yY}-${yM}-${yD}`;

      try {
        if (typeof compressRawLtForDate === 'function') {
          const compressResult = await compressRawLtForDate(env, yesterdayStr);
          console.log("📦 Compression result:", JSON.stringify(compressResult));
        }
      } catch (err) {
        console.error("❌ Compression failed:", err);
      }


      // Delete old raw_lt (7 days retention)
      try {
        if (typeof deleteOldRawLt === 'function') {
          const deleteResult = await deleteOldRawLt(env, 7);
          console.log("🗑️ Deletion result:", JSON.stringify(deleteResult));
        }
      } catch (err) {
        console.error("❌ Deletion failed:", err);
      }

      // 🧹 CLEANUP BACKFILL STATES
      try {
        if (typeof cleanupBackfillStates === 'function') {
          const cleanupStateResult = await cleanupBackfillStates(env);
          console.log("🧹 Backfill State Cleanup:", JSON.stringify(cleanupStateResult));
        }
      } catch (err) {
        console.error("❌ Backfill State Cleanup failed:", err);
      }
    } else {
      // Sesi 1 selesai / break / sesi 2 masih jalan → jangan final
      state.done = false;
      console.log(
        "⏳ stepBackfill DONE tapi market belum closed → akan lanjut kalau ada file baru (sesi berikutnya)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else if (data.status === "EMPTY") {
    console.log(`⚠️ Tidak ada data untuk tanggal ${dateStr} (status EMPTY).`);
    state.cursor = null;

    if (marketClosed) {
      // Misal hari libur penuh → boleh dianggap done
      state.done = true;
      console.log("📄 Hari ini kosong & market closed → tandai done.");
    } else {
      // Pagi sebelum market buka → jangan di-mark done, biar cron cek lagi nanti
      state.done = false;
      console.log(
        "🌅 EMPTY tapi market belum closed → akan cek lagi nanti (mungkin market belum buka)."
      );
    }

    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  } else {
    console.error("❌ Unknown status dari stepBackfill:", data);
    // Jangan ubah done, tapi tetap simpan state terbaru
    await env.DATA_LAKE.put(stateKey, JSON.stringify(state));
  }
}


// Manually process raw_lt -> footprint & processed for a full day
// NEW: Backfill via StateEngine Dispatch
// NEW: Backfill via StateEngine Dispatch
async function seedDay(env, dateStr, engineName = "BACKFILL_ENGINE_1") {
  const [y, m, d] = dateStr.split("-");
  const prefix = `raw_lt/${y}/${m}/${d}/`;

  let cursor = undefined;
  let processedCount = 0;
  const startTime = Date.now();

  const updateStatus = async (status) => {
    await env.DATA_LAKE.put(`seed_status/${dateStr}.json`, JSON.stringify({
      date: dateStr,
      updated: new Date().toISOString(),
      processed: processedCount,
      target_engine: engineName,
      status: status
    }));
  };

  await updateStatus("STARTING");

  // RESUME CHECKPOINT LOGIC
  try {
    const cpFile = await env.DATA_LAKE.get(`seed_checkpoint/${dateStr}.json`);
    if (cpFile) {
      const cpData = await cpFile.json();
      if (cpData.cursor) {
        cursor = cpData.cursor;
        console.log(`▶️ RESUMING from checkpoint: cursor=${cursor}`);
        await updateStatus("RESUMED");
      }
      if (cpData.processed) {
        processedCount = cpData.processed;
        console.log(`📊 RECOVERED processedCount: ${processedCount}`);
      }
    }
  } catch (e) {
    console.warn("Failed to read checkpoint, starting from scratch", e);
  }

  // Hourly routing handles binding selection dynamically below.


  try {
    while (true) {
      // Reduced limit to 50 to prevent OOM
      const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 50 });
      // Persist cursor AND processedCount checkpoint after each page so we can resume on timeout
      await env.DATA_LAKE.put(`seed_checkpoint/${dateStr}.json`, JSON.stringify({
        cursor: listed.cursor,
        processed: processedCount
      }));
      console.log(`🗂️ Listed ${listed.objects.length} objects, cursor=${listed.cursor}, totalProcessed=${processedCount}`);

      const processFile = async (obj) => {
        try {
          // Extract Date from Path: raw_lt/YYYY/MM/DD/...
          const pathParts = obj.key.split("/");
          if (pathParts.length < 5) return []; // Safety check
          const y = pathParts[1];
          const m = pathParts[2];
          const d = pathParts[3];

          const r = await env.DATA_LAKE.get(obj.key);
          if (!r) return [];
          const text = await r.text();
          const lines = text.split("\n");
          const itemsV2 = [];

          for (const line of lines) {
            const match = line.match(/"raw"\s*:\s*"([^"]+)"/);
            if (match) {
              const rawPipe = match[1];
              // Format: B|HHMMSS|...
              const pipeParts = rawPipe.split("|");
              let ts = Date.now();

              // Format: YYYYMMDD|HHMMSS|... (rawPipe is reliable source of truth)
              // If pipeParts[0] is date-like (8 chars), use it. timestamp from path is fallback.
              if (pipeParts.length >= 2) {
                const dStr = pipeParts[0].length === 8 ? pipeParts[0] : `${y}${m}${d}`;
                const tStr = pipeParts[1];

                if (dStr.length === 8 && tStr.length === 6) {
                  const Y = dStr.slice(0, 4);
                  const M = dStr.slice(4, 6);
                  const D = dStr.slice(6, 8);
                  const H = tStr.slice(0, 2);
                  const Min = tStr.slice(2, 4);
                  const S = tStr.slice(4, 6);

                  // Force WIB (+07:00) identity
                  const iso = `${Y}-${M}-${D}T${H}:${Min}:${S}+07:00`;
                  const parsed = Date.parse(iso);
                  if (!isNaN(parsed)) ts = parsed;
                }
              }

              itemsV2.push({
                v: 2,
                fmt: "pipe",
                src: "backfill_raw_lt",
                ts: ts,
                raw: rawPipe
              });
            }
          }
          return itemsV2;
        } catch (err) {
          console.error(`Error reading file ${obj.key}:`, err);
          return [];
        }
      };

      const results = await Promise.all(listed.objects.map(processFile));
      const batchV2 = results.flat();

      // Helper: Hourly Round-Robin Routing (7 Engines)
      const getEngineForHour = (h) => {
        // Map 0..23 hours to 1..7 engines
        // (h % 7) -> 0..6
        // +1 -> 1..7
        const id = (h % 7) + 1;
        return `BACKFILL_ENGINE_${id}`;
      };

      if (batchV2.length > 0) {
        // Group by Hour (UTC)
        const batchesByHour = {};
        for (const item of batchV2) {
          const h = new Date(item.ts).getUTCHours();
          if (!batchesByHour[h]) batchesByHour[h] = [];
          batchesByHour[h].push(item);
        }

        // Dispatch ALL hours in PARALLEL ("Keroyokan")
        await Promise.all(Object.entries(batchesByHour).map(async ([hourStr, items]) => {
          const hour = parseInt(hourStr);
          const engineName = getEngineForHour(hour);
          console.log(`🚀 Dispatching ${items.length} items for h=${hour} to ${engineName}`);
          const binding = env[engineName];

          if (!binding) {
            console.error(`Missing binding for ${engineName}`);
            return;
          }
          const id = binding.idFromName("BACKFILL_ENGINE");
          const stub = binding.get(id);

          // Process chunks sequentially per engine to respect rate limits/order
          for (let i = 0; i < items.length; i += 500) {
            const chunk = items.slice(i, i + 500);

            let attempts = 0;
            const maxAttempts = 3;
            while (true) {
              try {
                await stub.fetch("https://internal/trade-batch", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(chunk)
                });
                break;
              } catch (e) {
                attempts++;
                if (attempts >= maxAttempts) {
                  console.error(`Batch dispatch failed to ${engineName}`, e);
                  break;
                }
                const backoff = 50 * Math.pow(2, attempts);
                await new Promise(r => setTimeout(r, backoff));
              }
            }
            // slight throttle per engine
            await new Promise(r => setTimeout(r, 20));
          }
        }));
      }

      processedCount += listed.objects.length;
      if (processedCount % 50 === 0) {
        console.log(`🔄 Processed ${processedCount} items so far`);
        await updateStatus("PROCESSING");
      }

      if (!listed.truncated) break;
      cursor = listed.cursor;
    }

    console.log(`✅ seedDay COMPLETED for ${dateStr}. Total processed: ${processedCount}`);
    await updateStatus("COMPLETED");

  } catch (err) {
    console.error(`💥 seedDay FATAL ERROR for ${dateStr}:`, err);
    await updateStatus("FAILED");
  }
}

// Targetted Backfill for a single UTC hour
async function seedHour(env, dateStr, hourStr, reset = false, mode = "stream") {
  const logKey = `seed_logs/${dateStr}_h${hourStr}.log`;
  let logBuffer = [];
  const log = (msg) => {
    const ts = new Date().toISOString();
    logBuffer.push(`[${ts}] ${msg}`);
    console.log(msg); // Also console.log for tail
  };
  const flushLogs = async () => {
    if (logBuffer.length === 0) return;
    try {
      // Append to existing log file
      let existingLog = '';
      const existing = await env.DATA_LAKE.get(logKey);
      if (existing) existingLog = await existing.text();
      await env.DATA_LAKE.put(logKey, existingLog + logBuffer.join('\n') + '\n');
      logBuffer = [];
    } catch (e) {
      console.error('Failed to flush logs:', e);
    }
  };

  log(`🌱 seedHour task started for ${dateStr} hour ${hourStr} (reset=${reset}, mode=${mode})`);
  const [y, m, d] = dateStr.split("-");
  const prefix = `raw_lt/${y}/${m}/${d}/${hourStr}/`;
  const hour = parseInt(hourStr);
  const engineName = `BACKFILL_ENGINE_${(hour % 7) + 1}`;

  const statusKey = `seed_status/${dateStr}_h${hourStr}.json`;
  let processedCount = 0;
  let cursor = undefined;
  let startTime = Date.now(); // Default start time

  if (!reset) {
    try {
      const existingStatus = await env.DATA_LAKE.get(statusKey);
      if (existingStatus) {
        const data = await existingStatus.json();
        if (data.cursor) {
          cursor = data.cursor;
          processedCount = data.processed || 0;
          if (data.start_time) startTime = data.start_time; // Keep original start time
          log(`📡 RESUMING Hour Seed: cursor=${cursor}, processed=${processedCount}, elapsed=${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        }
      }
    } catch (e) {
      log(`⚠️ Failed to resume seedHour status: ${e.message}`);
    }
  } else {
    // Clear old log file on reset
    try { await env.DATA_LAKE.delete(logKey); } catch (e) { /* ignore */ }
  }

  const updateStatus = async (status, newCursor, newProcessed) => {
    if (newProcessed !== undefined) processedCount = newProcessed;
    const now = Date.now();
    const elapsed = ((now - startTime) / 1000).toFixed(1);

    await env.DATA_LAKE.put(statusKey, JSON.stringify({
      date: dateStr,
      hour: hourStr,
      updated: new Date().toISOString(),
      processed: processedCount,
      cursor: newCursor || cursor,
      target_engine: engineName,
      status: status,
      mode: mode,
      start_time: startTime,
      elapsed_sec: elapsed
    }));
  };

  await updateStatus("STARTING");

  try {
    const binding = env[engineName];
    if (!binding) throw new Error(`Missing binding for ${engineName}`);
    const id = binding.idFromName("BACKFILL_ENGINE");
    const stub = binding.get(id);

    // === PROCESSING LOGIC SPLIT ===
    if (mode === "warmup") {
      log(`🚀 Executing WARMUP MODE (Batch Ingest)`);
      // Implement Warmup Logic Here (Pass-through to DO Storage)
      // For now, we reuse the loop structure but will change the destination endpoint
      await processWarmupLoop(env, prefix, cursor, stub, log, updateStatus, flushLogs, processedCount, y, m, d, engineName, startTime);
    } else {
      log(`🌊 Executing STREAM MODE (Legacy Read-Merge-Write)`);
      await processStreamLoop(env, prefix, cursor, stub, log, updateStatus, flushLogs, processedCount, y, m, d, engineName);
    }

  } catch (err) {
    log(`💥 Error in seedHour: ${err.message}\n${err.stack}`);
    await updateStatus("FAILED");
    await flushLogs();
  }
}

// === SHARED HELPERS ===
async function listAndParse(env, prefix, cursor, y, m, d) {
  const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 50 });
  const processFile = async (obj) => {
    try {
      const r = await env.DATA_LAKE.get(obj.key);
      if (!r) return [];
      const text = await r.text();
      const lines = text.split("\n");
      const itemsV2 = [];
      for (const line of lines) {
        const match = line.match(/"raw"\s*:\s*"([^"]+)"/);
        if (match) {
          const rawPipe = match[1];
          const pipeParts = rawPipe.split("|");
          let ts = Date.now();
          if (pipeParts.length >= 2) {
            const dStr = pipeParts[0].length === 8 ? pipeParts[0] : `${y}${m}${d}`;
            const tStr = pipeParts[1];
            if (dStr.length === 8 && tStr.length === 6) {
              const iso = `${dStr.slice(0, 4)}-${dStr.slice(4, 6)}-${dStr.slice(6, 8)}T${tStr.slice(0, 2)}:${tStr.slice(2, 4)}:${tStr.slice(4, 6)}+07:00`;
              const parsed = Date.parse(iso);
              if (!isNaN(parsed)) ts = parsed;
            }
          }
          itemsV2.push({ v: 2, fmt: "pipe", src: "backfill_seed_hour", ts: ts, raw: rawPipe });
        }
      }
      return itemsV2;
    } catch (e) { return []; }
  };
  const results = await Promise.all(listed.objects.map(processFile));
  return { listed, batchV2: results.flat(), fileCount: listed.objects.length };
}


// === STREAM MODE IMPLEMENTATION ===
async function processStreamLoop(env, prefix, cursor, stub, log, updateStatus, flushLogs, processedCount, y, m, d, engineName) {
  while (true) {
    const { listed, batchV2, fileCount } = await listAndParse(env, prefix, cursor, y, m, d);

    log(`📂 seedHour: listed ${fileCount} files (total ${processedCount}), cursor=${cursor || "START"}`);
    log(`📦 seedHour: parsed ${batchV2.length} trades`);

    if (batchV2.length > 0) {
      for (let i = 0; i < batchV2.length; i += 500) {
        const chunk = batchV2.slice(i, i + 500);
        log(`🚀 seedHour: Dispatching chunk ${i / 500 + 1} (${chunk.length} items) to ${engineName}`);
        // STANDARD ENDPOINT (Triggers immediate R2 merge)
        await stub.fetch("https://internal/trade-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk)
        });
      }
    }

    processedCount += fileCount;
    cursor = listed.cursor;
    await updateStatus("PROCESSING", cursor);
    log(`✅ seedHour: Page processed. nextCursor=${cursor || "NONE"}`);
    await flushLogs();

    if (!listed.truncated) break;
  }
  log(`🎉 seedHour COMPLETED. Total processed: ${processedCount}`);
  await updateStatus("COMPLETED");
  await flushLogs();
}

// === WARMUP MODE IMPLEMENTATION (Placeholder for now) ===
async function processWarmupLoop(env, prefix, cursor, stub, log, updateStatus, flushLogs, processedCount, y, m, d, engineName, startTime) {
  // Currently re-uses the same flow but we will change the ENDPOINT later
  const workerStart = Date.now(); // Track execution time of THIS invocation
  const MAX_FILES_PER_HOUR = 2000; // Hard limit to prevent infinite processing
  let sessionFilesCount = 0; // Count files processed in THIS invocation only
  const SESSION_FLUSH_INTERVAL = 100; // Flush every 100 files within session (~10k trades)

  while (true) {
    // 0. Check Max Files Limit
    if (processedCount >= MAX_FILES_PER_HOUR) {
      log(`⚠️ MAX FILES LIMIT REACHED (${processedCount} >= ${MAX_FILES_PER_HOUR}). Forcing FINALIZE...`);
      break;
    }

    // 1. Check Time Limit (Queue Chaining)
    const elapsed = Date.now() - workerStart;
    if (elapsed > 20000) { // 20 seconds soft limit
      log(`⏳ Time Limit Reached (${elapsed}ms). Yielding to Queue...`);
      // Re-enqueue self
      await env.BACKFILL_QUEUE.send({
        type: "seed_hour",
        date: `${y}-${m}-${d}`,
        hour: prefix.split('/')[4], // raw_lt/2026/01/09/HH/
        reset: false, // RESUME
        mode: "warmup"
      });
      await updateStatus("YIELDING"); // Mark as yielding

      // D1 LOGGING (YIELD)
      await logToD1(env, {
        date: `${y}-${m}-${d}`,
        hour: prefix.split('/')[4],
        status: "YIELDING",
        files_processed: processedCount,
        elapsed_sec: ((Date.now() - startTime) / 1000).toFixed(1),
        engine: engineName
      });

      await flushLogs();
      return; // Exit gracefully (ACK message)
    }

    const { listed, batchV2, fileCount } = await listAndParse(env, prefix, cursor, y, m, d);

    log(`📂 seedHour (WARMUP): listed ${fileCount} files, truncated=${listed.truncated}, cursor=${cursor ? cursor.slice(0, 30) : 'START'}`);
    log(`📦 seedHour (WARMUP): parsed ${batchV2.length} trades`);

    if (batchV2.length > 0) {
      // Chunk trades to stay under DO 128KB fetch limit (~500 trades = ~70KB)
      for (let i = 0; i < batchV2.length; i += 500) {
        const chunk = batchV2.slice(i, i + 500);

        // Retry logic for safety
        let attempts = 0;
        let sent = false;
        while (attempts < 3 && !sent) {
          try {
            await stub.fetch("https://internal/warmup-batch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(chunk)
            });
            sent = true;
          } catch (e) {
            attempts++;
            log(`⚠️ Send failed attempt ${attempts}: ${e.message}`);
            await new Promise(r => setTimeout(r, 500));
          }
        }
        if (!sent) log(`❌ FAILED to send chunk ${i} after 3 attempts`);
      }
    }
    processedCount += fileCount;
    cursor = listed.cursor;
    await updateStatus("PROCESSING_WARMUP", cursor, processedCount);

    // D1 LOGGING (Every 100 files)
    if (processedCount % 100 === 0) {
      await logToD1(env, {
        date: `${y}-${m}-${d}`,
        hour: prefix.split('/')[4],
        status: "PROCESSING_WARMUP",
        files_processed: processedCount,
        elapsed_sec: ((Date.now() - startTime) / 1000).toFixed(1),
        engine: engineName
      });
    }

    // Checkpoint every 100 files (not every loop)
    if (processedCount % 100 === 0) {
      await flushLogs();
    }

    // Track session-local file count
    sessionFilesCount += fileCount;

    // Periodic flush every SESSION_FLUSH_INTERVAL files within THIS session
    if (sessionFilesCount >= SESSION_FLUSH_INTERVAL) {
      log(`🔄 Session flush at ${sessionFilesCount} local / ${processedCount} total files...`);
      try {
        await stub.fetch("https://internal/flush-warmup", { method: "POST" });
        sessionFilesCount = 0; // Reset session counter
        log(`✅ Session flush completed`);
      } catch (e) {
        log(`⚠️ Session flush failed: ${e.message}`);
      }
    }

    // Exit conditions: no more pages OR no files found in this batch
    if (!listed.truncated || fileCount === 0) break;
  }

  // After all files ingested, trigger FINALIZE
  log(`🏁 WARMUP Ingest Done. Triggering FINALIZE on ${engineName}...`);
  try {
    const finalizeRes = await stub.fetch("https://internal/finalize-warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const finalizeData = await finalizeRes.json();
    log(`🎉 FINALIZE Result: ${JSON.stringify(finalizeData)}`);
  } catch (e) {
    log(`💥 FINALIZE FAILED: ${e.message}`);
    throw e;
  }

  log(`🎉 seedHour WARMUP+FINALIZE COMPLETED.`);
  await updateStatus("COMPLETED", null, processedCount);

  // D1 LOGGING (FINAL)
  await logToD1(env, {
    date: `${y}-${m}-${d}`,
    hour: prefix.split('/')[4],
    status: "COMPLETED",
    files_processed: processedCount,
    elapsed_sec: ((Date.now() - startTime) / 1000).toFixed(1),
    engine: engineName
  });

  await flushLogs();
}

// D1 Logging Helper
async function logToD1(env, data) {
  try {
    if (!env.DB) return;
    const jobId = `${data.date}_h${data.hour}`;
    await env.DB.prepare(
      `INSERT INTO backfill_stats (job_id, date, hour, status, files_processed, elapsed_sec, engine) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(jobId, data.date, data.hour, data.status, data.files_processed, parseFloat(data.elapsed_sec), data.engine).run();
  } catch (e) {
    console.error("D1 Log Error:", e);
  }
}

// OLD: Deprecated
async function _deprecated_seedDay(env, dateStr) {
  const [y, m, d] = dateStr.split("-");
  const prefix = `raw_lt/${y}/${m}/${d}/`;

  let cursor = undefined;
  let processedCount = 0;
  const startTime = Date.now();

  // Status Tracker
  const updateStatus = async (status) => {
    await env.DATA_LAKE.put(`seed_status/${dateStr}.json`, JSON.stringify({
      date: dateStr,
      updated: new Date().toISOString(),
      processed: processedCount,
      status: status
    }));
  };

  await updateStatus("STARTING");

  const dailyState = {};
  const getTickerState = (ticker) => {
    if (!dailyState[ticker]) {
      dailyState[ticker] = {
        buckets: {}, open_day: 0, high_day: 0, low_day: Infinity, totalVol: 0, netVol: 0, freq: 0, last_updated: 0
      };
    }
    return dailyState[ticker];
  };

  try {
    while (true) {
      const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 50 });

      await Promise.all(listed.objects.map(async (obj) => {
        try {
          const r = await env.DATA_LAKE.get(obj.key);
          if (!r) return;
          const text = await r.text();
          const lines = text.split("\n");

          for (const line of lines) {
            const t = normalizeTradeFromLine(line, dateStr);
            if (!t) continue;

            const s = getTickerState(t.kode);
            const tr = String(t.timeRaw || "000000").padStart(6, '0');
            const hh = tr.slice(0, 2);
            const mm = tr.slice(2, 4);
            const timeKey = `${hh}:${mm}`;

            let bucket = s.buckets[timeKey];
            if (!bucket) {
              bucket = { vol: 0, netVol: 0, close: t.harga, valBucket: 0 };
              s.buckets[timeKey] = bucket;
            }

            if (!bucket.o) bucket.o = t.harga;
            bucket.h = Math.max(bucket.h || 0, t.harga);
            bucket.l = Math.min(bucket.l || Infinity, t.harga);
            bucket.c = t.harga;

            bucket.vol += t.vol;
            bucket.valBucket += (t.harga * t.vol);

            if (t.harga > bucket.o) bucket.netVol += t.vol;
            else if (t.harga < bucket.o) bucket.netVol -= t.vol;

            if (s.open_day === 0) s.open_day = t.harga;
            s.high_day = Math.max(s.high_day, t.harga);
            s.low_day = Math.min(s.low_day, t.harga);
            s.totalVol += t.vol;
          }
        } catch (err) {
          console.error(`Error processing file ${obj.key}:`, err);
        }
      }));

      processedCount += listed.objects.length;

      // Periodically update status (every ~500 files or every loop)
      if (processedCount % 200 === 0) {
        await updateStatus("PROCESSING");
      }

      if (!listed.truncated) break;
      cursor = listed.cursor;
    }

    await updateStatus("WRITING");

    // ... (Rest of writing logic same as before, simplified for diff clarity)
    // I need to include the writing block or reuse it. 
    // Since I'm replacing the WHOLE seedDay function body in this tool call context, 
    // I must include the writing part.

    // 2. Finalize & Write R2
    const writePromises = [];

    for (const [ticker, s] of Object.entries(dailyState)) {
      s.netVol = 0;
      Object.values(s.buckets).forEach(b => s.netVol += b.netVol);
      writePromises.push(env.DATA_LAKE.put(`processed/${ticker}/state.json`, JSON.stringify(s)));

      const finalWrapper = {};
      finalWrapper[ticker] = s;
      const outputArray = buildFinalOutputFromStats(finalWrapper, dateStr);
      const timeline = outputArray[0] ? outputArray[0].history : [];

      const publicData = {
        ticker,
        last_updated: new Date().toISOString(),
        day_stats: {
          o: s.open_day, h: s.high_day, l: s.low_day, v: s.totalVol, nv: s.netVol
        },
        timeline
      };

      writePromises.push(env.DATA_LAKE.put(`processed/${ticker}/intraday.json`, JSON.stringify(publicData)));

      // PATCH C: Group by UTC hour derived from candle.t0 (not WIB timeStr)
      const byHour = {};
      for (const [timeStr, b] of Object.entries(s.buckets)) {
        const candle = {
          t0: new Date(`${dateStr}T${timeStr}:00+07:00`).getTime(),
          ohlc: { o: b.o, h: b.h, l: b.l, c: b.close },
          vol: b.vol,
          delta: b.netVol,
          levels: []
        };
        // Derive UTC hour from candle.t0
        const dt = new Date(candle.t0);
        const hy = dt.getUTCFullYear();
        const hm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const hd = String(dt.getUTCDate()).padStart(2, "0");
        const hh = String(dt.getUTCHours()).padStart(2, "0");
        const hourPrefix = `${hy}/${hm}/${hd}/${hh}`;
        if (!byHour[hourPrefix]) byHour[hourPrefix] = [];
        byHour[hourPrefix].push(candle);
      }

      for (const [hourPrefix, candles] of Object.entries(byHour)) {
        const path = `footprint/${ticker}/1m/${hourPrefix}.jsonl`;
        const body = candles.map(c => JSON.stringify(c)).join("\n");
        writePromises.push(env.DATA_LAKE.put(path, body));
      }
    }

    await Promise.all(writePromises);
    await updateStatus("COMPLETED");
    return { tickers: Object.keys(dailyState).length, raw_files: processedCount, duration: Date.now() - startTime };

  } catch (e) {
    console.error("Seeding Failed", e);
    await env.DATA_LAKE.put(`seed_status/${dateStr}.json`, JSON.stringify({
      date: dateStr,
      status: "FAILED",
      error: e.message,
      processed: processedCount
    }));
    throw e; // Retry queue
  }
}

/**
 * Helper: Round time ke kelipatan 5 menit terdekat (format "HH:mm")
 * Menerima berbagai format timeRaw, akan di-normalisasi menjadi 6 digit (HHMMSS)
 */
function getTimeBucket(timeRaw) {
  // Buang semua non-digit, ambil 6 digit terakhir
  let cleaned = String(timeRaw).replace(/\D/g, "");
  if (!cleaned) cleaned = "000000";
  if (cleaned.length > 6) cleaned = cleaned.slice(-6);
  const str = cleaned.padStart(6, "0");

  let hh = parseInt(str.substring(0, 2), 10);
  let mm = parseInt(str.substring(2, 4), 10);

  // Round down (FLOOR) ke kelipatan 5 menit terdekat
  const remainder = mm % 5;
  if (remainder !== 0) {
    mm = mm - remainder;
  }
  // No rollover needed for floor

  const hStr = String(hh).padStart(2, "0");
  const mStr = String(mm).padStart(2, "0");
  return `${hStr}:${mStr}`;
}

// ✅ HELPER: Fast JSON String Extractor (No Regex, Handle Escapes)
function extractJsonStringField(lineText, fieldName) {
  // cari token "raw":
  const key = `"${fieldName}"`;
  const k = lineText.indexOf(key);
  if (k < 0) return null;

  // cari ':' setelah "raw"
  let i = k + key.length;
  while (i < lineText.length && /\s/.test(lineText[i])) i++;
  if (lineText[i] !== ":") return null;
  i++;
  while (i < lineText.length && /\s/.test(lineText[i])) i++;

  // harus dimulai dengan "
  if (lineText[i] !== '"') return null;
  i++;

  // parse string JSON dengan escape
  let out = "";
  while (i < lineText.length) {
    const ch = lineText[i];
    if (ch === '"') return out;            // end string
    if (ch === "\\") {
      const nxt = lineText[i + 1];
      if (nxt === undefined) return null;
      // handle escape paling umum
      if (nxt === '"' || nxt === "\\" || nxt === "/") { out += nxt; i += 2; continue; }
      if (nxt === "b") { out += "\b"; i += 2; continue; }
      if (nxt === "f") { out += "\f"; i += 2; continue; }
      if (nxt === "n") { out += "\n"; i += 2; continue; }
      if (nxt === "r") { out += "\r"; i += 2; continue; }
      if (nxt === "t") { out += "\t"; i += 2; continue; }
      if (nxt === "u") {
        const hex = lineText.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        return null;
      }
      // escape aneh -> fallback
      return null;
    }
    out += ch;
    i++;
  }
  return null;
}

// Helper: Hybrid Normalize from LINE TEXT directly
// Supports GEN-1 (Legacy Pipe), GEN-2 (Fast Extract), and Fallback (Full JSON)
// Returns { timeRaw, kode, papan, harga, vol, source, tsMs } or null
function normalizeTradeFromLine(lineText, defaultDateStr) {
  if (!lineText) return null;

  // (0) LEGACY: kalau line itu pure pipe (jaga-jaga)
  if (lineText.includes("|") && !lineText.includes("{") && !lineText.includes('"raw"')) {
    const parts = lineText.split("|");
    if (parts.length >= 8) {
      const harga = Number(parts[6]);
      const vol = Number(parts[7]);
      const papan = parts[4];
      const timeRaw = parts[1];
      if (papan === "RG" && Number.isFinite(harga) && Number.isFinite(vol) && vol > 0) {
        const hh = timeRaw.slice(0, 2) || "00";
        const mm = timeRaw.slice(2, 4) || "00";
        const ss = timeRaw.slice(4, 6) || "00";
        // WIB is UTC+7. ISO format with offset: YYYY-MM-DDTHH:mm:ss+07:00
        const tsFromRaw = Date.parse(`${defaultDateStr}T${hh}:${mm}:${ss}+07:00`);
        return { timeRaw, kode: parts[3], papan, harga, vol, source: "PIPE_LINE", tsMs: Number.isFinite(tsFromRaw) ? tsFromRaw : Date.now() };
      }
    }
  }

  // (1) FAST PATH: ambil raw string tanpa JSON.parse
  const rawStr = extractJsonStringField(lineText, "raw");
  // const fmtStr = extractJsonStringField(lineText, "fmt"); // optional

  if (rawStr && rawStr.includes("|")) {
    const parts = rawStr.split("|");
    if (parts.length >= 8) {
      const harga = Number(parts[6]);
      const vol = Number(parts[7]);
      const papan = parts[4];
      const timeRaw = parts[1];
      if (papan === "RG" && Number.isFinite(harga) && Number.isFinite(vol) && vol > 0) {

        // Fix TS calculation for FAST_RAW too
        const hh = timeRaw.slice(0, 2) || "00";
        const mm = timeRaw.slice(2, 4) || "00";
        const ss = timeRaw.slice(4, 6) || "00";
        const tsFromRaw = Date.parse(`${defaultDateStr}T${hh}:${mm}:${ss}+07:00`);

        return {
          timeRaw,
          kode: parts[3],
          papan,
          harga,
          vol,
          source: "FAST_RAW",
          tsMs: Number.isFinite(tsFromRaw) ? tsFromRaw : Date.now()
        };
      }
    }
  }

  // (2) FALLBACK: full JSON.parse (untuk fmt=obj atau kasus escape aneh)
  let lineObj;
  try { lineObj = JSON.parse(lineText); } catch { return null; }

  if (!lineObj || lineObj.raw == null) return null;

  const raw = lineObj.raw;
  const tsMs = Number(lineObj.ts) || Date.now();
  const fmt = lineObj.fmt;

  // B1: pipe string dalam JSON
  if (typeof raw === "string" && raw.includes("|")) {
    const parts = raw.split("|");
    if (parts.length < 8) return null;
    const harga = Number(parts[6]);
    const vol = Number(parts[7]);
    const papan = parts[4];
    const timeRaw = parts[1];
    if (papan !== "RG" || !Number.isFinite(harga) || !Number.isFinite(vol) || vol <= 0) return null;
    return { timeRaw, kode: parts[3], papan, harga, vol, source: "JSON_PIPE", tsMs };
  }

  // B2: structured object
  if (typeof raw === "object" && raw !== null) {
    const code = raw.code || raw.symbol || raw.ticker;
    const board = raw.board || raw.papan || raw.b || "RG";
    const price = Number(raw.price || raw.last || raw.harga || raw.p);
    const volume = Number(raw.volume || raw.vol || raw.qty || raw.v);

    let timeRaw = raw.time || raw.trade_time || raw.t;
    if (!timeRaw && tsMs) {
      const wibMs = tsMs + 7 * 60 * 60 * 1000;
      const d = new Date(wibMs);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      const ss = String(d.getUTCSeconds()).padStart(2, "0");
      timeRaw = `${hh}${mm}${ss}`;
    }

    if (!code || board !== "RG" || !Number.isFinite(price) || !Number.isFinite(volume) || volume <= 0) return null;
    return { timeRaw: String(timeRaw || "000000").replace(/:/g, ""), kode: code, papan: board, harga: price, vol: volume, source: "JSON_OBJ", tsMs };
  }

  return null;


  // ======= MOMENTUM & INTENTION SCORING (SIMPLE) =======
  function computeMomentumFromTrades(trades) {
    // trades: array { ts, raw }
    if (!trades || trades.length < 2) return 0;

    const parsePrice = (raw) => {
      const parts = String(raw).split("|");
      const h = parseInt(parts[6], 10);
      return Number.isNaN(h) ? null : h;
    };

    const firstValid = trades.find((t) => parsePrice(t.raw) !== null);
    const lastValid = [...trades].reverse().find((t) => parsePrice(t.raw) !== null);

    if (!firstValid || !lastValid) return 0;

    const p0 = parsePrice(firstValid.raw);
    const p1 = parsePrice(lastValid.raw);
    if (!p0 || !p1 || p0 === 0) return 0;

    // momentum sederhana: % change
    const pct = (p1 - p0) / p0;

    // clamp biar ga kebangetan
    const clamped = Math.max(-0.05, Math.min(0.05, pct)); // -5%..+5%

    // normalisasi ke -1..+1
    return clamped / 0.05;
  }




  // Helper: ambil objek-objek R2 paling recent untuk suatu prefix
  async function listRecentObjects(env, prefix, maxObjects = 50, pageSize = 100) {
    let cursor = undefined;
    let all = [];

    while (true) {
      const opts = { prefix, limit: pageSize };
      if (cursor) opts.cursor = cursor;

      const listed = await env.DATA_LAKE.list(opts);

      if (listed.objects && listed.objects.length > 0) {
        all.push(...listed.objects);
      }

      if (!listed.truncated) break;     // sudah page terakhir
      cursor = listed.cursor;

      // kalau sudah numpuk banyak banget, cukup simpan ekornya saja
      if (all.length >= maxObjects * 3) break;
    }

    // Ambil ekor saja (yang paling baru)
    if (all.length > maxObjects) {
      all = all.slice(-maxObjects);
    }

    return all;
  }

  async function loadLatestTradesForKode(env, kode, maxTrades = 50) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const H = String(now.getUTCHours()).padStart(2, "0");

    const prefixesToTry = [
      `raw_lt/${y}/${m}/${d}/${H}/`,
      `raw_lt/${y}/${m}/${d}/`,
    ];

    const trades = [];

    for (const prefix of prefixesToTry) {
      // ambil objek PALING BARU
      const maxObjects = Math.max(10, Math.ceil(maxTrades / 5));
      const objs = await listRecentObjects(env, prefix, maxObjects, 100);
      if (!objs || objs.length === 0) continue;

      for (const obj of objs) {
        const r = await env.DATA_LAKE.get(obj.key);
        const text = await r.text();
        const trimmed = text.trim();
        if (!trimmed) continue;

        const lines = trimmed.split("\n");
        for (const line of lines) {
          // Patch 2.2: Use normalizeTradeFromLine
          const trade = normalizeTradeFromLine(line, `${y}-${m}-${d}`);
          if (!trade) continue;
          if (trade.kode !== kode) continue;

          const hhmmss = String(trade.timeRaw || "000000").padStart(6, '0');

          // Build canonical raw string for MOMENTUM & HAKA calc
          // Format: YYYYMMDD|HHMMSS|X|CODE|RG|T|PRICE|VOL
          const canonicalRaw = `${y}${m}${d}|${hhmmss}|0|${kode}|RG|T|${trade.harga}|${trade.vol}`;
          const tsMs = Number.isFinite(trade.tsMs) ? trade.tsMs : (obj.uploaded || Date.now());

          trades.push({ ts: tsMs, raw: canonicalRaw });
        }
        // Cannot easily break early due to unsorted nature of files, 
        // but we limit objects at list level.
      }
      if (trades.length > 0) break;
    }

    if (trades.length === 0) return [];

    // Sort by timestamp
    trades.sort((a, b) => a.ts - b.ts);
    return trades.slice(-maxTrades);
  }

  async function realtimeSignal(env, url) {
    try {
      const kode = (url.searchParams.get("kode") || "GOTO").toUpperCase();
      const lite = url.searchParams.get("lite") === "1";

      // 1. Ambil data LT (trades)
      const maxTrades = lite ? 40 : 100;
      const trades = await loadLatestTradesForKode(env, kode, maxTrades);

      // 2. Ambil OB snapshot hanya kalau mode FULL
      let obSnapshot = null;
      let intentionScore = 0;

      if (!lite) {
        try {
          const obResp = await env.ORDERBOOK_AGG.fetch(
            "https://internal/intention?kode=" + kode
          );
          if (obResp.ok) {
            const obData = await obResp.json();
            intentionScore = obData.intention_score || 0;
            obSnapshot = obData.snapshot || null; // kalau mau sekalian kirim snapshot ringkas
          }
        } catch (e) {
          console.warn("Gagal fetch intention dari worker OB:", e);
        }
      }

      // 3. Hitung volume & HAKA dari raw_lt
      let totalVol = 0;
      let buyVol = 0;
      let lastPrice = null;
      let lastTrade = null;

      for (const t of trades) {
        const rawLine = String(t.raw || "");
        const parts = rawLine.split("|");
        if (parts.length < 8) continue;

        const papan = parts[4];
        if (papan !== "RG") continue;

        const harga = Number(parts[6]);
        const vol = Number(parts[7]);
        if (!Number.isFinite(harga) || !Number.isFinite(vol)) continue;

        totalVol += vol;

        let dir = 0;
        if (lastPrice === null) {
          dir = 0;
        } else if (harga > lastPrice) {
          dir = 1;
        } else if (harga < lastPrice) {
          dir = -1;
        }

        if (dir > 0) {
          buyVol += vol;
        }

        lastPrice = harga;
        lastTrade = {
          ts: t.ts,
          price: harga,
          volume: vol,
          dir,
        };
      }

      const hakaRatio = totalVol > 0 ? buyVol / totalVol : 0.5;

      // 4. Momentum (dari trades)
      const momentumScore = computeMomentumFromTrades(trades); // -1..+1

      // 6. Fused signal
      const hakaNorm = (hakaRatio - 0.5) * 2; // 0.5 â†’ 0, 1 â†’ +1, 0 â†’ -1
      let fused = lite
        ? hakaNorm // mode ringan: pakai HAKA saja
        : 0.6 * hakaNorm + 0.4 * intentionScore;

      if (!Number.isFinite(fused)) fused = 0;

      let side = "NONE";
      if (fused > 0.2) side = "BUY";
      else if (fused < -0.2) side = "SELL";

      const payload = {
        status: "OK",
        kode,
        mode: lite ? "lite" : "full",

        haka_ratio: Number(hakaRatio.toFixed(3)),
        momentum_score: Number(momentumScore.toFixed(3)),
        intention_score: Number(intentionScore.toFixed(3)),
        fused_signal: Number(fused.toFixed(3)),
        side,

        sample_counts: {
          trades: totalVol,
          has_orderbook: !!obSnapshot,
        },
        last_trade: lastTrade,
        ob_snapshot: lite ? null : obSnapshot,

        debug: {
          trades_count: trades.length,
          first_ts: trades[0]?.ts || null,
          first_raw: trades[0]?.raw || null,
          last_ts: lastTrade?.ts || null,
          last_price: lastTrade?.price || null,
        },
      };

      return new Response(JSON.stringify(payload, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("realtimeSignal error:", err);
      return new Response(
        JSON.stringify({ status: "ERROR", message: String(err) }, null, 2),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }



  /**
   * LOGIC UTAMA BACKFILL
   * isQueue: jika true, fungsi ini tidak return Response tpi melakukan chain ke queue (atau throw error)
   */
  async function stepBackfill(env, url, isQueue = false) {
    const dateParam = url.searchParams.get("date");
    const cursor = url.searchParams.get("cursor");
    const reset = url.searchParams.get("reset");
    // Snapshot Policy: "none" | "final" | "periodic" (default: "periodic" for today, "none" for past)
    let snapshotMode = url.searchParams.get("snapshotMode");

    if (!snapshotMode) {
      // Auto-detect default
      const todayStr = new Date().toISOString().split('T')[0];
      if (dateParam === todayStr) snapshotMode = "periodic";
      else snapshotMode = "none";
    }

    const noSnapshot = snapshotMode === "none"; // Compatibility alias for legacy noSnapshot flag

    let limit = parseInt(url.searchParams.get("limit"), 10);
    if (!limit || Number.isNaN(limit)) limit = 250;

    if (!dateParam) {
      return new Response("Error: Butuh param ?date=YYYY-MM-DD", {
        status: 400,
      });
    }

    const [y, m, d] = dateParam.split("-");
    const prefix = `raw_lt/${y}/${m}/${d}/`;
    const tempFile = `temp_state_${dateParam}.json`;

    let stats = {};
    if (!reset) {
      const existing = await env.DATA_LAKE.get(tempFile);
      if (existing) {
        try {
          stats = await existing.json();
        } catch (e) {
          stats = {};
        }
      }
    }

    const listParams = { prefix, limit };
    if (cursor) listParams.cursor = cursor;

    const listed = await env.DATA_LAKE.list(listParams);

    if (listed.objects.length === 0 && !cursor) {
      return new Response(
        JSON.stringify(
          { status: "EMPTY", message: "Tidak ada data." },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    // Bounded Concurrency & Sequential Processing
    const FETCH_CONCURRENCY = 50;

    // Counters
    let totalLines = 0;
    let parsedOk = 0;
    let skipped = 0;
    let countRegex = 0;
    let countJsonLegacy = 0;
    let countJsonObject = 0;
    const MAX_LOG_SAMPLE = 5;
    let logSampleCount = 0;

    const v2GlobalBatch = [];

    for (let i = 0; i < listed.objects.length; i += FETCH_CONCURRENCY) {
      const chunk = listed.objects.slice(i, i + FETCH_CONCURRENCY);

      // Fetch chunk in parallel
      const chunkResults = await Promise.all(
        chunk.map(obj => env.DATA_LAKE.get(obj.key).then(r => r.text()).catch(e => ""))
      );

      // Process chunk immediately (do not store)
      chunkResults.forEach((content) => {
        const text = content.trim();
        if (!text) return;

        const lines = text.split("\n");
        lines.forEach((line) => {
          if (!line) return;
          totalLines++;

          const trade = normalizeTradeFromLine(line, dateParam);

          if (!trade) {
            skipped++;
            if (logSampleCount < MAX_LOG_SAMPLE) {
              console.warn(`âš ï¸  Skip Line: ${line.slice(0, 200)}`);
              logSampleCount++;
            }
            return;
          }

          parsedOk++;
          if (trade.source === "REGEX") countRegex++;
          else if (trade.source === "JSON_LEGACY") countJsonLegacy++;
          else if (trade.source === "JSON_OBJECT") countJsonObject++;

          const { timeRaw, kode, harga, vol } = trade;

          // Logic Statistik
          if (!stats[kode]) {
            stats[kode] = {
              open_day: 0,
              high_day: 0,
              low_day: null,
              totalVol: 0,
              freq: 0,
              lastPrice: null,
              lastDir: 0,
              netVol: 0,
              buckets: {},
              lastRaw: null,
            };
          }

          const s = stats[kode];

          // OHLC harian
          if (s.open_day === 0) s.open_day = harga;
          if (harga > s.high_day) s.high_day = harga;
          if (s.low_day == null || harga < s.low_day) s.low_day = harga;

          s.totalVol += vol;
          s.freq += 1;

          let dir = 0;
          if (s.lastPrice == null) {
            dir = 0;
          } else if (harga > s.lastPrice) {
            dir = 1;
          } else if (harga < s.lastPrice) {
            dir = -1;
          } else {
            dir = s.lastDir || 0;
          }

          s.netVol += dir * vol;
          s.lastPrice = harga;
          s.lastDir = dir;
          // s.lastRaw = raw; // Disabled to save memory/complexity in hybrid

          // V2 BATCH
          if (env.STATE_ENGINE_V2) {
            // Fix Timezone: enforce +07:00 (WIB)
            const fullTs = `${dateParam}T${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}+07:00`;
            let v2Side = 'sell';
            if (dir === 1) v2Side = 'buy';
            else if (dir === -1) v2Side = 'sell';
            else if (s.lastDir === 1) v2Side = 'buy';

            v2GlobalBatch.push({
              ticker: kode,
              price: harga,
              amount: vol,
              side: v2Side,
              timestamp: Date.parse(fullTs) // use parse for reliability
            });
          }

          const bucketTime = getTimeBucket(timeRaw);

          if (!s.buckets[bucketTime]) {
            s.buckets[bucketTime] = {
              close: harga,
              vol: 0,
              netVol: 0,
              valBucket: 0,
            };
          }

          const b = s.buckets[bucketTime];
          b.vol += vol;
          b.close = harga;
          b.netVol += dir * vol;
          b.valBucket += vol * harga * 100;

        });
      });

      // Free memory for this chunk
    }


    // Flush V2 Batch (Global)
    if (v2GlobalBatch.length > 0 && env.STATE_ENGINE_V2) {
      try {
        const idV2 = env.STATE_ENGINE_V2.idFromName("GLOBAL_V2_ENGINE");
        const stubV2 = env.STATE_ENGINE_V2.get(idV2);
        // Fire and forget (await if strictly necessary, but catch handles error)
        stubV2.fetch("https://internal/batch-update", {
          method: "POST",
          body: JSON.stringify(v2GlobalBatch)
        }).catch(err => console.warn("V2 Global Batch Failed", err));
      } catch (errSync) {
        console.warn("V2 Global Batch Setup Failed", errSync);
      }
    }

    // LOG SUMMARY
    console.log(`ðŸ“Š [Parsed] OK: ${parsedOk}, Skipped: ${skipped} (Total: ${totalLines}). Sources -> Regex: ${countRegex}, JSON-Legacy: ${countJsonLegacy}, JSON-Object: ${countJsonObject}`);
    console.log("âš ï¸  netVol uses uptick dir based on processing order; may vary across reruns unless strict sorting is enabled.");


    const hasMore = listed.truncated;
    const nextCursor = listed.cursor;
    // âš ï¸ MODE RINGAN: kalau noSnapshot = true, JANGAN build finalOutput sama sekali
    // if (noSnapshot) { ... } // DISABLED: Always save snapshot

    const status = hasMore ? "PROGRESS" : "DONE";

    // QUEUE LOGIC: If hasMore, push next task to queue
    if (isQueue && hasMore) {
      // Construct next job
      const job = {
        date: dateParam,
        cursor: nextCursor,
        limit: limit,
        force: true // Always force in queue to bypass checks
      };
      console.log(`ðŸ”„ Queue Chain: Sending next batch (cursor=${nextCursor})`);
      await env.BACKFILL_QUEUE.send(job);
      return; // Void return for queue consumer
    }

    if (isQueue && !hasMore) {
      console.log("âœ… Queue Job Done: No more data.");
      // Lanjut ke logic DONE di bawah (buildFinalOutput) untuk cleanup
    }

    if (!isQueue && noSnapshot) { // Legacy HTTP mode with noSnapshot
      // ... existing HTTP logic ...
      await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));
      return new Response(JSON.stringify({
        status, processed: listed.objects.length, next_cursor: hasMore ? nextCursor : null, limit_used: limit
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }



    // Di sini hanya:
    // - batch terakhir dari cron (noSnapshot=true tapi hasMore=false), atau
    // - pemanggilan manual tanpa noSnapshot (misal HTTP)
    const finalOutput = buildFinalOutputFromStats(stats, dateParam);

    if (hasMore) {
      await env.DATA_LAKE.put(tempFile, JSON.stringify(stats));

      // Snapshot Policy Check
      if (snapshotMode === "periodic") {
        // Throttle: Only write partial snapshot every 1 minute or so
        const snapKey = `snapshot_state_${dateParam}.json`;
        let snapState = { lastSnapshotTs: 0 };

        // Try read existing state
        const stored = await env.DATA_LAKE.get(snapKey);
        if (stored) {
          try { snapState = await stored.json(); } catch (e) { }
        }

        const nowMs = Date.now();
        // Write if first time OR > 60s since last
        if (!snapState.lastSnapshotTs || (nowMs - snapState.lastSnapshotTs) >= 60000) {
          await env.DATA_LAKE.put("snapshot_latest.json", JSON.stringify(finalOutput));

          // Update state
          snapState.lastSnapshotTs = nowMs;
          await env.DATA_LAKE.put(snapKey, JSON.stringify(snapState));
          // console.log("ðŸ“¸ Snapshot updated (Throttled)");
        } else {
          // console.log(`â ³ Snapshot throttled. Next in ${60000 - (nowMs - snapState.lastSnapshotTs)}ms`);
        }
      }

      // If snapshotMode is 'final', we DO NOT write here.

      // (Legacy STATE_ENGINE write removed)

      // ============================================
      // V2 PARALLEL DISPATCH (Double Write)
      // ============================================
      try {
        if (env.STATE_ENGINE_V2) {
          // We need to send parsed trades, not aggregated swings.
          // We have `parsed` items above (line 981).
          // Let's send them in batch or individually. DO expects single update or batch?
          // My DO impl handles `/update` with single trade object: { ticker, price, side, vol, timestamp }
          // Let's adapt `parsed` items which are { s, p, v, t, type }.

          // Optimization: Create a batch endpoint in DO V2 later. For now, Promise.all.
          // Actually, let's just fire and forget loop to avoid timeout.
          const idV2 = env.STATE_ENGINE_V2.idFromName("GLOBAL_V2_ENGINE");
          const stubV2 = env.STATE_ENGINE_V2.get(idV2);

          // Limit V2 concurrency/load for now?
          // Doing full dual-write might be heavy. Let's do it.
          const v2Promises = finalOutput.flatMap(item => {
            // Wait, `finalOutput` is aggregated swings. We want RAW TRADES `parsed`.
            // `parsed` variable is not available here scope-wise easily unless we look up.
            // Ah, `parsed` is inside the loop. 
            // Better strategy: We should do this INSIDE the `processRawFile` logic or iterate `parsed` array if accessible.
            // `listed.objects` loop processes files.
            // I will insert this logic deep inside the file processing loop.
            return [];
          });
        }
      } catch (errV2) {
        console.error("Failed dispatch V2", errV2);
      }

      // QUEUE LOGIC: If hasMore, push next task to queue
      if (isQueue) {
        const job = {
          date: dateParam,
          cursor: nextCursor,
          limit: limit,
          force: true
        };
        console.log(`ðŸ”„ Queue Chain: Sending next batch (middle of cron)`);
        await env.BACKFILL_QUEUE.send(job);
        return;
      }

      // HTTP Response
      return new Response(
        JSON.stringify(
          {
            status: "PROGRESS",
            processed: listed.objects.length,
            next_cursor: nextCursor,
            limit_used: limit,
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Batch terakhir â†’ FINAL EOD
    if (finalOutput.length === 0) {
      await env.DATA_LAKE.delete(tempFile).catch(() => { });
      return new Response(
        JSON.stringify({ status: "DONE", total_items: 0 }, null, 2),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    await env.DATA_LAKE.put("snapshot_latest.json", JSON.stringify(finalOutput));
    await env.DATA_LAKE.put(
      `processed/${dateParam}.json`,
      JSON.stringify(finalOutput)
    );
    await env.DATA_LAKE.delete(tempFile).catch(() => { });

    // (Legacy STATE_ENGINE write removed)

    return new Response(
      JSON.stringify(
        {
          status: "DONE",
          total_items: finalOutput.length,
          message: "Selesai!",
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Compress all raw_lt files for a specific date into a single gzipped file
   * @param {Object} env - Worker environment bindings
   * @param {string} dateStr - Date in YYYY-MM-DD format
   * @returns {Object} - Compression result with stats
   */
  async function compressRawLtForDate(env, dateStr) {
    const [y, m, d] = dateStr.split('-');
    const prefix = `raw_lt/${y}/${m}/${d}/`;
    const outputKey = `raw_lt_compressed/${dateStr}.jsonl.gz`;

    console.log(`ðŸ—œï¸ Starting compression for ${dateStr}...`);

    // Check if already compressed
    const existing = await env.DATA_LAKE.head(outputKey);
    if (existing) {
      console.log(`âœ… Already compressed: ${outputKey}`);
      return { compressed: true, skipReason: 'already_exists', outputKey };
    }

    // List files with a reasonable limit to avoid API issues
    const MAX_FILES = 500; // Limit to avoid "Too many API requests" error
    const files = [];
    let cursor;
    let listCount = 0;
    const MAX_LIST_CALLS = 5; // Limit list operations

    do {
      const listed = await env.DATA_LAKE.list({ prefix, cursor, limit: 100 });
      files.push(...listed.objects);
      cursor = listed.truncated ? listed.cursor : null;
      listCount++;

      // Stop if we have enough files or made too many list calls
      if (files.length >= MAX_FILES || listCount >= MAX_LIST_CALLS) {
        console.log(`âš ï¸ Reached limit: ${files.length} files listed in ${listCount} calls`);
        break;
      }
    } while (cursor);

    if (files.length === 0) {
      console.log(`âš ï¸ No files to compress for ${dateStr}`);
      return { compressed: false, skipReason: 'no_files' };
    }

    // Fetch and concatenate files (limit to MAX_FILES to avoid memory/API issues)
    const filesToProcess = files.slice(0, MAX_FILES);
    const allLines = [];
    let originalSize = 0;

    for (const file of filesToProcess) {
      const obj = await env.DATA_LAKE.get(file.key);
      const text = await obj.text();
      const trimmed = text.trim();
      if (trimmed) {
        allLines.push(trimmed);
      }
      originalSize += file.size;
    }

    const combined = allLines.join('\n');

    // Compress using CompressionStream and collect into ArrayBuffer
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(combined));
        controller.close();
      }
    });

    const compressedStream = stream.pipeThrough(
      new CompressionStream('gzip')
    );

    // Collect stream into buffer
    const reader = compressedStream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    // Combine chunks into single Uint8Array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const compressedData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      compressedData.set(chunk, offset);
      offset += chunk.length;
    }

    // Upload compressed file with known length
    await env.DATA_LAKE.put(outputKey, compressedData, {
      httpMetadata: {
        contentType: 'application/gzip'
      }
    });

    const compressedSize = compressedData.length;
    const compressionRatio = Math.round((compressedSize / originalSize) * 100);

    console.log(`âœ… Compressed ${dateStr}: ${files.length} files, ${originalSize}â†’${compressedSize} bytes (${compressionRatio}%)`);

    return {
      compressed: true,
      fileCount: files.length,
      originalSize,
      compressedSize,
      compressionRatio,
      outputKey
    };
  }

  /**
   * Delete raw_lt folders older than retentionDays
   * @param {Object} env - Worker environment bindings  
   * @param {number} retentionDays - Keep data for this many days
   * @returns {Object} - Deletion result with stats
   */
  async function deleteOldRawLt(env, retentionDays = 7) {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const cutoffY = cutoffDate.getUTCFullYear();
    const cutoffM = String(cutoffDate.getUTCMonth() + 1).padStart(2, '0');
    const cutoffD = String(cutoffDate.getUTCDate()).padStart(2, '0');
    const cutoffStr = `${cutoffY}-${cutoffM}-${cutoffD}`;

    console.log(`ðŸ—‘ï¸ Deleting raw_lt older than ${cutoffStr} (${retentionDays} days retention)`);

    // List all files in raw_lt with date-based filtering
    const toDelete = [];
    const datesFound = new Set();
    let cursor;

    do {
      const listed = await env.DATA_LAKE.list({
        prefix: 'raw_lt/',
        cursor,
        limit: 1000
      });

      for (const obj of listed.objects) {
        // Parse date from path: raw_lt/YYYY/MM/DD/...
        const match = obj.key.match(/^raw_lt\/(\d{4})\/(\d{2})\/(\d{2})\//);
        if (!match) continue;

        const [_, y, m, d] = match;
        const fileDate = `${y}-${m}-${d}`;
        datesFound.add(fileDate);

        // Only delete if older than cutoff
        if (fileDate < cutoffStr) {
          toDelete.push(obj.key);
        }
      }

      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);

    if (toDelete.length === 0) {
      console.log(`âœ… No old files to delete (found dates: ${Array.from(datesFound).sort()})`);
      return { deleted: false, fileCount: 0, cutoffDate: cutoffStr, skipReason: 'no_old_files' };
    }

    // Delete in batches
    const batchSize = 100;
    let deleted = 0;

    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      await Promise.all(batch.map(key =>
        env.DATA_LAKE.delete(key).catch(err =>
          console.error(`Failed to delete ${key}:`, err)
        )
      ));
      deleted += batch.length;
    }

    console.log(`âœ… Deleted ${deleted} old raw_lt files (cutoff: ${cutoffStr})`);

    return {
      deleted: true,
      fileCount: deleted,
      cutoffDate: cutoffStr,
      datesDeleted: Array.from(datesFound).filter(d => d < cutoffStr).sort()
    };
  }

  /**
   * Cleanup old backfill_state_*.json files
   * Keep only the most recent one (or two), delete the rest via Batch Delete Worker
   */
  async function cleanupBackfillStates(env) {
    const prefix = BACKFILL_STATE_PREFIX; // "backfill_state_"

    // 1. List all state files
    const listed = await env.DATA_LAKE.list({ prefix });
    const allFiles = listed.objects;

    if (allFiles.length <= 1) {
      return { skipped: true, reason: "Not enough files to clean (<= 1)", count: allFiles.length };
    }

    // 2. Sort by uploaded time (descending) -> newest first
    // key format: backfill_state_YYYY-MM-DD.json
    // We can also sort by key since YYYY-MM-DD is lexicographically sortable
    allFiles.sort((a, b) => b.key.localeCompare(a.key));

    // 3. Keep the newest 2 files (active today + maybe yesterday) just to be safe
    const KEEP_COUNT = 2;
    const toDelete = allFiles.slice(KEEP_COUNT);

    if (toDelete.length === 0) {
      return { skipped: true, reason: "No old files to delete", count: allFiles.length };
    }

    const keysToDelete = toDelete.map(o => o.key);
    console.log(`ðŸ§¹ Found ${keysToDelete.length} old backfill states to delete:`, keysToDelete);

    // 4. Send to Batch Delete Worker
    if (!env.BATCH_DELETE) {
      console.warn("âš ï¸ BATCH_DELETE binding missing, falling back to manual delete");
      // Fallback: manual delete one by one
      let deletedCount = 0;
      for (const key of keysToDelete) {
        await env.DATA_LAKE.delete(key);
        deletedCount++;
      }
      return { manual: true, deleted: deletedCount };
    }

    try {
      const resp = await env.BATCH_DELETE.fetch("https://batch-delete/delete-keys?bucket=saham", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: keysToDelete })
      });

      const resJson = await resp.json();
      return {
        success: resp.ok,
        worker_response: resJson,
        deleted_keys: keysToDelete.length
      };
    } catch (err) {
      throw new Error(`Failed to call BATCH_DELETE: ${err.message}`);
    }
  }

}

// --- INTRADAY PROCESSED PIPELINE ---


// --- SHARED HELPERS ---

function buildFinalOutputFromStats(stats, dateStr) {
  return Object.keys(stats).map((kode) => {
    const s = stats[kode];
    const sortedTimes = Object.keys(s.buckets).sort();

    let cumVol = 0;
    let cumVal = 0;

    // Pakai range harian (high - low)
    const hasRange =
      s.high_day > 0 && s.low_day != null && s.high_day !== s.low_day;
    const dayRange = hasRange ? s.high_day - s.low_day : 0;

    // Profil quadran (buat iceberg / hidden acc)
    let q1 = 0,
      q2 = 0,
      q3 = 0,
      q4 = 0;
    let q4Vol = 0;
    let totalBuckets = 0;

    const timeline = sortedTimes.map((time) => {
      const b = s.buckets[time];

      const bucketVol = b.vol || 0;
      const bucketNetVol = b.netVol || 0;
      const bucketVal = b.valBucket || bucketVol * b.close * 100;

      cumVol += bucketVol;
      cumVal += bucketVal;

      // Momentum vs open day
      const momentum =
        s.open_day > 0 ? ((b.close - s.open_day) / s.open_day) * 100 : 0;

      // Absorption: cumVol / (high - low). Jika range 0 -> fallback ke cumVol
      const absorption = dayRange > 0 ? cumVol / dayRange : cumVol;

      // Money / Haka per bucket
      let moneyRaw = 0;
      if (bucketVol > 0) {
        moneyRaw = bucketNetVol / bucketVol; // -1..+1
      }
      const haka = (moneyRaw + 1) * 50; // 0..100
      const xAxis = haka - 50; // -50..+50

      // Profil quadran: X = xAxis, Y = momentum
      totalBuckets += 1;
      if (xAxis >= 0 && momentum >= 0) {
        q1++;
      } else if (xAxis < 0 && momentum >= 0) {
        q2++;
      } else if (xAxis < 0 && momentum < 0) {
        q3++;
      } else if (xAxis >= 0 && momentum < 0) {
        q4++;
        q4Vol += bucketVol;
      }

      return {
        t: time, // "HH:MM"
        p: b.close,
        v: cumVal, // cumulative value sampai bucket ini
        dv: bucketVal, // value per bucket -> bubble size
        m: Number(momentum.toFixed(2)),
        a: Number(absorption.toFixed(1)),
        haka: Number(haka.toFixed(1)),
        x: Number(xAxis.toFixed(1)),
      };
    });

    const lastPoint = timeline[timeline.length - 1] || {};

    const openDay = s.open_day || lastPoint.p || 0;
    const closeDay = lastPoint.p || openDay;
    const highDay = s.high_day || closeDay;
    const lowDay = s.low_day ?? closeDay;
    const totalVol = s.totalVol;
    const freq = s.freq;
    const netVol = s.netVol;

    const moneyFlow = totalVol > 0 ? netVol / totalVol : 0;

    // Profil iceberg / hidden accumulation
    const totalQ = q1 + q2 + q3 + q4 || 1;
    const q4Ratio = q4 / totalQ;
    const volBias = totalVol > 0 ? q4Vol / totalVol : 0;
    const buyBias = moneyFlow > 0 ? moneyFlow : 0;

    const hiddenAccScore = Number(
      (q4Ratio * volBias * buyBias).toFixed(4)
    );

    return {
      kode,
      date: dateStr, // Injected Date
      mode: "swing",

      open: openDay,
      close: closeDay,
      high: highDay,
      low: lowDay,
      vol: totalVol,
      freq,
      net_vol: netVol,
      money_flow: Number(moneyFlow.toFixed(4)),
      momentum: lastPoint.m ?? 0,
      absorption: lastPoint.a ?? 0,
      val: lastPoint.v ?? 0,

      quadrant_profile: {
        q1,
        q2,
        q3,
        q4,
        q4_ratio: Number(q4Ratio.toFixed(3)),
      },
      hidden_acc_score: hiddenAccScore,

      history: timeline,

      // raw trade terakhir (kalau mau dipakai di UI)
      last_raw: s.lastRaw || null,
    };
  });
}

async function handleProcessedBatch(batch, env) {
  for (const msg of batch.messages) {
    try {
      const job = msg.body;
      // job: { type: "minute_finalized", ticker, timeKey, hourPrefix, source, ts }
      if (job.type === "minute_finalized") {
        await processIntradayMinute(env, job);
      }
      msg.ack();
    } catch (e) {
      console.error("Processed Job Error", e);
      msg.retry();
    }
  }
}

async function processIntradayMinute(env, job) {
  const { ticker, timeKey, hourPrefix } = job;
  console.log(`🧵 processIntradayMinute: ${ticker} @ ${new Date(timeKey).getUTCHours()}:${new Date(timeKey).getUTCMinutes()} (UTC) from ${hourPrefix}`);

  // 1. Fetch Footprint Data
  const r2Key = `footprint/${ticker}/1m/${hourPrefix}.jsonl`;
  const obj = await env.DATA_LAKE.get(r2Key);
  if (!obj) {
    console.warn(`⚠️ Footprint missing: ${r2Key}`);
    return;
  }

  const text = await obj.text();
  const lines = text.split("\n").filter(l => l.trim().length > 0);
  console.log(`📄 Read ${lines.length} lines from ${r2Key}`);

  // Find valid candle for this minute (or all minutes in file to be safe/idempotent)
  // Actually, to be robust, we should merge the *entire file* into the state buckets for that hour
  // This allows re-processing/backfill to work naturally.

  // 2. Load State
  const stateKey = `processed/${ticker}/state.json`;
  let state = {
    buckets: {},
    open_day: 0,
    high_day: 0,
    low_day: Infinity,
    totalVol: 0,
    netVol: 0,
    freq: 0,
    last_updated: 0
  };

  try {
    const sObj = await env.DATA_LAKE.get(stateKey);
    if (sObj) state = await sObj.json();
  } catch (e) { /* ignore new state */ }

  // 3. Update State with new candles
  const candles = lines.map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(c => c !== null);

  let updated = false;

  for (const c of candles) {
    // C1: Only apply candles with t0 <= job.timeKey (strict minute_finalized semantics)
    // For backfill or rebuilds, job.timeKey might be huge or null, so we handle that.
    if (job.timeKey && typeof job.timeKey === "number" && c.t0 > job.timeKey) continue;

    // R8: Convert t0 (UTC ms) to HH:mm using UTC
    const d = new Date(c.t0);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    // Initialize Day Stats if first candle
    if (state.open_day === 0) state.open_day = c.ohlc.o;
    if (state.low_day === Infinity || state.low_day === 0) state.low_day = c.ohlc.l;

    // Update Day Level
    state.high_day = Math.max(state.high_day, c.ohlc.h);
    state.low_day = Math.min(state.low_day, c.ohlc.l);

    const bucket = {
      vol: c.vol,
      netVol: c.delta,
      close: c.ohlc.c,
      valBucket: c.vol * c.ohlc.c * 100
    };

    state.buckets[timeStr] = bucket;
    updated = true;
  }

  if (!updated) return;

  // Recalculate Totals
  state.totalVol = 0;
  state.netVol = 0;
  Object.values(state.buckets).forEach(b => {
    state.totalVol += b.vol;
    state.netVol += b.netVol;
  });

  state.last_updated = Date.now();

  // 4. Save State
  await env.DATA_LAKE.put(stateKey, JSON.stringify(state));

  // 5. Generate & Save Public Output
  // Use existing buildFinalOutputFromStats logic but for single ticker
  const finalWrapper = {};
  finalWrapper[ticker] = state;

  // We reuse the existing function which returns an ARRAY of objects
  // [ { t:..., p:..., ... } ] (inside the loop for each kode)
  // Wait, buildFinalOutputFromStats returns an array of results? 
  // No, it maps keys -> result. Let's check line 764.
  // keys.map(...) -> returns array of results.

  const [yStr, mStr, dStr] = hourPrefix.split("/");
  const dateStr = `${yStr}-${mStr}-${dStr}`;
  const outputArray = buildFinalOutputFromStats(finalWrapper, dateStr);
  // outputArray[0] is the full stats object { history: [...], ... }
  const timeline = outputArray[0] ? outputArray[0].history : [];

  // Construct the final JSON payload expected by frontend
  const publicData = {
    ticker,
    last_updated: new Date().toISOString(),
    day_stats: {
      o: state.open_day,
      h: state.high_day,
      l: state.low_day,
      v: state.totalVol,
      nv: state.netVol
    },
    timeline // The chart data
  };

  await env.DATA_LAKE.put(`processed/${ticker}/intraday.json`, JSON.stringify(publicData), {
    httpMetadata: { contentType: "application/json", cacheControl: "max-age=60" }
  });
}



