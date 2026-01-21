/**
 * @worker livetrade-taping
 * @objective Ingests live trade and orderbook data via WebSocket (socketcluster), buffers it in a Durable Object, and flushes raw data to R2.
 *
 * @endpoints
 * - GET /watchlist -> Returns active watchlist (internal/debug)
 * - GET /update?token=... -> Updates WS session token (internal)
 * - GET /shutdown or /restart -> Forces restart/eviction (internal/ops)
 * - GET / -> Status page (internal/health)
 *
 * @triggers
 * - http: yes (Proxy to Durable Object)
 * - cron: none
 * - queue: none
 * - durable_object: TradeIngestor
 * - alarms: yes (Frequent, ~2000ms, for flushing buffers and WS connectivity)
 *
 * @io
 * - reads: WebSocket (external ipotapp.ipot.id), DO Storage (token)
 * - writes: R2 (raw_lt, raw_ob, raw_ws)
 *
 * @relations
 * - upstream: IPOT WebSocket (via wss)
 * - downstream: livetrade-taping-agregator (via R2 raw files)
 *
 * @success_metrics
 * - WebSocket uptime/connectivity
 * - Data flush success rate (items saved to R2)
 * - Latency of flush operations
 *
 * @notes
 * - Maintains persistent WebSocket connection inside Durable Object.
 * - Implements failsafe buffering (rollback on R2 failure).
 * - "Req G/D/E" comments refer to specific functional requirements (Batch size, Max bytes, JSONL).
 */
import { DurableObject } from "cloudflare:workers";

// 🔧 Helper: build watchlist dari env
function buildWatchList(env) {
  const parse = (val) =>
    String(val || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

  const lq45 = parse(env.WATCHLIST_LQ45);
  const idx30 = parse(env.WATCHLIST_IDX30);

  const merged = [...new Set([...lq45, ...idx30])];

  // fallback kalau env kosong
  if (merged.length === 0) return ["GOTO"];

  return merged;
}


export default {
  async fetch(request, env, ctx) {
    const id = env.TRADE_INGESTOR.idFromName("MAIN_INGESTOR");
    const stub = env.TRADE_INGESTOR.get(id);
    return stub.fetch(request);
  },
};

export class TradeIngestor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;

    // Default Token
    this.currentSession = "";

    // Config
    // Config (Optimized for Requirement A & D)
    this.BATCH_SIZE = 500;         // Req G: Default 500
    this.FLUSH_INTERVAL_MS = 5000; // Req G: 5000ms
    this.ALARM_INTERVAL_MS = 2000; // Req A: 2000ms

    this.MAX_BYTES_LT = 512 * 1024; // Req D: 512KB
    this.MAX_BYTES_OB = 256 * 1024; // Req D: 256KB

    this.buffer = [];     // LT
    this.bufferOB = [];   // OB2
    this.BATCH_SIZE_OB = 200; // Req G: 200

    this.ws = null;
    this.lastFlushLT = Date.now();
    this.lastFlushOB = Date.now();

    // Part 1: Raw WS Safety Net
    this.bufferWS = [];
    this.BATCH_SIZE_WS = 200;
    this.MAX_BYTES_WS = 256 * 1024;
    this.lastFlushWS = Date.now();
    this.isFlushingWS = false;

    // PATCH 1: V2 Pipeline Buffer (StateEngine dispatch)
    this.bufferV2 = [];
    this.BATCH_SIZE_V2 = 300;
    this.MAX_BYTES_V2 = 256 * 1024;
    this.MAX_BUFFER_V2 = 10000; // B6: Safety cap
    this.lastFlushV2 = Date.now();
    this.isFlushingV2 = false;

    // B4: Dispatch observability
    this.lastDispatchTs = 0;
    this.lastDispatchOk = false;
    this.lastDispatchErr = "";
    this.lastDispatchStats = { accepted: 0, deduped: 0, errors: 0 };
    this.dispatchFailStreak = 0;  // A1: Track consecutive dispatch failures

    // Req C: Flush Locks
    this.isFlushingLT = false;
    this.isFlushingOB = false;

    // Req F: Sanity Throttling
    this.lastSanityLT = 0;
    this.SANITY_INTERVAL = 60000; // 1 min

    // 🟢 watchlist unik (LQ45 + IDX30, tanpa duplikat)
    this.watchList = buildWatchList(env);
    console.log("[OB] Watchlist aktif:", this.watchList.join(", "));

    this.ctx.blockConcurrencyWhile(async () => {
      const storedToken = await this.ctx.storage.get("session_token");
      if (storedToken) {
        this.currentSession = storedToken;
        console.log("Token loaded:", this.currentSession.substr(0, 10) + "...");
      }
    });

    // Req A: Frequent Alarm
    this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 1) API watchlist internal
    if (url.pathname === "/watchlist") {
      return new Response(
        JSON.stringify(
          {
            symbols: this.watchList,         // array ["BBRI","BBCA",...]
            counts: {
              total: this.watchList.length,
            },
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 2) Update token
    if (url.pathname === "/update") {
      return this.handleUpdateToken(url);
    }

    // 🔧 Force Restart (Eviction Strategy)
    if (url.pathname === "/shutdown" || url.pathname === "/restart") {
      const key = url.searchParams.get("key");
      // Hardcoded safety check for now, ideally use env.INTERNAL_SECRET
      if (key !== "saham-internal-ops") {
        return new Response("Unauthorized", { status: 401 });
      }

      console.log(`🔴 ${url.pathname} requested. Clearing alarms & closing WS.`);
      await this.ctx.storage.deleteAlarm();
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      return new Response("✅ Service Restart Triggered. Instance will evict and reload on next request.");
    }

    // 3) Status Page default (B4: Extended observability)
    let ws_status = "CLOSED";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) ws_status = "OPEN";
    else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) ws_status = "CONNECTING";

    return new Response(
      JSON.stringify(
        {
          ws_status,
          currentSession: this.currentSession ? "present" : "missing",
          bufferSizeLT: this.buffer.length,
          bufferSizeOB: this.bufferOB.length,
          bufferV2_len: this.bufferV2.length,
          lastFlushLT: new Date(this.lastFlushLT).toISOString(),
          lastFlushOB: new Date(this.lastFlushOB).toISOString(),
          lastDispatchTs: this.lastDispatchTs ? new Date(this.lastDispatchTs).toISOString() : null,
          lastDispatchOk: this.lastDispatchOk,
          lastDispatchErr: this.lastDispatchErr.slice(-200),
          lastDispatchStats: this.lastDispatchStats,
          binding_state_engine_present: !!this.env.STATE_ENGINE,
          watchlist_count: this.watchList.length,
        },
        null,
        2
      )
    );
  }

  // Logic ganti token tanpa restart worker
  async handleUpdateToken(url) {
    const newToken = url.searchParams.get("token");
    if (!newToken) return new Response("Error: Parameter ?token= tidak ada", { status: 400 });

    // 1. Simpan ke Memory & Storage
    this.currentSession = newToken;
    await this.ctx.storage.put("session_token", newToken);

    // 2. Matikan koneksi lama (Force Reconnect)
    if (this.ws) {
      console.log("Memutus koneksi lama untuk ganti token...");
      this.ws.close();
      this.ws = null;
    }

    // 3. Connect ulang segera
    this.connectStream();

    return new Response(`Sukses! Token diperbarui. Reconnecting...\nToken: ${newToken.substr(0, 10)}...`);
  }

  async alarm() {
    // Jangan connect kalau token kosong
    if (!this.currentSession) {
      console.log("Menunggu Token... (Hit /update?token=XYZ)");
      this.ctx.storage.setAlarm(Date.now() + 10000); // Backoff logic
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectStream();
    }

    const now = Date.now();
    const bufferSizeLT = JSON.stringify(this.buffer).length; // Approx size
    const bufferSizeOB = JSON.stringify(this.bufferOB).length;

    // Check Trigger LT
    if (this.buffer.length > 0 && !this.isFlushingLT) {
      const timeTrigger = (now - this.lastFlushLT) > this.FLUSH_INTERVAL_MS;
      const countTrigger = this.buffer.length >= this.BATCH_SIZE;
      const sizeTrigger = bufferSizeLT >= this.MAX_BYTES_LT;

      if (timeTrigger || countTrigger || sizeTrigger) {
        this.ctx.waitUntil(this.flushToR2()); // Req C: Async flush
      }
    }

    // Check Trigger OB
    if (this.bufferOB.length > 0 && !this.isFlushingOB) {
      const timeTrigger = (now - this.lastFlushOB) > this.FLUSH_INTERVAL_MS;
      const countTrigger = this.bufferOB.length >= this.BATCH_SIZE_OB;
      const sizeTrigger = bufferSizeOB >= this.MAX_BYTES_OB;

      if (timeTrigger || countTrigger || sizeTrigger) {
        this.ctx.waitUntil(this.flushOBToR2());
      }
    }

    // Check Trigger WS (Part 1.2)
    const bufferSizeWS = JSON.stringify(this.bufferWS).length;
    if (this.bufferWS.length > 0 && !this.isFlushingWS) {
      const timeTrigger = (now - this.lastFlushWS) > this.FLUSH_INTERVAL_MS;
      const countTrigger = this.bufferWS.length >= this.BATCH_SIZE_WS;
      const sizeTrigger = bufferSizeWS >= this.MAX_BYTES_WS;
      if (timeTrigger || countTrigger || sizeTrigger) {
        this.ctx.waitUntil(this.flushWSToR2());
      }
    }

    // PATCH 1: Check Trigger V2 (StateEngine dispatch)
    const bufferSizeV2 = JSON.stringify(this.bufferV2).length;
    if (this.bufferV2.length > 0 && !this.isFlushingV2) {
      const timeTrigger = (now - this.lastFlushV2) > 1000; // 1s for realtime
      // B1: Backoff if consecutive failures, increase effective interval
      const backoffActive = this.dispatchFailStreak >= 5;
      const timeTriggerWithBackoff = backoffActive ? (now - this.lastFlushV2) > 5000 : timeTrigger;
      const countTrigger = this.bufferV2.length >= this.BATCH_SIZE_V2;
      const sizeTrigger = bufferSizeV2 >= this.MAX_BYTES_V2;
      if (timeTriggerWithBackoff || countTrigger || sizeTrigger) {
        this.ctx.waitUntil(this.flushToStateEngineV2());
      }
    }

    // Req A: Always verify alarm existence/reschedule
    this.ctx.storage.setAlarm(Date.now() + this.ALARM_INTERVAL_MS);
  }

  connectStream() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      if (!this.currentSession) return;

      console.log("[WS] Connecting dengan token baru...");

      // Gunakan token dari variabel
      const wsUrl = `wss://ipotapp.ipot.id/socketcluster/?appsession=${this.currentSession}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener("open", () => {
        console.log("[WS] Connected! Handshaking...");

        this.ws.send(
          JSON.stringify({
            event: "#handshake",
            data: { authToken: null },
            cid: 1,
          })
        );

        setTimeout(() => {
          // 1) Live Trade global
          console.log("[WS] Subscribe Live Trade (LT)...");
          const subLT = {
            event: "cmd",
            data: {
              cmdid: 999,
              param: {
                cmd: "subscribe",
                service: "mi",
                rtype: "LT",
                code: "*",
                subsid: "livetrade_worker",
              },
            },
            cid: 2,
          };
          this.ws.send(JSON.stringify(subLT));

          // 2) OB2 untuk setiap kode unik
          console.log("[WS] Subscribe Orderbook (OB2) untuk watchlist...");
          this.watchList.forEach((kode, idx) => {
            const subOB = {
              event: "cmd",
              data: {
                cmdid: 1000 + idx,
                param: {
                  cmd: "subscribe",
                  service: "mi",
                  rtype: "OB2",
                  code: kode,                        // 🟢 contoh: TLKM
                  subsid: `ob_${kode}_sniper`,
                },
              },
              cid: 1000 + idx,
            };
            this.ws.send(JSON.stringify(subOB));
          });
        }, 1000);
      });


      this.ws.addEventListener("message", async (event) => {
        const rawMsg = event.data;
        // Part 1.2: Raw buffer capture
        if (typeof rawMsg === "string" && rawMsg.length > 0) {
          this.bufferWS.push({ ts: Date.now(), msg: rawMsg });
        }

        if (rawMsg === "#1") { this.ws.send("#2"); return; }
        try {
          const parsed = JSON.parse(rawMsg);
          if (parsed.event === "stream" || parsed.event === "#publish") {
            let rtype = parsed.data?.rtype || parsed.rtype;

            // === EXISTING LOGIC (Live Trade) ===
            if (rtype === "LT") {
              const tradeData = parsed.data?.data || parsed.data;
              // Part 1.1: Metadata injection
              const fmt = (typeof tradeData === "string" && tradeData.includes("|")) ? "pipe" : "obj";

              // B5: Derive timestamp from pipe fields (YYYYMMDD|HHMMSS|...)
              let ts_ms = Date.now();
              let ts_quality = "ingestion";

              if (fmt === "pipe" && typeof tradeData === "string") {
                const parts = tradeData.split("|");
                if (parts.length >= 2) {
                  try {
                    // parts[0] = YYYYMMDD, parts[1] = HHMMSS
                    const dateStr = parts[0]; // e.g., "20260115"
                    const timeStr = parts[1]; // e.g., "143025"
                    if (dateStr.length === 8 && timeStr.length === 6) {
                      const y = dateStr.slice(0, 4);
                      const m = dateStr.slice(4, 6);
                      const d = dateStr.slice(6, 8);
                      const hh = timeStr.slice(0, 2);
                      const mm = timeStr.slice(2, 4);
                      const ss = timeStr.slice(4, 6);
                      // PATCH A: Parse as WIB (+07:00) - Date.parse returns UTC epoch directly
                      const isoStr = `${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`;
                      const utcMs = Date.parse(isoStr);
                      if (!isNaN(utcMs)) {
                        ts_ms = utcMs;  // Already UTC, no conversion needed
                        ts_quality = "derived";
                      }
                    }
                  } catch (e) {
                    // Fallback to ingestion time
                  }
                }
              }

              const envelope = {
                v: 2,
                fmt,
                src: "ipot_ws",
                raw: tradeData,
                ts: ts_ms,
                ts_quality
              };
              this.buffer.push(envelope);

              // PATCH 1: Also push to V2 buffer for StateEngine dispatch
              this.bufferV2.push(envelope);

              // Req C: Remove await, threshold check via Alarm usually generally sufficient, 
              // but can trigger early if huge spike:
              if (this.buffer.length >= this.BATCH_SIZE * 2) {
                // Emergency flush signal (handled by next alarm or async if we want complex logic)
                // For requirement C, we do NOT await here.
              }
            }

            // === [BARU] NEW LOGIC (Orderbook GOTO) ===
            else if (rtype === "OB2") {
              const kode = (parsed.data && parsed.data.code) || parsed.code || "UNKNOWN";
              const obRaw = parsed.data || parsed;
              this.bufferOB.push({ kode, raw: obRaw, ts: Date.now() });
              // Req C: No await
            }


          }
        } catch (e) { }
      });

      this.ws.addEventListener("close", () => console.log("[WS] Closed."));
      this.ws.addEventListener("error", (e) => console.error("[WS] Error:", e));

    } catch (e) {
      console.error("[WS] Fatal:", e);
    }
  }

  // Req B: Safe Flush implementation
  async flushToR2() {
    if (this.buffer.length === 0) return;
    if (this.isFlushingLT) return; // Lock

    this.isFlushingLT = true;
    const pending = [...this.buffer];
    this.buffer = []; // Clear

    // Metadata for Log
    const count = pending.length;
    const now = new Date(); // Use distinct variable to avoid race conditions with Date.now()

    // Path: raw_lt/YYYY/MM/DD/HH/...
    // Part 1.3: Explicit UTC
    const path = `raw_lt/${now.getUTCFullYear()}/${(now.getUTCMonth() + 1).toString().padStart(2, '0')}/${now.getUTCDate().toString().padStart(2, '0')}/${now.getUTCHours().toString().padStart(2, '0')}`;

    // Req E: .jsonl extension
    const filename = `${path}/${Date.now()}_${count}.jsonl`;

    const fileContent = pending.map(JSON.stringify).join("\n");

    try {
      await this.env.DATA_LAKE.put(filename, fileContent);
      this.lastFlushLT = Date.now();

      // Req F: Throttled Sanity
      if (Date.now() - this.lastSanityLT > this.SANITY_INTERVAL) {
        const sanityPath = `${path}/sanity-info.json`;
        const sanityData = { last_update: Date.now(), status: "OK", count, service: "livetrade-taping" };
        // Fire & Forget sanity write to save latency
        this.ctx.waitUntil(this.env.DATA_LAKE.put(sanityPath, JSON.stringify(sanityData)));
        this.lastSanityLT = Date.now();
      }

      console.log(`[LT] Saved ${count} items.`);
    } catch (err) {
      console.error("[R2] Fail LT, Rolling back buffer:", err);
      // Req B: Rollback
      this.buffer.unshift(...pending);
    } finally {
      this.isFlushingLT = false;
    }
  }

  // --- [BARU] Fungsi Flush Khusus Orderbook ---
  // --- Fungsi Flush Khusus Orderbook (multi-kode) ---
  // Req B: Safe Flush for OB
  async flushOBToR2() {
    if (this.bufferOB.length === 0) return;
    if (this.isFlushingOB) return;

    this.isFlushingOB = true;
    const pending = [...this.bufferOB];
    this.bufferOB = [];

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const H = String(now.getHours()).padStart(2, "0");

    // Grouping
    const byKode = {};
    for (const row of pending) {
      const kode = (row.kode || "UNKNOWN").toUpperCase();
      if (!byKode[kode]) byKode[kode] = [];
      byKode[kode].push(row);
    }

    try {
      const promises = [];
      for (const [kode, rows] of Object.entries(byKode)) {
        const path = `raw_ob/${kode}/${y}/${m}/${d}/${H}`;
        const filename = `${path}/${Date.now()}_${kode}_${rows.length}.jsonl`; // Req E
        const fileContent = rows.map(JSON.stringify).join("\n");

        promises.push(
          this.env.DATA_LAKE.put(filename, fileContent)
            .then(() => console.log(`[OB] Saved ${rows.length} for ${kode}`))
            .catch(e => { throw e; }) // Throw to trigger rollback
        );
      }
      await Promise.all(promises);
      this.lastFlushOB = Date.now();
    } catch (err) {
      console.error("[R2] Fail OB, Rolling back:", err);
      this.bufferOB.unshift(...pending); // Rollback entire batch if ANY fail (simple strategy)
    } finally {
      this.isFlushingOB = false;
    }
  }

  // Part 1.4: Flush WS
  async flushWSToR2() {
    if (this.bufferWS.length === 0) return;
    if (this.isFlushingWS) return;

    this.isFlushingWS = true;
    const pending = [...this.bufferWS];
    this.bufferWS = [];

    const count = pending.length;
    const now = new Date();
    const path = `raw_ws/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCHours()).padStart(2, '0')}`;
    const filename = `${path}/${Date.now()}_${count}.jsonl`;
    const fileContent = pending.map(JSON.stringify).join("\n");

    try {
      await this.env.DATA_LAKE.put(filename, fileContent);
      this.lastFlushWS = Date.now();
      console.log(`[WS] Saved ${count} frames.`);
    } catch (err) {
      console.error("[R2] Fail WS, Rolling back:", err);
      this.bufferWS.unshift(...pending);
    } finally {
      this.isFlushingWS = false;
    }
  }

  // PATCH 1: Flush to StateEngine V2
  async flushToStateEngineV2() {
    if (this.bufferV2.length === 0) return;
    if (this.isFlushingV2) return;

    this.isFlushingV2 = true;

    // B6: Buffer safety cap - drop oldest if exceeded
    if (this.bufferV2.length > this.MAX_BUFFER_V2) {
      const dropped = this.bufferV2.length - this.MAX_BUFFER_V2;
      this.bufferV2 = this.bufferV2.slice(-this.MAX_BUFFER_V2);
      console.warn(`[V2] Buffer overflow, dropped ${dropped} oldest items.`);
    }

    const pending = [...this.bufferV2];
    this.bufferV2 = [];

    try {
      // Check if STATE_ENGINE binding exists
      if (!this.env.STATE_ENGINE) {
        this.lastDispatchErr = "STATE_ENGINE binding not found";
        this.lastDispatchOk = false;
        console.warn("[V2] STATE_ENGINE binding not found, skipping dispatch.");
        return;
      }

      const id = this.env.STATE_ENGINE.idFromName("GLOBAL_V2_ENGINE");
      const stub = this.env.STATE_ENGINE.get(id);

      const resp = await stub.fetch("https://internal/trade-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending),
      });

      if (!resp.ok) {
        throw new Error(`StateEngine /trade-batch failed: ${resp.status}`);
      }

      // B4: Update observability fields
      const result = await resp.json().catch(() => ({}));
      this.lastDispatchTs = Date.now();
      this.lastDispatchOk = true;
      this.lastDispatchErr = "";
      this.lastDispatchStats = {
        accepted: result.accepted || 0,
        deduped: result.deduped || 0,
        errors: result.errors || 0,
      };
      this.dispatchFailStreak = 0;  // A1: Reset on success
      this.lastFlushV2 = Date.now();
      console.log(`[V2] Dispatched ${pending.length} trades. Accepted: ${result.accepted}, Deduped: ${result.deduped}`);
    } catch (e) {
      // B4: Track error
      this.lastDispatchTs = Date.now();
      this.lastDispatchOk = false;
      this.lastDispatchErr = String(e);
      this.dispatchFailStreak += 1;  // A1: Increment on failure
      console.error("[V2] dispatch failed, rollback:", e);
      // B2: Rollback with cap to avoid memory spiral
      this.bufferV2 = pending.concat(this.bufferV2);
      if (this.bufferV2.length > this.MAX_BUFFER_V2) {
        this.bufferV2 = this.bufferV2.slice(-this.MAX_BUFFER_V2);
      }
    } finally {
      this.isFlushingV2 = false;
    }
  }


}