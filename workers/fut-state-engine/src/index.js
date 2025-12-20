// fut-state-engine/src/index.js
import { DurableObject } from "cloudflare:workers";

export default {
    async fetch(request, env) {
        const id = env.TOPSTEPX_TAPER.idFromName("MAIN_TAPER");
        const stub = env.TOPSTEPX_TAPER.get(id);
        return stub.fetch(request);
    },
};

export class TopstepXTaper extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ctx = ctx;
        this.env = env;

        // =========================
        // CONFIG FLAGS (SAFE MODE)
        // =========================
        this.ENABLE_FOOTPRINT = true;
        this.ENABLE_RAW_BACKUP = true;   // raw_tns tetap ada (tapi hemat: 1 file per menit)
        this.SYMBOL = env.TAPER_SYMBOL || "ENQ";
        this.TF = env.TAPER_TIMEFRAME || "1m";
        this.TICK = parseFloat(env.TAPER_TICK_SIZE || "0.25");

        // late trades grace (trade telat 1-2 detik masih masuk menit benar)
        this.GRACE_MS = parseInt(env.TAPER_GRACE_MS || "2000");

        // alarm cadence (jangan terlalu cepat biar hemat)
        this.ALARM_MS = parseInt(env.TAPER_ALARM_MS || "1000");

        // memory pressure thresholds
        this.MAX_CANDLES_IN_MEMORY = parseInt(env.TAPER_MAX_CANDLES || "100");
        this.MAX_RAW_BUCKETS = parseInt(env.TAPER_MAX_RAW_BUCKETS || "100");

        // L1 staleness threshold
        this.L1_MAX_STALENESS_MS = parseInt(env.TAPER_L1_STALENESS_MS || "5000");

        // write retry config
        this.MAX_WRITE_RETRIES = 3;
        this.WRITE_RETRY_BASE_MS = 500;

        // =========================
        // WS + TOKEN STATE
        // =========================
        this.accessToken = "";
        this.ws = null;
        this.handshakeConfirmed = false;

        // =========================
        // L1 QUOTE CONTEXT
        // =========================
        this.bestBid = 0;
        this.bestAsk = 0;
        this.bestBidTs = 0;
        this.bestAskTs = 0;

        // =========================
        // FOOTPRINT STATE
        // =========================
        this.candles = new Map(); // bucketTs -> candle
        this.lastWrittenMinuteTs = 0;

        // =========================
        // RAW BACKUP STATE (per-minute bucket)
        // =========================
        this.rawByMinute = new Map(); // minuteBucketTs -> array of raw frames strings

        // =========================
        // METRICS & MONITORING
        // =========================
        this.metrics = {
            wsDisconnects: 0,
            tradesProcessed: 0,
            l1QuoteUpdates: 0,
            integrityErrors: 0,
            writeFailures: 0,
            writeRetries: 0,
            memoryPressureEvents: 0,
            l1StalenessEvents: 0,
            alarmExecutions: 0,
            lastAlarmDurationMs: 0,
        };

        // counters
        this.messageCount = 0;
        this.lastWriteOkAt = 0;
        this.workerStartedAt = Date.now();

        // restore token
        this.ctx.blockConcurrencyWhile(async () => {
            const token = await this.ctx.storage.get("access_token");
            if (token) {
                this.accessToken = token;
                // Auto-reconnect WebSocket on startup if token exists
                this.connectSignalR();
            }
        });

        // start alarm AFTER everything initialized
        this.ctx.storage.setAlarm(Date.now() + this.ALARM_MS);
    }

    // =========================
    // ROUTES
    // =========================
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/subscribe") {
            this.subscribeToMarketData();
            return Response.json({ success: true, message: "Subscription triggered" });
        }

        if (url.pathname === "/update-token") {
            return this.handleUpdateToken(url);
        }

        if (url.pathname === "/token-status") {
            return this.tokenStatus();
        }

        if (url.pathname === "/metrics") {
            return this.getMetrics(url);
        }

        if (url.pathname === "/sanity") {
            return this.getSanity();
        }

        if (url.pathname === "/health") {
            return this.getHealth();
        }

        // CORS proxy for footprint data
        if (url.pathname.startsWith("/data/")) {
            return this.getFootprintData(url);
        }

        // Raw Backup Access
        if (url.pathname.startsWith("/raw/")) {
            return this.getRawBackup(url);
        }

        // status default
        const wsStatus = this.ws?.readyState === WebSocket.OPEN ? "CONNECTED" : "DISCONNECTED";
        const now = Date.now();
        const lagMs = this.lastWrittenMinuteTs ? now - this.lastWrittenMinuteTs - 60000 : 0;

        return Response.json({
            status: wsStatus,
            tokenSet: this.accessToken ? "YES" : "NO",
            symbol: this.SYMBOL,
            openCandles: this.candles.size,
            bestBid: this.bestBid,
            bestAsk: this.bestAsk,
            lastWrittenMinuteTs: this.lastWrittenMinuteTs,
            processingLagMs: lagMs > 0 ? lagMs : 0,
            messageCount: this.messageCount,
            lastWriteOkAt: this.lastWriteOkAt ? new Date(this.lastWriteOkAt).toISOString() : null,
            rawBackupOpenMinutes: this.ENABLE_RAW_BACKUP ? this.rawByMinute.size : 0,
            flags: {
                ENABLE_FOOTPRINT: this.ENABLE_FOOTPRINT,
                ENABLE_RAW_BACKUP: this.ENABLE_RAW_BACKUP,
            },
            metricsPreview: {
                integrityErrors: this.metrics.integrityErrors,
                writeFailures: this.metrics.writeFailures,
                memoryPressure: this.metrics.memoryPressureEvents,
            },
        });
    }

    async handleUpdateToken(url) {
        const token = url.searchParams.get("token");
        if (!token) return new Response("Missing token parameter", { status: 400 });

        this.accessToken = token;
        await this.ctx.storage.put("access_token", token);

        // reconnect
        if (this.ws) {
            try { this.ws.close(); } catch { }
            this.ws = null;
        }
        this.connectSignalR();

        return Response.json({ success: true, message: "Token updated and reconnecting", token: token.slice(0, 20) + "..." });
    }

    tokenStatus() {
        if (!this.accessToken) return Response.json({ valid: false, message: "No token set" });

        try {
            const parts = this.accessToken.split(".");
            if (parts.length !== 3) throw new Error("Invalid JWT format");

            const payload = JSON.parse(atob(parts[1]));
            const exp = payload.exp * 1000;
            const remaining = exp - Date.now();

            return Response.json({
                valid: remaining > 0,
                expiresAt: new Date(exp).toISOString(),
                remainingSeconds: Math.floor(remaining / 1000),
                issuer: payload.iss || "Unknown",
            });
        } catch (e) {
            return Response.json({ valid: false, message: "Failed to parse token", error: e.message });
        }
    }

    getMetrics(url) {
        const format = url.searchParams.get("format") || "json";
        const now = Date.now();
        const uptimeSeconds = Math.floor((now - this.workerStartedAt) / 1000);

        const data = {
            uptime_seconds: uptimeSeconds,
            ws_connected: this.ws?.readyState === WebSocket.OPEN ? 1 : 0,
            ws_disconnects_total: this.metrics.wsDisconnects,
            trades_processed_total: this.metrics.tradesProcessed,
            l1_quote_updates_total: this.metrics.l1QuoteUpdates,
            integrity_errors_total: this.metrics.integrityErrors,
            write_failures_total: this.metrics.writeFailures,
            write_retries_total: this.metrics.writeRetries,
            memory_pressure_events_total: this.metrics.memoryPressureEvents,
            l1_staleness_events_total: this.metrics.l1StalenessEvents,
            alarm_executions_total: this.metrics.alarmExecutions,
            last_alarm_duration_ms: this.metrics.lastAlarmDurationMs,
            candles_in_memory: this.candles.size,
            raw_buckets_in_memory: this.rawByMinute.size,
            messages_received_total: this.messageCount,
            last_write_timestamp: this.lastWriteOkAt,
            processing_lag_ms: this.lastWrittenMinuteTs ? Math.max(0, now - this.lastWrittenMinuteTs - 60000) : 0,
        };

        if (format === "prometheus") {
            const lines = [];
            for (const [key, value] of Object.entries(data)) {
                lines.push(`taper_${key} ${value}`);
            }
            return new Response(lines.join("\n") + "\n", {
                headers: { "Content-Type": "text/plain; version=0.0.4" },
            });
        }

        return Response.json(data);
    }

    getHealth() {
        const now = Date.now();
        const wsOk = this.ws?.readyState === WebSocket.OPEN;
        const tokenOk = !!this.accessToken;
        const recentWrite = this.lastWriteOkAt && (now - this.lastWriteOkAt < 120000); // within 2 min

        const healthy = wsOk && tokenOk && (recentWrite || this.candles.size > 0);
        const warnings = [];

        if (!wsOk) warnings.push("websocket_disconnected");
        if (!tokenOk) warnings.push("no_token");
        if (!recentWrite && this.candles.size === 0) warnings.push("no_recent_activity");
        if (this.metrics.integrityErrors > 0) warnings.push(`integrity_errors:${this.metrics.integrityErrors}`);
        if (this.metrics.writeFailures > 0) warnings.push(`write_failures:${this.metrics.writeFailures}`);
        if (this.metrics.memoryPressureEvents > 10) warnings.push(`memory_pressure:${this.metrics.memoryPressureEvents}`);

        return Response.json({
            healthy,
            status: healthy ? "ok" : "degraded",
            warnings,
            timestamp: new Date(now).toISOString(),
        }, { status: healthy ? 200 : 503 });
    }

    async getSanity() {
        // Return latest sanity file from current hour
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        const h = String(now.getUTCHours()).padStart(2, "0");

        const path = `footprint/${this.SYMBOL}/${this.TF}/${y}/${m}/${d}/${h}_sanity.json`;

        try {
            const obj = await this.env.DATA_LAKE.get(path);
            if (!obj) {
                return Response.json({
                    status: "NOT_FOUND",
                    message: "Sanity file not yet written for current hour",
                    expected_path: path,
                    timestamp: now.toISOString(),
                }, { status: 404 });
            }

            const sanity = await obj.json();
            return Response.json({
                ...sanity,
                path,
                timestamp: now.toISOString(),
            });
        } catch (e) {
            return Response.json({
                status: "ERROR",
                message: e.message,
                path,
                timestamp: now.toISOString(),
            }, { status: 500 });
        }
    }

    async getFootprintData(url) {
        // Serve footprint data with CORS headers
        // Path format: /data/YYYY/MM/DD/HH
        const pathParts = url.pathname.split('/').filter(Boolean);

        if (pathParts.length !== 5) {
            return new Response("Invalid path format. Use: /data/YYYY/MM/DD/HH", {
                status: 400,
                headers: { "Access-Control-Allow-Origin": "*" }
            });
        }

        const [_, y, m, d, h] = pathParts;
        const key = `footprint/${this.SYMBOL}/${this.TF}/${y}/${m}/${d}/${h}.jsonl`;

        try {
            const obj = await this.env.DATA_LAKE.get(key);

            if (!obj) {
                return new Response("Data not found", {
                    status: 404,
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Content-Type": "application/json"
                    }
                });
            }

            const data = await obj.text();

            return new Response(data, {
                status: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Content-Type": "application/x-ndjson",
                    "Cache-Control": "public, max-age=60"
                }
            });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json"
                }
            });
        }
    }

    async getDailySummary(url) {
        // Path: /daily/YYYY/MM/DD
        // key: SYMBOL/YYYYMMDD.json
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length !== 4) {
            return new Response("Invalid path. Use: /daily/YYYY/MM/DD", { status: 400 });
        }

        const [_, y, m, d] = pathParts;
        const dateStr = `${y}${m}${d}`;
        // Using TAPER_SYMBOL if available, else from path (but here we are fixed to SYMBOL)
        // Screenshot implies structure: tape-data-futures / MNQ / YYYYMMDD.json
        // DATA_LAKE binding should point to tape-data-futures bucket
        const key = `${this.SYMBOL}/${dateStr}.json`;

        try {
            const obj = await this.env.DATA_LAKE.get(key);

            if (!obj) {
                // Return zero seed if not found
                return new Response(JSON.stringify({ vol: 0, turnover: 0 }), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            }

            return new Response(obj.body, {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                }
            });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Access-Control-Allow-Origin": "*" }
            });
        }
    }

    async getRawBackup(url) {
        // Path format: /raw/YYYY/MM/DD/HH/MM
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length !== 6) {
            return new Response("Invalid path. Use: /raw/YYYY/MM/DD/HH/MM", { status: 400 });
        }

        const [_, y, m, d, h, mm] = pathParts;
        const key = `raw_tns_backup/${this.SYMBOL}/${y}/${m}/${d}/${h}/${mm}.jsonl`;

        try {
            const obj = await this.env.DATA_LAKE.get(key);
            if (!obj) return new Response("Not found", { status: 404 });

            return new Response(obj.body, {
                headers: { "Content-Type": "application/x-ndjson" }
            });
        } catch (e) {
            return new Response(e.message, { status: 500 });
        }
    }

    // =========================
    // ALARM LOOP
    // =========================
    async alarm() {
        const alarmStart = Date.now();

        try {
            this.metrics.alarmExecutions++;

            // no token yet -> sleep longer
            if (!this.accessToken) {
                return;
            }

            // ensure ws
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.connectSignalR();
            }

            // memory pressure check
            await this.checkMemoryPressure();

            // finalize minutes + write footprint
            try {
                if (this.ENABLE_FOOTPRINT) await this.finalizeAndWriteReadyMinutes();
                if (this.ENABLE_RAW_BACKUP) await this.flushReadyRawMinutes();
            } catch (e) {
                console.error("[Alarm] finalize/write error:", e?.message || e);
            }
        } finally {
            // guarantee next alarm always scheduled
            const alarmDuration = Date.now() - alarmStart;
            this.metrics.lastAlarmDurationMs = alarmDuration;

            const nextAlarmDelay = !this.accessToken ? 10000 : this.ALARM_MS;
            this.ctx.storage.setAlarm(Date.now() + nextAlarmDelay);
        }
    }

    async checkMemoryPressure() {
        const now = Date.now();
        const barMs = 60000;

        // check candles
        if (this.candles.size > this.MAX_CANDLES_IN_MEMORY) {
            this.metrics.memoryPressureEvents++;
            console.warn(`[MemoryPressure] Candles overflow: ${this.candles.size}, forcing flush`);

            // force flush oldest candles
            const cutoff = Math.floor((now - this.GRACE_MS) / barMs) * barMs;
            const buckets = Array.from(this.candles.keys()).sort((a, b) => a - b);

            for (const bucketTs of buckets) {
                if (this.candles.size <= this.MAX_CANDLES_IN_MEMORY / 2) break;

                if (bucketTs < cutoff) {
                    const c = this.candles.get(bucketTs);
                    if (c && !c._writeFailed) {
                        this.candles.delete(bucketTs);
                    }
                }
            }
        }

        // check raw buckets
        if (this.rawByMinute.size > this.MAX_RAW_BUCKETS) {
            this.metrics.memoryPressureEvents++;
            console.warn(`[MemoryPressure] Raw buckets overflow: ${this.rawByMinute.size}, forcing flush`);

            const cutoff = Math.floor((now - this.GRACE_MS) / barMs) * barMs;
            const minutes = Array.from(this.rawByMinute.keys()).sort((a, b) => a - b);

            for (const minuteTs of minutes) {
                if (this.rawByMinute.size <= this.MAX_RAW_BUCKETS / 2) break;
                if (minuteTs < cutoff) {
                    this.rawByMinute.delete(minuteTs);
                }
            }
        }
    }

    // =========================
    // SIGNALR CONNECT
    // =========================
    connectSignalR() {
        try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
            if (!this.accessToken) return;

            this.handshakeConfirmed = false;

            const wsUrl = `wss://chartapi.topstepx.com/hubs/chart?access_token=${this.accessToken}`;
            this.ws = new WebSocket(wsUrl);

            this.ws.addEventListener("open", () => {
                const handshake = JSON.stringify({ protocol: "json", version: 1 }) + "\u001e";
                this.ws.send(handshake);
            });

            this.ws.addEventListener("message", (event) => {
                const data = event.data;

                // ping
                if (data === "{}") {
                    try { this.ws.send("{}"); } catch { }
                    return;
                }

                // confirm handshake once
                if (!this.handshakeConfirmed) {
                    this.handshakeConfirmed = true;
                    this.subscribeToMarketData();
                }

                this.messageCount++;

                // raw backup (bucket by receive-time minute, cheap)
                if (this.ENABLE_RAW_BACKUP) this.bufferRawFrame(String(data));

                // parse frames (delimited \u001e)
                const frames = String(data).split("\u001e").filter(Boolean);

                for (const f of frames) {
                    let msg;
                    try { msg = JSON.parse(f); } catch { continue; }

                    // Quotes: update bestBid/bestAsk
                    if (msg.target === "RealTimeSymbolQuote" && msg.arguments?.[0]) {
                        const q = msg.arguments[0];
                        const sym = String(q.symbol || "").replace("F.US.", "");
                        if (sym === this.SYMBOL) {
                            const now = Date.now();
                            if (Number.isFinite(q.bestBid)) {
                                this.bestBid = q.bestBid;
                                this.bestBidTs = now;
                                this.metrics.l1QuoteUpdates++;
                            }
                            if (Number.isFinite(q.bestAsk)) {
                                this.bestAsk = q.bestAsk;
                                this.bestAskTs = now;
                                this.metrics.l1QuoteUpdates++;
                            }
                        }
                        continue;
                    }

                    // Trades
                    if (msg.target === "RealTimeTradeLogWithSpeed") {
                        const symRaw = msg.arguments?.[0];
                        const trades = msg.arguments?.[1];
                        const sym = String(symRaw || "").replace("F.US.", "");
                        if (sym !== this.SYMBOL) continue;
                        if (!Array.isArray(trades)) continue;

                        for (const t of trades) {
                            this.ingestTrade(t, this.bestBid, this.bestAsk);
                        }
                    }
                }
            });

            this.ws.addEventListener("close", () => {
                this.metrics.wsDisconnects++;
            });

            this.ws.addEventListener("error", () => {
                // no spam
            });
        } catch (e) {
            console.error("[SignalR] Fatal error:", e?.message || e);
        }
    }

    subscribeToMarketData() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const tradeLogSub = JSON.stringify({
            type: 1,
            target: "SubscribeTradeLogWithSpeed",
            arguments: [`F.US.${this.SYMBOL}`, 0],
            invocationId: "1",
        }) + "\u001e";

        const quotesSub = JSON.stringify({
            type: 1,
            target: "SubscribeQuotesForSymbolWithSpeed",
            arguments: [`F.US.${this.SYMBOL}`, 0],
            invocationId: "2",
        }) + "\u001e";

        const timeSub = JSON.stringify({
            type: 1,
            target: "ServerTime",
            arguments: [],
            invocationId: "3",
        }) + "\u001e";

        try {
            this.ws.send(tradeLogSub);
            this.ws.send(quotesSub);
            this.ws.send(timeSub);
        } catch { }
    }

    // =========================
    // RAW BACKUP (1 file / minute)
    // =========================
    bufferRawFrame(frameStr) {
        const now = Date.now();
        const barMs = 60000;
        const minuteTs = Math.floor(now / barMs) * barMs;
        const arr = this.rawByMinute.get(minuteTs) || [];
        arr.push(frameStr);
        this.rawByMinute.set(minuteTs, arr);
    }

    async flushReadyRawMinutes() {
        const now = Date.now();
        const barMs = 60000;
        const cutoff = Math.floor((now - this.GRACE_MS) / barMs) * barMs;

        const minutes = Array.from(this.rawByMinute.keys()).sort((a, b) => a - b);
        for (const minuteTs of minutes) {
            if (minuteTs >= cutoff) break;

            const frames = this.rawByMinute.get(minuteTs);
            this.rawByMinute.delete(minuteTs);
            if (!frames || frames.length === 0) continue;

            // write 1 file per minute (overwrite is fine)
            const dt = new Date(minuteTs);
            const y = dt.getUTCFullYear();
            const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
            const d = String(dt.getUTCDate()).padStart(2, "0");
            const h = String(dt.getUTCHours()).padStart(2, "0");
            const mm = String(dt.getUTCMinutes()).padStart(2, "0");

            const key = `raw_tns_backup/${this.SYMBOL}/${y}/${m}/${d}/${h}/${mm}.jsonl`;
            const body = frames.join("\n") + "\n";

            await this.writeWithRetry(key, body, {
                httpMetadata: { contentType: "application/x-ndjson" },
            });
        }
    }

    // =========================
    // FOOTPRINT INGEST
    // =========================
    ingestTrade(trade, currentBid, currentAsk) {
        const ts = new Date(trade.timestamp).getTime();
        if (!Number.isFinite(ts)) return;

        this.metrics.tradesProcessed++;

        const barMs = 60000;
        const bucketTs = Math.floor(ts / barMs) * barMs;
        const c = this.getOrCreateCandle(bucketTs, trade);

        // dedup ringan per candle
        const dedupKey = `${trade.timestamp}|${trade.price}|${trade.volume}|${trade.type}`;
        if (c._seen.has(dedupKey)) return;
        c._seen.add(dedupKey);

        // OHLC + vol
        const px = trade.price;
        c.ohlc.h = Math.max(c.ohlc.h, px);
        c.ohlc.l = Math.min(c.ohlc.l, px);
        c.ohlc.c = px;
        c.vol += trade.volume;

        // aggressor inference with L1 staleness check
        const now = Date.now();
        const tick = c.tick;
        const eps = tick / 2;

        const bidFresh = (now - this.bestBidTs) < this.L1_MAX_STALENESS_MS;
        const askFresh = (now - this.bestAskTs) < this.L1_MAX_STALENESS_MS;
        const haveL1 = bidFresh && askFresh &&
            Number.isFinite(currentBid) && Number.isFinite(currentAsk) &&
            currentBid > 0 && currentAsk > 0;

        if (!haveL1 && this.bestBid > 0 && this.bestAsk > 0) {
            this.metrics.l1StalenessEvents++;
        }

        let isBuy;
        if (haveL1 && px >= (currentAsk - eps)) isBuy = true;
        else if (haveL1 && px <= (currentBid + eps)) isBuy = false;
        else isBuy = (trade.type === 0); // fallback: type=0 BUY, type=1 SELL

        // quantize to tick
        const p = Math.round(px / tick) * tick;
        const key = p.toFixed(2);

        if (!c.profile[key]) c.profile[key] = { bid: 0, ask: 0, bid_trades: 0, ask_trades: 0 };

        if (isBuy) {
            c.delta += trade.volume;
            c.total_ask += trade.volume;
            c.profile[key].ask += trade.volume;
            c.profile[key].ask_trades += 1;
        } else {
            c.delta -= trade.volume;
            c.total_bid += trade.volume;
            c.profile[key].bid += trade.volume;
            c.profile[key].bid_trades += 1;
        }
    }

    getOrCreateCandle(bucketTs, trade) {
        let c = this.candles.get(bucketTs);
        if (c) return c;

        const barMs = 60000;
        const t0 = new Date(bucketTs);
        const t1 = new Date(bucketTs + barMs);

        c = {
            v: 1,
            symbol: `F.US.${this.SYMBOL}`,
            tick: this.TICK,
            bar_ms: barMs,
            t0: t0.toISOString(),
            t1: t1.toISOString(),
            ohlc: { o: trade.price, h: trade.price, l: trade.price, c: trade.price },
            vol: 0,
            delta: 0,
            total_bid: 0,
            total_ask: 0,
            profile: {},
            _seen: new Set(),
        };

        this.candles.set(bucketTs, c);
        return c;
    }

    finalizeCandle(c) {
        let maxVol = -1;
        let pocPrice = 0;
        const levels = [];
        let totalVolPrice = 0;
        let totalVol = 0;

        const priceKeys = Object.keys(c.profile)
            .map((k) => Number(k))
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b);  // ASCENDING: industry standard (low to high)

        // Build profile map for O(1) lookup and calculate POC/VWAP
        const profileMap = new Map();
        for (const p of priceKeys) {
            const key = p.toFixed(2);
            const stats = c.profile[key];
            if (!stats) continue;

            profileMap.set(p, stats);
            const total = stats.bid + stats.ask;
            totalVolPrice += p * total;
            totalVol += total;

            if (total > maxVol) {
                maxVol = total;
                pocPrice = p;
            } else if (total === maxVol && maxVol > 0) {
                // tie-breaker: use VWAP interim
                const vwap = totalVolPrice / totalVol;
                if (Math.abs(p - vwap) < Math.abs(pocPrice - vwap)) {
                    pocPrice = p;
                }
            }
        }

        // Generate continuous tick ladder from hi to lo (fill gaps with 0)
        const tick = c.tick || 0.25;
        if (priceKeys.length > 0) {
            const hi = priceKeys[priceKeys.length - 1];  // highest price
            const lo = priceKeys[0];  // lowest price

            for (let p = hi; p >= lo - 0.001; p -= tick) {
                const tickPrice = Math.round(p * 1000) / 1000; // avoid float errors
                const stats = profileMap.get(tickPrice);

                if (stats) {
                    // Industry standard format: object with all metrics
                    const delta = stats.ask - stats.bid;
                    const imbalance = stats.bid > 0 ? stats.ask / stats.bid : (stats.ask > 0 ? 999 : 1);
                    const avgBidSize = stats.bid_trades > 0 ? stats.bid / stats.bid_trades : 0;
                    const avgAskSize = stats.ask_trades > 0 ? stats.ask / stats.ask_trades : 0;

                    levels.push({
                        p: tickPrice,                                // price
                        bv: stats.bid,                               // bid volume
                        av: stats.ask,                               // ask volume
                        bt: stats.bid_trades,                        // bid trade count
                        at: stats.ask_trades,                        // ask trade count
                        d: delta,                                    // delta (ask - bid)
                        imb: parseFloat(imbalance.toFixed(2)),       // imbalance ratio
                        abs: parseFloat(avgBidSize.toFixed(2)),      // avg bid size
                        aas: parseFloat(avgAskSize.toFixed(2))       // avg ask size
                    });
                } else {
                    // Fill gap with 0
                    levels.push({
                        p: tickPrice,
                        bv: 0,
                        av: 0,
                        bt: 0,
                        at: 0,
                        d: 0,
                        imb: 1,
                        abs: 0,
                        aas: 0
                    });
                }
            }
        }

        c.poc = pocPrice;
        c.vwap = totalVol > 0 ? totalVolPrice / totalVol : c.ohlc.c;

        // Calculate Value Area (70% of volume)
        const valueAreaResult = this.calculateValueArea(levels, totalVol);
        c.value_area_high = valueAreaResult.high;
        c.value_area_low = valueAreaResult.low;
        c.value_area_volume = valueAreaResult.volume;

        c.levels = levels;

        // integrity check
        const sumVol = c.total_ask + c.total_bid;
        const calcDelta = c.total_ask - c.total_bid;

        if (sumVol !== c.vol) {
            c.integrity_error = "vol_mismatch";
            this.metrics.integrityErrors++;
        }
        if (calcDelta !== c.delta) {
            c.integrity_error = (c.integrity_error ? c.integrity_error + "|delta_mismatch" : "delta_mismatch");
            this.metrics.integrityErrors++;
        }

        // cleanup heavy fields
        delete c.profile;
        delete c._seen;
    }

    calculateValueArea(levels, totalVol) {
        if (levels.length === 0 || totalVol === 0) {
            return { high: 0, low: 0, volume: 0 };
        }

        // Industry standard: Value Area = 70% of total volume
        const valueAreaThreshold = totalVol * 0.70;

        // Sort by total volume per level (descending)
        const sortedByVol = levels
            .map(level => ({
                price: level.p,
                volume: level.bv + level.av
            }))
            .sort((a, b) => b.volume - a.volume);

        // Accumulate highest volume levels until 70%
        let accumulated = 0;
        const valueAreaPrices = [];

        for (const level of sortedByVol) {
            valueAreaPrices.push(level.price);
            accumulated += level.volume;
            if (accumulated >= valueAreaThreshold) break;
        }

        return {
            high: Math.max(...valueAreaPrices),
            low: Math.min(...valueAreaPrices),
            volume: accumulated
        };
    }

    async finalizeAndWriteReadyMinutes() {
        const now = Date.now();
        const barMs = 60000;
        const cutoff = Math.floor((now - this.GRACE_MS) / barMs) * barMs;

        const buckets = Array.from(this.candles.keys()).sort((a, b) => a - b);

        for (const bucketTs of buckets) {
            if (bucketTs >= cutoff) break;

            if (bucketTs <= this.lastWrittenMinuteTs) {
                this.candles.delete(bucketTs);
                continue;
            }

            const c = this.candles.get(bucketTs);
            if (!c) continue;

            // clone then finalize
            const out = structuredClone(c);
            this.finalizeCandle(out);

            try {
                await this.writeToHourlyFootprintJsonl(bucketTs, out);
                this.lastWrittenMinuteTs = bucketTs;
                this.candles.delete(bucketTs);
                this.lastWriteOkAt = Date.now();
            } catch (e) {
                console.error("[Write] failed:", bucketTs, e?.message || e);
                // mark as failed, keep in memory for potential retry
                c._writeFailed = true;
                this.metrics.writeFailures++;
            }
        }
    }

    async writeToHourlyFootprintJsonl(bucketTs, candleObj) {
        const dt = new Date(bucketTs);
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const d = String(dt.getUTCDate()).padStart(2, "0");
        const h = String(dt.getUTCHours()).padStart(2, "0");

        const key = `footprint/${this.SYMBOL}/${this.TF}/${y}/${m}/${d}/${h}.jsonl`;

        // read existing
        let existing = "";
        try {
            const obj = await this.env.DATA_LAKE.get(key);
            if (obj) existing = await obj.text();
        } catch { }

        // idempotent replace by minute id t0
        const line = JSON.stringify(candleObj);
        const lines = existing ? existing.split("\n").filter(Boolean) : [];
        const minuteId = candleObj.t0;

        const kept = [];
        let replaced = false;

        for (const ln of lines) {
            try {
                const parsed = JSON.parse(ln);
                if (parsed?.t0 === minuteId) {
                    kept.push(line);
                    replaced = true;
                } else {
                    kept.push(ln);
                }
            } catch {
                // drop corrupted line
            }
        }
        if (!replaced) kept.push(line);

        // keep stable ordering
        kept.sort((a, b) => {
            try { return new Date(JSON.parse(a).t0).getTime() - new Date(JSON.parse(b).t0).getTime(); }
            catch { return 0; }
        });

        const out = kept.join("\n") + "\n";

        await this.writeWithRetry(key, out, {
            httpMetadata: { contentType: "application/x-ndjson" },
        });

        // sanity per hour with health metrics
        await this.writeWithRetry(
            `footprint/${this.SYMBOL}/${this.TF}/${y}/${m}/${d}/${h}_sanity.json`,
            JSON.stringify({
                last_update: Date.now(),
                status: "OK",
                count: kept.length,
                key,
                integrity_errors: this.metrics.integrityErrors,
                write_failures: this.metrics.writeFailures,
            }),
            { httpMetadata: { contentType: "application/json" } }
        );
    }

    async writeWithRetry(key, body, options) {
        let lastError;
        for (let attempt = 0; attempt < this.MAX_WRITE_RETRIES; attempt++) {
            try {
                await this.env.DATA_LAKE.put(key, body, options);
                if (attempt > 0) {
                    this.metrics.writeRetries += attempt;
                }
                return;
            } catch (e) {
                lastError = e;
                if (attempt < this.MAX_WRITE_RETRIES - 1) {
                    const delay = this.WRITE_RETRY_BASE_MS * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        // all retries failed
        this.metrics.writeFailures++;
        throw lastError;
    }
}
