// otp.js — Clean OTP module (no DO, no KV, D1 only)

// Generate 6-digit OTP
export function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Save OTP to D1 (with expiration time)
export async function saveOTP(env, phone, otp) {
  const expires = Date.now() + 5 * 60 * 1000; // 5 minutes TTL

  await env.BPJS_UUID_BINDING
    .prepare(`INSERT OR REPLACE INTO otp_codes (phone, otp, expires_at) VALUES (?, ?, ?)`)
    .bind(phone, otp, expires)
    .run();
}

// Get OTP from D1
export async function getOTP(env, phone) {
  return await env.BPJS_UUID_BINDING
    .prepare(`SELECT otp, expires_at FROM otp_codes WHERE phone = ?`)
    .bind(phone)
    .first();
}

// Delete OTP after use
export async function deleteOTP(env, phone) {
  await env.BPJS_UUID_BINDING
    .prepare(`DELETE FROM otp_codes WHERE phone = ?`)
    .bind(phone)
    .run();
}

// Send OTP to third-party API (Fonnte/Twilio/WABA/etc.)
export async function sendOTP(env, phone, otp) {
  // Example generic fetch
  const url = env.OTP_PROVIDER_URL;     // kamu simpan di vars atau secret
  const apiKey = env.OTP_API_KEY;       // secret key provider

  // Payload default (ubah sesuai provider)
  const payload = {
    target: phone,
    message: `Kode OTP Anda adalah: ${otp}`
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error("Failed to send OTP:", await res.text());
  }
}
