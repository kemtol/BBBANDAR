import { DurableObject } from "cloudflare:workers";

export default {
    async fetch(request, env, ctx) {
        // Route to appropriate DO instance
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

        // State
        this.accessToken = "";
        this.ws = null;
        this.buffer = [];
        this.messageCount = 0;

        // Config
        this.BATCH_SIZE = 50;
        this.FLUSH_INTERVAL_MS = 5000;
        this.lastFlush = Date.now();

        // Restore token from storage
        this.ctx.blockConcurrencyWhile(async () => {
            const token = await this.ctx.storage.get("access_token");
            if (token) {
                this.accessToken = token;
                console.log("[Token] Loaded from storage");
            }
        });

        // Start alarm
        this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    async fetch(request) {
        const url = new URL(request.url);

        // Manual subscription trigger
        if (url.pathname === "/subscribe") {
            // ... (keep existing)
            this.subscribeToMarketData();
            return Response.json({ success: true, message: "Subscription triggered" });
        }

        // Token status endpoint
        if (url.pathname === "/token-status") {
            if (!this.accessToken) {
                return Response.json({ valid: false, message: "No token set" });
            }

            try {
                const parts = this.accessToken.split('.');
                if (parts.length !== 3) throw new Error("Invalid JWT format");

                const payload = JSON.parse(atob(parts[1]));
                const exp = payload.exp * 1000; // Convert to ms
                const now = Date.now();
                const remaining = exp - now;

                const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
                const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

                return Response.json({
                    valid: remaining > 0,
                    expiresAt: new Date(exp).toISOString(),
                    remainingSeconds: Math.floor(remaining / 1000),
                    remainingHuman: remaining > 0 ? `${days} days, ${hours} hours` : "Expired",
                    issuer: payload.iss || "Unknown"
                });
            } catch (e) {
                return Response.json({ valid: false, message: "Failed to parse token", error: e.message });
            }
        }

        // Update token endpoint
        if (url.pathname === "/update-token") {
            return this.handleUpdateToken(url);
        }

        // Status endpoint (default)
        const wsStatus = this.ws?.readyState === WebSocket.OPEN ? "CONNECTED" : "DISCONNECTED";

        return Response.json({
            status: wsStatus,
            tokenSet: this.accessToken ? "YES" : "NO",
            bufferSize: this.buffer.length,
            messageCount: this.messageCount,
            lastFlush: new Date(this.lastFlush).toISOString()
        });
    }

    async handleUpdateToken(url) {
        const token = url.searchParams.get("token");
        if (!token) {
            return new Response("Missing token parameter", { status: 400 });
        }

        this.accessToken = token;
        await this.ctx.storage.put("access_token", token);

        // Reconnect with new token
        if (this.ws) {
            console.log("[WS] Closing old connection for token update");
            this.ws.close();
            this.ws = null;
        }

        this.connectSignalR();

        return Response.json({
            success: true,
            message: "Token updated and reconnecting",
            token: token.substring(0, 20) + "..."
        });
    }

    async alarm() {
        // Don't connect if no token
        if (!this.accessToken) {
            console.log("[Alarm] Waiting for token... (use /update-token)");
            this.ctx.storage.setAlarm(Date.now() + 10000);
            return;
        }

        // Ensure connection
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.connectSignalR();
        }

        // Flush if needed
        if (this.buffer.length > 0 && (Date.now() - this.lastFlush > this.FLUSH_INTERVAL_MS)) {
            await this.flushToR2();
        }

        // Next alarm
        this.ctx.storage.setAlarm(Date.now() + 5000);
    }

    connectSignalR() {
        try {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
            if (!this.accessToken) return;

            console.log("[SignalR] Connecting...");
            this.handshakeConfirmed = false;

            const wsUrl = `wss://chartapi.topstepx.com/hubs/chart?access_token=${this.accessToken}`;
            this.ws = new WebSocket(wsUrl);

            this.ws.addEventListener("open", () => {
                console.log("[SignalR] ✅ Connected!");

                // SignalR handshake - send protocol version
                const handshake = JSON.stringify({
                    protocol: "json",
                    version: 1
                }) + "\u001e";

                this.ws.send(handshake);
                console.log("[SignalR] Handshake sent, waiting for reply...");
            });

            this.ws.addEventListener("message", async (event) => {
                // Confirm handshake and subscribe
                if (!this.handshakeConfirmed) {
                    this.handshakeConfirmed = true;
                    console.log("[SignalR] ✅ Handshake confirmed via message, triggering subscription...");
                    this.subscribeToMarketData();
                }
                const data = event.data;

                // Handle ping
                if (data === "{}") {
                    this.ws.send("{}");
                    return;
                }

                // Buffer raw message
                this.messageCount++;
                this.buffer.push({
                    raw: data,
                    ts: Date.now(),
                    count: this.messageCount
                });

                console.log(`[Data] Received message #${this.messageCount}, buffer: ${this.buffer.length}`);

                // Auto-flush if batch size reached
                if (this.buffer.length >= this.BATCH_SIZE) {
                    await this.flushToR2();
                }
            });

            this.ws.addEventListener("close", (event) => {
                console.log(`[SignalR] ❌ Disconnected (code: ${event.code})`);
            });

            this.ws.addEventListener("error", (event) => {
                console.error("[SignalR] Error:", event);
            });

        } catch (e) {
            console.error("[SignalR] Fatal error:", e);
        }
    }

    subscribeToMarketData() {
        console.log("[Subscribe] ========== SUBSCRIPTION CALLED ==========");
        console.log("[Subscribe] WS exists:", !!this.ws);
        console.log("[Subscribe] WS state:", this.ws?.readyState);
        console.log("[Subscribe] WebSocket.OPEN constant:", WebSocket.OPEN);

        if (!this.ws) {
            console.error("[Subscribe] ❌ NO WEBSOCKET!");
            return;
        }

        if (this.ws.readyState !== WebSocket.OPEN) {
            console.error("[Subscribe] ❌ WS NOT OPEN! State:", this.ws.readyState, "Expected:", WebSocket.OPEN);
            return;
        }

        console.log("[Subscribe] ✅ WS is OPEN, sending subscriptions...");

        // Subscribe to Trade Log for footprint data (Using F.US.ENQ as confirmed)
        const tradeLogSub = JSON.stringify({
            type: 1,
            target: "SubscribeTradeLogWithSpeed",
            arguments: ["F.US.ENQ", 0],
            invocationId: "1"
        }) + "\u001e";

        // Subscribe to Quotes
        const quotesSub = JSON.stringify({
            type: 1,
            target: "SubscribeQuotesForSymbolWithSpeed",
            arguments: ["F.US.ENQ", 0],
            invocationId: "2"
        }) + "\u001e";

        // Subscribe to ServerTime (Sanity check)
        const timeSub = JSON.stringify({
            type: 1,
            target: "ServerTime",
            arguments: [],
            invocationId: "3"
        }) + "\u001e";

        try {
            this.ws.send(tradeLogSub);
            this.ws.send(quotesSub);
            this.ws.send(timeSub);
            console.log("[Subscribe] ✅ Sent F.US.ENQ & ServerTime subscriptions");

            console.log("[Subscribe] ========== SUBSCRIPTIONS SENT ==========");
        } catch (e) {
            console.error("[Subscribe] ❌ SEND FAILED:", e);
        }
    }

    async flushToR2() {
        if (this.buffer.length === 0) return;

        const dataToWrite = [...this.buffer];
        this.buffer = [];
        this.lastFlush = Date.now();

        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        const h = String(now.getUTCHours()).padStart(2, '0');

        // Group by symbol (parse from SignalR message)
        const bySymbol = {};
        for (const item of dataToWrite) {
            let symbol = "UNKNOWN";

            try {
                // Parse SignalR message to extract symbol
                const messages = item.raw.split('\u001e').filter(Boolean);
                for (const msg of messages) {
                    const parsed = JSON.parse(msg);

                    // Handle RealTimeTradeLogWithSpeed response
                    if (parsed.target === "RealTimeTradeLogWithSpeed" && parsed.arguments && parsed.arguments[0]) {
                        symbol = parsed.arguments[0]; // First argument is symbol (F.US.MNQ)
                        symbol = symbol.replace("F.US.", ""); // Convert F.US.MNQ → MNQ
                    }
                    // Handle RealTimeSymbolQuote
                    else if (parsed.target === "RealTimeSymbolQuote" && parsed.arguments && parsed.arguments[0] && parsed.arguments[0].symbol) {
                        symbol = parsed.arguments[0].symbol.replace("F.US.", "");
                    }
                    // Look for symbol in arguments array
                    else if (parsed.arguments && parsed.arguments[0] && parsed.arguments[0].symbol) {
                        symbol = parsed.arguments[0].symbol;
                    } else if (parsed.arguments && parsed.arguments[0] && parsed.arguments[0].symbolId) {
                        symbol = parsed.arguments[0].symbolId.replace("F.US.", "");
                    }
                }
            } catch (e) {
                // If parsing fails, keep as UNKNOWN
            }

            symbol = symbol.toUpperCase();
            if (!bySymbol[symbol]) bySymbol[symbol] = [];
            bySymbol[symbol].push(item);
        }

        // Save per symbol
        for (const [symbol, messages] of Object.entries(bySymbol)) {
            const path = `raw_tns/${symbol}/${y}/${m}/${d}/${h}`;
            const filename = `${path}/${Date.now()}.json`;
            const fileContent = messages.map(JSON.stringify).join('\n');

            try {
                await this.env.DATA_LAKE.put(filename, fileContent);
                console.log(`[R2] ✅ Saved ${messages.length} messages for ${symbol} to ${filename}`);
            } catch (err) {
                console.error(`[R2] ❌ Failed to save ${symbol}:`, err);
                // Put back to buffer if failed
                this.buffer = [...messages, ...this.buffer];
            }
        }
    }
}
