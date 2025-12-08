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
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 menit

    await env.DB
      .prepare(
        "UPDATE users SET temp_password_hash = ?, temp_password_expires_at = ? WHERE phone = ?"
      )
      .bind(tempHash, expiresAt, phone)
      .run();

    console.log("[auth-uid] temp password for", phone, "=", temp);

    return json(
      {
        ok: true,
        user_id: userId,
        mock_temp_password: temp, // simulasi WA
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
        "UPDATE users SET temp_password_hash = NULL, temp_password_expires_at = NULL, must_update_profile = 1 WHERE user_id = ?"
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
