const puppeteer = require('puppeteer');

// KONFIGURASI
// Simpan kredensial di Environment Variables atau .env file untuk keamanan
const EMAIL = process.env.TS_EMAIL || 'your-email@example.com';
const PASSWORD = process.env.TS_PASSWORD || 'your-password';
const WORKER_URL = 'https://fut-taping.mkemalw.workers.dev/update-token';

if (!EMAIL || !PASSWORD || EMAIL === 'your-email@example.com') {
    console.error('❌ Error: Harap set Environment Variables TS_EMAIL dan TS_PASSWORD');
    process.exit(1);
}

(async () => {
    console.log('🚀 Starting TopstepX Auto-Login RPA...');

    // Launch Browser (Headless = true untuk background, false untuk debug melihat browser)
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // 1. Setup Network Interception untuk menangkap Token
        // Kita dengarkan request WebSocket ke chartapi
        let tokenFound = false;

        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = request.url();

            // Cek apakah URL ini adalah koneksi WebSocket chart
            if (url.includes('chartapi.topstepx.com/hubs/chart') && url.includes('access_token=')) {
                // Extract token dari URL parameter
                const match = url.match(/access_token=([^&]+)/);
                if (match && !tokenFound) {
                    tokenFound = true;
                    const token = match[1];
                    console.log('✅ Token Captured!');
                    console.log('🔑 Token Length:', token.length);

                    // 4. Kirim Token ke Cloudflare Worker
                    updateWorkerToken(token);
                }
            }
            request.continue();
        });

        // 2. Go to Login Page
        console.log('📍 Navigating to Login Page...');
        await page.goto('https://app.topstepx.com/login', { waitUntil: 'networkidle2' });

        // Tunggu form login muncul
        // Note: Selector ini mungkin perlu disesuaikan jika TopstepX update UI
        const emailSelector = 'input[name="email"], input[type="email"]';
        const passSelector = 'input[name="password"], input[type="password"]';
        const btnSelector = 'button[type="submit"]';

        await page.waitForSelector(emailSelector);

        // 3. Perform Login
        console.log('✍️  Typing Credentials...');
        await page.type(emailSelector, EMAIL);
        await page.type(passSelector, PASSWORD);

        console.log('CLICK Login...');
        await page.click(btnSelector);

        // Tunggu Dashboard Load (Token harusnya tertangkap saat dashboard connect ke chart)
        console.log('⏳ Waiting for Dashboard & Token capture...');

        // Wait max 60 seconds for token
        const startTime = Date.now();
        while (!tokenFound && (Date.now() - startTime) < 60000) {
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!tokenFound) {
            throw new Error('Timeout: Token tidak ditemukan (Mungkin Login Gagal / MFA?)');
        }

    } catch (error) {
        console.error('❌ RPA Error:', error.message);
    } finally {
        await browser.close();
        console.log('👋 Browser Closed');
    }
})();

async function updateWorkerToken(token) {
    console.log('📡 Updating Worker Token...');
    try {
        const response = await fetch(`${WORKER_URL}?token=${token}`);
        const json = await response.json();
        console.log('✅ Worker Response:', json);
    } catch (e) {
        console.error('❌ Failed to update worker:', e);
    }
}
