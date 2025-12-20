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
    this.BATCH_SIZE = 100;
    this.FLUSH_INTERVAL_MS = 3000;

    this.buffer = [];     // LT
    this.bufferOB = [];   // OB2 semua kode

    this.ws = null;
    this.lastFlushLT = Date.now();
    this.lastFlushOB = Date.now();

    // 🟢 watchlist unik (LQ45 + IDX30, tanpa duplikat)
    this.watchList = buildWatchList(env);
    console.log("[OB] Watchlist aktif:", this.watchList.join(", "));

    this.ctx.blockConcurrencyWhile(async () => {
      const storedToken = await this.ctx.storage.get("session_token");
      if (storedToken) {
        this.currentSession = storedToken;
        console.log(
          "Token dimuat dari storage:",
          this.currentSession.substr(0, 10) + "..."
        );
      }
    });

    this.ctx.storage.setAlarm(Date.now() + 1000);
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

    // 3) Status Page default
    let status = "Mati";
    if (this.ws && this.ws.readyState === WebSocket.OPEN)
      status = "CONNECTED (LT + OB watchlist)";

    return new Response(
      JSON.stringify(
        {
          status: status,
          currentSession: this.currentSession ? "Terisi" : "KOSONG",
          bufferSizeLT: this.buffer.length,
          bufferSizeOB: this.bufferOB.length,
          lastFlush: new Date(this.lastFlushLT).toISOString(),
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
              // kode bisa ada di parsed.code atau parsed.data.code
              const kode =
                (parsed.data && parsed.data.code) ||
                parsed.code ||
                "UNKNOWN";

              const obRaw = parsed.data || parsed; // simpan event lengkap (ada .data)

              this.bufferOB.push({
                kode,
                raw: obRaw,
                ts: Date.now(),
              });

              if (this.bufferOB.length >= 50) {
                await this.flushOBToR2();
              }
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
    try {
      await this.env.DATA_LAKE.put(filename, fileContent);

      // --- SANITY INFO ---
      const sanityPath = `${path}/sanity-info.json`;
      const sanityData = {
        last_update: Date.now(),
        status: "OK",
        count: dataToWrite.length,
        service: "livetrade-taping"
      };
      await this.env.DATA_LAKE.put(sanityPath, JSON.stringify(sanityData));
      // -------------------

      console.log(`[LT] Saved ${dataToWrite.length} items.`);
    } catch (err) { console.error("[R2] Fail LT:", err); }
  }

  // --- [BARU] Fungsi Flush Khusus Orderbook ---
  // --- Fungsi Flush Khusus Orderbook (multi-kode) ---
  async flushOBToR2() {
    if (this.bufferOB.length === 0) return;

    const dataToWrite = [...this.bufferOB];
    this.bufferOB = [];
    this.lastFlushOB = Date.now();

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const H = String(now.getHours()).padStart(2, "0");

    // 🟢 group per kode: supaya TLKM, BBRI, GOTO dll masing-masing 1 file
    const byKode = {};
    for (const row of dataToWrite) {
      const kode = (row.kode || "UNKNOWN").toUpperCase();
      if (!byKode[kode]) byKode[kode] = [];
      byKode[kode].push(row);
    }

    for (const [kode, rows] of Object.entries(byKode)) {
      const path = `raw_ob/${kode}/${y}/${m}/${d}/${H}`;
      const filename = `${path}/${Date.now()}_${kode}.json`;
      const fileContent = rows.map(JSON.stringify).join("\n");

      try {
        await this.env.DATA_LAKE.put(filename, fileContent);
        console.log(`[OB] Saved ${rows.length} snapshots for ${kode}.`);
      } catch (err) {
        console.error("[R2] Fail OB for", kode, err);
      }
    }
  }


}