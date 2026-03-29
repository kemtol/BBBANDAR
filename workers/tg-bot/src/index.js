/**
 * @worker tg-bot
 * @objective Telegram Bot webhook handler untuk onboarding user SSSAHAM.
 *            Menerima /start <base64phone>, mengambil OTP dari auth-uid,
 *            mengirimkan OTP ke user via Telegram, dan mengirim invite group
 *            setelah OTP diverifikasi di web.
 *
 * @endpoints
 * - POST /webhook        -> Telegram update handler (set sebagai Telegram webhook URL)
 * - POST /send-invite    -> Dipanggil web setelah OTP verified; kirim invite group ke user
 * - GET  /set-webhook    -> Helper: daftarkan webhook URL ke Telegram (panggil sekali)
 *
 * @triggers
 * - http: yes
 * - cron: none
 * - queue: none
 * - durable_object: none
 * - alarms: none
 *
 * @io
 * - reads: env.BOT_TOKEN, env.BOT_SECRET, env.AUTH_BASE, env.GROUP_INVITE_LINK
 * - writes: Telegram Bot API (sendMessage)
 *
 * @relations
 * - upstream: Telegram Bot API (webhook), Frontend (otp.html)
 * - downstream: auth-uid worker (/tg/get-otp, /tg/store-chat)
 *
 * @secrets (set via wrangler secret put)
 * - BOT_TOKEN          : Telegram Bot API token dari @BotFather
 * - BOT_SECRET         : Shared secret dengan auth-uid + frontend (buat sendiri, random string)
 * - GROUP_INVITE_LINK  : Invite link grup Telegram SSSAHAM (https://t.me/+xxxx)
 *
 * @vars (di wrangler.jsonc)
 * - AUTH_BASE          : URL auth-uid worker
 * - BOT_USERNAME       : Username bot tanpa @
 * - APP_BASE           : URL frontend (sssaham.com)
 *
 * @setup
 * 1. Buat bot di @BotFather, dapatkan BOT_TOKEN
 * 2. Deploy worker ini: wrangler deploy
 * 3. Set secrets: wrangler secret put BOT_TOKEN / BOT_SECRET / GROUP_INVITE_LINK
 * 4. Daftarkan webhook: GET https://tg-bot.mkemalw.workers.dev/set-webhook
 * 5. Set BOT_SECRET yang sama di auth-uid: cd ../auth-uid && wrangler secret put BOT_SECRET
 */

const TG_API = 'https://api.telegram.org/bot';

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResp(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

/**
 * Kirim pesan ke Telegram user.
 * @param {string} botToken
 * @param {string|number} chatId
 * @param {string} text   - HTML formatted
 * @param {object} extra  - opsi tambahan (reply_markup dll)
 */
async function sendMessage(botToken, chatId, text, extra = {}) {
    const body = {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    };
    const resp = await fetch(`${TG_API}${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error('[tg-bot] sendMessage failed', resp.status, errText);
    }
    return resp;
}

/**
 * Ambil OTP dari auth-uid untuk phone tertentu.
 */
async function fetchOtp(authBase, phone, botSecret) {
    const resp = await fetch(`${authBase}/tg/get-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, bot_secret: botSecret }),
    });
    return resp.json().catch(() => ({ ok: false }));
}

/**
 * Simpan telegram_chat_id ke auth-uid DB (untuk later invite).
 */
async function storeChatId(authBase, phone, chatId, botSecret) {
    const resp = await fetch(`${authBase}/tg/store-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, telegram_chat_id: chatId, bot_secret: botSecret }),
    });
    return resp.json().catch(() => ({ ok: false }));
}

// ─── Webhook Handler ─────────────────────────────────────────────────────────

async function handleWebhook(request, env) {
    let update;
    try {
        update = await request.json();
    } catch {
        return jsonResp({ ok: false, error: 'invalid json' }, 400);
    }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return jsonResp({ ok: true });

    const chatId = String(msg.chat.id);
    const text = msg.text.trim();
    const appBase = env.APP_BASE || 'https://sssaham.com';

    // ── /start <base64phone> ────────────────────────────────────────────────
    if (text.startsWith('/start')) {
        const parts = text.split(' ');

        if (parts.length < 2 || !parts[1]) {
            await sendMessage(
                env.BOT_TOKEN,
                chatId,
                `👋 Selamat datang di <b>SSSAHAM Bot</b>!\n\n` +
                `Daftar dulu di <a href="${appBase}/register.html">${appBase}/register.html</a> ` +
                `— setelah itu kamu akan otomatis diarahkan ke sini untuk mendapatkan OTP.`
            );
            return jsonResp({ ok: true });
        }

        // Decode phone dari base64
        let phone;
        try {
            phone = atob(parts[1]);
        } catch {
            await sendMessage(
                env.BOT_TOKEN,
                chatId,
                `❌ Link tidak valid. Daftar ulang di <a href="${appBase}/register.html">sini</a>.`
            );
            return jsonResp({ ok: true });
        }

        // Validasi format phone minimal
        if (!phone || phone.length < 8) {
            await sendMessage(env.BOT_TOKEN, chatId, `❌ Nomor HP tidak valid. Daftar ulang.`);
            return jsonResp({ ok: true });
        }

        // Simpan chat_id ke auth-uid DB
        const storeResult = await storeChatId(env.AUTH_BASE, phone, chatId, env.BOT_SECRET);
        if (!storeResult.ok) {
            console.warn('[tg-bot] storeChatId failed', storeResult);
        }

        // Ambil OTP dari auth-uid
        const otpData = await fetchOtp(env.AUTH_BASE, phone, env.BOT_SECRET);

        if (!otpData.ok || !otpData.temp_password) {
            await sendMessage(
                env.BOT_TOKEN,
                chatId,
                `⚠️ Tidak ditemukan OTP aktif untuk nomor <code>${phone}</code>.\n\n` +
                `Mungkin OTP sudah kedaluwarsa. Minta OTP baru di:\n` +
                `<a href="${appBase}/register.html">${appBase}/register.html</a>`
            );
            return jsonResp({ ok: true });
        }

        // Kirim OTP ke user
        await sendMessage(
            env.BOT_TOKEN,
            chatId,
            `🔐 <b>Kode OTP kamu:</b>\n\n` +
            `<code>${otpData.temp_password}</code>\n\n` +
            `⏰ Berlaku <b>5 menit</b>\n\n` +
            `Masukkan kode ini di halaman registrasi:\n` +
            `👉 <a href="${appBase}/otp.html">${appBase}/otp.html</a>`,
            {
                reply_markup: JSON.stringify({
                    inline_keyboard: [[
                        { text: '📝 Masukkan OTP', url: `${appBase}/otp.html` }
                    ]]
                })
            }
        );

        return jsonResp({ ok: true });
    }

    // ── /login → kirim ulang OTP ────────────────────────────────────────────
    if (text.startsWith('/login')) {
        // Kita tidak simpan phone di bot (tidak ada KV binding) — phone ada di auth-uid
        // User perlu daftar ulang dari web jika belum punya OTP aktif
        await sendMessage(
            env.BOT_TOKEN,
            chatId,
            `ℹ️ Untuk mendapatkan OTP baru:\n\n` +
            `1. Buka <a href="${appBase}/register.html">${appBase}/register.html</a>\n` +
            `2. Masukkan nomor HP kamu\n` +
            `3. Klik tombol <b>Buka Telegram Bot</b>\n\n` +
            `Bot akan langsung mengirimkan OTP ke sini.`
        );
        return jsonResp({ ok: true });
    }

    // ── /help ───────────────────────────────────────────────────────────────
    if (text.startsWith('/help') || text === '/?') {
        await sendMessage(
            env.BOT_TOKEN,
            chatId,
            `📌 <b>SSSAHAM Bot</b>\n\n` +
            `• <b>/start</b> — Mulai proses verifikasi (dipakai otomatis dari web)\n` +
            `• <b>/login</b> — Petunjuk login\n` +
            `• <b>/help</b> — Tampilkan pesan ini\n\n` +
            `🌐 <a href="${appBase}">${appBase}</a>`
        );
        return jsonResp({ ok: true });
    }

    // ── Default ─────────────────────────────────────────────────────────────
    await sendMessage(
        env.BOT_TOKEN,
        chatId,
        `👋 Hai! Ketik /help untuk melihat commands yang tersedia.`
    );
    return jsonResp({ ok: true });
}

// ─── Send Invite (dipanggil oleh otp.html setelah OTP berhasil) ──────────────

/**
 * POST /send-invite
 * Body: { phone: string, bot_secret: string }
 *
 * Ambil telegram_chat_id dari auth-uid (/me-nya sudah punya chat_id),
 * lalu kirim invite link ke user.
 */
async function handleSendInvite(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResp({ ok: false, error: 'invalid json' }, 400);
    }

    const { phone, bot_secret } = body;

    if (!phone || !bot_secret) {
        return jsonResp({ ok: false, error: 'missing fields' }, 400);
    }
    if (bot_secret !== env.BOT_SECRET) {
        return jsonResp({ ok: false, error: 'unauthorized' }, 401);
    }

    // Ambil telegram_chat_id dari auth-uid via /me-check
    // Kita buat endpoint sementara: query ke auth-uid untuk ambil chat_id
    // Karena auth-uid tidak punya GET /tg/chat-id, kita pakai cara lain:
    // auth-uid sudah simpan telegram_chat_id di kolom users saat /tg/store-chat
    // Kita buat tg-bot langsung query auth-uid untuk ambil info user
    const profileResp = await fetch(`${env.AUTH_BASE}/tg/get-chat-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, bot_secret: env.BOT_SECRET }),
    });
    const profileData = await profileResp.json().catch(() => ({}));

    if (!profileData.ok || !profileData.telegram_chat_id) {
        // User belum buka bot (Telegram belum terhubung) — tetap OK
        console.warn('[tg-bot] no telegram_chat_id for phone', phone);
        return jsonResp({ ok: true, telegram_linked: false });
    }

    const chatId = profileData.telegram_chat_id;
    const inviteLink = env.GROUP_INVITE_LINK || 'https://t.me/sssaham';
    const appBase = env.APP_BASE || 'https://sssaham.com';

    await sendMessage(
        env.BOT_TOKEN,
        chatId,
        `✅ <b>Verifikasi berhasil! Selamat bergabung di SSSAHAM 🎉</b>\n\n` +
        `Kamu sekarang sudah terdaftar sebagai member SSSAHAM.\n\n` +
        `👇 Klik untuk bergabung ke grup komunitas:\n${inviteLink}\n\n` +
        `🌐 Dashboard: <a href="${appBase}/idx/index.html">${appBase}/idx/index.html</a>`,
        {
            reply_markup: JSON.stringify({
                inline_keyboard: [[
                    { text: '🚀 Masuk Grup SSSAHAM', url: inviteLink }
                ]]
            })
        }
    );

    return jsonResp({ ok: true, telegram_linked: true });
}

// ─── Set Webhook Helper ──────────────────────────────────────────────────────

/**
 * GET /set-webhook?url=https://tg-bot.mkemalw.workers.dev/webhook
 * Panggil sekali saat setup untuk mendaftarkan webhook ke Telegram.
 */
async function handleSetWebhook(request, env) {
    const url = new URL(request.url);
    const webhookUrl = url.searchParams.get('url') ||
        `https://tg-bot.mkemalw.workers.dev/webhook`;

    const resp = await fetch(
        `${TG_API}${env.BOT_TOKEN}/setWebhook`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] }),
        }
    );
    const data = await resp.json().catch(() => ({}));
    return jsonResp(data);
}

// ─── Main Router ─────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }

        // Telegram webhook
        if (url.pathname === '/webhook' && request.method === 'POST') {
            return handleWebhook(request, env);
        }

        // Dipanggil web setelah OTP verify berhasil
        if (url.pathname === '/send-invite' && request.method === 'POST') {
            return handleSendInvite(request, env);
        }

        // Setup helper (panggil sekali dari browser)
        if (url.pathname === '/set-webhook') {
            return handleSetWebhook(request, env);
        }

        return new Response(
            JSON.stringify({ ok: true, service: 'tg-bot', bot: env.BOT_USERNAME }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    },
};
