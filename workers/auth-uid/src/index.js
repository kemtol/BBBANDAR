/**
 * @worker auth-uid
 * @objective Authentication service using D1 for user storage and JWT for session management. Handles registration, login, and profile updates.
 *
 * @endpoints
 * - POST /register -> Register new user (public)
 * - POST /register-temp -> Register temporary user (public)
 * - POST /verify-temp -> Verify temp user (public)
 * - POST /login -> Login (public)
 * - GET /me -> Get current user info (authenticated)
 * - POST /logout -> Logout (authenticated)
 * - POST /profile/update -> Update profile (authenticated)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: D1
 * - writes: D1
 *
 * @relations
 * - upstream: Frontend
 * - downstream: none
 *
 * @success_metrics
 * - Login success rate
 * - Latency of /me
 *
 * @notes
 * - Uses UUID v7 for user IDs.
 * - Implements CORS for browser access.
 */
// auth-uid/src/index.js
// Clean Auth Worker – D1 + JWT, With CORS, Cookies & JSON helper
import { SignJWT, jwtVerify } from "jose";

/**
 * Tabel users (setelah migration 0003):
 *
 * phone TEXT PRIMARY KEY,
 * name TEXT,
 * password_hash TEXT,
 * createdAt INTEGER DEFAULT (strftime('%s','now')),
 * user_id TEXT,
 * email TEXT,
 * must_update_profile INTEGER DEFAULT 0,
 * temp_password_hash TEXT,
 * temp_password_expires_at INTEGER
 */

// =======================
// UUID v7
// =======================
function uuidv7() {
  let ts = BigInt(Date.now());
  const bytes = new Uint8Array(16);

  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }

  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  bytes.set(rnd, 6);

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

// =======================
// CORS + JSON helper
// =======================
function corsHeaders(origin) {
  if (origin) {
    // Untuk request browser (punya Origin) dan butuh credentials
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
  }

  // Fallback (misal curl tanpa Origin)
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200, extraHeaders = {}, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

// =======================
// Utils: hash, compare, JWT
// =======================
async function hash(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function compare(str, hashed) {
  return (await hash(str)) === hashed;
}

async function createJWT(payload, secret) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(secret));
}

async function verifyJWT(token, secret) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
  return payload;
}

// =======================
// Temp Password (OTP 6 digit)
// =======================
function generateTempPassword() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// =======================
// Generate Unique Password untuk bot (format: SAHAM-XXXX-XXXX)
// =======================
function generateUniquePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O,0,I,1
  const rand = (n) => Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    b => chars[b % chars.length]
  ).join('');
  return `SAHAM-${rand(4)}-${rand(4)}`;
}

// =======================
// Normalize phone → 62xxx (Indonesian format)
// Accepts: 08xxx / 628xxx / +628xxx / 8xxx
// =======================
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s\-().+]/g, '');
  if (p.startsWith('62')) {
    // already has country code — keep as is
  } else if (p.startsWith('0')) {
    p = '62' + p.slice(1);   // 08xxx → 628xxx
  } else if (p.startsWith('8')) {
    p = '62' + p;            // 8xxx  → 628xxx
  } else {
    return null;
  }
  if (/^628\d{8,11}$/.test(p)) return p;
  return null;
}

// =======================
// Kirim pesan Telegram
// =======================
async function sendTgMessage(botToken, chatId, text, extra = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[tg] sendMessage failed', res.status, err);
    }
  } catch (e) {
    console.error('[tg] sendMessage error', e.message);
  }
}

// =======================
// TELEGRAM WEBHOOK HANDLER
// =======================
async function handleTgWebhook(request, env) {
  let update;
  try { update = await request.json(); } catch { return new Response('OK'); }

  const msg = update.message;
  if (!msg) return new Response('OK');

  const chatId    = msg.chat.id;
  const threadId  = msg.message_thread_id;   // ada jika forum topics aktif
  const text      = (msg.text || '').trim();
  const isGroup   = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const APP_URL   = env.APP_BASE || 'https://sssaham.xyz';
  const BOT_USERNAME = env.BOT_USERNAME || 'Sssaham_bot';

  // Helper: kirim pesan, otomatis reply ke thread yang sama jika ada
  const reply = (text, extra = {}) => {
    const opts = threadId ? { message_thread_id: threadId, ...extra } : extra;
    return sendTgMessage(env.BOT_TOKEN, chatId, text, opts);
  };

  // ── Member baru join grup ──────────────────────────────────────────────────
  if (msg.new_chat_members && msg.new_chat_members.length > 0) {
    for (const member of msg.new_chat_members) {
      if (member.is_bot) continue;
      const name = member.first_name || 'Sobat';
      await reply(
        `👋 Selamat datang *${name}* di SSSAHAM Algotrade!\n\n` +
        `Untuk akses dashboard, DM *@${BOT_USERNAME}* dan tap tombol *Bagikan Nomor HP*.\n\n` +
        `📊 AI Recs, Broker Summary & Real-Time API — *Gratis!* 🚀`,
        {
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '🤖 DM Bot Sekarang', url: `https://t.me/${BOT_USERNAME}` },
              { text: '🌐 Buka Dashboard',  url: APP_URL }
            ]]
          })
        }
      );
    }
    return new Response('OK');
  }

  // ── Hanya proses pesan private (DM ke bot) ────────────────────────────────
  if (isGroup) return new Response('OK');

  // ── /start ─────────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    await reply(
      `Halo! 👋 Selamat datang di *SSSAHAM Bot*.\n\n` +
      `Ketik perintah berikut untuk mendapatkan password akses dashboard:\n\n` +
      `\`/login 628xxxxxxxxxx\`\n\n` +
      `Ganti \`628xxxxxxxxxx\` dengan nomor HP yang kamu daftarkan di website.\n\n` +
      `💡 Belum daftar? Kunjungi ${env.APP_BASE || 'https://sssaham.xyz'} dulu.`,
      { parse_mode: 'Markdown' }
    );
    return new Response('OK');
  }

  // ── /help ──────────────────────────────────────────────────────────────────
  if (text === '/help') {
    await reply(
      `📌 *SSSAHAM Bot*\n\n` +
      `• Kirim nomor HP → dapat password akses\n` +
      `• /start — mulai ulang\n` +
      `• /help — tampilkan pesan ini\n\n` +
      `🌐 Dashboard: ${env.APP_BASE || 'https://sssaham.xyz'}`,
      { parse_mode: 'Markdown' }
    );
    return new Response('OK');
  }

  // ── /login <phone> ──────────────────────────────────────────────────────────
  if (text.startsWith('/login')) {
    const parts = text.trim().split(/\s+/);
    const rawPhone = parts[1] || '';
    const phone = normalizePhone(rawPhone);

    if (!phone) {
      await reply(
        `❌ Format salah. Gunakan:\n\`/login 628xxxxxxxxxx\`\n\nContoh: \`/login 6281234567890\``,
        { parse_mode: 'Markdown' }
      );
      return new Response('OK');
    }

    const row = await env.DB
      .prepare('SELECT temp_password_plain, temp_password_expires_at FROM users WHERE phone = ?')
      .bind(phone).first();

    if (!row || !row.temp_password_plain) {
      await reply(
        `❌ Nomor *${phone}* belum terdaftar.\n\nDaftar dulu di website: ${env.APP_BASE || 'https://sssaham.xyz'}`,
        { parse_mode: 'Markdown' }
      );
      return new Response('OK');
    }

    if (Number(row.temp_password_expires_at) < Date.now()) {
      await reply(
        `⏰ Password sudah kadaluarsa.\n\nSilakan daftar ulang di: ${env.APP_BASE || 'https://sssaham.xyz'}`,
        { parse_mode: 'Markdown' }
      );
      return new Response('OK');
    }

    // Simpan chat_id + extend expiry 10 menit untuk login
    await env.DB
      .prepare('UPDATE users SET telegram_chat_id = ?, temp_password_expires_at = ? WHERE phone = ?')
      .bind(String(chatId), Date.now() + 10 * 60 * 1000, phone)
      .run();

    await reply(
      `✅ *Password kamu ditemukan!*\n\n` +
      `📱 Nomor: \`${phone}\`\n` +
      `🔑 Password: \`${row.temp_password_plain}\`\n\n` +
      `⚠️ *Berlaku 10 menit — segera login!*\n\n` +
      `🔗 Login di: ${env.APP_BASE || 'https://sssaham.xyz'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: '🚀 Login Sekarang', url: env.APP_BASE || 'https://sssaham.xyz' }
          ]]
        })
      }
    );
    return new Response('OK');
  }

  // ── Input nomor HP langsung (fallback lama → arahkan ke /login) ────────────
  const phone = normalizePhone(text);
  if (phone) {
    // Arahkan ke /login command
    await reply(
      `Gunakan perintah ini untuk login:\n\n\`/login ${phone}\``,
      { parse_mode: 'Markdown' }
    );
    return new Response('OK');
  }

  // ── Default fallback ───────────────────────────────────────────────────────
  await reply(
    `Kirimkan nomor HP kamu untuk mendapatkan password.\nContoh: \`08123456789\`\n\nAtau ketik /help untuk bantuan.`,
    { parse_mode: 'Markdown' }
  );
  return new Response('OK');
}

// =======================
// SET WEBHOOK HELPER (panggil sekali saja via browser)
// =======================
async function handleTgSetWebhook(request, env) {
  const url   = new URL(request.url);
  const workerUrl = url.searchParams.get('url') ||
    `https://auth-uid.mkemalw.workers.dev/tg/webhook`;
  const resp = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: workerUrl, allowed_updates: ['message', 'contact'] }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

// =======================
// LEGACY REGISTER: phone + password
// =======================
async function handleRegisterLegacy(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, name, password } = await request.json();

    if (!phone || !password) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }

    const safeName = name && name.trim() ? name.trim() : null;

    const exists = await env.DB
      .prepare("SELECT phone FROM users WHERE phone = ?")
      .bind(phone)
      .first();

    if (exists) {
      return json({ ok: false, reason: "user_exists" }, 409, {}, origin);
    }

    const userId = uuidv7();

    await env.DB
      .prepare(
        "INSERT INTO users (phone, name, password_hash, user_id, must_update_profile) VALUES (?, ?, ?, ?, 1)"
      )
      .bind(phone, safeName, await hash(password), userId)
      .run();

    return json({ ok: true, user_id: userId }, 200, {}, origin);
  } catch (err) {
    return json(
      { ok: false, error: err.message, stack: err.stack },
      500,
      {},
      origin
    );
  }
}

// =======================
// REGISTER TEMP: phone (+ optional email), TANPA password
// Dipakai untuk full OTP flow.
// =======================
async function handleRegisterTemp(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, email } = await request.json();

    if (!phone) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }

    const safeEmail = email && email.trim ? email.trim() : null;

    let user = await env.DB
      .prepare(
        "SELECT phone, user_id, password_hash FROM users WHERE phone = ?"
      )
      .bind(phone)
      .first();

    if (user && user.password_hash) {
      // sudah punya password permanen → suruh login biasa
      return json({ ok: false, reason: "user_exists" }, 409, {}, origin);
    }

    let userId;

    if (!user) {
      userId = uuidv7();
      await env.DB
        .prepare(
          "INSERT INTO users (phone, email, user_id, must_update_profile) VALUES (?, ?, ?, 1)"
        )
        .bind(phone, safeEmail, userId)
        .run();
    } else {
      userId = user.user_id;
      await env.DB
        .prepare("UPDATE users SET email = COALESCE(email, ?) WHERE phone = ?")
        .bind(safeEmail, phone)
        .run();
    }

    const temp = generateTempPassword();
    const tempHash = await hash(temp);
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30 menit (user perlu waktu join Telegram)

    await env.DB
      .prepare(
        "UPDATE users SET temp_password_hash = ?, temp_password_plain = ?, temp_password_expires_at = ? WHERE phone = ?"
      )
      .bind(tempHash, temp, expiresAt, phone)
      .run();

    console.log("[auth-uid] temp password for", phone, "=", temp);

    return json(
      {
        ok: true,
        user_id: userId,
        mock_temp_password: temp, // simulasi / fallback
        expires_in_sec: 300,
      },
      200,
      {},
      origin
    );
  } catch (err) {
    return json(
      { ok: false, error: err.message, stack: err.stack },
      500,
      {},
      origin
    );
  }
}

// =======================
// VERIFY TEMP: phone + temp_password (6 digit)
// =======================
async function handleVerifyTemp(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, temp_password } = await request.json();

    if (!phone || !temp_password) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }

    const row = await env.DB
      .prepare(
        "SELECT user_id, temp_password_hash, temp_password_expires_at FROM users WHERE phone = ?"
      )
      .bind(phone)
      .first();

    if (!row || !row.temp_password_hash || !row.temp_password_expires_at) {
      return json(
        { ok: false, reason: "invalid_or_expired_temp_password" },
        401,
        {},
        origin
      );
    }

    const now = Date.now();
    if (Number(row.temp_password_expires_at) < now) {
      return json(
        { ok: false, reason: "invalid_or_expired_temp_password" },
        401,
        {},
        origin
      );
    }

    const match = await compare(temp_password, row.temp_password_hash);
    if (!match) {
      return json(
        { ok: false, reason: "invalid_or_expired_temp_password" },
        401,
        {},
        origin
      );
    }

    await env.DB
      .prepare(
        "UPDATE users SET temp_password_hash = NULL, temp_password_plain = NULL, temp_password_expires_at = NULL, must_update_profile = 1 WHERE user_id = ?"
      )
      .bind(row.user_id)
      .run();

    const token = await createJWT(
      {
        sub: row.user_id,
      },
      env.JWT_SECRET
    );

    return json(
      { ok: true, must_update_profile: true },
      200,
      {
        "Set-Cookie": `bpjs_jwt=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=604800`,
      },
      origin
    );
  } catch (err) {
    return json(
      { ok: false, error: err.message, stack: err.stack },
      500,
      {},
      origin
    );
  }
}

// =======================
// LOGIN klasik: phone + password permanen
// =======================
async function handleLogin(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, password } = await request.json();

    if (!phone || !password) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }

    let user = await env.DB
      .prepare(
        "SELECT phone, name, password_hash, user_id, must_update_profile FROM users WHERE phone = ?"
      )
      .bind(phone)
      .first();

    if (!user || !user.password_hash) {
      return json(
        { ok: false, reason: "invalid_credentials" },
        401,
        {},
        origin
      );
    }

    if (!(await compare(password, user.password_hash))) {
      return json(
        { ok: false, reason: "invalid_credentials" },
        401,
        {},
        origin
      );
    }

    if (!user.user_id) {
      const newId = uuidv7();
      await env.DB
        .prepare("UPDATE users SET user_id = ? WHERE phone = ?")
        .bind(newId, phone)
        .run();
      user.user_id = newId;
    }

    const token = await createJWT(
      {
        sub: user.user_id,
      },
      env.JWT_SECRET
    );

    return json(
      { ok: true, must_update_profile: !!user.must_update_profile },
      200,
      {
        "Set-Cookie": `bpjs_jwt=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=604800`,
      },
      origin
    );
  } catch (err) {
    return json(
      { ok: false, error: err.message, stack: err.stack },
      500,
      {},
      origin
    );
  }
}

// =======================
// /me: cek login & baca user dari DB
// =======================
async function handleMe(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const cookie = request.headers.get("Cookie") || "";
    const token = cookie.match(/bpjs_jwt=([^;]+)/)?.[1];

    if (!token) return json({ logged_in: false }, 200, {}, origin);

    let payload;
    try {
      payload = await verifyJWT(token, env.JWT_SECRET);
    } catch {
      return json({ logged_in: false }, 200, {}, origin);
    }

    const userRow = await env.DB
      .prepare(
        "SELECT phone, name, must_update_profile FROM users WHERE user_id = ?"
      )
      .bind(payload.sub)
      .first();

    if (!userRow) {
      return json({ logged_in: false }, 200, {}, origin);
    }

    return json(
      {
        logged_in: true,
        user: {
          user_id: payload.sub,
          phone: userRow.phone,
          name: userRow.name,
          must_update_profile: !!userRow.must_update_profile,
        },
      },
      200,
      {},
      origin
    );
  } catch (err) {
    return json(
      { logged_in: false, error: err.message },
      500,
      {},
      origin
    );
  }
}

// =======================
// LOGOUT
// =======================
function handleLogout(request) {
  const origin = request.headers.get("Origin");
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `bpjs_jwt=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
    },
    origin
  );
}

// =======================
// PROFILE UPDATE: name + new_password
// =======================
async function handleProfileUpdate(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { full_name, new_password } = await request.json();

    if (!full_name || !new_password) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }

    const nameTrimmed = full_name.trim();
    const nameRegex = /^[A-Za-z. ]+$/; // huruf, spasi, titik saja

    if (!nameRegex.test(nameTrimmed)) {
      return json({ ok: false, reason: "invalid_name" }, 400, {}, origin);
    }

    if (typeof new_password !== "string" || new_password.length < 6) {
      return json({ ok: false, reason: "weak_password" }, 400, {}, origin);
    }

    const cookie = request.headers.get("Cookie") || "";
    const token = cookie.match(/bpjs_jwt=([^;]+)/)?.[1];

    if (!token) {
      return json({ ok: false, reason: "not_logged_in" }, 401, {}, origin);
    }

    let payload;
    try {
      payload = await verifyJWT(token, env.JWT_SECRET);
    } catch {
      return json({ ok: false, reason: "not_logged_in" }, 401, {}, origin);
    }

    const pwHash = await hash(new_password);

    await env.DB
      .prepare(
        "UPDATE users SET name = ?, password_hash = ?, must_update_profile = 0 WHERE user_id = ?"
      )
      .bind(nameTrimmed, pwHash, payload.sub)
      .run();

    return json({ ok: true }, 200, {}, origin);
  } catch (err) {
    return json(
      { ok: false, error: err.message, stack: err.stack },
      500,
      {},
      origin
    );
  }
}

// =======================
// /tg/get-otp  – dipanggil tg-bot untuk ambil OTP plaintext (internal)
// =======================
async function handleTgGetOtp(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, bot_secret } = await request.json();

    if (!phone || !bot_secret) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }
    if (bot_secret !== env.BOT_SECRET) {
      return json({ ok: false, reason: "unauthorized" }, 401, {}, origin);
    }

    const row = await env.DB
      .prepare(
        "SELECT temp_password_plain, temp_password_expires_at FROM users WHERE phone = ?"
      )
      .bind(phone)
      .first();

    if (!row || !row.temp_password_plain) {
      return json({ ok: false, reason: "no_active_otp" }, 404, {}, origin);
    }

    if (Number(row.temp_password_expires_at) < Date.now()) {
      return json({ ok: false, reason: "otp_expired" }, 410, {}, origin);
    }

    return json(
      { ok: true, temp_password: row.temp_password_plain },
      200, {}, origin
    );
  } catch (err) {
    return json({ ok: false, error: err.message }, 500, {}, origin);
  }
}

// =======================
// /tg/trigger-invite  – dipanggil web (authed user) setelah OTP verify
//   auth-uid forward ke tg-bot /send-invite dengan BOT_SECRET
// =======================
async function handleTgTriggerInvite(request, env) {
  const origin = request.headers.get("Origin");
  try {
    // Harus sudah login (punya cookie)
    const cookie = request.headers.get("Cookie") || "";
    const token = cookie.match(/bpjs_jwt=([^;]+)/)?.[1];
    if (!token) {
      return json({ ok: false, reason: "not_logged_in" }, 401, {}, origin);
    }

    let payload;
    try {
      payload = await verifyJWT(token, env.JWT_SECRET);
    } catch {
      return json({ ok: false, reason: "not_logged_in" }, 401, {}, origin);
    }

    // Ambil phone dari DB berdasarkan user_id
    const userRow = await env.DB
      .prepare("SELECT phone FROM users WHERE user_id = ?")
      .bind(payload.sub)
      .first();

    if (!userRow) {
      return json({ ok: false, reason: "user_not_found" }, 404, {}, origin);
    }

    // Forward ke tg-bot
    if (!env.TG_BOT_BASE || !env.BOT_SECRET) {
      // Tidak dikonfigurasi — skip silently
      return json({ ok: true, telegram_triggered: false }, 200, {}, origin);
    }

    const tgResp = await fetch(`${env.TG_BOT_BASE}/send-invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: userRow.phone, bot_secret: env.BOT_SECRET }),
    });
    const tgData = await tgResp.json().catch(() => ({ ok: false }));

    return json(
      { ok: true, telegram_triggered: !!tgData.ok, telegram_linked: tgData.telegram_linked },
      200, {}, origin
    );
  } catch (err) {
    // Fire-and-forget — jangan error ke user
    console.error("[auth-uid] tg/trigger-invite error", err.message);
    return json({ ok: true, telegram_triggered: false }, 200, {}, origin);
  }
}

// =======================
// /tg/get-chat-id  – tg-bot ambil telegram_chat_id untuk phone tertentu
// =======================
async function handleTgGetChatId(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, bot_secret } = await request.json();

    if (!phone || !bot_secret) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }
    if (bot_secret !== env.BOT_SECRET) {
      return json({ ok: false, reason: "unauthorized" }, 401, {}, origin);
    }

    const row = await env.DB
      .prepare("SELECT telegram_chat_id FROM users WHERE phone = ?")
      .bind(phone)
      .first();

    if (!row || !row.telegram_chat_id) {
      return json({ ok: false, reason: "no_telegram_linked" }, 404, {}, origin);
    }

    return json({ ok: true, telegram_chat_id: row.telegram_chat_id }, 200, {}, origin);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500, {}, origin);
  }
}

// =======================
// /tg/store-chat  – tg-bot menyimpan chat_id user agar bisa dikirim invite
// =======================
async function handleTgStoreChat(request, env) {
  const origin = request.headers.get("Origin");
  try {
    const { phone, telegram_chat_id, bot_secret } = await request.json();

    if (!phone || !telegram_chat_id || !bot_secret) {
      return json({ ok: false, reason: "missing_fields" }, 400, {}, origin);
    }
    if (bot_secret !== env.BOT_SECRET) {
      return json({ ok: false, reason: "unauthorized" }, 401, {}, origin);
    }

    await env.DB
      .prepare("UPDATE users SET telegram_chat_id = ? WHERE phone = ?")
      .bind(String(telegram_chat_id), phone)
      .run();

    return json({ ok: true }, 200, {}, origin);
  } catch (err) {
    return json({ ok: false, error: err.message }, 500, {}, origin);
  }
}

// =======================
// Router
// =======================
async function router(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  // Legacy simple register: phone + password
  if (url.pathname === "/register" && request.method === "POST") {
    return handleRegisterLegacy(request, env);
  }

  // New OTP flow
  if (url.pathname === "/register-temp" && request.method === "POST") {
    return handleRegisterTemp(request, env);
  }

  if (url.pathname === "/verify-temp" && request.method === "POST") {
    return handleVerifyTemp(request, env);
  }

  if (url.pathname === "/login" && request.method === "POST") {
    return handleLogin(request, env);
  }

  if (url.pathname === "/me") {
    return handleMe(request, env);
  }

  if (url.pathname === "/logout" && request.method === "POST") {
    return handleLogout(request);
  }

  if (url.pathname === "/profile/update" && request.method === "POST") {
    return handleProfileUpdate(request, env);
  }

  // Telegram bot internal endpoints (secured by BOT_SECRET)
  if (url.pathname === "/tg/get-otp" && request.method === "POST") {
    return handleTgGetOtp(request, env);
  }

  if (url.pathname === "/tg/store-chat" && request.method === "POST") {
    return handleTgStoreChat(request, env);
  }

  if (url.pathname === "/tg/get-chat-id" && request.method === "POST") {
    return handleTgGetChatId(request, env);
  }

  // Dipanggil web (authed) setelah OTP verify berhasil — forward ke tg-bot
  if (url.pathname === "/tg/trigger-invite" && request.method === "POST") {
    return handleTgTriggerInvite(request, env);
  }

  // Telegram Bot webhook (terima update dari Telegram)
  if (url.pathname === "/tg/webhook" && request.method === "POST") {
    return handleTgWebhook(request, env);
  }

  // Setup webhook (panggil sekali: /tg/set-webhook?url=https://...)
  if (url.pathname === "/tg/set-webhook") {
    return handleTgSetWebhook(request, env);
  }

  return new Response("auth worker ready", { headers: corsHeaders(origin) });
}

// =======================
// Export Worker
// =======================
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    try {
      return await router(request, env);
    } catch (err) {
      return json(
        { ok: false, fatal: err.message, stack: err.stack },
        500,
        {},
        origin
      );
    }
  },
};
