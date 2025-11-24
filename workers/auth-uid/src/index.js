// Clean Auth Worker – D1 + JWT, With CORS, Cookies & JSON helper
import { SignJWT, jwtVerify } from "jose";

// =======================
// CORS
// =======================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // jika nanti mau restrict, ganti wildcard
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true"
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extraHeaders
    }
  });
}

// =======================
// Utils
// =======================
async function hash(str) {
  return str; // TODO: ganti bcrypt jika mau security real
}

async function compare(str, hashed) {
  return str === hashed;
}

async function createJWT(payload, secret) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(secret));
}

async function verifyJWT(token, secret) {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret)
  );
  return payload;
}

// =======================
// Routes
// =======================
async function handleRegister(request, env) {
  try {
    const { phone, name, password } = await request.json();

    if (!phone || !name || !password) {
      return json({ ok: false, reason: "missing_fields" }, 400);
    }

    const exists = await env.DB
      .prepare("SELECT phone FROM users WHERE phone = ?")
      .bind(phone)
      .first();

    if (exists) {
      return json({ ok: false, reason: "user_exists" }, 409);
    }

    await env.DB
      .prepare("INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)")
      .bind(phone, name, await hash(password))
      .run();

    return json({ ok: true });

  } catch (err) {
    return json({ ok: false, error: err.message, stack: err.stack }, 500);
  }
}

async function handleLogin(request, env) {
  try {
    const { phone, password } = await request.json();

    const user = await env.DB
      .prepare("SELECT phone, name, password_hash FROM users WHERE phone = ?")
      .bind(phone)
      .first();

    if (!user || !(await compare(password, user.password_hash))) {
      return json({ ok: false, reason: "invalid_credentials" }, 401);
    }

    const token = await createJWT(
      { phone: user.phone, name: user.name },
      env.JWT_SECRET
    );

    return json(
      { ok: true },
      200,
      {
        "Set-Cookie": `bpjs_jwt=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=604800`
      }
    );

  } catch (err) {
    return json({ ok: false, error: err.message, stack: err.stack }, 500);
  }
}

async function handleMe(request, env) {
  try {
    const cookie = request.headers.get("Cookie") || "";
    const token = cookie.match(/bpjs_jwt=([^;]+)/)?.[1];

    if (!token) return json({ logged_in: false });

    const user = await verifyJWT(token, env.JWT_SECRET);
    return json({ logged_in: true, user });

  } catch {
    return json({ logged_in: false });
  }
}

function handleLogout() {
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `bpjs_jwt=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`
    }
  );
}

// =======================
// Router
// =======================
async function router(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === "/register" && request.method === "POST")
    return handleRegister(request, env);

  if (url.pathname === "/login" && request.method === "POST")
    return handleLogin(request, env);

  if (url.pathname === "/me")
    return handleMe(request, env);

  if (url.pathname === "/logout" && request.method === "POST")
    return handleLogout();

  return new Response("auth worker ready", { headers: corsHeaders() });
}

// =======================
// Export Worker
// =======================
export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (err) {
      return json(
        { ok: false, fatal: err.message, stack: err.stack },
        500
      );
    }
  }
};
