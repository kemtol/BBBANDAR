// workers/livetrade-state-engine/src/index.js
import { DurableObject } from "cloudflare:workers";

// Helper CORS (dipakai di layer luar)
function withCORS(resp) {
  const headers = new Headers(resp.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");

  return new Response(resp.body, {
    status: resp.status || 200,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight dari browser
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // 🔴 BYPASS /history DI SINI (TIDAK LEWAT DO)
    // Bagian ini dibiarkan sesuai original request (bypass dummy)
    if (pathname === "/history") {
      const kode = url.searchParams.get("kode");
      const mode = url.searchParams.get("mode") || "swing";
      let limit = parseInt(url.searchParams.get("limit") || "50", 10);
      if (!limit || Number.isNaN(limit)) limit = 50;

      if (!kode) {
        return withCORS(
          new Response("Butuh ?kode=XXXX", {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          })
        );
      }

      const dummy = {
        kode,
        mode,
        limit,
        count: 0,
        items: [],
        note: "HISTORY_BYPASSED_DO_DEBUG",
      };

      return withCORS(
        new Response(JSON.stringify(dummy, null, 2), {
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Selain /history → teruskan ke DO GLOBAL_STATE
    const id = env.STATE_ENGINE.idFromName("GLOBAL_STATE");
    const stub = env.STATE_ENGINE.get(id);

    try {
      const resp = await stub.fetch(request);
      return withCORS(resp);
    } catch (err) {
      console.error("STATE_ENGINE DO error:", err);
      return withCORS(
        new Response(
          JSON.stringify(
            { error: "DO_FETCH_ERROR", message: String(err) },
            null,
            2
          ),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        )
      );
    }
  },
};

export class StateEngine extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;

      // 1. Ambil default dari URL params (untuk GET)
      let kode = url.searchParams.get("kode");
      let mode = url.searchParams.get("mode") || "swing";
      let bodyData = null;

      // 2. JIKA POST: Coba ambil data dari JSON Body (akan menimpa URL params jika ada)
      if (request.method === "POST") {
        try {
          // Clone request agar aman jika perlu dibaca ulang, lalu parse JSON
          bodyData = await request.clone().json();
          
          if (bodyData.kode) kode = bodyData.kode;
          if (bodyData.mode) mode = bodyData.mode;
        } catch (e) {
          console.warn("Gagal parse JSON body:", e);
        }
      }

      // ============================================================
      // LOGIC BARU: BULK UPDATE (Simpan Data dari Backfill Worker)
      // ============================================================
      if (pathname === "/bulk-update" && request.method === "POST" && bodyData) {
        const items = bodyData.items || [];
        
        // Simpan ke storage DO (Persistent Storage)
        if (items.length > 0) {
           let ops = {};
           items.forEach(item => {
             // Key: Kode Saham, Value: Object lengkap (termasuk history array)
             ops[item.kode] = item; 
           });
           
           // Cloudflare DO supports bulk put (menyimpan banyak sekaligus)
           await this.storage.put(ops);
        }

        return new Response(JSON.stringify({ 
          status: "UPDATED", 
          count: items.length,
          note: "Data stored securely in Durable Object"
        }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // ============================================================
      // LOGIC BARU: GET STATE (Ambil Data Real untuk Frontend)
      // ============================================================
      if (pathname === "/state" && request.method === "GET") {
        if (kode) {
          // Ambil data asli dari storage
          const storedData = await this.storage.get(kode);
          
          if (storedData) {
            return new Response(JSON.stringify(storedData, null, 2), {
              headers: { "Content-Type": "application/json" }
            });
          } else {
             // Jika data belum ada di storage, kembalikan kosong/error halus
             return new Response(JSON.stringify({ error: "No Data Found", kode }, null, 2), {
               status: 404,
               headers: { "Content-Type": "application/json" }
             });
          }
        }
      }

      // ============================================================
      // FALLBACK: DEBUG RESPONSE (Original Logic)
      // ============================================================
      // Jika route tidak cocok dengan logic baru, kembalikan debug payload asli
      const debugPayload = {
        path: pathname,
        method: request.method,
        kode, 
        mode,
        received_body: bodyData, 
        note: "DEBUG_MINIMAL_FETCH_FIXED (Fallback Route)"
      };

      return new Response(JSON.stringify(debugPayload, null, 2), {
        headers: { "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(
        JSON.stringify(
          { error: "DO_MINIMAL_ERROR", message: String(err) },
          null,
          2
        ),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }
}