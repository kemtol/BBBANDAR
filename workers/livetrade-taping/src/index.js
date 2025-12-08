import { DurableObject } from "cloudflare:workers";

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

    // Default Token (Bisa kosong, nanti diisi via CLI)
    this.currentSession = "";

    // Config
    this.BATCH_SIZE = 100;
    this.FLUSH_INTERVAL_MS = 3000;

    this.buffer = [];   // Buffer untuk Live Trade (LT)
    this.bufferOB = []; // --- [BARU] Buffer khusus Orderbook (OB2)

    this.ws = null;
    this.lastFlush = Date.now();
    this.lastFlushOB = Date.now();

    // Load token terakhir dari storage (agar tahan banting kalau restart)
    this.ctx.blockConcurrencyWhile(async () => {
      let storedToken = await this.ctx.storage.get("session_token");
      if (storedToken) {
        this.currentSession = storedToken;
        console.log("Token dimuat dari storage:", this.currentSession.substr(0, 10) + "...");
      }
    });

    this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // === FITUR BARU: UPDATE TOKEN VIA URL ===
    // Cara pakai: curl "https://worker-anda.dev/update?token=TOKEN_BARU"
    if (url.pathname === "/update") {
      return this.handleUpdateToken(url);
    }

    // Status Page
    let status = "Mati";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) status = "CONNECTED (Live Trade + OB GOTO)";

    return new Response(JSON.stringify({
      status: status,
      currentSession: this.currentSession ? "Terisi" : "KOSONG",
      bufferSizeLT: this.buffer.length,
      bufferSizeOB: this.bufferOB.length, // --- [BARU] Info buffer OB
      lastFlush: new Date(this.lastFlush).toISOString()
    }, null, 2));
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
      this.ctx.storage.setAlarm(Date.now() + 10000); // Cek lagi nanti
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectStream();
    }

    // Flush Live Trade (LT) - Cek lastFlushLT
    if (this.buffer.length > 0 && (Date.now() - this.lastFlushLT > this.FLUSH_INTERVAL_MS)) {
      await this.flushToR2();
    }

    // Flush Orderbook (OB) - Cek lastFlushOB
    if (this.bufferOB.length > 0 && (Date.now() - this.lastFlushOB > this.FLUSH_INTERVAL_MS)) {
      await this.flushOBToR2();
    }

    this.ctx.storage.setAlarm(Date.now() + 5000);
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

        this.ws.send(JSON.stringify({ "event": "#handshake", "data": { "authToken": null }, "cid": 1 }));

        setTimeout(() => {
          // 1. SUBSCRIBE EXISTING (Live Trade Global)
          console.log("[WS] Subscribe Live Trade (LT)...");
          const subLT = {
            "event": "cmd",
            "data": {
              "cmdid": 999,
              "param": { "cmd": "subscribe", "service": "mi", "rtype": "LT", "code": "*", "subsid": "livetrade_worker" }
            },
            "cid": 2
          };
          this.ws.send(JSON.stringify(subLT));

          // --- [BARU] 2. SUBSCRIBE ORDERBOOK (Khusus GOTO) ---
          console.log("[WS] Subscribe Orderbook GOTO...");
          const subOB = {
            "event": "cmd",
            "data": {
              "cmdid": 1000, // ID beda dikit biar aman
              "param": { "cmd": "subscribe", "service": "mi", "rtype": "OB2", "code": "GOTO", "subsid": "ob_goto_sniper" }
            },
            "cid": 3
          };
          this.ws.send(JSON.stringify(subOB));

        }, 1000);
      });

      this.ws.addEventListener("message", async (event) => {
        const rawMsg = event.data;
        if (rawMsg === "#1") { this.ws.send("#2"); return; }
        try {
          const parsed = JSON.parse(rawMsg);
          if (parsed.event === "stream" || parsed.event === "#publish") {
            let rtype = parsed.data?.rtype || parsed.rtype;

            // === EXISTING LOGIC (Live Trade) ===
            if (rtype === "LT") {
              const tradeData = parsed.data?.data || parsed.data;
              this.buffer.push({ raw: tradeData, ts: Date.now() });
              if (this.buffer.length >= this.BATCH_SIZE) await this.flushToR2();
            }

            // === [BARU] NEW LOGIC (Orderbook GOTO) ===
            else if (rtype === "OB2") {
              // Ambil raw stringnya (recinfo)
              // Struktur data OB2 biasanya ada di parsed.data.data.recinfo (string pipe)
              const obData = parsed.data?.data?.recinfo || parsed.data?.recinfo || parsed.data;

              // Kita simpan mentahannya saja biar enteng
              this.bufferOB.push({ raw: obData, ts: Date.now() });

              // Batch size untuk OB bisa disamakan atau dikecilkan
              if (this.bufferOB.length >= 50) await this.flushOBToR2();
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

  // Existing Flush Function (Untuk Live Trade)
  async flushToR2() {
    if (this.buffer.length === 0) return;
    const dataToWrite = [...this.buffer];
    this.buffer = [];
    this.lastFlushLT = Date.now(); // <--- Update Timer LT Saja
    const fileContent = dataToWrite.map(JSON.stringify).join("\n");
    const now = new Date();
    // Path: raw_lt/...
    const path = `raw_lt/${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')}/${now.getHours().toString().padStart(2, '0')}`;
    const filename = `${path}/${Date.now()}.json`;
    try { await this.env.DATA_LAKE.put(filename, fileContent); console.log(`[LT] Saved ${dataToWrite.length} items.`); } catch (err) { console.error("[R2] Fail LT:", err); }
  }

  // --- [BARU] Fungsi Flush Khusus Orderbook ---
  async flushOBToR2() {
    if (this.bufferOB.length === 0) return;
    const dataToWrite = [...this.bufferOB];
    this.bufferOB = [];
    this.lastFlushOB = Date.now(); // <--- Update Timer OB Saja

    const fileContent = dataToWrite.map(JSON.stringify).join("\n");
    const now = new Date();

    // Path BEDA: raw_ob/GOTO/... (Biar rapi)
    const path = `raw_ob/GOTO/${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')}/${now.getHours().toString().padStart(2, '0')}`;
    const filename = `${path}/${Date.now()}.json`;

    try {
      await this.env.DATA_LAKE.put(filename, fileContent);
      console.log(`[OB] Saved ${dataToWrite.length} snapshots GOTO.`);
    } catch (err) {
      console.error("[R2] Fail OB:", err);
    }
  }
}